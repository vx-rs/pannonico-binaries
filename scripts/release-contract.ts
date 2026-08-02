import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { canonicalJSON } from "./package-files.ts";
import { archiveName, RELEASE_TARGETS } from "./release-targets.ts";

import type { ReleaseTarget } from "./release-targets.ts";

export type SourceArtifact = {
  path: string;
  sha256: string;
  size: number;
  target: string;
};

export type SourceReleaseMetadata = {
  artifacts: SourceArtifact[];
  buildEpoch: number;
  edition: "free";
  goVersion: string;
  nativeManifestHash: string;
  notarized: false;
  resolvedCapabilities: string[];
  schemaVersion: 1;
  signatureType: null;
  signed: false;
  sourceCommit: string;
  sourceTag: string;
  version: string;
  wasiManifestHash: string;
};

export type VerifiedSourceRelease = {
  capabilities: string;
  metadata: SourceReleaseMetadata;
  payloads: Map<string, Buffer>;
  privateRoot: string;
  releaseNotes: string;
  sbom: string;
  sourceRoot: string;
  thirdPartyNotices: string;
};

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** validateVersion accepts the semantic-version subset shared with the Phase 14 builder. */
export const validateVersion = (version: string): string => {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid release version ${JSON.stringify(version)}`);
  }
  return version;
};

/** sha256File returns one regular file's lowercase SHA-256 digest. */
export const sha256File = (filePath: string): string =>
  createHash("sha256").update(readRegularFile(filePath, "digest input")).digest("hex");

/** goCanonicalJSON matches encoding/json indentation and default HTML-sensitive escaping. */
export const goCanonicalJSON = (value: unknown): string =>
  canonicalJSON(value).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0")}`,
  );

/** readRegularFile reads a non-symlink regular file and rejects every other filesystem type. */
export const readRegularFile = (filePath: string, label: string): Buffer => {
  const information = lstatSync(filePath);
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error(`${label} is not a regular non-symlink file: ${filePath}`);
  }
  return readFileSync(filePath);
};

/** sanitizeReleaseNotes selects exactly one Public changes subsection for the requested version. */
export const sanitizeReleaseNotes = (contents: string, version: string): string => {
  const lines = contents.replaceAll("\r\n", "\n").split("\n");
  const expectedHeading = version.endsWith("-dev") ? "## Unreleased" : `## ${version}`;
  if (lines[0] !== expectedHeading) {
    throw new Error(`Release notes do not begin with ${JSON.stringify(expectedHeading)}`);
  }
  const publicHeadings = lines
    .map((line, index) => ({ index, line }))
    .filter(({ line }) => line === "### Public changes");
  if (publicHeadings.length !== 1) {
    throw new Error(`Release notes contain ${publicHeadings.length} Public changes sections`);
  }
  const start = publicHeadings[0].index;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ") || lines[index].startsWith("### ")) {
      end = index;
      break;
    }
  }
  const publicLines = lines.slice(start + 1, end);
  while (publicLines[0]?.trim() === "") publicLines.shift();
  while (publicLines.at(-1)?.trim() === "") publicLines.pop();
  if (publicLines.length === 0) {
    throw new Error("Public changes section is empty");
  }
  return `## ${version}\n\n### Public changes\n\n${publicLines.join("\n")}\n`;
};

