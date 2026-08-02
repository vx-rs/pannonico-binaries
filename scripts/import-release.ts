import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJSON, packageManifest, packageReadme } from "./package-files.ts";
import {
  assertNoPrivateMarkers,
  readRegularFile,
  sha256File,
  validateSourceRelease,
} from "./release-contract.ts";
import { packagePayloadPath, RELEASE_TARGETS } from "./release-targets.ts";
import { validateRelease } from "./validate-release.ts";

export type PublicTargetManifest = {
  archive: string;
  archiveSHA256: string;
  archiveSize: number;
  executable: string;
  executableSHA256: string;
  executableSize: number;
  package: string;
  target: string;
};

export type PublicReleaseManifest = {
  buildEpoch: number;
  goVersion: string;
  nativeManifestHash: string;
  notarized: false;
  resolvedCapabilities: string[];
  schemaVersion: 1;
  signatureType: null;
  signed: false;
  sourceCommit: string;
  sourceTag: string;
  targets: PublicTargetManifest[];
  version: string;
  wasiManifestHash: string;
};

export type ImportReleaseOptions = {
  repositoryRoot?: string;
  source: string;
};

const CURRENT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(CURRENT_FILE), "..");
const LEGAL_FILES = ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md"] as const;

/** importRelease stages, validates, and installs one approved public Free release. */
export const importRelease = ({
  repositoryRoot = REPOSITORY_ROOT,
  source,
}: ImportReleaseOptions): PublicReleaseManifest => {
  const repository = resolve(repositoryRoot);
  const repositoryInformation = lstatSync(repository);
  if (repositoryInformation.isSymbolicLink() || !repositoryInformation.isDirectory()) {
    throw new Error("Public binary repository root is not a real directory");
  }
  const verified = validateSourceRelease(source);
  const stagingRoot = mkdtempSync(join(dirname(repository), ".pannonico-import-"));
  const stagedRepository = join(stagingRoot, "repository");
  try {
    mkdirSync(stagedRepository, { mode: 0o755 });
    stageRepositoryMetadata(repository, stagedRepository, verified.metadata.version);
    const targets = stageTargetPackages(repository, stagedRepository, verified);
    const manifest: PublicReleaseManifest = {
      buildEpoch: verified.metadata.buildEpoch,
      goVersion: verified.metadata.goVersion,
      nativeManifestHash: verified.metadata.nativeManifestHash,
      notarized: false,
      resolvedCapabilities: [...verified.metadata.resolvedCapabilities],
      schemaVersion: 1,
      signatureType: null,
      signed: false,
      sourceCommit: verified.metadata.sourceCommit,
      sourceTag: verified.metadata.sourceTag,
      targets,
      version: verified.metadata.version,
      wasiManifestHash: verified.metadata.wasiManifestHash,
    };
    stagePublicRelease(stagedRepository, verified, manifest);
    writeFileSync(join(stagedRepository, "release-manifest.json"), canonicalJSON(manifest), {
      mode: 0o644,
    });
    assertNoPrivateMarkers(stagedRepository, [verified.privateRoot, verified.sourceRoot]);
    validateRelease({ repositoryRoot: stagedRepository, version: verified.metadata.version });
    installStagedRelease(repository, stagedRepository, stagingRoot);
    return manifest;
  } finally {
    rmSync(stagingRoot, { force: true, recursive: true });
  }
};

/** stageRepositoryMetadata prepares versioned root metadata and legal validation inputs. */
const stageRepositoryMetadata = (
  repositoryRoot: string,
  stagedRepository: string,
  version: string,
): void => {
  const packageJson = JSON.parse(
    readRegularFile(join(repositoryRoot, "package.json"), "root package manifest").toString("utf8"),
  ) as Record<string, unknown>;
  if (packageJson.name !== "@vx.rs/pannonico-binaries" || packageJson.private !== true) {
    throw new Error("Root package manifest does not identify the private public-binary workspace");
  }
  packageJson.version = version;
  writeFileSync(join(stagedRepository, "package.json"), canonicalJSON(packageJson), {
    mode: 0o644,
  });
  const lockPath = join(repositoryRoot, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(
      readRegularFile(lockPath, "package lockfile").toString("utf8"),
    ) as Record<string, unknown>;
    lock.name = packageJson.name;
    lock.version = version;
    const packages = lock.packages as Record<string, Record<string, unknown>> | undefined;
    if (packages?.[""]) {
      packages[""].name = packageJson.name;
      packages[""].version = version;
    }
    writeFileSync(join(stagedRepository, "package-lock.json"), canonicalJSON(lock), {
      mode: 0o644,
    });
  }
  for (const fileName of LEGAL_FILES) {
    copyFileSync(join(repositoryRoot, fileName), join(stagedRepository, fileName));
  }
};

