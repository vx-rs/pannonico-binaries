# Phase 15 local verification evidence

## Scope

Phase 15 initializes the public binary repository without importing private
application source. It defines seven artifact-free target package templates,
the strict Phase 14 Free handoff parser, archive-to-payload verification,
public release-note and metadata sanitization, staged import with rollback,
independent public-tree validation, and a tag-gated GitHub release workflow.

The importer requires a matching source tag and rejects Pro, untagged,
additional, missing, symlinked, non-canonical, checksum-divergent, and
archive-divergent inputs before repository mutation. It extracts each package
payload from the checksum-bound source archive and compares it with the Phase
14 unpacked acceptance copy. Public output is constructed from explicit path
and metadata allowlists.

## Automated coverage

The Node fixture suite covers:

- all seven source artifact and npm package identities;
- exact archive-byte preservation from private to public release trees;
- TAR header and ZIP central-directory, mode, compression, size, and CRC checks;
- source checksum, metadata, tag, edition, symlink, unpacked, SBOM, and archive
  tampering before mutation;
- Public-only release-note filtering;
- staged private-path exclusion;
- public payload, capability metadata, note, and checksum tampering;
- exact target package file allowlists and synchronized versions.

Node's built-in coverage report records 89.57 percent line coverage, 71.52
percent branch coverage, and 96.59 percent function coverage across the public
automation modules.

## Real Phase 14 handoff

`pannonico-go` was clean at signed commit
`79346a736e9c6ef0cc2c10fb7681414bc592be69`. Its Phase 14 builder produced and
independently verified a real seven-target Free `0.0.0-dev` distribution at
epoch `1785630600`.

The source commit is deliberately untagged, so the production importer rejects
that distribution. To exercise the complete local parser without creating a
tag, a temporary copy changed only `sourceTag` to `v0.0.0-dev` and regenerated
the copy's source checksum inventory. The importer then accepted all real Go
TAR, ZIP, JSON, SPDX, notice, checksum, and executable bytes. Independent
public validation reported version `0.0.0-dev`, the exact source commit above,
and seven targets.

All seven imported package trees passed real `npm pack --dry-run --json`.
Each report contained exactly the declared payload, `package.json`, README,
checksum, and three legal files. Linux and macOS payloads retained mode `0755`;
Windows payloads used regular-file mode; the WASI module was the only non-native
payload.

## Final checks

The following local checks pass:

- clean `npm ci --ignore-scripts` from `package-lock.json`;
- `npm run format:check`;
- `npm run lint` with warnings denied;
- `npm test`;
- Node built-in coverage;
- `git diff --check`;
- npm audit with no reported vulnerability;
- Phase 14 `release-builder verify` against the real local Free distribution;
- independent public validation and all seven real package dry runs.

`actionlint` is not installed in this environment. The workflow was formatted
and reviewed locally but was not executed because no branch or tag was pushed.

No remote was mutated. No tag, hosted release, npm package, repository dispatch,
signature, notarization, or publication was created.

Phase 16 subsequently extended each generated target manifest with explicit
schema-v1 Free edition, target, and payload identity. The package-local
`SHA256SUMS` remains the payload digest authority, and the Phase 15 importer,
validator, template test, and exact package-file allowlist cover the added
metadata before any launcher consumes it.