/** validateSourceRelease establishes the complete private-to-public handoff boundary. */
export const validateSourceRelease = (source: string): VerifiedSourceRelease => {
  const sourceRoot = resolve(source);
  const metadataPath = join(sourceRoot, "metadata", "release.json");
  const metadata = parseSourceMetadata(parseCanonicalJSON(metadataPath, "release metadata"));
  validateSourceLocation(sourceRoot, metadata.version);
  verifySourceTree(sourceRoot, metadata.version);
  const checksums = parseChecksums(
    readRegularFile(join(sourceRoot, "SHA256SUMS"), "source checksum inventory").toString("utf8"),
  );
  verifySourceChecksums(sourceRoot, metadata, checksums);
  const payloads = verifyArchivePayloads(sourceRoot, metadata);

  const capabilitiesValue = parseCanonicalJSON(
    join(sourceRoot, "metadata", "capabilities.json"),
    "capability metadata",
  );
  validateCapabilities(capabilitiesValue, metadata);
  const buildInfo = parseCanonicalJSON(
    join(sourceRoot, "metadata", "build-info.json"),
    "build metadata",
  );
  validateBuildInfo(buildInfo, metadata);
  const sbomValue = parseCanonicalJSON(join(sourceRoot, "metadata", "sbom.spdx.json"), "SBOM");
  validateSBOM(sbomValue, metadata);
  const thirdPartyNotices = readRegularFile(
    join(sourceRoot, "metadata", "THIRD_PARTY_NOTICES.md"),
    "third-party notices",
  ).toString("utf8");
  validateThirdPartyNotices(thirdPartyNotices);
  const releaseNotes = sanitizeReleaseNotes(
    readRegularFile(join(sourceRoot, "RELEASE_NOTES.md"), "release notes").toString("utf8"),
    metadata.version,
  );

  return {
    capabilities: canonicalJSON(capabilitiesValue),
    metadata,
    payloads,
    privateRoot: dirname(dirname(dirname(sourceRoot))),
    releaseNotes,
    sbom: canonicalJSON(sbomValue),
    sourceRoot,
    thirdPartyNotices,
  };
};

/** verifyArchivePayloads extracts checksum-bound archives and matches their local acceptance copies. */
const verifyArchivePayloads = (
  sourceRoot: string,
  metadata: SourceReleaseMetadata,
): Map<string, Buffer> => {
  const payloads = new Map<string, Buffer>();
  RELEASE_TARGETS.forEach((target, index) => {
    const artifact = metadata.artifacts[index];
    const archive = readRegularFile(
      join(sourceRoot, ...artifact.path.split("/")),
      `${target.target} archive`,
    );
    const payload =
      target.archiveKind === "tar.gz"
        ? extractTarGzipPayload(archive, target)
        : extractZipPayload(archive, target);
    const unpacked = readRegularFile(
      join(sourceRoot, "unpacked", target.target, target.binaryName),
      `${target.target} unpacked payload`,
    );
    if (!payload.equals(unpacked)) {
      throw new Error(`${target.target} archive payload differs from the unpacked acceptance copy`);
    }
    payloads.set(target.target, payload);
  });
  return payloads;
};

