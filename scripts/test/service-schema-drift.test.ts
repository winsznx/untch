import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { GENERATED_DIR, buildArtifacts } from "../gen-service-schemas";

/**
 * The mechanism, not the generation.
 *
 * Generating the artefacts fixes nothing on its own — a generator whose output nobody checks adds a
 * seventh copy of the contract to the six the audit already found. This is the check: the committed
 * files must equal what the registry produces today, so a definition change that lands without
 * regenerated artefacts fails the build rather than quietly reintroducing the divergence.
 */
describe("generated service artefacts", () => {
  for (const artifact of buildArtifacts()) {
    test(`${artifact.file} matches the registry`, () => {
      let onDisk: string;
      try {
        onDisk = readFileSync(join(GENERATED_DIR, artifact.file), "utf8");
      } catch {
        assert.fail(`${artifact.file} is missing — run \`pnpm gen:schemas\` and commit the result`);
      }
      assert.equal(onDisk, artifact.content, `run \`pnpm gen:schemas\` and commit the result`);
    });
  }
});
