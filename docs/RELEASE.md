# Public binary release

The private source release controls every Pannonico version. Do not independently
choose a version, edit a generated payload, or construct a release manifest in
this repository.

The importer described in [PUBLIC-HANDOFF.md](./PUBLIC-HANDOFF.md) prepares the
committed public release tree and all seven target package trees. The tag-gated
workflow validates those files again before it creates a GitHub release and
publishes all seven packages through npm trusted publishing. It does not
dispatch or publish the launcher repository.

Local validation never pushes a branch or tag and never creates a hosted
release. Publishing requires an explicit later remote operation.

Configure the seven npm package connections as described in
[TRUSTED-PUBLISHING.md](./TRUSTED-PUBLISHING.md) before pushing a release tag.
