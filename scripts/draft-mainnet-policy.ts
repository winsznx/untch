/**
 * Build — and only build — the mainnet policy registration a user's own wallet must send.
 *
 * WHY A SCRIPT AND NOT A CURL
 *
 * The production route that does this needs a wallet-backed session, which needs a signature this
 * process cannot produce and must not try to. So the artefacts a person needs in order to DECIDE —
 * the exact rules, the hash they commit to, the calldata, the address that must send it and the event
 * that will prove it worked — are computed here, from the same pure functions the route uses, and
 * printed. Nothing is broadcast. Nothing is stored. No key is read.
 *
 * The derivation is deterministic: `derivePolicyRules` and `hashCanonicalJson` are pure, so the hash
 * printed here is byte-identical to the one `/consumer/policies/draft` will return for the same input
 * on the server. That is what makes this a preview rather than a second implementation — if the two
 * ever disagreed, the sync would refuse, because `syncRegistration` re-hashes the rules against what
 * the chain anchored.
 *
 *   pnpm tsx scripts/draft-mainnet-policy.ts --owner 0x… [--agent 0x…] [--expiry 2026-09-01T00:00:00Z]
 */

// Relative imports, matching every other script here: `scripts/` is not a workspace package and has
// no `node_modules/@untch` of its own, so a bare specifier resolves to nothing.
import { hashCanonicalJson } from "../packages/canon/src/index";
import { parsePolicyRules, ViemRegistryReader } from "../packages/policy-store/src/index";
import { derivePolicyRules, summarisePolicyRules } from "../services/asp/src/consumer/policy-shape";
import { CHAIN_REGISTRY } from "../packages/shared/src/chain-registry";
import { getAddress, type Address, type Chain, type Hex } from "viem";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : null;
}

const X_LAYER_MAINNET = 196;

function main(): void {
  const ownerRaw = arg("owner");
  if (!ownerRaw) {
    console.error(
      "an --owner is required: PolicyRegistry.registerPolicy makes msg.sender the owner, so the\n" +
        "address that will SEND this transaction has to be named before the calldata means anything.",
    );
    process.exit(2);
  }
  const owner = getAddress(ownerRaw) as Address;
  /**
   * The agent a policy governs is immutable on chain once registered.
   *
   * Defaulted to the owner rather than to an Untch-held address, because a policy whose agent is a
   * key Untch controls is a policy Untch can spend under. Naming the owner means the policy governs
   * the user's own wallet until they deliberately point it elsewhere.
   */
  const agent = getAddress(arg("agent") ?? ownerRaw) as Address;

  const chain = CHAIN_REGISTRY.find((c) => c.chainId === X_LAYER_MAINNET);
  if (!chain?.contracts?.policyRegistry) {
    console.error("the chain registry has no PolicyRegistry for chain 196 — refusing to guess one");
    process.exit(2);
    return;
  }
  const registry = getAddress(chain.contracts.policyRegistry) as Address;

  /**
   * The rules, exactly as the brief states them.
   *
   * `autoApproveAtOrBelow` 5.00 and `hardCap` 8.00 are the two numbers the demos turn on: 4.00 is
   * automatic, 6.00 escalates, and nothing above 8.00 is authorised even with an approval. The expiry
   * is short on purpose — a policy that outlives the reason it was created is a standing authority
   * nobody revisits.
   */
  const expiry = arg("expiry") ?? "2026-09-30T00:00:00.000Z";
  const intent = {
    name: "Untch Builder Demo",
    currency: "USDT0",
    perActionLimit: "8.00",
    dailyLimit: "20.00",
    autoApproveAtOrBelow: "5.00",
    hardCap: "8.00",
    allowedCapabilities: ["battle_card", "owned_work.demo"],
    expiry,
    duplicateWindowMinutes: 60,
    quoteTolerancePercent: 0,
  };

  const derived = derivePolicyRules(intent);
  const rules = parsePolicyRules(derived.rules);
  const policyHash = hashCanonicalJson(rules as unknown as Record<string, unknown>) as Hex;
  const expiryUnix = Math.floor(Date.parse(expiry) / 1000);
  /**
   * A reader, not a registry client.
   *
   * `ViemRegistryReader` holds a PUBLIC client and no key, and `buildRegister` is pure encoding — no
   * request leaves this process. Using it rather than re-encoding the call here means the calldata
   * printed is produced by the same function the production route calls, so the two cannot drift.
   */
  const viemChain: Chain = {
    id: X_LAYER_MAINNET,
    name: chain.name,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [...chain.rpcUrls] } },
  };
  const reader = new ViemRegistryReader({
    chain: viemChain,
    rpcUrl: chain.rpcUrls[0] ?? "https://rpc.xlayer.tech",
    registry,
  });
  const call = reader.buildRegister(agent, policyHash, BigInt(expiryUnix));

  const out = {
    checkpoint: "MAINNET_POLICY_BROADCAST_APPROVAL_REQUIRED",
    network: { chainId: X_LAYER_MAINNET, name: chain.name, explorer: chain.explorerUrl },
    policyRegistry: registry,
    owner,
    agent,
    policyHash,
    expiry: { iso: expiry, unix: expiryUnix },
    canonicalRules: rules,
    derivedDefaults: derived.derived,
    readable: summarisePolicyRules(rules as unknown as Record<string, unknown>),
    transaction: {
      to: call.to,
      functionName: call.functionName,
      args: call.args.map((a) => (typeof a === "bigint" ? a.toString() : a)),
      data: call.calldata,
      value: "0x0",
      chainId: call.chainId,
    },
    expectedEvent: {
      name: "PolicyRegistered",
      emittedBy: registry,
      // Named field by field, because the sync reads the OWNER from the event rather than trusting
      // whoever reports the transaction — a predicted id and a reverted transaction look identical
      // from the server side.
      fields: { policyId: "uint256 (assigned on chain)", owner: `must equal ${owner}`, agent, policyHash, expiry: expiryUnix },
    },
    /**
     * Not estimated here, and the reason is worth stating rather than leaving as an omission.
     *
     * A gas estimate is an `eth_estimateGas` against the live registry from the sending address. This
     * script holds no key, makes no RPC call, and an estimate produced from a different sender is a
     * number that looks authoritative and is not the one the wallet will use. The wallet estimates it
     * at signing time, against the real state, from the real sender.
     */
    gasEstimate: null,
    gasEstimateNote:
      "not computed here: an estimate from any sender but yours is a different number. Your wallet " +
      "estimates against live state at signing time.",
    doNot: [
      "Do not send this from an Untch operator key. The sender becomes the owner, and a policy Untch owns is not yours.",
      "Do not edit the rules after reading the hash. The hash commits to these exact bytes and the sync will refuse a mismatch.",
    ],
  };

  console.log(JSON.stringify(out, null, 2));
}

main();
