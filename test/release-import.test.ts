import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { importRelease, installStagedRelease } from "../scripts/import-release.ts";
import { canonicalJSON } from "../scripts/package-files.ts";
import { goCanonicalJSON } from "../scripts/release-contract.ts";
import { archiveName, RELEASE_TARGETS } from "../scripts/release-targets.ts";
import { validateRelease } from "../scripts/validate-release.ts";
import { createReleaseFixture, rewriteSourceChecksums } from "./release-fixture.ts";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Expect a tagged Free handoff to produce sanitized byte-identical public artifacts", () => {
  const fixture = createReleaseFixture(REPOSITORY_ROOT);
  try {
    const manifest = importRelease({
      repositoryRoot: fixture.repositoryRoot,
      source: fixture.sourceRoot,
    });
    assert.deepEqual(
      validateRelease({ repositoryRoot: fixture.repositoryRoot, version: fixture.version }),
      manifest,
    );
    const notes = readFileSync(
      join(fixture.repositoryRoot, "public-release", "RELEASE_NOTES.md"),
      "utf8",
    );
    assert.match(notes, /### Public changes/);
    assert.doesNotMatch(notes, /Pro changes|Internal changes|Private/);
    for (const target of RELEASE_TARGETS) {
      const name = archiveName(target, fixture.version);
      assert.deepEqual(
        readFileSync(join(fixture.repositoryRoot, "public-release", "assets", name)),
        readFileSync(join(fixture.sourceRoot, "assets", name)),
      );
    }
    const generated = readFileSync(join(fixture.repositoryRoot, "release-manifest.json"));
    assert.equal(generated.includes(Buffer.from(fixture.privateRoot)), false);
  } finally {
    fixture.remove();
  }
});

test("Expect invalid source identities, schemas, paths, and archives to fail before mutation", () => {
  const mutators: Array<(fixture: ReturnType<typeof createReleaseFixture>) => void> = [
    (fixture) =>
      writeFileSync(
        join(fixture.sourceRoot, "assets", archiveName(RELEASE_TARGETS[0], fixture.version)),
        "tampered",
      ),
    (fixture) =>
      rewriteMetadata(fixture.sourceRoot, (metadata) => ({ ...metadata, edition: "pro" })),
    (fixture) =>
      rewriteMetadata(fixture.sourceRoot, (metadata) => ({ ...metadata, sourceTag: "" })),
    (fixture) => {
      const archive = join(
        fixture.sourceRoot,
        "assets",
        archiveName(RELEASE_TARGETS[0], fixture.version),
      );
      rmSync(archive);
      const target = join(fixture.sourceRoot, "unpacked", "linux-x64", "pannonico");
      symlinkSync(target, archive);
      assert.equal(readlinkSync(archive), target);
    },
    (fixture) => {
      const unpacked = join(fixture.sourceRoot, "unpacked", "linux-x64", "pannonico");
      writeFileSync(unpacked, "different archive payload");
      chmodSync(unpacked, 0o755);
    },
    (fixture) => {
      const sbomPath = join(fixture.sourceRoot, "metadata", "sbom.spdx.json");
      const sbom = JSON.parse(readFileSync(sbomPath, "utf8")) as Record<string, unknown>;
      sbom.privateNotes = ["must not cross the public boundary"];
      writeFileSync(sbomPath, goCanonicalJSON(sbom));
      rewriteSourceChecksums(fixture.sourceRoot);
    },
    (fixture) => corruptZipPayload(fixture.sourceRoot, fixture.version),
  ];
  for (const mutate of mutators) {
    const fixture = createReleaseFixture(REPOSITORY_ROOT);
    try {
      const before = readFileSync(join(fixture.repositoryRoot, "package.json"));
      mutate(fixture);
      assert.throws(() =>
        importRelease({ repositoryRoot: fixture.repositoryRoot, source: fixture.sourceRoot }),
      );
      assert.deepEqual(readFileSync(join(fixture.repositoryRoot, "package.json")), before);
      assert.equal(
        readFileSync(
          join(fixture.repositoryRoot, "packages", "linux-x64", "package.json"),
          "utf8",
        ).includes(fixture.version),
        false,
      );
    } finally {
      fixture.remove();
    }
  }
});

