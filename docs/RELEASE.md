# Public binary release

The private source release controls every Pannonico version. Do not independently
choose a version, edit a generated payload, or construct a release manifest in
this repository.

The importer described in [PUBLIC-HANDOFF.md](./PUBLIC-HANDOFF.md) prepares the
committed public release tree and all seven target package trees. The tag-gated
workflow validates those files again before it creates a GitHub release and
publishes all seven packages through npm trusted publishing. After every target
package succeeds, it dispatches the exact version and binary tag to the launcher
repository. The launcher owns its own verification and publication.

Local validation never pushes a branch or tag and never creates a hosted
release. Publishing requires an explicit later remote operation.

Run the complete local gate from this repository:

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

Inspect the published handoff without changing it:

```sh
VERSION=X.Y.Z
git ls-remote --exit-code --tags origin "refs/tags/v$VERSION"
gh release view "v$VERSION" --repo vx-rs/pannonico-binaries
gh run list --repo vx-rs/pannonico-node --event repository_dispatch --limit 5
```

Configure the seven npm package connections as described in
[TRUSTED-PUBLISHING.md](./TRUSTED-PUBLISHING.md) before pushing a release tag.
Configure `VX_WRAPPER_REPOSITORY_TOKEN` as a narrowly scoped credential with
Contents read/write access only to `vx-rs/pannonico-node`, which permits the
repository dispatch request.
