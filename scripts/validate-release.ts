import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJSON, packageManifest, packageReadme } from "./package-files.ts";
import { readRegularFile, sha256File, validateVersion } from "./release-contract.ts";
import { archiveName, packagePayloadPath, RELEASE_TARGETS } from "./release-targets.ts";

import type { PublicReleaseManifest, PublicTargetManifest } from "./import-release.ts";

export type ValidateReleaseOptions = {
  repositoryRoot?: string;
  version: string;
};

const CURRENT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(CURRENT_FILE), "..");
const LEGAL_FILES = ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md"] as const;

/** validateRelease independently validates all generated public release and package files. */
export const validateRelease = ({
  repositoryRoot = REPOSITORY_ROOT,
  version,
}: ValidateReleaseOptions): PublicReleaseManifest => {
  validateVersion(version);
  const root = resolve(repositoryRoot);
  const manifestBytes = readRegularFile(join(root, "release-manifest.json"), "public manifest");
  const manifest = parseManifest(manifestBytes.toString("utf8"), version);
  verifyGeneratedTree(root, version);
  verifyRootVersion(root, version);
  verifyPackages(root, manifest);
  verifyPublicRelease(root, manifest, manifestBytes);
  verifyPublicSanitization(root);
  return manifest;
};

/** parseManifest checks the exact public schema, provenance, and ordered target matrix. */
const parseManifest = (contents: string, version: string): PublicReleaseManifest => {
  const value = JSON.parse(contents) as Record<string, unknown>;
  if (canonicalJSON(value) !== contents)
    throw new Error("Public release manifest is not canonical JSON");
  const keys = [
    "buildEpoch",
    "goVersion",
    "nativeManifestHash",
    "notarized",
    "resolvedCapabilities",
    "schemaVersion",
    "signatureType",
    "signed",
    "sourceCommit",
    "sourceTag",
    "targets",
    "version",
    "wasiManifestHash",
  ];
  if (Object.keys(value).join("\n") !== keys.join("\n"))
    throw new Error("Public manifest fields do not match schema v1");
  if (
    value.schemaVersion !== 1 ||
    value.version !== version ||
    value.sourceTag !== `v${version}` ||
    typeof value.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.sourceCommit) ||
    value.signed !== false ||
    value.signatureType !== null ||
    value.notarized !== false ||
    !Number.isSafeInteger(value.buildEpoch) ||
    typeof value.goVersion !== "string" ||
    typeof value.nativeManifestHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.nativeManifestHash) ||
    typeof value.wasiManifestHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.wasiManifestHash) ||
    !Array.isArray(value.resolvedCapabilities) ||
    value.resolvedCapabilities.some((capability) => typeof capability !== "string") ||
    new Set(value.resolvedCapabilities).size !== value.resolvedCapabilities.length ||
    !Array.isArray(value.targets)
  ) {
    throw new Error("Public manifest provenance is invalid");
  }
  if (value.targets.length !== RELEASE_TARGETS.length)
    throw new Error("Public manifest target matrix is incomplete");
  const targets = value.targets.map((entry, index) => parseManifestTarget(entry, index, version));
  return { ...(value as Omit<PublicReleaseManifest, "targets">), targets };
};