test("Expect modified unpacked payloads to fail archive equality before staging", () => {
  const fixture = createReleaseFixture(REPOSITORY_ROOT);
  try {
    const payload = join(fixture.sourceRoot, "unpacked", "linux-x64", "pannonico");
    writeFileSync(payload, fixture.privateRoot);
    chmodSync(payload, 0o755);
    assert.throws(
      () => importRelease({ repositoryRoot: fixture.repositoryRoot, source: fixture.sourceRoot }),
      /differs from the unpacked acceptance copy/,
    );
  } finally {
    fixture.remove();
  }
});

test("Expect a symlinked public repository boundary to be rejected", () => {
  const fixture = createReleaseFixture(REPOSITORY_ROOT);
  try {
    const repositoryLink = join(fixture.directory, "repository-link");
    symlinkSync(fixture.repositoryRoot, repositoryLink, "dir");
    assert.throws(
      () => importRelease({ repositoryRoot: repositoryLink, source: fixture.sourceRoot }),
      /repository root is not a real directory/,
    );
  } finally {
    fixture.remove();
  }
});

test("Expect an incomplete install rollback to retain its recovery copy outside staging", () => {
  const root = mkdtempSync(join(REPOSITORY_ROOT, ".pannonico-rollback-test-"));
  const repository = join(root, "repository");
  const stagingRoot = join(root, "staging");
  const stagedRepository = join(stagingRoot, "repository");
  const backupRoot = `${stagingRoot}-backup`;
  try {
    for (const directory of [repository, stagedRepository])
      mkdirSync(directory, { recursive: true });
    for (const directory of ["packages", "public-release"]) {
      mkdirSync(join(repository, directory));
      mkdirSync(join(stagedRepository, directory));
    }
    for (const name of ["package.json", "release-manifest.json"]) {
      writeFileSync(join(repository, name), `old ${name}\n`);
      writeFileSync(join(stagedRepository, name), `new ${name}\n`);
    }
    assert.throws(
      () =>
        installStagedRelease(repository, stagedRepository, stagingRoot, {
          exists: existsSync,
          remove: rmSync,
          rename: (source, destination) => {
            if (source === join(stagedRepository, "packages")) throw new Error("install failed");
            if (source === join(backupRoot, "package.json")) throw new Error("restore failed");
            renameSync(source, destination);
          },
        }),
      /rollback was incomplete; recovery files remain/,
    );
    assert.equal(readFileSync(join(backupRoot, "package.json"), "utf8"), "old package.json\n");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("Expect public validation to reject payload and public-note tampering", () => {
  const fixture = createReleaseFixture(REPOSITORY_ROOT);
  try {
    importRelease({ repositoryRoot: fixture.repositoryRoot, source: fixture.sourceRoot });
    const payload = join(fixture.repositoryRoot, "packages", "linux-x64", "bin", "pannonico");
    writeFileSync(payload, "tampered");
    assert.throws(
      () => validateRelease({ repositoryRoot: fixture.repositoryRoot, version: fixture.version }),
      /Package payload mismatch/,
    );
    importRelease({ repositoryRoot: fixture.repositoryRoot, source: fixture.sourceRoot });
    const capabilityPath = join(
      fixture.repositoryRoot,
      "public-release",
      "metadata",
      "capabilities.json",
    );
    const capabilities = JSON.parse(readFileSync(capabilityPath, "utf8")) as Record<
      string,
      unknown
    >;
    capabilities.edition = "pro";
    writeFileSync(capabilityPath, canonicalJSON(capabilities));
    rewritePublicChecksum(fixture.repositoryRoot, "metadata/capabilities.json");
    assert.throws(
      () => validateRelease({ repositoryRoot: fixture.repositoryRoot, version: fixture.version }),
      /Public capability metadata is invalid/,
    );
    importRelease({ repositoryRoot: fixture.repositoryRoot, source: fixture.sourceRoot });
    writeFileSync(
      join(fixture.repositoryRoot, "public-release", "RELEASE_NOTES.md"),
      `## ${fixture.version}\n\n### Public changes\n\n- Public.\n\n### Internal changes\n\n- Secret.\n`,
    );
    rewritePublicChecksum(fixture.repositoryRoot, "RELEASE_NOTES.md");
    assert.throws(
      () => validateRelease({ repositoryRoot: fixture.repositoryRoot, version: fixture.version }),
      /checksum inventory|not sanitized/,
    );
  } finally {
    fixture.remove();
  }
});

test("Expect imported target package trees to contain only declared payload and public metadata", () => {
  const fixture = createReleaseFixture(REPOSITORY_ROOT);
  try {
    importRelease({ repositoryRoot: fixture.repositoryRoot, source: fixture.sourceRoot });
    for (const target of RELEASE_TARGETS) {
      const packageRoot = join(fixture.repositoryRoot, "packages", target.packageDirectory);
      assert.deepEqual(
        listFiles(packageRoot),
        [
          "COMMERCIAL-LICENSE.md",
          "LICENSE",
          "NOTICE",
          "README.md",
          "SHA256SUMS",
          "package.json",
          target.target === "wasi" ? "pannonico.wasm" : `bin/${target.binaryName}`,
        ].sort(),
      );
    }
  } finally {
    fixture.remove();
  }
});

/** listFiles returns the exact slash-normalized regular-file tree below one package. */
const listFiles = (root: string): string[] => {
  const files: string[] = [];
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(directory, entry.name), relativePath);
      else files.push(relativePath);
    }
  };
  visit(root);
  return files.sort();
};

