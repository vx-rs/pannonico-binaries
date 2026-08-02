import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { goCanonicalJSON } from "../scripts/release-contract.ts";
import { archiveName, RELEASE_TARGETS } from "../scripts/release-targets.ts";

export type ReleaseFixture = {
  directory: string;
  privateRoot: string;
  repositoryRoot: string;
  sourceRoot: string;
  version: string;
  remove: () => void;
};

/** createReleaseFixture creates an exact synthetic Phase 14 Free distribution and public scaffold. */
export const createReleaseFixture = (templateRoot: string): ReleaseFixture => {
  const directory = mkdtempSync(join(os.tmpdir(), "pannonico-public-release-"));
  const repositoryRoot = join(directory, "repository");
  const privateRoot = join(directory, "private", "pannonico-go");
  const version = "1.2.3-rc.1";
  const sourceRoot = join(privateRoot, "dist", "free", `v${version}`);
  mkdirSync(repositoryRoot, { recursive: true });
  for (const fileName of ["package.json", "LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md"]) {
    copyFileSync(join(templateRoot, fileName), join(repositoryRoot, fileName));
  }
  if (existsSync(join(templateRoot, "package-lock.json"))) {
    copyFileSync(
      join(templateRoot, "package-lock.json"),
      join(repositoryRoot, "package-lock.json"),
    );
  }
  cpSync(join(templateRoot, "packages"), join(repositoryRoot, "packages"), { recursive: true });
  createSourceRelease(sourceRoot, version);
  return {
    directory,
    privateRoot,
    repositoryRoot,
    sourceRoot,
    version,
    remove: () => rmSync(directory, { force: true, recursive: true }),
  };
};

/** rewriteSourceChecksums refreshes the fixture checksum inventory after an intentional test edit. */
export const rewriteSourceChecksums = (sourceRoot: string): void => {
  const paths = [
    "RELEASE_NOTES.md",
    ...RELEASE_TARGETS.map((target) => `assets/${findArchive(sourceRoot, target.target)}`),
    "metadata/THIRD_PARTY_NOTICES.md",
    "metadata/build-info.json",
    "metadata/capabilities.json",
    "metadata/release.json",
    "metadata/sbom.spdx.json",
  ].sort();
  const contents = paths
    .map((path) => `${digest(readFileSync(join(sourceRoot, ...path.split("/"))))}  ${path}\n`)
    .join("");
  writeFileSync(join(sourceRoot, "SHA256SUMS"), contents);
};