/** parseManifestTarget validates one public archive-to-package mapping. */
const parseManifestTarget = (
  value: unknown,
  index: number,
  version: string,
): PublicTargetManifest => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Public target ${index} is invalid`);
  const entry = value as Record<string, unknown>;
  const keys = [
    "archive",
    "archiveSHA256",
    "archiveSize",
    "executable",
    "executableSHA256",
    "executableSize",
    "package",
    "target",
  ];
  const target = RELEASE_TARGETS[index];
  const expectedArchive = `public-release/assets/${archiveName(target, version)}`;
  const expectedExecutable = `packages/${target.packageDirectory}/${packagePayloadPath(target)}`;
  if (
    Object.keys(entry).join("\n") !== keys.join("\n") ||
    entry.archive !== expectedArchive ||
    entry.executable !== expectedExecutable ||
    entry.package !== target.packageName ||
    entry.target !== target.target ||
    typeof entry.archiveSHA256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.archiveSHA256) ||
    typeof entry.executableSHA256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(entry.executableSHA256) ||
    !Number.isSafeInteger(entry.archiveSize) ||
    !Number.isSafeInteger(entry.executableSize)
  ) {
    throw new Error(`Public target ${index} does not match ${target.target}`);
  }
  return entry as PublicTargetManifest;
};

/** verifyGeneratedTree enforces exact public-release and package path allowlists. */
const verifyGeneratedTree = (root: string, version: string): void => {
  const expectedDirectories = new Set([
    "public-release",
    "public-release/assets",
    "public-release/metadata",
    "packages",
  ]);
  const expectedFiles = new Set([
    "public-release/RELEASE_NOTES.md",
    "public-release/SHA256SUMS",
    "public-release/metadata/release.json",
    "public-release/metadata/capabilities.json",
    "public-release/metadata/sbom.spdx.json",
    "public-release/metadata/THIRD_PARTY_NOTICES.md",
  ]);
  for (const target of RELEASE_TARGETS) {
    const packageRoot = `packages/${target.packageDirectory}`;
    expectedDirectories.add(packageRoot);
    if (target.target !== "wasi") expectedDirectories.add(`${packageRoot}/bin`);
    expectedFiles.add(`public-release/assets/${archiveName(target, version)}`);
    expectedFiles.add(`${packageRoot}/package.json`);
    expectedFiles.add(`${packageRoot}/README.md`);
    expectedFiles.add(`${packageRoot}/SHA256SUMS`);
    expectedFiles.add(`${packageRoot}/${packagePayloadPath(target)}`);
    for (const legal of LEGAL_FILES) expectedFiles.add(`${packageRoot}/${legal}`);
  }
  for (const generatedRoot of [join(root, "public-release"), join(root, "packages")]) {
    walkTree(generatedRoot, (path, information) => {
      const relativePath = relative(root, path).split(sep).join("/");
      if (information.isSymbolicLink())
        throw new Error(`Generated path ${relativePath} is a symlink`);
      if (information.isDirectory()) {
        if (!expectedDirectories.has(relativePath))
          throw new Error(`Unexpected generated directory ${relativePath}`);
        expectedDirectories.delete(relativePath);
      } else if (!information.isFile() || !expectedFiles.delete(relativePath)) {
        throw new Error(`Unexpected generated file ${relativePath}`);
      }
    });
  }
  if (expectedDirectories.size > 0 || expectedFiles.size > 0)
    throw new Error("Generated public tree is incomplete");
};

/** verifyRootVersion checks the private automation workspace version used for this import. */
const verifyRootVersion = (root: string, version: string): void => {
  const packageJson = JSON.parse(
    readRegularFile(join(root, "package.json"), "root package manifest").toString("utf8"),
  ) as {
    name: string;
    private: boolean;
    version: string;
  };
  if (
    packageJson.name !== "@vx.rs/pannonico-binaries" ||
    packageJson.private !== true ||
    packageJson.version !== version
  ) {
    throw new Error("Root package version does not match the imported release");
  }
};

/** verifyPackages checks exact manifests, payload hashes, modes, checksums, prose, and legal files. */
const verifyPackages = (root: string, manifest: PublicReleaseManifest): void => {
  RELEASE_TARGETS.forEach((target, index) => {
    const packageRoot = join(root, "packages", target.packageDirectory);
    const manifestTarget = manifest.targets[index];
    const expectedPackage = canonicalJSON(packageManifest(target, manifest.version));
    if (
      readRegularFile(join(packageRoot, "package.json"), "target package manifest").toString(
        "utf8",
      ) !== expectedPackage
    ) {
      throw new Error(`Package manifest mismatch for ${target.target}`);
    }
    if (
      readRegularFile(join(packageRoot, "README.md"), "target README").toString("utf8") !==
      packageReadme(target)
    ) {
      throw new Error(`Package README mismatch for ${target.target}`);
    }
    const payload = join(packageRoot, ...packagePayloadPath(target).split("/"));
    if (
      sha256File(payload) !== manifestTarget.executableSHA256 ||
      statSync(payload).size !== manifestTarget.executableSize
    ) {
      throw new Error(`Package payload mismatch for ${target.target}`);
    }
    if (target.platform !== "win32" && (statSync(payload).mode & 0o111) === 0) {
      throw new Error(`Package payload lacks an executable mode for ${target.target}`);
    }
    const checksum = `${manifestTarget.executableSHA256}  ${packagePayloadPath(target)}\n`;
    if (
      readRegularFile(join(packageRoot, "SHA256SUMS"), "package checksum").toString("utf8") !==
      checksum
    ) {
      throw new Error(`Package checksum mismatch for ${target.target}`);
    }
    for (const legal of LEGAL_FILES) {
      if (
        !readRegularFile(join(packageRoot, legal), "package legal file").equals(
          readRegularFile(join(root, legal), "root legal file"),
        )
      ) {
        throw new Error(`Package legal file ${legal} differs for ${target.target}`);
      }
    }
  });
};

/** verifyPublicRelease checks archives, sanitized metadata, public notes, and checksum coverage. */
const verifyPublicRelease = (
  root: string,
  manifest: PublicReleaseManifest,
  manifestBytes: Buffer,
): void => {
  const publicRoot = join(root, "public-release");
  const metadataManifest = readRegularFile(
    join(publicRoot, "metadata", "release.json"),
    "public release metadata",
  );
  if (!metadataManifest.equals(manifestBytes))
    throw new Error("Public release metadata differs from the root manifest");
  const expectedChecksums = new Map<string, string>();
  for (const target of manifest.targets) {
    const relativeArchive = target.archive.replace(/^public-release\//, "");
    const archivePath = join(root, ...target.archive.split("/"));
    if (
      sha256File(archivePath) !== target.archiveSHA256 ||
      statSync(archivePath).size !== target.archiveSize
    ) {
      throw new Error(`Public archive mismatch for ${target.target}`);
    }
    expectedChecksums.set(relativeArchive, target.archiveSHA256);
  }
  for (const path of [
    "RELEASE_NOTES.md",
    "metadata/THIRD_PARTY_NOTICES.md",
    "metadata/capabilities.json",
    "metadata/release.json",
    "metadata/sbom.spdx.json",
  ]) {
    expectedChecksums.set(path, sha256File(join(publicRoot, ...path.split("/"))));
  }
  const expectedDocument = [...expectedChecksums]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, digest]) => `${digest}  ${path}\n`)
    .join("");
  if (
    readRegularFile(join(publicRoot, "SHA256SUMS"), "public checksum inventory").toString(
      "utf8",
    ) !== expectedDocument
  ) {
    throw new Error("Public checksum inventory is invalid");
  }
  const notes = readRegularFile(
    join(publicRoot, "RELEASE_NOTES.md"),
    "public release notes",
  ).toString("utf8");
  if (
    !notes.startsWith(`## ${manifest.version}\n\n### Public changes\n\n`) ||
    /### (?:Pro|Internal) changes/.test(notes)
  ) {
    throw new Error("Public release notes are not sanitized");
  }
  verifyPublicMetadata(publicRoot, manifest);
};

