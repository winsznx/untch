import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "./db";

/**
 * Reducing a wallet binding's authority, deliberately.
 *
 * WHY THIS EXISTS AS ITS OWN OPERATION
 *
 * `linkWallet` used to upsert `scopes = EXCLUDED.scopes`, so a relink that asked for `["identity"]`
 * silently stripped `policy-authority` from an ACTIVE binding — the account kept its wallet and quietly
 * lost the authority to approve a payment, with nothing recording that it had happened.
 *
 * The relink path now unions, which makes proving you hold a wallet incapable of removing anything.
 * That is the right default and it leaves a real need: an owner sometimes genuinely wants less
 * authority on a binding. This is that operation, and it is deliberately harder than a relink.
 *
 * WHAT IT ASKS FOR THAT A RELINK DOES NOT
 *
 * A fresh signature from the wallet whose authority is being reduced, over a nonce this server issued,
 * naming the exact binding and the exact final scope set. A session alone is not enough: reducing
 * authority is precisely what somebody does with a borrowed session, quietly, before anything else.
 */

export type BindingScopeName = string;

export const DOWNGRADE_CHALLENGE_TTL_MS = 10 * 60_000;

/** Identity is what attaches the wallet. A downgrade reduces what a binding may DO, never who it is. */
export const UNREMOVABLE_SCOPE = "identity" as const;

export type ScopeDowngradeRefusal =
  | "BINDING_NOT_FOUND"
  | "WRONG_ACCOUNT"
  | "BINDING_NOT_ACTIVE"
  | "AUTHORITY_NOT_HELD"
  | "IDENTITY_NOT_REMOVABLE"
  | "NOTHING_TO_REMOVE"
  | "CHALLENGE_NOT_FOUND"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_REPLAYED"
  | "CHALLENGE_BINDING_MISMATCH"
  | "SCOPES_MOVED";

