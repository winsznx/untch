import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scanRepository, scanText, stripComments } from "../lint-production-surface";
import { renderChainRegistry, CHAIN_REGISTRY_JSON_PATH } from "../gen-chain-registry";
import { readFileSync } from "node:fs";

/**
 * A scanner is only worth having if it fails on the thing it was written for. These tests feed it the
 * four defects the cold relisting audit found, in the shape they appeared in, and assert it catches
 * each — and then assert it does NOT catch the prose that explains why they are wrong, because a
 * scanner whose output is mostly noise is a scanner that gets muted.
 */
describe("production-surface scanner", () => {
  test("catches the retyped deprecated chain id, in the shape it actually shipped", () => {
    const findings = scanText("services/asp/src/consumer/auth.ts", 'const SIGNIN = new Set([196, 195]);\nconst c = { chainId: 195 };');
    assert.ok(findings.some((f) => f.ruleId === "deprecated-xlayer-195"));
  });

  test("catches a testnet RPC used as a default", () => {
    const findings = scanText("x.ts", 'const rpc = "https://testrpc.xlayer.tech";');
    assert.ok(findings.some((f) => f.ruleId === "testnet-rpc"));
  });

  test("catches a testnet explorer link and a faucet URL", () => {
    assert.ok(
      scanText("x.ts", 'const u = "https://www.oklink.com/x-layer-testnet/tx/0x1";').some(
        (f) => f.ruleId === "testnet-explorer",
      ),
    );
    assert.ok(
      scanText("x.ts", 'const f = "https://www.okx.com/xlayer/faucet";').some((f) => f.ruleId === "faucet"),
    );
  });

  test("catches a published anvil key, using the same list the boot check refuses", () => {
    const findings = scanText(
      "x.ts",
      'const k = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";',
    );
    assert.ok(
      findings.some((f) => f.ruleId === "test-signing-key"),
      "the scanner must cover every key assertUsableEvmKey rejects, not a subset of them",
    );
  });

  test("catches localhost, devnet and sandbox hosts", () => {
    assert.ok(scanText("x.ts", 'const u = "http://localhost:4021";').some((f) => f.ruleId === "localhost"));
    assert.ok(
      scanText("x.ts", 'const u = "https://api.devnet.solana.com";').some((f) => f.ruleId === "devnet-testnet-hosts"),
    );
    assert.ok(
      scanText("x.ts", 'const u = "https://sandbox.provider.dev/v1";').some((f) => f.ruleId === "sandbox-provider"),
    );
  });

  test("does NOT flag prose that explains why a value is refused", () => {
    const text = [
      "/**",
      " * Anything else, including devnet and testnet, is refused.",
      " * The active testnet is 1952; eip155:195 was retired.",
      " */",
      "// a comment naming http://localhost is documentation, not a served URL",
      "const ok = true;",
    ].join("\n");
    assert.deepEqual(scanText("x.ts", text), []);
  });

  test("the escape hatch requires naming the rule, and only exempts that rule", () => {
    const exempted = scanText(
      "x.ts",
      '// production-surface-allow: localhost — local driver only\nconst u = "http://localhost:1";',
    );
    assert.deepEqual(exempted, []);

    const wrongRule = scanText(
      "x.ts",
      '// production-surface-allow: faucet — wrong rule named\nconst u = "http://localhost:1";',
    );
    assert.equal(wrongRule.length, 1, "an allow for one rule must not silence a different one");
  });

  test("stripComments leaves line numbers intact so findings point at the right line", () => {
    const text = "a\n/* multi\nline */\nb";
    assert.equal(stripComments(text).split("\n").length, text.split("\n").length);
  });

  test("the repository's production scopes are clean", () => {
    const findings = scanRepository();
    assert.deepEqual(
      findings.map((f) => `${f.file}:${f.line} ${f.ruleId}`),
      [],
    );
  });
});

describe("generated chain registry", () => {
  test("the committed JSON matches the TypeScript registry", () => {
    assert.equal(
      readFileSync(CHAIN_REGISTRY_JSON_PATH, "utf8"),
      renderChainRegistry(),
      "run `pnpm gen:chains` and commit the result",
    );
  });
});
