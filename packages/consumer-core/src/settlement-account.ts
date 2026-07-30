/**
 * Is a registered settlement account structurally sound, and is it funded?
 *
 * Two questions, answered separately, because an operator can fix one of them by sending a transfer
 * and cannot fix the other at all.
 *
 * SOUNDNESS is about whether the recorded float is really ours to spend. A public authority and a
 * balance are not enough to establish that. On Solana the balance sits in an associated token account,
 * and that account can carry:
 *
 *   • a DELEGATE — a third party approved to transfer the balance out. The authority still looks
 *     correct and the balance still reads correctly; someone else can simply take it.
 *   • a FROZEN state — set by the mint's freeze authority. The balance is visible and unspendable, so
 *     a payment would be authorised, signed, submitted, and fail after the gate had been claimed.
 *   • a CLOSE AUTHORITY — a party who may close the account, reclaiming the rent and sweeping the
 *     remaining balance to themselves.
 *
 * None of the three is visible from the authority address, all three change what the balance means, and
 * checking them is cheap exactly once — at registration. So they are read then, stored, and classified
 * here. A frozen, delegated or closable account is refused rather than warned about: this module runs
 * on the path that decides whether to arm a treasury, and a warning at that moment is a refusal that
 * someone has to remember to act on.
 *
 * FUNDING is deliberately a second answer. An account can be sound and empty, and the honest reading of
 * that is "registered, not funded" — which is a state an operator resolves with a transfer, not a
 * re-registration.
 *
 * This module reads no chain and holds no key. It is a pure classifier over what was already observed,
 * which is what makes it testable without an RPC and safe to call from a route.
 */

import type { AssetRef } from "./assets";
import type { Money } from "./money";
import type { SettlementAccountAttestation, TreasuryAccountRecord } from "./repo";

/** Bumped when the fact set in `SettlementAccountAttestation` changes. Recorded on every record. */
export const SETTLEMENT_REGISTRATION_VERSION = 1;

export type SettlementAccountDefect =
  | "NOT_ATTESTED"
  | "REGISTRATION_VERSION_UNSUPPORTED"
  | "MINT_MISMATCH"
  | "DECIMALS_MISMATCH"
  | "TOKEN_ACCOUNT_MISSING"
  | "TOKEN_ACCOUNT_OWNER_MISMATCH"
  | "TOKEN_PROGRAM_UNEXPECTED"
  | "ACCOUNT_FROZEN"
  | "ACCOUNT_NOT_INITIALIZED"
  | "DELEGATE_PRESENT"
  | "CLOSE_AUTHORITY_PRESENT";

export interface SettlementAccountSoundness {
  readonly sound: boolean;
  readonly defects: readonly { readonly code: SettlementAccountDefect; readonly detail: string }[];
}

/**
 * Classify a stored attestation against the asset the registry names.
 *
 * `asset` comes from `confirmedAssetsFor` — the registry's own record — never from the caller and never
 * from the attestation itself. Comparing an attestation against a mint it supplied would be comparing
 * it against itself.
 *
 * WHY THE ACCEPTED TOKEN PROGRAMS ARE A PARAMETER
 *
 * Two reasons, and the second is the substantive one.
 *
 * A bare 44-character base58 constant is what a secret scanner matches on, and this repository already
 * learned that once: `packages/consumer-providers/src/x402/solana-exact.ts` takes the SPL program
 * addresses from `@solana-program/token` rather than writing them down, with a comment saying why. Two
 * literals here would have produced findings that are false and still have to be triaged.
 *
 * More importantly, the accepted set has to AGREE with the program the payment path derives the
 * associated token account under. `associatedTokenAccountFor` derives it under the classic SPL token
 * program; a Token-2022 mint's associated account is a different address entirely. Accepting a program
 * this build cannot derive an account for would attest one account and later spend from another. So the
 * set comes from the layer that owns the derivation, and this module compares rather than decides.
 */
