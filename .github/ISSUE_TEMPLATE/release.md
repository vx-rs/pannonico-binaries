---
name: Synchronized Free binary release
about: Track source-authorized Free binary import and target-package publication
title: "release: publish Free vX.Y.Z"
labels: RELEASE
assignees: vsjov
---

# Free binary release vX.Y.Z

The matching `pannonico-go` tag is the only release authority. Do not construct,
edit, tag, or publish a binary release independently.

## Candidate

- [ ] Confirm the source tag and imported `sourceCommit` identify the same commit.
- [ ] Confirm the root manifest and all seven target manifests use `X.Y.Z`.

```sh
VERSION=X.Y.Z
SOURCE_COMMIT="$(git -C ../pannonico-go rev-parse "v$VERSION^{commit}")"
MANIFEST_COMMIT="$(node -p 'JSON.parse(require("fs").readFileSync("release-manifest.json")).sourceCommit')"
test "$SOURCE_COMMIT" = "$MANIFEST_COMMIT"
node -e 'const m=JSON.parse(require("fs").readFileSync("release-manifest.json")); console.log(m.sourceCommit, m.sourceTag, m.version)'
for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64 \
  win32-x64 win32-arm64 wasi; do
  node -p "require('./packages/$target/package.json').version"
done
```

- [ ] Run the complete repository validation gate.
- [ ] Inspect the exact contents of every target package.

```sh
VERSION=X.Y.Z
npm ci --ignore-scripts
npm run format:check
npm run lint
npm test
npm run validate-release -- "$VERSION"
for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64 \
  win32-x64 win32-arm64 wasi; do
  npm pack --dry-run --json --ignore-scripts "packages/$target"
done
```

## Completion

- [ ] Confirm the source handoff created tag `vX.Y.Z`.
- [ ] Confirm the hosted release contains the verified assets and metadata.
- [ ] Confirm all six native packages and the WASI package exist at `X.Y.Z`.
- [ ] Confirm the binary workflow dispatched the launcher workflow.

```sh
VERSION=X.Y.Z
git ls-remote --exit-code --tags origin "refs/tags/v$VERSION"
gh release view "v$VERSION" --repo vx-rs/pannonico-binaries
for package_name in \
  @vx.rs/pannonico-bin-linux-x64 \
  @vx.rs/pannonico-bin-linux-arm64 \
  @vx.rs/pannonico-bin-darwin-x64 \
  @vx.rs/pannonico-bin-darwin-arm64 \
  @vx.rs/pannonico-bin-win32-x64 \
  @vx.rs/pannonico-bin-win32-arm64 \
  @vx.rs/pannonico-wasi; do
  npm view "$package_name@$VERSION" version --registry=https://registry.npmjs.org
done
gh run list --repo vx-rs/pannonico-node --event repository_dispatch --limit 5
```

Never reuse `X.Y.Z` after any target package has been published.
