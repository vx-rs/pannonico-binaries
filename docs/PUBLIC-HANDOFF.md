# Public artifact handoff

The private `pannonico-go` repository is the only authority that builds and
verifies Pannonico executables. This repository accepts one complete Phase 14
Free distribution and prepares public GitHub release files plus target-specific
npm package trees. It never rebuilds or modifies an executable.

## Required input

The importer accepts `dist/free/v<version>` only after the source repository has
run its `release-builder verify`, `test-host`, and `test-wasi` commands. The
directory must contain schema-v1 metadata for the Free edition, the fixed seven
target matrix, a full hexadecimal source commit, and `sourceTag` equal to
`v<version>`. V1 artifacts must record `signed: false`, a null signature type,
and `notarized: false`.

The importer independently checks the exact Phase 14 directory shape, regular
file and non-symlink constraints, canonical `SHA256SUMS`, archive hashes and
sizes, target ordering, metadata envelopes, the clean vendored build marker,
and the matching source tag. Any failure occurs before repository output is
replaced.

## Public output

The importer writes these generated surfaces:

```text
release-manifest.json
public-release/
  RELEASE_NOTES.md
  SHA256SUMS
  assets/<seven unchanged source archives>
  metadata/
    release.json
    capabilities.json
    sbom.spdx.json
    THIRD_PARTY_NOTICES.md
packages/<seven target package directories>/
```

Archive bytes are copied unchanged. Their digest and size must agree across the
private release metadata, private checksum inventory, public copied file, and
public release manifest. `public-release/SHA256SUMS` is regenerated because the
public notes and release metadata intentionally differ from the private source
release.

Each target package receives one executable or WASI module from the verified
`unpacked` tree. It also receives its exact checksum, public package manifest,
README, and legal files. The importer does not consume the Phase 14 `npm`
placeholder. The package manifest carries schema-v1 `free` edition, exact
target, and exact payload-path identity so the Phase 16 launcher can validate
metadata without inferring it from an npm installation layout.

## Sanitization boundary

The public release notes contain only the selected version and its single
`Public changes` subsection. Pro and Internal subsections are never copied.

Public `release.json` is reconstructed from an explicit schema. It contains the
version, source commit and tag, build epoch, Go version, Free manifest hashes,
Free capabilities, unsigned/notarized state, archive identities, and package
payload hashes. The private `build-info.json`, local `unpacked` directory, npm
staging directory, source files, arbitrary metadata, and unknown source paths
are not copied.

The importer scans staged public files for the derived private checkout path and
common absolute checkout prefixes before installation. The validator also
enforces exact generated path allowlists, so `.go`, module, vendor, edition,
policy, Git, and other private source files cannot enter through recursive copy.

## Local procedure

1. Build and verify the matching tagged Free distribution in `pannonico-go`.
2. Run the importer from this repository:

   ```sh
   node scripts/import-release.ts --source ../pannonico-go/dist/free/vX.Y.Z
   ```

3. Run `npm run format:check`, `npm run lint`, `npm test`, and
   `npm run validate-release -- X.Y.Z`.
4. Review `git diff`, the filtered notes, `release-manifest.json`, and package
   tarball contents before any commit, tag, or remote action.

Do not create a public tag or hosted release until the private source workflow
has completed every release gate. npm publication and launcher dispatch belong
to Phase 16.
