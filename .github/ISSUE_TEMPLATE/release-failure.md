---
name: Report a Free release failure
about: Track a failed or partially published Free binary and launcher release
title: "release: investigate Free vX.Y.Z"
labels: RELEASE
assignees: vsjov
---

# Free release failure vX.Y.Z

- Source tag:
- Binary repository tag:
- Failed workflow run:
- Packages already published:

## Failure evidence

- [ ] Download the failed logs.
- [ ] Re-run the read-only binary validator against the checked-out release.
- [ ] Inspect the binary tag and hosted release without mutating them.

```sh
VERSION=X.Y.Z
gh run view RUN_ID --repo vx-rs/pannonico-binaries --log-failed
npm ci --ignore-scripts
npm run validate-release -- "$VERSION"
git ls-remote --tags origin "refs/tags/v$VERSION"
gh release view "v$VERSION" --repo vx-rs/pannonico-binaries
```

- [ ] Record which six native packages, WASI package, and launcher version exist.

```sh
VERSION=X.Y.Z
for package_name in \
  @vx.rs/pannonico-bin-linux-x64 \
  @vx.rs/pannonico-bin-linux-arm64 \
  @vx.rs/pannonico-bin-darwin-x64 \
  @vx.rs/pannonico-bin-darwin-arm64 \
  @vx.rs/pannonico-bin-win32-x64 \
  @vx.rs/pannonico-bin-win32-arm64 \
  @vx.rs/pannonico-wasi \
  @vx.rs/pannonico; do
  npm view "$package_name@$VERSION" version --registry=https://registry.npmjs.org \
    || true
done
```

## Recovery

- [ ] Do not overwrite, unpublish, or reuse an immutable npm version.
- [ ] Stop launcher publication until every target package exists at one version.
- [ ] If no wrapper exists and all target packages exist, run the manual launcher
      recovery dispatch.

```sh
VERSION=X.Y.Z
gh workflow run release.yml \
  --repo vx-rs/pannonico-node --ref master \
  -f version="$VERSION" \
  -f binary_repository_tag="v$VERSION"
```

- [ ] If any published package is incorrect or missing permanently, prepare a
      corrected new source version.
- [ ] Record the resolution before closing this issue.
