import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { SERVICES } from "../src/registry/services";

/**
 * The relisting payload, in OKX's shape, checked against the rules OKX states.
 *
 * The live listing carries five services and every one has a TWO-line `serviceDescription`. The
 * `agent update` contract requires FOUR for an A2MCP service — what it does, the parameter spec on one
 * line, the request method, and a working curl against the real endpoint — and says "all FOUR
 * REQUIRED; an A2MCP listing missing any is rejected at listing QA". Five listings, five rejections
 * waiting, and nothing in this repo would have caught it.
 */

interface Entry {
  readonly operation: string;
  readonly id?: string;
  readonly serviceName?: string;
  readonly serviceDescription?: string;
  readonly serviceType?: string;
  readonly fee?: string;
  readonly endpoint?: string;
}

const payload = JSON.parse(
  readFileSync(new URL("../generated/okx-relisting-services.json", import.meta.url), "utf8"),
) as Entry[];

const listed = payload.filter((e): e is Required<Entry> => e.operation !== "delete");

describe("the relisting payload would survive listing QA", () => {
  test("every A2MCP service carries all four description lines", () => {
    for (const s of listed) {
      const lines = s.serviceDescription.split("\n");
      assert.equal(lines.length, 4, `${s.serviceName} has ${lines.length} lines, not 4`);
      for (const [i, line] of lines.entries()) {
        assert.notEqual(line.trim(), "", `${s.serviceName} line ${i + 1} is empty`);
      }
    }
  });

  /** Line 2's shape is dictated: every key param on ONE line, `<name>(<type>, required/optional)`. */
  test("the parameter spec uses the required notation on one line", () => {
    for (const s of listed) {
      const spec = s.serviceDescription.split("\n")[1]!;
      if (spec === "no parameters") continue;
      assert.match(spec, /\w+\((string|object|array|number|integer|boolean), (required|optional)\):/);
    }
  });

  /** Line 4 must be runnable. A reviewer pastes it, and it has to hit the endpoint being listed. */
  test("the request example is a curl against the endpoint being listed", () => {
    for (const s of listed) {
      const example = s.serviceDescription.split("\n")[3]!;
      assert.match(example, /^curl -X POST /);
      assert.ok(example.includes(s.endpoint), `${s.serviceName}'s example does not use its own endpoint`);
    }
  });

  test("names are 5-30 characters and never the agent's own name", () => {
    for (const s of listed) {
      assert.ok(s.serviceName.length >= 5 && s.serviceName.length <= 30, `${s.serviceName} is out of range`);
      assert.notEqual(s.serviceName.toLowerCase(), "untch");
    }
  });

  /** A plain number, USDT implied. `$0.05` is rejected, and so is an empty fee on A2MCP. */
  test("fees are plain numbers to at most six decimals", () => {
    for (const s of listed) {
      assert.match(s.fee, /^\d+(\.\d{1,6})?$/, `${s.serviceName} has fee ${s.fee}`);
    }
  });

  test("every listed price matches the registry, so the listing cannot drift from the challenge", () => {
    for (const s of listed) {
      const svc = SERVICES.find((x) => s.endpoint.endsWith(x.path));
      assert.ok(svc, `${s.endpoint} matches no registry service`);
      assert.equal(s.fee, String(svc.pricing.price).replace(/^\$/, ""), `${s.serviceName} price drifted`);
    }
  });
});

describe("what is deliberately not listed", () => {
  /**
   * `Untch cafe latte` answers 410 — it simulates a coffee order, and pricing it made a demonstration
   * look like a purchase. `Rail ping` is free now. OKX's own `agent x402-check` returns `valid: false`
   * for both.
   */
  test("the disabled simulation and the free health check are deleted, not rewritten", () => {
    const deletes = payload.filter((e) => e.operation === "delete");
    assert.equal(deletes.length, 2);
    for (const d of deletes) assert.ok(d.id, "a delete must carry the existing service id");
  });

  test("only genuinely paid services are listed, since A2MCP rejects an empty fee", () => {
    for (const s of listed) {
      const svc = SERVICES.find((x) => s.endpoint.endsWith(x.path))!;
      assert.equal(svc.pricing.kind, "paid", `${s.serviceName} is free and cannot be an A2MCP listing`);
      assert.equal(svc.classification.serviceClass, "MARKETPLACE_LISTABLE");
    }
  });
});
