export type ReleaseTarget = {
  archiveKind: "tar.gz" | "zip";
  architecture?: "arm64" | "x64";
  binaryName: "pannonico" | "pannonico.exe" | "pannonico.wasm";
  packageDirectory: string;
  packageName: string;
  platform?: "darwin" | "linux" | "win32";
  target: string;
};

/** RELEASE_TARGETS is the ordered Phase 14 Free distribution and package matrix. */
export const RELEASE_TARGETS: readonly ReleaseTarget[] = [
  {
    archiveKind: "tar.gz",
    architecture: "x64",
    binaryName: "pannonico",
    packageDirectory: "linux-x64",
    packageName: "@vx.rs/pannonico-bin-linux-x64",
    platform: "linux",
    target: "linux-x64",
  },
  {
    archiveKind: "tar.gz",
    architecture: "arm64",
    binaryName: "pannonico",
    packageDirectory: "linux-arm64",
    packageName: "@vx.rs/pannonico-bin-linux-arm64",
    platform: "linux",
    target: "linux-arm64",
  },
  {
    archiveKind: "tar.gz",
    architecture: "x64",
    binaryName: "pannonico",
    packageDirectory: "darwin-x64",
    packageName: "@vx.rs/pannonico-bin-darwin-x64",
    platform: "darwin",
    target: "darwin-x64",
  },
  {
    archiveKind: "tar.gz",
    architecture: "arm64",
    binaryName: "pannonico",
    packageDirectory: "darwin-arm64",
    packageName: "@vx.rs/pannonico-bin-darwin-arm64",
    platform: "darwin",
    target: "darwin-arm64",
  },
  {
    archiveKind: "zip",
    architecture: "x64",
    binaryName: "pannonico.exe",
    packageDirectory: "win32-x64",
    packageName: "@vx.rs/pannonico-bin-win32-x64",
    platform: "win32",
    target: "windows-x64",
  },
  {
    archiveKind: "zip",
    architecture: "arm64",
    binaryName: "pannonico.exe",
    packageDirectory: "win32-arm64",
    packageName: "@vx.rs/pannonico-bin-win32-arm64",
    platform: "win32",
    target: "windows-arm64",
  },
  {
    archiveKind: "zip",
    binaryName: "pannonico.wasm",
    packageDirectory: "wasi",
    packageName: "@vx.rs/pannonico-wasi",
    target: "wasi",
  },
];

/** archiveName returns the fixed Phase 14 archive name for a target and version. */
export const archiveName = (target: ReleaseTarget, version: string): string =>
  `pannonico-v${version}-${target.target}.${target.archiveKind}`;

/** packagePayloadPath returns the package-relative executable or WASI module path. */
export const packagePayloadPath = (target: ReleaseTarget): string =>
  target.target === "wasi" ? target.binaryName : `bin/${target.binaryName}`;
