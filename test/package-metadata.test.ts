import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packageManifest } from "../scripts/package-files.ts";
import { RELEASE_TARGETS } from "../scripts/release-targets.ts";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Expect artifact-free templates to define the exact seven public target packages", () => {
  assert.equal(RELEASE_TARGETS.length, 7);
  assert.equal(new Set(RELEASE_TARGETS.map(({ target }) => target)).size, 7);
  for (const target of RELEASE_TARGETS) {
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(REPOSITORY_ROOT, "packages", target.packageDirectory, "package.json"),
          "utf8",
        ),
      ),
      packageManifest(target, "0.0.0"),
    );
  }
});
