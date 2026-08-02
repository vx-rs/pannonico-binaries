# Pannonico binaries

This public repository contains target-specific Free Pannonico executables,
public release metadata, and npm package inputs. The private `pannonico-go`
repository remains the only build authority. This repository does not contain
the private application source.

Install the launcher instead of a target package directly:

```sh
npm install --global @vx.rs/pannonico
pannonico --help
```

Native packages cover Linux, macOS, and Windows on x64 and arm64. The
platform-independent WASI package is the fallback for unsupported or blocked
native execution. Package publication and launcher selection are implemented
in later release phases.

See [the public handoff contract](./docs/PUBLIC-HANDOFF.md) before importing a
release.
