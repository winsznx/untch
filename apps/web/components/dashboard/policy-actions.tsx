"use client";

import { useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { POLICY_REGISTRY, POLICY_REGISTRY_ABI } from "../../lib/chain/contracts";
import {
  buildPausePolicy,
  buildRegisterPolicy,
  buildResumePolicy,
  buildUpdatePolicy,
  computePolicyHash,
  type PolicyRules,
} from "../../lib/chain/policy-tx";
import { makePublicClient } from "../../lib/wallet/provider";
import { TxButton, type TxStep } from "../wallet/tx-button";
import { useWallet } from "../wallet/wallet-context";

/**
 * The real PolicyRegistry write surface (§15 #2). The operator edits the ruleset as raw JSON; the
 * canonical policy hash (@untch/canon) recomputes live as they type, so what they will anchor is visible
 * before they sign. "Create" registers a brand-new policy owned by the connected wallet; the id it lands
 * at is read from the registry just before broadcast and captured on confirm, which is what then enables
 * "Update" and "Pause" on that policy (you can only update a policy you own, so the flow deliberately
 * operates on the operator's OWN policy rather than the shared demo one, which would revert).
 */

/** The demo agent the guided rules govern, matching the deploy scripts + anchored demo policy. */
const DEMO_AGENT: Address = "0x000000000000000000000000000000000000A9E7";

export function PolicyActions({ initialRules }: { initialRules: PolicyRules }) {
  const w = useWallet();
  const [rulesText, setRulesText] = useState(() => JSON.stringify(initialRules, null, 2));
  const [ownedPolicyId, setOwnedPolicyId] = useState<bigint | null>(null);
  const predictedRef = useRef<bigint | null>(null);

  const parsed = useMemo<{ rules: PolicyRules; hash: string } | { error: string }>(() => {
    try {
      const rules = JSON.parse(rulesText) as PolicyRules;
      return { rules, hash: computePolicyHash(rules) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Invalid JSON" };
    }
  }, [rulesText]);

  const ok = "rules" in parsed;

  async function prepareCreate(): Promise<TxStep[]> {
    if (!ok) throw new Error("Fix the policy JSON first.");
    if (!w.address) throw new Error("Connect a wallet first.");
    const predicted = (await makePublicClient().readContract({
      address: POLICY_REGISTRY,
      abi: POLICY_REGISTRY_ABI,
      functionName: "nextPolicyId",
      args: [w.address],
    })) as bigint;
    predictedRef.current = predicted;
    const { request } = buildRegisterPolicy({ agent: DEMO_AGENT, rules: parsed.rules });
    return [{ label: "Register policy", call: request }];
  }

  function prepareUpdate(): TxStep[] {
    if (!ok) throw new Error("Fix the policy JSON first.");
    if (ownedPolicyId === null) throw new Error("Create a policy first.");
    const { request } = buildUpdatePolicy({ policyId: ownedPolicyId, rules: parsed.rules });
    return [{ label: "Update policy", call: request }];
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Raw JSON (editable)</span>
        <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>
          {ownedPolicyId !== null ? `your policyId ${short(ownedPolicyId.toString())}` : "not yet registered"}
        </span>
      </div>

      <textarea
        value={rulesText}
        onChange={(e) => setRulesText(e.target.value)}
        spellCheck={false}
        rows={16}
        className="w-full overflow-x-auto rounded-inputs p-4 text-caption-lg"
        style={{ background: "var(--color-canvas)", border: `1px solid ${ok ? "var(--color-border-soft)" : "var(--color-signal)"}`, color: "var(--color-inverse-canvas)", fontFamily: "ui-monospace, monospace" }}
      />

      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>Policy hash (live)</span>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, color: ok ? "var(--color-data)" : "var(--color-signal)" }}>
          {ok ? parsed.hash : parsed.error}
        </span>
      </div>

      <div className="flex flex-wrap gap-3">
        <TxButton
          label="Create policy"
          prepare={prepareCreate}
          requireAuth
          disabled={!ok}
          onConfirmed={() => setOwnedPolicyId(predictedRef.current)}
        />
        <TxButton label="Update policy" prepare={prepareUpdate} requireAuth disabled={!ok || ownedPolicyId === null} variant="signal" />
        <TxButton
          label="Pause policy"
          prepare={() => stepFor("Pause policy", ownedPolicyId, (id) => buildPausePolicy(id))}
          requireAuth
          disabled={ownedPolicyId === null}
          variant="signal"
        />
        <TxButton
          label="Resume policy"
          prepare={() => stepFor("Resume policy", ownedPolicyId, (id) => buildResumePolicy(id))}
          requireAuth
          disabled={ownedPolicyId === null}
          variant="signal"
        />
      </div>

      <p className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>
        Create registers a new policy owned by your connected wallet. Update, pause, and resume act on that
        policy. Each is a real transaction you sign in your wallet and confirm on X Layer testnet.
      </p>
    </div>
  );
}

function stepFor(label: string, id: bigint | null, build: (id: bigint) => TxStep["call"]): TxStep[] {
  if (id === null) throw new Error("Create a policy first.");
  return [{ label, call: build(id) }];
}

function short(v: string): string {
  return v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
}