/** verifyPublicMetadata rechecks sanitized capability, SBOM, and notice envelopes independently. */
const verifyPublicMetadata = (publicRoot: string, manifest: PublicReleaseManifest): void => {
  const capabilityText = readRegularFile(
    join(publicRoot, "metadata", "capabilities.json"),
    "public capabilities",
  ).toString("utf8");
  const capabilityDocument = JSON.parse(capabilityText) as Record<string, unknown>;
  if (
    canonicalJSON(capabilityDocument) !== capabilityText ||
    Object.keys(capabilityDocument).join("\n") !== "schemaVersion\nedition\ntargets" ||
    capabilityDocument.schemaVersion !== 1 ||
    capabilityDocument.edition !== "free" ||
    !Array.isArray(capabilityDocument.targets) ||
    capabilityDocument.targets.length !== RELEASE_TARGETS.length
  ) {
    throw new Error("Public capability metadata is invalid");
  }
  capabilityDocument.targets.forEach((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Public capability target ${index} is invalid`);
    }
    const target = value as Record<string, unknown>;
    const expected = RELEASE_TARGETS[index];
    const expectedHash =
      expected.target === "wasi" ? manifest.wasiManifestHash : manifest.nativeManifestHash;
    if (
      Object.keys(target).join("\n") !== "target\nmanifestHash\ncapabilities\nexcluded" ||
      target.target !== expected.target ||
      target.manifestHash !== expectedHash ||
      !Array.isArray(target.capabilities) ||
      !Array.isArray(target.excluded)
    ) {
      throw new Error(`Public capability target ${expected.target} is invalid`);
    }
  });
  const sbomText = readRegularFile(
    join(publicRoot, "metadata", "sbom.spdx.json"),
    "public SBOM",
  ).toString("utf8");
  const sbom = JSON.parse(sbomText) as Record<string, unknown>;
  if (
    canonicalJSON(sbom) !== sbomText ||
    Object.keys(sbom).join("\n") !==
      "spdxVersion\ndataLicense\nSPDXID\nname\ndocumentNamespace\ncreationInfo\npackages\nrelationships" ||
    sbom.spdxVersion !== "SPDX-2.3" ||
    sbom.name !== `pannonico-free-${manifest.version}` ||
    typeof sbom.documentNamespace !== "string" ||
    !sbom.documentNamespace.endsWith(`/${manifest.sourceCommit}`)
  ) {
    throw new Error("Public SBOM metadata is invalid");
  }
  const notices = readRegularFile(
    join(publicRoot, "metadata", "THIRD_PARTY_NOTICES.md"),
    "public third-party notices",
  ).toString("utf8");
  if (
    !notices.startsWith(
      "# Third-party notices\n\nPannonico includes or was built from the following approved Go modules.\n\n",
    ) ||
    !notices.endsWith("\n")
  ) {
    throw new Error("Public third-party notices are invalid");
  }
};

/** verifyPublicSanitization rejects private source names and common absolute checkout paths. */
const verifyPublicSanitization = (root: string): void => {
  const forbiddenText = [
    /### Pro changes/,
    /### Internal changes/,
    /(?:^|\s)\/home\//,
    /(?:^|\s)\/Users\//,
    /[A-Za-z]:\\Users\\/,
  ];
  for (const generatedRoot of [
    join(root, "release-manifest.json"),
    join(root, "public-release"),
    join(root, "packages"),
  ]) {
    walkTree(generatedRoot, (path, information) => {
      if (!information.isFile()) return;
      const text = readFileSync(path).toString("latin1");
      if (forbiddenText.some((pattern) => pattern.test(text))) {
        throw new Error(`Generated public file ${relative(root, path)} contains private-only text`);
      }
    });
  }
};

/** walkTree visits one generated path hierarchy without following symlinks. */
const walkTree = (
  root: string,
  visit: (path: string, information: ReturnType<typeof lstatSync>) => void,
): void => {
  const visitPath = (path: string): void => {
    const information = lstatSync(path);
    visit(path, information);
    if (information.isDirectory() && !information.isSymbolicLink()) {
      for (const entry of readdirSync(path).sort()) visitPath(join(path, entry));
    }
  };
  visitPath(root);
};

if (process.argv[1] && resolve(process.argv[1]) === CURRENT_FILE) {
  try {
    const version = process.argv[2] ?? "";
    if (process.argv.length !== 3)
      throw new Error("Usage: node scripts/validate-release.ts <version>");
    const manifest = validateRelease({ version });
    console.log(`Validated Pannonico public release ${manifest.version}`);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export default validateRelease;
