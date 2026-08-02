import type { ReleaseTarget } from "./release-targets.ts";

/** packageManifest creates one target package manifest from the fixed public identity. */
export const packageManifest = (
  target: ReleaseTarget,
  version: string,
): Record<string, unknown> => {
  const platformName =
    target.platform === "darwin"
      ? "macOS"
      : target.platform === "linux"
        ? "Linux"
        : target.platform === "win32"
          ? "Windows"
          : undefined;
  const manifest: Record<string, unknown> = {
    name: target.packageName,
    version,
    description:
      target.target === "wasi"
        ? "Platform-independent Pannonico Free WASI fallback"
        : `Pannonico Free binary for ${platformName} ${target.architecture}`,
    license: "PolyForm-Noncommercial-1.0.0",
    files:
      target.target === "wasi"
        ? [
            "pannonico.wasm",
            "LICENSE",
            "NOTICE",
            "COMMERCIAL-LICENSE.md",
            "README.md",
            "SHA256SUMS",
          ]
        : ["bin/", "LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md", "SHA256SUMS"],
    repository: {
      type: "git",
      url: "git+https://github.com/vx-rs/pannonico-binaries.git",
      directory: `packages/${target.packageDirectory}`,
    },
    publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
  };
  if (target.platform && target.architecture) {
    manifest.os = [target.platform];
    manifest.cpu = [target.architecture];
    manifest.bin = { pannonico: `./bin/${target.binaryName}` };
  }
  return manifest;
};

/** packageReadme creates public usage text for one generated target package. */
export const packageReadme = (target: ReleaseTarget): string => {
  if (target.target === "wasi") {
    return (
      "# Pannonico WASI compatibility fallback\n\n" +
      "This package contains the platform-independent WASI build of `pannonico`. It is\n" +
      "installed automatically and consumed by `@vx.rs/pannonico` only when no compatible\n" +
      "native binary can run. The fallback is slower than a native binary.\n\n" +
      "Install `@vx.rs/pannonico` instead of this package directly.\n"
    );
  }
  return (
    `# Pannonico binary for ${target.packageDirectory}\n\n` +
    `This package contains the native \`pannonico\` binary built for \`${target.target}\`. It is\n` +
    "installed automatically and consumed by `@vx.rs/pannonico` on this platform.\n\n" +
    "Install `@vx.rs/pannonico` instead of this target package directly.\n"
  );
};

/** canonicalJSON serializes public JSON with stable indentation and one terminal newline. */
export const canonicalJSON = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