/** stageTargetPackages constructs exact target trees from verified unpacked payloads. */
const stageTargetPackages = (
  repositoryRoot: string,
  stagedRepository: string,
  verified: ReturnType<typeof validateSourceRelease>,
): PublicTargetManifest[] =>
  RELEASE_TARGETS.map((target, index) => {
    const packageDirectory = join(stagedRepository, "packages", target.packageDirectory);
    const payloadRelative = packagePayloadPath(target);
    const payloadPath = join(packageDirectory, ...payloadRelative.split("/"));
    mkdirSync(dirname(payloadPath), { recursive: true, mode: 0o755 });
    const payload = verified.payloads.get(target.target);
    if (!payload) throw new Error(`Verified payload is missing for ${target.target}`);
    writeFileSync(payloadPath, payload, { mode: target.platform === "win32" ? 0o644 : 0o755 });
    if (target.platform !== "win32") {
      // npm preserves the executable bit for native Unix payloads.
      chmodSync(payloadPath, 0o755);
    }
    const executableSHA256 = sha256File(payloadPath);
    const executableSize = readRegularFile(payloadPath, "staged package payload").length;
    writeFileSync(
      join(packageDirectory, "package.json"),
      canonicalJSON(packageManifest(target, verified.metadata.version)),
      {
        mode: 0o644,
      },
    );
    writeFileSync(join(packageDirectory, "README.md"), packageReadme(target), { mode: 0o644 });
    writeFileSync(
      join(packageDirectory, "SHA256SUMS"),
      `${executableSHA256}  ${payloadRelative}\n`,
      {
        mode: 0o644,
      },
    );
    for (const fileName of LEGAL_FILES) {
      copyFileSync(join(repositoryRoot, fileName), join(packageDirectory, fileName));
    }
    const sourceArtifact = verified.metadata.artifacts[index];
    return {
      archive: `public-release/${sourceArtifact.path}`,
      archiveSHA256: sourceArtifact.sha256,
      archiveSize: sourceArtifact.size,
      executable: `packages/${target.packageDirectory}/${payloadRelative}`,
      executableSHA256,
      executableSize,
      package: target.packageName,
      target: target.target,
    };
  });

/** stagePublicRelease copies exact archives and writes only approved public metadata. */
const stagePublicRelease = (
  stagedRepository: string,
  verified: ReturnType<typeof validateSourceRelease>,
  manifest: PublicReleaseManifest,
): void => {
  const publicRoot = join(stagedRepository, "public-release");
  mkdirSync(join(publicRoot, "assets"), { recursive: true, mode: 0o755 });
  mkdirSync(join(publicRoot, "metadata"), { recursive: true, mode: 0o755 });
  for (const artifact of verified.metadata.artifacts) {
    copyFileSync(
      join(verified.sourceRoot, ...artifact.path.split("/")),
      join(publicRoot, ...artifact.path.split("/")),
    );
  }
  writeFileSync(join(publicRoot, "RELEASE_NOTES.md"), verified.releaseNotes, { mode: 0o644 });
  writeFileSync(join(publicRoot, "metadata", "release.json"), canonicalJSON(manifest), {
    mode: 0o644,
  });
  writeFileSync(join(publicRoot, "metadata", "capabilities.json"), verified.capabilities, {
    mode: 0o644,
  });
  writeFileSync(join(publicRoot, "metadata", "sbom.spdx.json"), verified.sbom, { mode: 0o644 });
  writeFileSync(
    join(publicRoot, "metadata", "THIRD_PARTY_NOTICES.md"),
    verified.thirdPartyNotices,
    { mode: 0o644 },
  );
  const checksumPaths = [
    "RELEASE_NOTES.md",
    ...verified.metadata.artifacts.map(({ path }) => path),
    "metadata/THIRD_PARTY_NOTICES.md",
    "metadata/capabilities.json",
    "metadata/release.json",
    "metadata/sbom.spdx.json",
  ].sort();
  const checksumDocument = checksumPaths
    .map((path) => `${sha256File(join(publicRoot, ...path.split("/")))}  ${path}\n`)
    .join("");
  writeFileSync(join(publicRoot, "SHA256SUMS"), checksumDocument, { mode: 0o644 });
};

/** installStagedRelease replaces only importer-owned paths and rolls them back on failure. */
const installStagedRelease = (
  repositoryRoot: string,
  stagedRepository: string,
  stagingRoot: string,
): void => {
  const names = ["package.json", "packages", "public-release", "release-manifest.json"];
  if (existsSync(join(stagedRepository, "package-lock.json")))
    names.splice(1, 0, "package-lock.json");
  const backupRoot = join(stagingRoot, "backup");
  mkdirSync(backupRoot, { mode: 0o755 });
  const backedUp: string[] = [];
  const installed: string[] = [];
  try {
    for (const name of names) {
      const destination = join(repositoryRoot, name);
      if (existsSync(destination)) {
        renameSync(destination, join(backupRoot, name));
        backedUp.push(name);
      }
      renameSync(join(stagedRepository, name), destination);
      installed.push(name);
    }
  } catch (error) {
    for (const name of installed.reverse())
      rmSync(join(repositoryRoot, name), { force: true, recursive: true });
    for (const name of backedUp.reverse())
      renameSync(join(backupRoot, name), join(repositoryRoot, name));
    throw new Error(
      `Install staged public release: ${error instanceof Error ? error.message : error}`,
    );
  }
};

/** parseArguments accepts only the required named source argument. */
const parseArguments = (argumentsToParse: string[]): { source: string } => {
  if (argumentsToParse.length !== 2 || argumentsToParse[0] !== "--source") {
    throw new Error("Usage: node scripts/import-release.ts --source <dist/free/vX.Y.Z>");
  }
  return { source: resolve(argumentsToParse[1]) };
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  try {
    const manifest = importRelease(parseArguments(process.argv.slice(2)));
    console.log(`Imported Pannonico Free ${manifest.version} from ${manifest.sourceCommit}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export default importRelease;
