import { hashCanonicalJson } from "@untch/canon";
import { getAddress, type Address, type Hex } from "viem";
import type { RegistryReader } from "./registry";
import type { PolicyRepo } from "./repo";
import { parsePolicyRules, PolicyValidationError } from "./rules";
import type { BuildCreatePolicyResult, OnchainRef, StoredPolicy, SyncRegistrationResult } from "./types";

/**
 * Per-caller `create_spend_policy` (PRD §6.2 / §10.1, the target state finally built).
 *
 * The backend does NOT sign on the caller's behalf. `PolicyRegistry.registerPolicy` is `msg.sender ==
 * owner` — direct, no relayer — so the ONLY way a caller becomes the on-chain owner is to submit the tx
 * with their own key. This service respects that instead of working around it:
 *
 *   1. `buildCreate` — canonicalize + hash the rules (via @untch/canon, REUSED) and return the UNSIGNED
 *      registerPolicy calldata. No key, no tx, no owner yet.
 *   2. the caller's own wallet signs + submits it → the caller becomes the on-chain owner.
 *   3. `syncRegistration` — read the confirmed `PolicyRegistered` event and store the row with `owner`
 *      set to whatever address ACTUALLY submitted it. The stored rules must hash to the event's
 *      `policyHash`, so a caller can neither claim a different owner (read from chain) nor store rules
 *      that don't match what was anchored.
 *
 * Never signs. It cannot: it holds a key-free `RegistryReader`, not a wallet.
 */
export class PolicyRegistrationService {
  constructor(
    private readonly repo: PolicyRepo,
    private readonly reader: RegistryReader,
  ) {}

  get registry(): Address {
    return this.reader.registryAddress;
  }

  get chainId(): number {
    return this.reader.chainId;
  }

  /** Validate + hash the rules and return the unsigned registerPolicy call for the caller to sign. */
  buildCreate(args: { agent: Address; rules: unknown }): BuildCreatePolicyResult {
    const rules = parsePolicyRules(args.rules); // throws PolicyValidationError on a bad ruleset
    const agent = getAddress(args.agent);
    const policyHash = hashCanonicalJson(rules as unknown as Record<string, unknown>) as Hex;
    const expiry = expiryUnixFromRules(rules.expiry);

    const call = this.reader.buildRegister(agent, policyHash, BigInt(expiry));
    return {
      policyHash,
      registry: this.reader.registryAddress,
      chainId: this.reader.chainId,
      agentId: agent,
      expiry,
      unsignedTx: {
        to: call.to,
        functionName: call.functionName,
        args: call.args,
        calldata: call.calldata,
        value: "0x0",
        chainId: call.chainId,
      },
    };
  }

  /**
   * Sync Postgres from a confirmed registration. `owner` comes from the on-chain event (the real
   * submitter), never from the caller. `rules` must hash to the anchored `policyHash` or the sync is
   * rejected — binding the stored ruleset to what the chain committed. Idempotent: a row that already
   * exists (re-sync, or a dashboard-created policy) is left as-is and returned with `alreadyStored`.
   */
  async syncRegistration(args: { txHash: Hex; rules: unknown }): Promise<SyncRegistrationResult> {
    const rules = parsePolicyRules(args.rules);
    const rulesHash = hashCanonicalJson(rules as unknown as Record<string, unknown>) as Hex;

    const reg = await this.reader.getRegistrationFromReceipt(args.txHash);

    if (reg.policyHash.toLowerCase() !== rulesHash.toLowerCase()) {
      throw new PolicyValidationError(
        "RULES_HASH_MISMATCH",
        `the supplied rules hash to ${rulesHash} but tx ${args.txHash} anchored policyHash ${reg.policyHash} — ` +
          "resubmit the exact rules that were registered (the on-chain hash is authoritative)",
      );
    }

    const policyId = reg.policyId.toString();
    const existing = await this.repo.getById(policyId);
    if (existing) {
      return toResult(reg, true);
    }

    const owner = reg.owner;
    const onchainRef: OnchainRef = {
      chainId: this.reader.chainId,
      registry: this.reader.registryAddress,
      registerTx: reg.txHash,
      registerBlock: reg.blockNumber,
      lastTx: reg.txHash,
      lastBlock: reg.blockNumber,
    };
    const nowIso = new Date().toISOString();
    const stored: StoredPolicy = {
      id: policyId,
      owner,
      agentId: reg.agent,
      version: reg.version,
      status: "ACTIVE",
      policyHash: reg.policyHash,
      expiry: Number(reg.expiry),
      onchainRef,
      rules,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.repo.insert(stored);
    return toResult(reg, false);
  }
}

function toResult(
  reg: Awaited<ReturnType<RegistryReader["getRegistrationFromReceipt"]>>,
  alreadyStored: boolean,
): SyncRegistrationResult {
  return {
    policyId: reg.policyId.toString(),
    owner: reg.owner,
    agentId: reg.agent,
    policyHash: reg.policyHash,
    txHash: reg.txHash,
    blockNumber: reg.blockNumber,
    version: reg.version,
    expiry: Number(reg.expiry),
    alreadyStored,
  };
}

function expiryUnixFromRules(expiryIso: string): number {
  const ms = Date.parse(expiryIso);
  if (Number.isNaN(ms)) throw new Error(`rules.expiry is not a parseable instant: ${expiryIso}`);
  return Math.floor(ms / 1000);
}