/** extractTarGzipPayload returns the one executable from a normalized Phase 14 tar.gz archive. */
const extractTarGzipPayload = (archive: Buffer, target: ReleaseTarget): Buffer => {
  const tar = gunzipSync(archive);
  const payloads: Buffer[] = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readNullTerminated(header.subarray(0, 100));
    const recordedChecksum = parseTarOctal(header.subarray(148, 156), "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (recordedChecksum !== actualChecksum)
      throw new Error(`${target.target} tar header checksum is invalid`);
    const mode = parseTarOctal(header.subarray(100, 108), "mode");
    const size = parseTarOctal(header.subarray(124, 136), "size");
    const type = String.fromCharCode(header[156] || 48);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) throw new Error(`${target.target} tar entry exceeds the archive`);
    if (type === "0") {
      if (name !== target.binaryName || mode !== 0o755) {
        throw new Error(`${target.target} tar payload name or mode is invalid`);
      }
      payloads.push(Buffer.from(tar.subarray(contentStart, contentEnd)));
    } else if (type !== "x") {
      throw new Error(
        `${target.target} tar contains unsupported entry type ${JSON.stringify(type)}`,
      );
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (payloads.length !== 1)
    throw new Error(`${target.target} tar does not contain exactly one payload`);
  return payloads[0];
};

/** extractZipPayload returns the one executable from a normalized Phase 14 ZIP archive. */
const extractZipPayload = (archive: Buffer, target: ReleaseTarget): Buffer => {
  const endOffset = findZipEnd(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  if (entryCount !== 1 || archive.readUInt32LE(centralOffset) !== 0x02014b50) {
    throw new Error(`${target.target} ZIP does not contain exactly one central entry`);
  }
  const method = archive.readUInt16LE(centralOffset + 10);
  const expectedCRC = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const commentLength = archive.readUInt16LE(centralOffset + 32);
  const externalAttributes = archive.readUInt32LE(centralOffset + 38);
  const localOffset = archive.readUInt32LE(centralOffset + 42);
  const name = archive
    .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
    .toString("utf8");
  const centralEnd = centralOffset + 46 + nameLength + extraLength + commentLength;
  if (
    name !== target.binaryName ||
    ((externalAttributes >>> 16) & 0o777) !== 0o755 ||
    centralEnd !== endOffset ||
    centralEnd - centralOffset !== centralSize
  ) {
    throw new Error(`${target.target} ZIP payload name, mode, or central directory is invalid`);
  }
  if (archive.readUInt32LE(localOffset) !== 0x04034b50)
    throw new Error(`${target.target} ZIP local header is invalid`);
  const flags = archive.readUInt16LE(localOffset + 6);
  const localMethod = archive.readUInt16LE(localOffset + 8);
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const localName = archive
    .subarray(localOffset + 30, localOffset + 30 + localNameLength)
    .toString("utf8");
  if ((flags & 1) !== 0 || localMethod !== method || localName !== name) {
    throw new Error(`${target.target} ZIP local entry metadata is invalid`);
  }
  const compressedStart = localOffset + 30 + localNameLength + localExtraLength;
  if (compressedStart + compressedSize > centralOffset) {
    throw new Error(`${target.target} ZIP compressed payload overlaps the central directory`);
  }
  const compressed = archive.subarray(compressedStart, compressedStart + compressedSize);
  const payload =
    method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : undefined;
  if (!payload || payload.length !== uncompressedSize)
    throw new Error(`${target.target} ZIP compression is invalid`);
  if (crc32(payload) !== expectedCRC)
    throw new Error(`${target.target} ZIP payload CRC is invalid`);
  return payload;
};

/** findZipEnd locates the non-spanned end record of one normalized ZIP archive. */
const findZipEnd = (archive: Buffer): number => {
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      if (
        archive.readUInt16LE(offset + 4) !== 0 ||
        archive.readUInt16LE(offset + 6) !== 0 ||
        archive.readUInt16LE(offset + 20) !== archive.length - offset - 22
      ) {
        throw new Error("ZIP end record uses unsupported spanning or trailing data");
      }
      return offset;
    }
  }
  throw new Error("ZIP end record is missing");
};

/** readNullTerminated decodes one fixed-width tar text field. */
const readNullTerminated = (value: Buffer): string =>
  value.subarray(0, value.indexOf(0) < 0 ? value.length : value.indexOf(0)).toString("utf8");

/** parseTarOctal decodes one normalized tar numeric field. */
const parseTarOctal = (value: Buffer, label: string): number => {
  const text = readNullTerminated(value).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error(`Tar ${label} is not octal`);
  return Number.parseInt(text, 8);
};

