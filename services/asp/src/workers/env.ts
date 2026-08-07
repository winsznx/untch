/**
 * Everything the Worker is given, and the refusal when it is given something it must not act on.
 *
 * Bindings are named here once so the wrangler config, the CI binding check and the runtime cannot
 * drift apart. A binding renamed in one place and not the others fails at the first request that needs
 * it, which on a scheduled handler means the first tick nobody was watching.
 */

/** Cloudflare's Hyperdrive binding, narrowed to what is used. */
export interface HyperdriveBinding {
  readonly connectionString: string;
}

export interface QueueBinding {
  send(body: unknown): Promise<void>;
  sendBatch(messages: { body: unknown }[]): Promise<void>;
}

export interface WorkerEnv {
  // ── bindings ───────────────────────────────────────────────────────────────
  readonly HYPERDRIVE: HyperdriveBinding;
  readonly APPROVAL_DELIVERY: QueueBinding;

  // ── posture ────────────────────────────────────────────────────────────────
  /** Exactly "1" arms financial operations. Nothing else does. */
  readonly UNTCH_FINANCIAL_ARMED?: string;
  /** Exactly "1" transfers production write ownership to this deployment. */
  readonly UNTCH_PRODUCTION_WRITER_ACTIVE?: string;
  /** "preview" | "production". Decides which public base URL is advertised. */
  readonly UNTCH_ENVIRONMENT?: string;

  // ── identity ───────────────────────────────────────────────────────────────
  readonly ASP_PUBLIC_URL?: string;
  /** The published payee for every priced route. Public, and required: see REQUIRED_VARS. */
  readonly PAY_TO_ADDRESS?: string;
  readonly DISCORD_PUBLIC_KEY?: string;
  readonly DISCORD_APPLICATION_ID?: string;

  // ── secrets (never logged, never echoed) ───────────────────────────────────
  readonly OKX_API_KEY?: string;
  readonly OKX_SECRET_KEY?: string;
  readonly OKX_PASSPHRASE?: string;
  readonly CONSUMER_SESSION_SECRET?: string;
  readonly APPROVAL_ACTION_TOKEN_SECRET?: string;
}

/** The exact binding names the wrangler config must declare. Asserted by CI against the config file. */
export const REQUIRED_BINDINGS = ["HYPERDRIVE", "APPROVAL_DELIVERY"] as const;
/**
 * Deliberately empty.
 *
 * There is no R2 binding here on purpose. A Worker cannot run `pg_dump` — it has no subprocess and no
 * PostgreSQL client that speaks the archive format — so the backup runner is an external scheduled
 * job that writes to R2 directly. Binding the bucket to the public Worker would put a backup-capable
 * credential on the request path for no benefit.
 */
export const OPTIONAL_BINDINGS = [] as const;

/**
 * Plain vars the Worker cannot serve without.
 *
 * `PAY_TO_ADDRESS` is here because the x402 discovery document names a payee, and there is no safe
 * default for one. Falling back to a zero address would publish "send USDT0 into a burn"; falling back
 * to a hardcoded literal would let the deployed payee and the committed one drift apart silently. So
 * it is required, and a deployment missing it refuses by name rather than serving a document that
 * misdirects money.
 */
export const REQUIRED_VARS = ["PAY_TO_ADDRESS"] as const;

export class MissingBindingError extends Error {
  constructor(readonly binding: string) {
    super(`binding ${binding} is not present — the Worker cannot serve without it`);
    this.name = "MissingBindingError";
  }
}

/**
 * Check the bindings exist before anything tries to use one.
 *
 * A missing Hyperdrive binding otherwise surfaces as a confusing connection error deep inside a
 * handler, and on a scheduled tick it surfaces nowhere at all.
 */
export function assertBindings(env: Partial<WorkerEnv>): void {
  for (const name of REQUIRED_BINDINGS) {
    if (env[name] === undefined || env[name] === null) throw new MissingBindingError(name);
  }
  for (const name of REQUIRED_VARS) {
    if (!env[name]?.trim()) throw new MissingBindingError(name);
  }
}

export type Environment = "preview" | "production";

export function environmentOf(env: Pick<WorkerEnv, "UNTCH_ENVIRONMENT">): Environment {
  return env.UNTCH_ENVIRONMENT?.trim() === "production" ? "production" : "preview";
}

/**
 * The base URL this deployment may advertise.
 *
 * A preview Worker must never publish `asp.untch.xyz` in a catalog, an OpenAPI document or an x402
 * descriptor: a reviewer or a marketplace validator reading those would be told the preview IS the
 * listed endpoint. Equally a production Worker must never advertise a workers.dev URL. So the value
 * is derived from the environment rather than trusted from configuration, and a mismatch is refused.
 */
export function publicBaseUrl(env: Pick<WorkerEnv, "UNTCH_ENVIRONMENT" | "ASP_PUBLIC_URL">): string {
  const configured = env.ASP_PUBLIC_URL?.trim();
  const environment = environmentOf(env);

  if (environment === "production") {
    if (!configured) return "https://asp.untch.xyz";
    if (configured.includes("workers.dev")) {
      throw new Error("a production deployment must not advertise a workers.dev URL");
    }
    return configured;
  }

  // Preview. Refuse to claim the production hostname whatever the configuration says.
  if (configured && !configured.includes("workers.dev")) {
    throw new Error(
      `a preview deployment must not advertise ${configured} — only the production Worker may claim the listed endpoint`,
    );
  }
  return configured ?? "https://untch-asp-preview.timjosh507.workers.dev";
}
