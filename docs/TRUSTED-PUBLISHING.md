# npm trusted publishing

Each of the six native packages and `@vx.rs/pannonico-wasi` is published from
`.github/workflows/release.yml` only after the matching committed import passes
independent validation and the public GitHub release exists.

Configure one npm trusted publisher for each package with:

- provider: GitHub Actions;
- organization: `vx-rs`;
- repository: `pannonico-binaries`;
- workflow filename: `release.yml`;
- environment: none;
- allowed action: publish.

The workflow uses a GitHub-hosted runner, Node 24, `id-token: write`, the public
npm registry, and provenance. After the initial package bootstrap, remove and
revoke every temporary npm token, require two-factor authentication, and
disallow token-based publication in package settings.

Trusted-publisher creation, first-package bootstrap, credential changes, tags,
hosted releases, and publication are external state changes. Local repository
implementation and validation do not perform them.