/** crc32 computes the checksum recorded by a ZIP central directory entry. */
const crc32 = (contents: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** assertNoPrivateMarkers rejects staged output containing its private checkout or source path. */
export const assertNoPrivateMarkers = (root: string, markers: readonly string[]): void => {
  walkFiles(root, (filePath) => {
    const contents = readRegularFile(filePath, "public output");
    for (const marker of markers.filter(Boolean)) {
      if (contents.includes(Buffer.from(marker))) {
        throw new Error(`Public output ${relative(root, filePath)} contains a private path marker`);
      }
    }
  });
};

/** parseCanonicalJSON reads one canonical schema document without accepting duplicate formatting. */
const parseCanonicalJSON = (filePath: string, label: string): unknown => {
  const contents = readRegularFile(filePath, label).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (goCanonicalJSON(value) !== contents) {
    throw new Error(`${label} is not canonical indented JSON`);
  }
  return value;
};

/** parseSourceMetadata validates the strict schema-v1 source release envelope. */
const parseSourceMetadata = (value: unknown): SourceReleaseMetadata => {
  const metadata = expectObject(value, "release metadata");
  expectKeys(metadata, "release metadata", [
    "schemaVersion",
    "version",
    "edition",
    "sourceCommit",
    "sourceTag",
    "buildEpoch",
    "goVersion",
    "nativeManifestHash",
    "wasiManifestHash",
    "resolvedCapabilities",
    "artifacts",
    "signed",
    "signatureType",
    "notarized",
  ]);
  const version = expectString(metadata.version, "version");
  validateVersion(version);
  if (
    metadata.schemaVersion !== 1 ||
    metadata.edition !== "free" ||
    metadata.sourceTag !== `v${version}` ||
    metadata.signed !== false ||
    metadata.signatureType !== null ||
    metadata.notarized !== false
  ) {
    throw new Error("Source release is not a matching tagged unsigned Free schema-v1 release");
  }
  const sourceCommit = expectString(metadata.sourceCommit, "source commit");
  const nativeManifestHash = expectString(metadata.nativeManifestHash, "native manifest hash");
  const wasiManifestHash = expectString(metadata.wasiManifestHash, "WASI manifest hash");
  if (
    !/^[0-9a-f]{40}$/.test(sourceCommit) ||
    !HASH_PATTERN.test(nativeManifestHash) ||
    !HASH_PATTERN.test(wasiManifestHash)
  ) {
    throw new Error("Source release contains an invalid commit or manifest hash");
  }
  if (!Number.isSafeInteger(metadata.buildEpoch)) {
    throw new Error("Source release build epoch is not a safe integer");
  }
  const resolvedCapabilities = expectStringArray(metadata.resolvedCapabilities, "capabilities");
  const artifactsValue = expectArray(metadata.artifacts, "artifacts");
  if (artifactsValue.length !== RELEASE_TARGETS.length) {
    throw new Error("Source release does not contain the fixed seven-target artifact matrix");
  }
  const artifacts = artifactsValue.map((entry, index) => parseArtifact(entry, index, version));
  return {
    artifacts,
    buildEpoch: metadata.buildEpoch,
    edition: "free",
    goVersion: expectString(metadata.goVersion, "Go version"),
    nativeManifestHash,
    notarized: false,
    resolvedCapabilities,
    schemaVersion: 1,
    signatureType: null,
    signed: false,
    sourceCommit,
    sourceTag: `v${version}`,
    version,
    wasiManifestHash,
  };
};

/** parseArtifact validates one ordered archive identity against the fixed target matrix. */
const parseArtifact = (value: unknown, index: number, version: string): SourceArtifact => {
  const artifact = expectObject(value, `artifact ${index}`);
  expectKeys(artifact, `artifact ${index}`, ["target", "path", "sha256", "size"]);
  const target = RELEASE_TARGETS[index];
  const expectedPath = `assets/${archiveName(target, version)}`;
  if (artifact.target !== target.target || artifact.path !== expectedPath) {
    throw new Error(`Artifact ${index} does not match target ${target.target}`);
  }
  const sha256 = expectString(artifact.sha256, `artifact ${index} hash`);
  if (
    !HASH_PATTERN.test(sha256) ||
    !Number.isSafeInteger(artifact.size) ||
    Number(artifact.size) <= 0
  ) {
    throw new Error(`Artifact ${index} has an invalid digest or size`);
  }
  return { path: expectedPath, sha256, size: Number(artifact.size), target: target.target };
};

/** validateSourceLocation binds the importer to the documented dist/free/version layout. */
const validateSourceLocation = (sourceRoot: string, version: string): void => {
  if (
    basename(sourceRoot) !== `v${version}` ||
    basename(dirname(sourceRoot)) !== "free" ||
    basename(dirname(dirname(sourceRoot))) !== "dist"
  ) {
    throw new Error("Source release must use the exact dist/free/v<version> layout");
  }
};

/** verifySourceTree rejects missing, additional, or symlinked Phase 14 input paths. */
const verifySourceTree = (sourceRoot: string, version: string): void => {
  const expectedDirectories = new Set([".", "assets", "metadata", "npm", "unpacked"]);
  const expectedFiles = new Set([
    "RELEASE_NOTES.md",
    "SHA256SUMS",
    "metadata/release.json",
    "metadata/capabilities.json",
    "metadata/build-info.json",
    "metadata/sbom.spdx.json",
    "metadata/THIRD_PARTY_NOTICES.md",
  ]);
  for (const target of RELEASE_TARGETS) {
    expectedDirectories.add(`unpacked/${target.target}`);
    expectedFiles.add(`assets/${archiveName(target, version)}`);
    expectedFiles.add(`unpacked/${target.target}/${target.binaryName}`);
  }
  const seenDirectories = new Set<string>();
  const seenFiles = new Set<string>();
  walkTree(sourceRoot, (relativePath, information) => {
    if (information.isSymbolicLink()) {
      throw new Error(`Source release path ${relativePath} is a symlink`);
    }
    if (information.isDirectory()) {
      if (!expectedDirectories.has(relativePath)) {
        throw new Error(`Source release contains unexpected directory ${relativePath}`);
      }
      seenDirectories.add(relativePath);
      return;
    }
    if (!information.isFile() || !expectedFiles.has(relativePath)) {
      throw new Error(`Source release contains unexpected file ${relativePath}`);
    }
    seenFiles.add(relativePath);
  });
  for (const path of expectedDirectories)
    if (!seenDirectories.has(path)) throw new Error(`Source release directory ${path} is missing`);
  for (const path of expectedFiles)
    if (!seenFiles.has(path)) throw new Error(`Source release file ${path} is missing`);
};

/** parseChecksums parses canonical sorted SHA256SUMS entries and rejects duplicates. */
const parseChecksums = (contents: string): Map<string, string> => {
  const result = new Map<string, string>();
  const lines = contents.split("\n");
  if (lines.at(-1) !== "") throw new Error("Checksum inventory lacks a terminal newline");
  lines.pop();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
    if (!match || result.has(match[2]))
      throw new Error(`Malformed or duplicate checksum line ${JSON.stringify(line)}`);
    result.set(match[2], match[1]);
  }
  if ([...result.keys()].join("\n") !== [...result.keys()].sort().join("\n")) {
    throw new Error("Checksum inventory is not sorted");
  }
  return result;
};