/** rewriteMetadata applies one malformed-envelope edit while preserving canonical JSON. */
const rewriteMetadata = (
  sourceRoot: string,
  mutate: (metadata: Record<string, unknown>) => Record<string, unknown>,
): void => {
  const path = join(sourceRoot, "metadata", "release.json");
  const metadata = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, goCanonicalJSON(mutate(metadata)));
  rewriteSourceChecksums(sourceRoot);
};

/** corruptZipPayload changes checksum-bound ZIP bytes while preserving source metadata consistency. */
const corruptZipPayload = (sourceRoot: string, version: string): void => {
  const target = RELEASE_TARGETS.find(({ target: identity }) => identity === "windows-x64");
  if (!target) throw new Error("Windows fixture target is missing");
  const archivePath = join(sourceRoot, "assets", archiveName(target, version));
  const archive = readFileSync(archivePath);
  const payloadOffset = 30 + archive.readUInt16LE(26) + archive.readUInt16LE(28);
  archive[payloadOffset] ^= 0xff;
  writeFileSync(archivePath, archive);
  const metadataPath = join(sourceRoot, "metadata", "release.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
    artifacts: Array<{ path: string; sha256: string; size: number }>;
  };
  const artifact = metadata.artifacts.find(({ path }) =>
    path.endsWith(archiveName(target, version)),
  );
  if (!artifact) throw new Error("Windows fixture artifact metadata is missing");
  artifact.sha256 = digest(archive);
  artifact.size = archive.length;
  writeFileSync(metadataPath, goCanonicalJSON(metadata));
  rewriteSourceChecksums(sourceRoot);
};

/** rewritePublicChecksum keeps a tampered public file checksum-bound for validator regression tests. */
const rewritePublicChecksum = (repositoryRoot: string, relativePath: string): void => {
  const publicRoot = join(repositoryRoot, "public-release");
  const checksumPath = join(publicRoot, "SHA256SUMS");
  const lines = readFileSync(checksumPath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) =>
      line.endsWith(`  ${relativePath}`)
        ? `${digest(readFileSync(join(publicRoot, ...relativePath.split("/"))))}  ${relativePath}`
        : line,
    );
  writeFileSync(checksumPath, `${lines.join("\n")}\n`);
};

/** digest returns a lowercase SHA-256 digest for tamper fixtures. */
const digest = (contents: Buffer): string => createHash("sha256").update(contents).digest("hex");
