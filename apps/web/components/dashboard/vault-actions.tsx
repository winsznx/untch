"use client";

import { useRef, useState } from "react";
import { parseUnits, type Address } from "viem";
import { ERC20_ABI, VAULT_FACTORY, VAULT_FACTORY_ABI, VAULT_TOKEN } from "../../lib/chain/contracts";
import {
  buildApprove,
  buildDeployVault,
  buildDeposit,
  buildOwnerWithdraw,
  buildVaultPause,
} from "../../lib/chain/vault-tx";
import { makePublicClient } from "../../lib/wallet/provider";
import { addressUrl } from "../../lib/onchain";
import { TxButton, type TxStep } from "../wallet/tx-button";
import { useWallet } from "../wallet/wallet-context";

/**
 * The operator's own direct vault actions (§15 #6): deploy a per-agent vault, deposit into it, withdraw
 * (the unconditional I4 owner path), and pause. These are real transactions signed by the connected owner
 * wallet against the deployed UntchVaultFactory / UntchVault on X Layer testnet. Deploy creates a vault
 * owned by the connected wallet, so deposit / withdraw / pause act on a vault the operator actually owns
 * (withdraw and pause are owner-only and would revert against the shared demo vault). The always-on Mode C
 * oracle spend-signing service is deliberately not here: nothing below signs a `spend()`.
 */

const DEMO_AGENT: Address = "0x000000000000000000000000000000000000A9E7";
const DEMO_ORACLE: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const EPOCH_LEN_SECS = 86_400n;
const PER_TX_CAP_DISPLAY = "100";
const EPOCH_BUDGET_DISPLAY = "250";

export function VaultActions() {
  const w = useWallet();
  const [deployedVault, setDeployedVault] = useState<Address | null>(null);
  const [amount, setAmount] = useState("1.0");
  const predictedRef = useRef<Address | null>(null);

  const owner = w.address;
  const hasVault = deployedVault !== null;

  function deployParams(decimals: number) {
    return {
      owner: owner!,
      agent: DEMO_AGENT,
      oracle: DEMO_ORACLE,
      perTxCap: parseUnits(PER_TX_CAP_DISPLAY, decimals),
      epochBudget: parseUnits(EPOCH_BUDGET_DISPLAY, decimals),
      epochLenSecs: EPOCH_LEN_SECS,
      tokenAllow: [VAULT_TOKEN] as const,
      requireAnchoredIntent: true,
    };
  }

  async function tokenDecimals(): Promise<number> {
    return Number(
      await makePublicClient().readContract({ address: VAULT_TOKEN, abi: ERC20_ABI, functionName: "decimals" }),
    );
  }

  async function prepareDeploy(): Promise<TxStep[]> {
    if (!owner) throw new Error("Connect a wallet first.");
    const decimals = await tokenDecimals();
    const params = deployParams(decimals);
    const predicted = await makePublicClient().readContract({
      address: VAULT_FACTORY,
      abi: VAULT_FACTORY_ABI,
      functionName: "computeVaultAddress",
      args: [
        params.owner,
        params.agent,
        params.oracle,
        params.perTxCap,
        params.epochBudget,
        params.epochLenSecs,
        [...params.tokenAllow],
        params.requireAnchoredIntent,
      ],
    });
    predictedRef.current = predicted;
    return [{ label: "Deploy vault", call: buildDeployVault(params) }];
  }

  async function prepareDeposit(): Promise<TxStep[]> {
    if (!owner || !deployedVault) throw new Error("Deploy your vault first.");
    const decimals = await tokenDecimals();
    const amt = parseUnits(amount || "0", decimals);
    if (amt <= 0n) throw new Error("Enter an amount above zero.");
    const allowance = (await makePublicClient().readContract({
      address: VAULT_TOKEN,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [owner, deployedVault],
    })) as bigint;
    const steps: TxStep[] = [];
    if (allowance < amt) steps.push({ label: "Approve token", call: buildApprove(VAULT_TOKEN, deployedVault, amt) });
    steps.push({ label: "Deposit", call: buildDeposit(deployedVault, VAULT_TOKEN, amt) });
    return steps;
  }

  async function prepareWithdraw(): Promise<TxStep[]> {
    if (!owner || !deployedVault) throw new Error("Deploy your vault first.");
    const decimals = await tokenDecimals();
    const amt = parseUnits(amount || "0", decimals);
    if (amt <= 0n) throw new Error("Enter an amount above zero.");
    return [{ label: "Owner withdraw", call: buildOwnerWithdraw(deployedVault, VAULT_TOKEN, owner, amt) }];
  }

  return (
    <div className="flex flex-col gap-4">
      <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Owner actions</span>

      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>Your vault</span>
        {hasVault ? (
          <a href={addressUrl("testnet", deployedVault!)} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
            {deployedVault!.slice(0, 10)}…{deployedVault!.slice(-6)}
          </a>
        ) : (
          <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>deploy to create one</span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <label className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>Amount</label>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className="w-28 rounded-inputs px-3 py-2 text-body-sm"
          style={{ background: "var(--color-canvas)", border: "1px solid var(--color-border-soft)", color: "var(--color-text)", fontFamily: "ui-monospace, monospace" }}
        />
        <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>USDT · deposit / withdraw</span>
      </div>

      <div className="flex flex-wrap gap-3">
        <TxButton label="Deploy" prepare={prepareDeploy} requireAuth onConfirmed={() => setDeployedVault(predictedRef.current)} />
        <TxButton label="Deposit" prepare={prepareDeposit} requireAuth disabled={!hasVault} variant="signal" />
        <TxButton label="Withdraw" prepare={prepareWithdraw} requireAuth disabled={!hasVault} variant="signal" />
        <TxButton
          label="Pause"
          prepare={() => {
            if (!deployedVault) throw new Error("Deploy your vault first.");
            return [{ label: "Pause vault", call: buildVaultPause(deployedVault, false) }];
          }}
          requireAuth
          disabled={!hasVault}
          variant="signal"
        />
      </div>

      <p className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>
        The oracle key cannot withdraw or transfer funds. Owner withdraw is unconditional and needs nothing
        from Untch (invariant I4).
      </p>
    </div>
  );
}