export interface ScopeDowngradeChallenge {
  readonly challengeNonce: string;
  readonly bindingId: string;
  readonly accountId: string;
  readonly address: string;
  readonly scopesBefore: readonly string[];
  readonly scopesAfter: readonly string[];
  readonly scopesRemoved: readonly string[];
  readonly message: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export type ScopeDowngradeStart =
  | { readonly ok: true; readonly challenge: ScopeDowngradeChallenge }
  | { readonly ok: false; readonly refusal: ScopeDowngradeRefusal; readonly detail: string };

export type ScopeDowngradeResult =
  | {
      readonly ok: true;
      readonly downgradeId: string;
      readonly bindingId: string;
      readonly scopesBefore: readonly string[];
      readonly scopesAfter: readonly string[];
      readonly scopesRemoved: readonly string[];
    }
  | { readonly ok: false; readonly refusal: ScopeDowngradeRefusal; readonly detail: string };

const norm = (scopes: readonly string[]): string[] => [...new Set(scopes.map((s) => s.trim()))].sort();

/**
 * The message the wallet signs.
 *
 * It names the binding, the authority being GIVEN UP and the authority that remains, in words rather
 * than as a scope list alone — the person approving this in a wallet popup sees a sentence, and a
 * sentence that says "you will no longer be able to approve payments" is the only part of this flow
 * that can stop a mistake.
 */
export function downgradeMessage(args: {
  readonly address: string;
  readonly bindingId: string;
  readonly scopesRemoved: readonly string[];
  readonly scopesAfter: readonly string[];
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}): string {
  return [
    "Untch — reduce this wallet's authority",
    "",
    `Wallet: ${args.address}`,
    `Binding: ${args.bindingId}`,
    "",
    "You are REMOVING the following authority from this wallet:",
    ...args.scopesRemoved.map((s) => `  - ${s}`),
    "",
    "After this, the wallet keeps only:",
    ...args.scopesAfter.map((s) => `  - ${s}`),
    "",
    args.scopesRemoved.includes("policy-authority")
      ? "This wallet will NO LONGER be able to approve payments under a policy."
      : "This wallet keeps its ability to approve payments under a policy.",
    "",
    "This does not detach the wallet and does not move any funds.",
    `Nonce: ${args.nonce}`,
    `Issued At: ${args.issuedAt}`,
    `Expiration Time: ${args.expiresAt}`,
  ].join("\n");
}

/**
 * Issue one challenge for one reduction.
 *
 * The FINAL scope set is computed here and stored, so the completion cannot present a different set
 * than the one the signer was shown. A caller that names scopes to remove and a caller that names the
 * final set both end up authorising exactly the sentence they read.
 */
export async function startScopeDowngrade(
  pool: Pool,
  args: {
    readonly accountId: string;
    readonly bindingId: string;
    readonly removeScopes: readonly string[];
    readonly nowMs?: number;
  },
): Promise<ScopeDowngradeStart> {
  const now = args.nowMs ?? Date.now();
  const { rows } = await pool.query<{ account_id: string; status: string; scopes: string[] | null; address: string }>(
    `SELECT account_id, status, scopes, address FROM untch_wallet_bindings WHERE binding_id = $1`,
    [args.bindingId],
  );
  const b = rows[0];
  if (!b) return { ok: false, refusal: "BINDING_NOT_FOUND", detail: "no such wallet binding" };
  if (b.account_id !== args.accountId) {
    return { ok: false, refusal: "WRONG_ACCOUNT", detail: "this binding belongs to a different account" };
  }
  if (b.status !== "ACTIVE") {
    return { ok: false, refusal: "BINDING_NOT_ACTIVE", detail: `this binding is ${b.status}` };
  }

  const before = norm(b.scopes ?? []);
  /**
   * Reducing authority is itself an exercise of authority. A binding that cannot approve payments
   * cannot be used to take that ability away from itself — the operation requires the very scope it
   * is usually removing, which is what stops an identity-only session performing it.
   */
  if (!before.includes("policy-authority")) {
    return {
      ok: false,
      refusal: "AUTHORITY_NOT_HELD",
      detail: "reducing authority requires policy-authority on the binding being reduced",
    };
  }

  const remove = norm(args.removeScopes);
  if (remove.includes(UNREMOVABLE_SCOPE)) {
    return {
      ok: false,
      refusal: "IDENTITY_NOT_REMOVABLE",
      detail: "identity is what attaches this wallet; removing it is detaching, which this is not",
    };
  }
  const removable = remove.filter((s) => before.includes(s));
  if (removable.length === 0) {
    return { ok: false, refusal: "NOTHING_TO_REMOVE", detail: "this binding holds none of the named scopes" };
  }
  const after = before.filter((s) => !removable.includes(s));

  const nonce = randomBytes(24).toString("hex");
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + DOWNGRADE_CHALLENGE_TTL_MS).toISOString();
  const message = downgradeMessage({
    address: b.address,
    bindingId: args.bindingId,
    scopesRemoved: removable,
    scopesAfter: after,
    nonce,
    issuedAt,
    expiresAt,
  });