/** verifySourceChecksums binds every publishable input byte to both source inventories. */
const verifySourceChecksums = (
  sourceRoot: string,
  metadata: SourceReleaseMetadata,
  checksums: Map<string, string>,
): void => {
  const expectedPaths = [
    "RELEASE_NOTES.md",
    ...metadata.artifacts.map(({ path }) => path),
    "metadata/THIRD_PARTY_NOTICES.md",
    "metadata/build-info.json",
    "metadata/capabilities.json",
    "metadata/release.json",
    "metadata/sbom.spdx.json",
  ].sort();
  if ([...checksums.keys()].join("\n") !== expectedPaths.join("\n")) {
    throw new Error("Source checksum inventory does not cover the exact publishable tree");
  }
  for (const path of expectedPaths) {
    if (sha256File(join(sourceRoot, ...path.split("/"))) !== checksums.get(path)) {
      throw new Error(`Source checksum mismatch for ${path}`);
    }
  }
  for (const artifact of metadata.artifacts) {
    const fullPath = join(sourceRoot, ...artifact.path.split("/"));
    if (
      checksums.get(artifact.path) !== artifact.sha256 ||
      statSync(fullPath).size !== artifact.size
    ) {
      throw new Error(`Source artifact metadata mismatch for ${artifact.target}`);
    }
  }
};

/** validateCapabilities checks the public-safe Free capability envelope and target hashes. */
const validateCapabilities = (value: unknown, metadata: SourceReleaseMetadata): void => {
  const document = expectObject(value, "capability metadata");
  expectKeys(document, "capability metadata", ["schemaVersion", "edition", "targets"]);
  if (document.schemaVersion !== 1 || document.edition !== "free") {
    throw new Error("Capability metadata is not schema-v1 Free metadata");
  }
  const targets = expectArray(document.targets, "capability targets");
  if (targets.length !== RELEASE_TARGETS.length)
    throw new Error("Capability target matrix is incomplete");
  targets.forEach((entry, index) => {
    const target = expectObject(entry, `capability target ${index}`);
    expectKeys(target, `capability target ${index}`, [
      "target",
      "manifestHash",
      "capabilities",
      "excluded",
    ]);
    const expected = RELEASE_TARGETS[index];
    const expectedHash =
      expected.target === "wasi" ? metadata.wasiManifestHash : metadata.nativeManifestHash;
    if (target.target !== expected.target || target.manifestHash !== expectedHash) {
      throw new Error(`Capability metadata does not match ${expected.target}`);
    }
    validateCapabilityDescriptors(target.capabilities, `capabilities for ${expected.target}`);
    validateCapabilityDescriptors(target.excluded, `exclusions for ${expected.target}`);
  });
  const nativeCapabilities = expectArray(
    expectObject(targets[0], "first native capability target").capabilities,
    "first native capabilities",
  ).map((entry) =>
    expectString(expectObject(entry, "native capability").name, "native capability name"),
  );
  if (nativeCapabilities.join("\n") !== metadata.resolvedCapabilities.join("\n")) {
    throw new Error("Release and capability metadata disagree about resolved Free capabilities");
  }
};

