import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildJobs, requiredCrons } from "../src/workers/jobs";
import { OPTIONAL_BINDINGS, REQUIRED_BINDINGS, REQUIRED_VARS } from "../src/workers/env";
import { writerGate } from "../src/workers/writer-gate";

/** The committed seller role address. Not retyped: packages/shared owns it. */
const ROLE_PAY_TO = "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba";

/**
 * The wrangler config and the code must agree, and a comment saying so is not a mechanism.
 *
 * Every fact here has a failure mode that is silent at deploy time and loud in production: a cron the
 * code expects but the config never fires, a binding renamed in one place, an environment that ships
 * armed, or a preview advertising the listed endpoint. Each is asserted rather than reviewed.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(HERE, "..", "workers", "wrangler.jsonc");

/** JSONC: strip line comments before parsing. Block comments are not used in this file. */
function readConfig(): Record<string, any> {
  const raw = readFileSync(CONFIG, "utf8");
  const stripped = raw
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
  return JSON.parse(stripped) as Record<string, any>;
}

const config = readConfig();
const production = config.env.production as Record<string, any>;
const environments: [string, Record<string, any>][] = [
  ["preview (top level)", config],
  ["production", production],
];

describe("the config declares exactly the crons the jobs need", () => {
  test("both environments fire every required cron", () => {
    const required = requiredCrons(buildJobs({ gate: writerGate(undefined) } as never));
    for (const [name, envConfig] of environments) {
      const declared: string[] = envConfig.triggers?.crons ?? [];
      for (const cron of required) {
        assert.ok(declared.includes(cron), `${name} must declare cron ${cron} or that job never runs`);
      }
    }
  });

  test("no cron is declared that no job answers", () => {
    const required = new Set(requiredCrons(buildJobs({ gate: writerGate(undefined) } as never)));
    for (const [name, envConfig] of environments) {
      for (const cron of envConfig.triggers?.crons ?? []) {
        assert.ok(required.has(cron), `${name} declares ${cron} but no job answers it — a tick that does nothing`);
      }
    }
  });
});

describe("bindings match the names the code reads", () => {
  test("every required binding is declared in both environments", () => {
    for (const [name, envConfig] of environments) {
      const declared = new Set<string>([
        ...(envConfig.hyperdrive ?? []).map((h: { binding: string }) => h.binding),
        ...(envConfig.queues?.producers ?? []).map((q: { binding: string }) => q.binding),
        ...(envConfig.r2_buckets ?? []).map((r: { binding: string }) => r.binding),
      ]);
      for (const required of REQUIRED_BINDINGS) {
        assert.ok(declared.has(required), `${name} is missing binding ${required}`);
      }
      assert.ok(
        !declared.has("BACKUPS"),
        `${name} must NOT bind R2: the backup runner is external, and binding it would put a ` +
          "backup-capable credential on the public request path",
      );
    }
  });

  test("the queue consumer has bounded retries and its own dead-letter queue", () => {
    for (const [name, envConfig] of environments) {
      const consumer = (envConfig.queues?.consumers ?? [])[0];
      assert.ok(consumer, `${name} must consume the delivery queue`);
      assert.ok(consumer.max_retries > 0 && consumer.max_retries <= 10, `${name}: retries must be bounded`);
      assert.equal(
        consumer.dead_letter_queue,
        `${consumer.queue}-dlq`,
        `${name}: without a dead-letter queue a poison message circulates forever`,
      );
    }
  });

  /**
   * THE ISOLATION THE WRITER GATE SHOULD NOT HAVE TO PROVIDE.
   *
   * A Cloudflare Queue accepts exactly one consumer. While both environments named the same queue, the
   * preview held it and production's deploy was refused — and every approval delivery production
   * enqueued would have been handed to the preview, with only the writer gate refusing each claim.
   * Separate queues make a preview structurally unable to touch production's deliveries.
   */
  test("the two environments never share a queue", () => {
    const queuesOf = (envConfig: Record<string, any>): string[] => [
      ...(envConfig.queues?.producers ?? []).map((p: { queue: string }) => p.queue),
      ...(envConfig.queues?.consumers ?? []).map((c: { queue: string }) => c.queue),
      ...(envConfig.queues?.consumers ?? []).map((c: { dead_letter_queue: string }) => c.dead_letter_queue),
    ];
    const previewQueues = new Set(queuesOf(config));
    for (const queue of queuesOf(production)) {
      assert.ok(
        !previewQueues.has(queue),
        `both environments use ${queue}. One consumer per queue means one deploy wins, and the loser's ` +
          "messages go to the wrong Worker.",
      );
    }
  });

  test("a queue and its consumer agree, in both environments", () => {
    for (const [name, envConfig] of environments) {
      const produced = (envConfig.queues?.producers ?? []).map((p: { queue: string }) => p.queue);
      const consumed = (envConfig.queues?.consumers ?? []).map((c: { queue: string }) => c.queue);
      assert.deepEqual(produced, consumed, `${name} produces into a queue it does not consume`);
    }
  });
});