/** createSourceRelease writes the exact directories, archives, metadata, and checksums under test. */
const createSourceRelease = (sourceRoot: string, version: string): void => {
  mkdirSync(join(sourceRoot, "assets"), { recursive: true });
  mkdirSync(join(sourceRoot, "metadata"), { recursive: true });
  mkdirSync(join(sourceRoot, "npm"), { recursive: true });
  const nativeHash = "a".repeat(64);
  const wasiHash = "b".repeat(64);
  const artifacts = RELEASE_TARGETS.map((target) => {
    const payload = Buffer.from(`fixture executable for ${target.target}\n`);
    const unpackedPath = join(sourceRoot, "unpacked", target.target, target.binaryName);
    mkdirSync(dirname(unpackedPath), { recursive: true });
    writeFileSync(unpackedPath, payload, { mode: 0o755 });
    chmodSync(unpackedPath, 0o755);
    const archive =
      target.archiveKind === "tar.gz"
        ? createTarGzip(target.binaryName, payload)
        : createZip(target.binaryName, payload);
    const name = archiveName(target, version);
    const archivePath = join(sourceRoot, "assets", name);
    writeFileSync(archivePath, archive, { mode: 0o644 });
    return {
      target: target.target,
      path: `assets/${name}`,
      sha256: digest(archive),
      size: archive.length,
    };
  });
  const metadata = {
    schemaVersion: 1,
    version,
    edition: "free",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    sourceTag: `v${version}`,
    buildEpoch: 1_785_630_600,
    goVersion: "go1.26.5",
    nativeManifestHash: nativeHash,
    wasiManifestHash: wasiHash,
    resolvedCapabilities: ["core"],
    artifacts,
    signed: false,
    signatureType: null,
    notarized: false,
  };
  writeFileSync(join(sourceRoot, "metadata", "release.json"), goCanonicalJSON(metadata));
  const descriptor = {
    name: "core",
    version: 1,
    nativeOnly: false,
    dependencies: [],
    conflicts: [],
    commands: ["build"],
  };
  writeFileSync(
    join(sourceRoot, "metadata", "capabilities.json"),
    goCanonicalJSON({
      schemaVersion: 1,
      edition: "free",
      targets: RELEASE_TARGETS.map((target) => ({
        target: target.target,
        manifestHash: target.target === "wasi" ? wasiHash : nativeHash,
        capabilities: [descriptor],
        excluded: [],
      })),
    }),
  );
  writeFileSync(
    join(sourceRoot, "metadata", "build-info.json"),
    goCanonicalJSON({
      schemaVersion: 1,
      goVersion: "go1.26.5",
      cgoEnabled: "0",
      buildFlags: [
        "-mod=vendor",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags=-X main.version=<version>",
      ],
      moduleVendorVerified: true,
      sourceTreeClean: true,
      releaseBuilderVersion: "1",
      targets: RELEASE_TARGETS.map((target) => ({
        name: target.target,
        goos:
          target.target === "wasi"
            ? "wasip1"
            : target.target.split("-")[0].replace("windows", "windows"),
        goarch:
          target.target === "wasi" ? "wasm" : target.architecture === "x64" ? "amd64" : "arm64",
        binaryName: target.binaryName,
        archiveName: archiveName(target, version),
        archiveKind: target.archiveKind,
      })),
    }),
  );
  writeFileSync(
    join(sourceRoot, "metadata", "sbom.spdx.json"),
    goCanonicalJSON({
      spdxVersion: "SPDX-2.3",
      dataLicense: "CC0-1.0",
      SPDXID: "SPDXRef-DOCUMENT",
      name: `pannonico-free-${version}`,
      documentNamespace: `https://vx.rs/spdx/pannonico/free/${version}/${metadata.sourceCommit}`,
      creationInfo: {
        created: "2026-08-02T12:30:00Z",
        creators: ["Tool: pannonico-release-builder-1"],
      },
      packages: [],
      relationships: [],
    }),
  );
  writeFileSync(
    join(sourceRoot, "metadata", "THIRD_PARTY_NOTICES.md"),
    "# Third-party notices\n\nPannonico includes or was built from the following approved Go modules.\n\n- `example.test/module` `v1.0.0` - MIT\n",
  );
  writeFileSync(
    join(sourceRoot, "RELEASE_NOTES.md"),
    `## ${version}\n\n### Public changes\n\n- Added the public handoff.\n\n### Pro changes\n\n- Private Pro detail.\n\n### Internal changes\n\n- Private source detail.\n`,
  );
  rewriteSourceChecksums(sourceRoot);
};

/** findArchive returns the only fixture archive containing one target identity. */
const findArchive = (sourceRoot: string, target: string): string => {
  const name = readdirSync(join(sourceRoot, "assets")).find((entry) =>
    entry.includes(`-${target}.`),
  );
  if (!name) throw new Error(`Fixture archive missing for ${target}`);
  return name;
};

/** digest returns a lowercase SHA-256 digest for fixture bytes. */
const digest = (contents: Buffer): string => createHash("sha256").update(contents).digest("hex");

/** createTarGzip writes one normalized executable entry used by archive-contract tests. */
const createTarGzip = (name: string, payload: Buffer): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, 0o755);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, payload.length);
  writeTarOctal(header, 136, 12, 1_785_630_600);
  header.fill(0x20, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc(Math.ceil(payload.length / 512) * 512 - payload.length);
  return gzipSync(Buffer.concat([header, payload, padding, Buffer.alloc(1024)]), {
    level: 9,
    mtime: 0,
  });
};

/** writeTarOctal writes one NUL-terminated fixed-width tar integer. */
const writeTarOctal = (buffer: Buffer, offset: number, width: number, value: number): void => {
  const text = value.toString(8).padStart(width - 1, "0");
  buffer.write(text, offset, width - 1, "ascii");
  buffer[offset + width - 1] = 0;
};

/** createZip writes one stored Unix-mode executable used by archive-contract tests. */
const createZip = (name: string, payload: Buffer): Buffer => {
  const nameBytes = Buffer.from(name);
  const crc = crc32(payload);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + payload.length, 16);
  return Buffer.concat([local, payload, central, end]);
};

/** crc32 computes the ZIP payload checksum without a test-only dependency. */
const crc32 = (contents: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};