/** validateCapabilityDescriptors rejects unknown fields in public capability records. */
const validateCapabilityDescriptors = (value: unknown, label: string): void => {
  expectArray(value, label).forEach((entry, index) => {
    const descriptor = expectObject(entry, `${label} ${index}`);
    expectKeys(descriptor, `${label} ${index}`, [
      "name",
      "version",
      "nativeOnly",
      "dependencies",
      "conflicts",
      "commands",
    ]);
    expectString(descriptor.name, `${label} name`);
    if (!Number.isSafeInteger(descriptor.version) || typeof descriptor.nativeOnly !== "boolean") {
      throw new Error(`${label} has invalid version or nativeOnly fields`);
    }
    expectStringArray(descriptor.dependencies, `${label} dependencies`);
    expectStringArray(descriptor.conflicts, `${label} conflicts`);
    expectStringArray(descriptor.commands, `${label} commands`);
  });
};

/** validateBuildInfo checks non-public evidence required before accepting the source handoff. */
const validateBuildInfo = (value: unknown, metadata: SourceReleaseMetadata): void => {
  const document = expectObject(value, "build metadata");
  expectKeys(document, "build metadata", [
    "schemaVersion",
    "goVersion",
    "cgoEnabled",
    "buildFlags",
    "moduleVendorVerified",
    "sourceTreeClean",
    "releaseBuilderVersion",
    "targets",
  ]);
  if (
    document.schemaVersion !== 1 ||
    document.goVersion !== metadata.goVersion ||
    document.cgoEnabled !== "0" ||
    document.moduleVendorVerified !== true ||
    document.sourceTreeClean !== true ||
    document.releaseBuilderVersion !== "1"
  ) {
    throw new Error("Build metadata does not describe a clean verified Phase 14 build");
  }
  if (!expectStringArray(document.buildFlags, "build flags").includes("-trimpath")) {
    throw new Error("Build metadata does not record -trimpath");
  }
  const targets = expectArray(document.targets, "build targets");
  if (targets.length !== RELEASE_TARGETS.length)
    throw new Error("Build target matrix is incomplete");
  targets.forEach((entry, index) => {
    const target = expectObject(entry, `build target ${index}`);
    expectKeys(target, `build target ${index}`, [
      "name",
      "goos",
      "goarch",
      "binaryName",
      "archiveName",
      "archiveKind",
    ]);
    const expected = RELEASE_TARGETS[index];
    const expectedGOOS = expected.target === "wasi" ? "wasip1" : expected.target.split("-")[0];
    const expectedGOARCH =
      expected.target === "wasi" ? "wasm" : expected.architecture === "x64" ? "amd64" : "arm64";
    if (
      target.name !== expected.target ||
      target.goos !== expectedGOOS ||
      target.goarch !== expectedGOARCH ||
      target.binaryName !== expected.binaryName ||
      target.archiveName !== archiveName(expected, metadata.version) ||
      target.archiveKind !== expected.archiveKind
    )
      throw new Error(`Build target ${index} is out of order`);
  });
};