  await pool.query(
    `INSERT INTO untch_wallet_scope_challenges
       (challenge_nonce, account_id, binding_id, scopes_after, message, issued_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [nonce, args.accountId, args.bindingId, after, message, issuedAt, expiresAt],
  );

  return {
    ok: true,
    challenge: {
      challengeNonce: nonce,
      bindingId: args.bindingId,
      accountId: args.accountId,
      address: b.address,
      scopesBefore: before,
      scopesAfter: after,
      scopesRemoved: removable,
      message,
      issuedAt,
      expiresAt,
    },
  };
}

/**
 * Redeem a challenge and apply the reduction, once.
 *
 * The whole thing runs in ONE transaction that locks the binding row, so a relink arriving at the same
 * moment either happens entirely before this (and its unioned scopes are what gets reduced) or
 * entirely after (and it unions against the reduced set). Interleaving is the only outcome that could
 * produce a scope set nobody asked for, and the lock is what removes it.
 *
 * The caller verifies the SIGNATURE — this module never sees a key and has no opinion about wallets.
 * It is handed `proofRef`, the reference to a signature the caller has already checked against the
 * binding's address, and it records that reference so the reduction can be re-verified later.
 */
export async function completeScopeDowngrade(
  pool: Pool,
  args: {
    readonly accountId: string;
    readonly bindingId: string;
    readonly challengeNonce: string;
    readonly proofRef: string;
    readonly by: string;
    readonly nowMs?: number;
  },
): Promise<ScopeDowngradeResult> {
  const now = args.nowMs ?? Date.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const refuse = async (refusal: ScopeDowngradeRefusal, detail: string): Promise<ScopeDowngradeResult> => {
      await client.query("ROLLBACK");
      return { ok: false, refusal, detail };
    };

    /**
     * The challenge is claimed with a conditional UPDATE, so two concurrent completions cannot both
     * pass. A read-then-write would let both see it unconsumed.
     */
    const { rows: claimed } = await client.query<{
      account_id: string;
      binding_id: string;
      scopes_after: string[];
      message: string;
      issued_at: Date;
      expires_at: Date;
    }>(
      `UPDATE untch_wallet_scope_challenges
          SET consumed_at = now()
        WHERE challenge_nonce = $1 AND consumed_at IS NULL
        RETURNING account_id, binding_id, scopes_after, message, issued_at, expires_at`,
      [args.challengeNonce],
    );
    const ch = claimed[0];
    if (!ch) {
      const { rows: seen } = await client.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM untch_wallet_scope_challenges WHERE challenge_nonce = $1`,
        [args.challengeNonce],
      );
      return seen[0]
        ? await refuse("CHALLENGE_REPLAYED", "this downgrade challenge has already been used")
        : await refuse("CHALLENGE_NOT_FOUND", "no such downgrade challenge");
    }
    if (ch.expires_at.getTime() <= now) {
      return await refuse("CHALLENGE_EXPIRED", "this downgrade challenge has expired; start another");
    }
    if (ch.account_id !== args.accountId || ch.binding_id !== args.bindingId) {
      return await refuse("CHALLENGE_BINDING_MISMATCH", "this challenge was issued for a different binding");
    }

    const { rows: bindings } = await client.query<{ status: string; scopes: string[] | null; address: string }>(
      `SELECT status, scopes, address FROM untch_wallet_bindings WHERE binding_id = $1 FOR UPDATE`,
      [args.bindingId],
    );
    const b = bindings[0];
    if (!b) return await refuse("BINDING_NOT_FOUND", "no such wallet binding");
    if (b.status !== "ACTIVE") return await refuse("BINDING_NOT_ACTIVE", `this binding is ${b.status}`);

    const before = norm(b.scopes ?? []);
    const after = norm(ch.scopes_after);
    const removed = before.filter((s) => !after.includes(s));

    /**
     * The scope set moved between issuing and redeeming — a relink added something, or another
     * downgrade already ran. Applying the stored set now would silently remove authority the signer
     * never saw described, so it refuses and asks for a fresh challenge.
     */
    if (!after.every((s) => before.includes(s))) {
      return await refuse(
        "SCOPES_MOVED",
        "this binding's authority changed after the challenge was issued; start another",
      );
    }
    if (removed.length === 0) {
      return await refuse("NOTHING_TO_REMOVE", "this binding no longer holds any of the named scopes");
    }
    if (!after.includes(UNREMOVABLE_SCOPE)) {
      return await refuse("IDENTITY_NOT_REMOVABLE", "identity may not be removed by a downgrade");
    }

    await client.query(
      `UPDATE untch_wallet_bindings
          SET scopes = $2, updated_at = now(), updated_by = $3
        WHERE binding_id = $1`,
      [args.bindingId, after, args.by],
    );

    const downgradeId = `wsd_${randomBytes(16).toString("hex")}`;
    await client.query(
      `INSERT INTO untch_wallet_scope_downgrades
         (downgrade_id, challenge_nonce, account_id, binding_id, address, scopes_before, scopes_after,
          scopes_removed, proof_ref, challenge_digest, issued_at, expires_at, applied_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        downgradeId,
        args.challengeNonce,
        args.accountId,
        args.bindingId,
        b.address,
        before,
        after,
        removed,
        args.proofRef,
        `sha256:${createHash("sha256").update(ch.message, "utf8").digest("hex")}`,
        ch.issued_at.toISOString(),
        ch.expires_at.toISOString(),
        args.by,
      ],
    );

    await client.query("COMMIT");
    return { ok: true, downgradeId, bindingId: args.bindingId, scopesBefore: before, scopesAfter: after, scopesRemoved: removed };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