export function classifySettlementAccount(
  attestation: SettlementAccountAttestation | null | undefined,
  asset: AssetRef,
  acceptedTokenPrograms: readonly string[],
): SettlementAccountSoundness {
  const defects: { code: SettlementAccountDefect; detail: string }[] = [];
  const add = (code: SettlementAccountDefect, detail: string): void => {
    defects.push({ code, detail });
  };

  if (!attestation) {
    return {
      sound: false,
      defects: [
        {
          code: "NOT_ATTESTED",
          detail:
            "this settlement account carries no on-chain attestation, so nothing is known about the " +
            "token account holding its balance",
        },
      ],
    };
  }

  if (attestation.registrationVersion !== SETTLEMENT_REGISTRATION_VERSION) {
    add(
      "REGISTRATION_VERSION_UNSUPPORTED",
      `this account was registered at version ${attestation.registrationVersion}; this build ` +
        `understands ${SETTLEMENT_REGISTRATION_VERSION}. Re-register it.`,
    );
  }

  const expectedMint = asset.address;
  if (expectedMint !== null) {
    if (attestation.mint === null) {
      add("MINT_MISMATCH", `the registry names mint ${expectedMint} but the attestation records none`);
    } else if (attestation.mint !== expectedMint) {
      add(
        "MINT_MISMATCH",
        `the attested mint does not match the ${asset.symbol} mint the registry names for ${asset.chain}`,
      );
    }
  }

  if (attestation.decimals !== asset.decimals) {
    add(
      "DECIMALS_MISMATCH",
      `the attested account uses ${attestation.decimals} decimals; the registry names ${asset.decimals}`,
    );
  }

  /**
   * The token-account checks apply only where the rail HAS a token account.
   *
   * An EVM float holds its balance at the authority address itself, so demanding a token account there
   * would refuse a working Base treasury for lacking a Solana concept. The attestation records `null`
   * for those rails, and the distinction is the chain's, not the caller's.
   */
  const isTokenAccountRail = asset.chain.startsWith("solana:");
  if (isTokenAccountRail) {
    if (attestation.tokenAccount === null) {
      add(
        "TOKEN_ACCOUNT_MISSING",
        "no token account was derived for this authority, so the balance has nowhere to sit",
      );
    }
    if (attestation.tokenProgram === null || !acceptedTokenPrograms.includes(attestation.tokenProgram)) {
      add(
        "TOKEN_PROGRAM_UNEXPECTED",
        "the token account is not owned by a token program this build can derive an associated account " +
          "under, so what was attested and what would be spent from may differ",
      );
    }
    if (attestation.tokenAccountOwner === null) {
      add("TOKEN_ACCOUNT_OWNER_MISMATCH", "the token account reports no owner");
    } else if (attestation.tokenAccountOwner !== attestation.authority) {
      add(
        "TOKEN_ACCOUNT_OWNER_MISMATCH",
        "the token account is owned by a different authority than the one registered, so its balance " +
          "is not spendable by this treasury",
      );
    }
    if (attestation.accountState === "frozen") {
      add(
        "ACCOUNT_FROZEN",
        "the token account is frozen: the balance is readable and unspendable, so a payment would be " +
          "authorised and then fail after the gate had been claimed",
      );
    } else if (attestation.accountState !== "initialized") {
      add(
        "ACCOUNT_NOT_INITIALIZED",
        `the token account state is '${attestation.accountState ?? "unknown"}', not 'initialized'`,
      );
    }
    if (attestation.delegate !== null) {
      add(
        "DELEGATE_PRESENT",
        "the token account has a delegate approved to transfer its balance, so this float is not " +
          "solely under Untch's control",
      );
    }
    if (attestation.closeAuthority !== null) {
      add(
        "CLOSE_AUTHORITY_PRESENT",
        "the token account has a close authority, which may close it and sweep the remaining balance",
      );
    }
  }

  return { sound: defects.length === 0, defects };
}

export interface SettlementAccountFunding {
  readonly funded: boolean;
  readonly observed: bigint;
  readonly required: bigint;
}

/**
 * Does the observed balance clear what one authorisation needs, and stay above the account's floor?
 *
 * The floor is included because the treasury router enforces it at spend time: an account whose balance
 * covers the payment but lands under `minBalance` afterwards refuses there. Reporting it funded here
 * would put that refusal after the gate had been armed, which is the whole class of surprise this
 * readiness work exists to remove.
 */
export function classifySettlementFunding(
  account: TreasuryAccountRecord,
  maxAuthorisedAmount: Money,
): SettlementAccountFunding {
  const observed = BigInt(account.attestation?.observedTokenBalance ?? "0");
  const required = maxAuthorisedAmount.amount + account.minBalance.amount;
  return { funded: observed >= required, observed, required };
}