/** validateSBOM checks the public SPDX identity before allowing the document to cross repositories. */
const validateSBOM = (value: unknown, metadata: SourceReleaseMetadata): void => {
  const document = expectObject(value, "SBOM");
  expectKeys(document, "SBOM", [
    "spdxVersion",
    "dataLicense",
    "SPDXID",
    "name",
    "documentNamespace",
    "creationInfo",
    "packages",
    "relationships",
  ]);
  if (
    document.spdxVersion !== "SPDX-2.3" ||
    document.name !== `pannonico-free-${metadata.version}` ||
    typeof document.documentNamespace !== "string" ||
    !document.documentNamespace.endsWith(`/${metadata.sourceCommit}`)
  ) {
    throw new Error("SBOM does not match the Free source release");
  }
  const creationInfo = expectObject(document.creationInfo, "SBOM creationInfo");
  expectKeys(creationInfo, "SBOM creationInfo", ["created", "creators"]);
  expectString(creationInfo.created, "SBOM creation time");
  expectStringArray(creationInfo.creators, "SBOM creators");
  expectArray(document.packages, "SBOM packages").forEach((entry, index) => {
    const packageRecord = expectObject(entry, `SBOM package ${index}`);
    expectKeys(packageRecord, `SBOM package ${index}`, [
      "name",
      "SPDXID",
      "versionInfo",
      "downloadLocation",
      "filesAnalyzed",
      "licenseConcluded",
      "licenseDeclared",
    ]);
    for (const field of [
      "name",
      "SPDXID",
      "versionInfo",
      "downloadLocation",
      "licenseConcluded",
      "licenseDeclared",
    ]) {
      expectString(packageRecord[field], `SBOM package ${index} ${field}`);
    }
    if (packageRecord.filesAnalyzed !== false)
      throw new Error(`SBOM package ${index} unexpectedly claims file analysis`);
  });
  expectArray(document.relationships, "SBOM relationships").forEach((entry, index) => {
    const relationship = expectObject(entry, `SBOM relationship ${index}`);
    expectKeys(relationship, `SBOM relationship ${index}`, [
      "spdxElementId",
      "relationshipType",
      "relatedSpdxElement",
    ]);
    expectString(relationship.spdxElementId, "SBOM relationship source");
    expectString(relationship.relationshipType, "SBOM relationship type");
    expectString(relationship.relatedSpdxElement, "SBOM relationship target");
  });
};

/** validateThirdPartyNotices restricts copied notice text to the generated module/license format. */
const validateThirdPartyNotices = (contents: string): void => {
  const lines = contents.split("\n");
  if (
    lines[0] !== "# Third-party notices" ||
    lines[1] !== "" ||
    lines[2] !== "Pannonico includes or was built from the following approved Go modules." ||
    lines[3] !== "" ||
    lines.at(-1) !== ""
  ) {
    throw new Error("Third-party notices do not use the public release format");
  }
  const records = lines.slice(4, -1);
  if (
    records.length === 0 ||
    records.some(
      (line) => !/^- `[^`]+` `[^`]+` - [A-Za-z0-9+.-]+(?:, [A-Za-z0-9+.-]+)*$/.test(line),
    )
  ) {
    throw new Error("Third-party notices contain an invalid module/license record");
  }
};

/** expectObject narrows one JSON value to a non-array object. */
const expectObject = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
};

/** expectArray narrows one JSON value to an array. */
const expectArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
};

/** expectString narrows one JSON value to a non-empty string. */
const expectString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} is not a non-empty string`);
  return value;
};

/** expectStringArray narrows one JSON value to an ordered array of unique strings. */
const expectStringArray = (value: unknown, label: string): string[] => {
  const values = expectArray(value, label).map((entry) => expectString(entry, label));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values;
};

/** expectKeys enforces one explicit metadata allowlist without accepting extra fields. */
const expectKeys = (
  value: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): void => {
  if (Object.keys(value).join("\n") !== keys.join("\n")) {
    throw new Error(`${label} fields do not match the approved schema`);
  }
};

/** walkTree visits a root and every descendant without following symlinks. */
const walkTree = (
  root: string,
  visit: (relativePath: string, information: ReturnType<typeof lstatSync>) => void,
): void => {
  const visitPath = (path: string): void => {
    const information = lstatSync(path);
    const relativePath = relative(root, path).split(sep).join("/") || ".";
    visit(relativePath, information);
    if (information.isDirectory() && !information.isSymbolicLink()) {
      for (const entry of readdirSync(path).sort()) visitPath(join(path, entry));
    }
  };
  visitPath(root);
};

/** walkFiles visits regular files below one generated output root. */
const walkFiles = (root: string, visit: (filePath: string) => void): void => {
  walkTree(root, (_relativePath, information) => {
    if (information.isSymbolicLink()) throw new Error("Public output contains a symlink");
  });
  const visitPath = (path: string): void => {
    const information = lstatSync(path);
    if (information.isDirectory()) {
      for (const entry of readdirSync(path)) visitPath(join(path, entry));
    } else if (information.isFile()) {
      visit(path);
    }
  };
  visitPath(root);
};