describe("both environments ship in the safe posture", () => {
  /**
   * THE PROPERTY THAT MATTERS MOST IN THIS FILE.
   *
   * A deploy from this config must not be able to spend money or claim production writes. Both gates
   * default to "0", and only a deliberate change makes either "1".
   */
  test("financial arming is off in every environment", () => {
    for (const [name, envConfig] of environments) {
      assert.equal(envConfig.vars?.UNTCH_FINANCIAL_ARMED, "0", `${name} must ship financially disarmed`);
    }
  });

  /**
   * EXACTLY ONE DEPLOYMENT OWNS PRODUCTION WRITES.
   *
   * Before cutover that was Railway and both environments shipped "0". Railway is now frozen — its
   * deployments removed, zero row growth verified, all 74 tables byte-identical — so production claims
   * writes and preview must not. Two writers against one database is worse than none: a preview
   * sweeping expiries against production rows would expire real approvals.
   */
  test("production owns writes and preview never does", () => {
    assert.equal(
      production.vars?.UNTCH_PRODUCTION_WRITER_ACTIVE,
      "1",
      "production owns production writes after cutover",
    );
    assert.equal(
      config.vars?.UNTCH_PRODUCTION_WRITER_ACTIVE,
      "0",
      "a preview must never claim production writes — it shares the production database",
    );
  });

  /**
   * A var whose absence stops the Worker serving at all, so its absence must fail here rather than at
   * the first request after a deploy. The value is checked too: the x402 document publishes it as the
   * payee, and a wrong address there sends USDT0 somewhere Untch does not control.
   */
  test("both environments declare the committed payee", () => {
    for (const [name, envConfig] of environments) {
      for (const required of REQUIRED_VARS) {
        assert.ok(envConfig.vars?.[required]?.trim(), `${name} must declare ${required}`);
      }
      assert.equal(
        envConfig.vars?.PAY_TO_ADDRESS,
        ROLE_PAY_TO,
        `${name} publishes a payee that is not the committed role address`,
      );
    }
  });

  test("no secret value is committed", () => {
    const raw = readFileSync(CONFIG, "utf8");
    for (const forbidden of [
      "OKX_API_KEY",
      "OKX_SECRET_KEY",
      "OKX_PASSPHRASE",
      "CONSUMER_SESSION_SECRET",
      "APPROVAL_ACTION_TOKEN_SECRET",
      "DISCORD_BOT_TOKEN",
      "postgres://",
      "postgresql://",
    ]) {
      assert.ok(!raw.includes(forbidden), `${forbidden} must be a wrangler secret, never a committed var`);
    }
  });
});

describe("a preview can never be mistaken for the listed endpoint", () => {
  test("the two environments have different Worker names", () => {
    assert.notEqual(config.name, production.name, "one name would deploy preview over production");
    assert.match(config.name, /preview/);
    assert.equal(production.name, "untch-asp");
  });

  test("preview declares no production base URL", () => {
    assert.equal(
      config.vars?.ASP_PUBLIC_URL,
      undefined,
      "a preview that advertises asp.untch.xyz tells a reviewer the preview IS the listing",
    );
    assert.equal(config.vars?.UNTCH_ENVIRONMENT, "preview");
  });

  test("production advertises the listed endpoint and nothing else", () => {
    assert.equal(production.vars?.ASP_PUBLIC_URL, "https://asp.untch.xyz");
    assert.equal(production.vars?.UNTCH_ENVIRONMENT, "production");
  });

  test("neither environment attaches a custom domain in config", () => {
    for (const [name, envConfig] of environments) {
      assert.equal(envConfig.routes, undefined, `${name} must not bind a route in config`);
      assert.equal(
        envConfig.custom_domains,
        undefined,
        `${name}: asp.untch.xyz is attached deliberately at cutover, not by a deploy`,
      );
    }
  });
});

describe("runtime compatibility", () => {
  test("nodejs_compat is enabled, because pg and node:dns need it", () => {
    assert.ok((config.compatibility_flags ?? []).includes("nodejs_compat"));
  });

  test("observability is on, so a stalled cron is visible", () => {
    for (const [name, envConfig] of environments) {
      assert.equal(envConfig.observability?.enabled, true, `${name} must emit logs`);
    }
  });
});
