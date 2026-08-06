/**
 * Which code is actually serving, and is it actually ready?
 *
 * WHY THIS EXISTS
 *
 * On 2026-07-29 two deployments carrying a new spending gate failed at the build step. No container was
 * ever created, so an older container that predated the gate kept serving. Spending authority was
 * granted to the service in the belief that the new code was live. It was not, and nothing the service
 * emitted made that distinguishable: the running process had no way to say which commit it was built
 * from, and Railway's newest deployment was not the deployment serving traffic.
 *
 * The lesson is narrow and worth stating precisely. The existence of a newer deployment is not evidence
 * that it is running. Anything that grants authority on the assumption that new code is live must first
 * ask the RUNNING PROCESS what it is, and get an answer that cannot be faked by a stale configuration
 * value.
 *
 * WHY THE COMMIT COMES FROM A FILE IN THE ARTEFACT
 *
 * `RAILWAY_GIT_COMMIT_SHA` is only populated for git-connected deployments. This service is uploaded
 * with `railway up`, which ships a directory and carries no git metadata, so that variable is absent
 * and cannot be relied on.
 *
 * A Railway variable set by the deploy script would be worse than nothing. Variables outlive the
 * deployment that was meant to consume them, so a variable saying "commit X" while the build for X
 * failed is a lie of exactly the shape that caused the incident. The attestation is therefore written
 * INTO the uploaded tree, by the deploy script, from a clean export of the commit. It cannot drift from
 * the code beside it, because it travelled with it.
 *
 * Absent attestation is reported as unattested rather than guessed at. An unattested deployment is a
 * deployment that must not be armed, and saying so is more useful than inventing a commit.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Written by `pnpm deploy:asp` into the exported tree, immediately before upload. */
export const ATTESTATION_FILENAME = ".untch-build-attestation.json";

export interface BuildAttestation {
  /** Full commit SHA the uploaded tree was exported from. */
  readonly commit: string;
  readonly branch: string | null;
  /** ISO 8601, when the export was taken. */
  readonly builtAt: string;
  /** How the tree was produced. Only a clean export is trusted. */
  readonly source: string;
}

/**
 * Three distinct facts, deliberately not collapsed into one boolean.
 *
 * `STARTING` means the process is up but has not finished the work that makes it safe to serve.
 * `READY` means every startup gate passed. `FAILED` means a gate failed and will not pass without
 * intervention. A health check that cannot tell STARTING from READY reports a migrating process as
 * healthy, which is how a half-upgraded schema ends up taking traffic.
 */
export type LifecyclePhase = "STARTING" | "READY" | "FAILED";

export interface RailAvailability {
  readonly rails: readonly string[];
}

export interface SolanaPosture {
  /** The proof-gate module is compiled into this build. */
  readonly codePresent: boolean;
  /** Migration 011's table exists in the database this process is connected to. */
  readonly schemaReady: boolean;
  /** `CONSUMER_SOLANA_PROOF_MODE`. */
  readonly proofMode: "enabled" | "disabled";
  /** Whether a secret key is configured. The key itself is never read out of here. */
  readonly signer: "present" | "absent";
  /** `CONSUMER_SOLANA_EXECUTION_ENABLED`. */
  readonly execution: "enabled" | "disabled";
  /** Host only. The Alchemy key lives in the URL path and must never be reported. */
  readonly rpcHost: string | null;
  readonly rpcMode: "read-only" | "read-write";
}

export interface DeploymentInfo {
  readonly app: string;
  readonly phase: LifecyclePhase;
  readonly failureReason: string | null;
  readonly commit: string | null;
  readonly commitShort: string | null;
  readonly branch: string | null;
  readonly builtAt: string | null;
  readonly attested: boolean;
  readonly railwayDeploymentId: string | null;
  readonly startedAt: string;
  readonly readyAt: string | null;
  readonly migrationVersion: string | null;
  readonly settlementRails: readonly string[];
  readonly solana: SolanaPosture;
  readonly baseTreasuryAddress: string | null;
}

/**
 * Find the attestation by walking up from this module.
 *
 * The start command is `pnpm --filter @untch/asp start`, which runs with the package directory as the
 * working directory, while the attestation sits at the repository root of the uploaded tree. Walking up
 * covers both that case and a run from the root, without either caller needing to agree on a depth.
 */
export function readBuildAttestation(startDir?: string): BuildAttestation | null {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, ATTESTATION_FILENAME);
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<BuildAttestation>;
        if (typeof parsed.commit === "string" && parsed.commit.length >= 7) {
          return {
            commit: parsed.commit,
            branch: typeof parsed.branch === "string" ? parsed.branch : null,
            builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "(unknown)",
            source: typeof parsed.source === "string" ? parsed.source : "(unknown)",
          };
        }
      } catch {
        // A malformed attestation is treated as no attestation. Reporting "unattested" is correct and
        // safe; salvaging fields out of a file that failed to parse would be reporting a guess.
        return null;
      }
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/** Host only, never the path. Alchemy and every comparable provider put the key in the path. */
export function rpcHostOf(rawUrl: string | undefined): string | null {
  const raw = rawUrl?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return "(unparseable)";
  }
}

/** Read the Solana posture from the environment. Absent always reads as the safer value. */
export function solanaPostureOf(
  env: NodeJS.ProcessEnv,
  gate: { readonly codePresent: boolean; readonly schemaReady: boolean },
): SolanaPosture {
  const on = (v: string | undefined): boolean => v?.trim() === "1" || v?.trim().toLowerCase() === "true";
  const signerPresent = Boolean(env.CONSUMER_TREASURY_SOLANA_SECRET_KEY?.trim());
  const execution = on(env.CONSUMER_SOLANA_EXECUTION_ENABLED);

  return {
    codePresent: gate.codePresent,
    schemaReady: gate.schemaReady,
    proofMode: on(env.CONSUMER_SOLANA_PROOF_MODE) ? "enabled" : "disabled",
    signer: signerPresent ? "present" : "absent",
    execution: execution ? "enabled" : "disabled",
    rpcHost: rpcHostOf(env.CONSUMER_SOLANA_RPC_URL),
    // A configured RPC with no signer and no execution flag can only read. Naming that explicitly is
    // the difference between "Solana is off" and "Solana is off but reconciliation still works".
    rpcMode: signerPresent && execution ? "read-write" : "read-only",
  };
}

/**
 * The lifecycle a deployment moves through, and the only thing the health check consults.
 *
 * Held as mutable state on purpose: readiness is a fact about this process at this instant, and the
 * health endpoint has to be able to answer before the answer is known. It starts at STARTING, which
 * fails the health check, so Railway cannot route to a process that has not finished migrating.
 */
export class DeploymentLifecycle {
  private phase: LifecyclePhase = "STARTING";
  private failureReason: string | null = null;
  private readonly startedAtIso: string;
  private readyAtIso: string | null = null;
  private migrationVersion: string | null = null;
  private rails: readonly string[] = [];
  private gate = { codePresent: false, schemaReady: false };
  private baseTreasuryAddress: string | null = null;

  /**
   * `attestationDir` is a TEST SEAM and nothing more.
   *
   * `readBuildAttestation` already takes a start directory for exactly this reason; the lifecycle
   * simply passes one through. A deployed process never supplies it, so the search still begins at
   * this module and still walks up to the uploaded tree's root — the attestation cannot be pointed
   * somewhere else by configuration, which is the property that makes it worth trusting.
   *
   * `attestationSource` is how the SAME guarantee is kept on a runtime with no filesystem.
   *
   * Cloudflare Workers cannot walk a directory, so the Worker entry passes a reader that returns the
   * attestation COMPILED INTO ITS BUNDLE. That preserves the property this whole mechanism exists for
   * — the attestation travelled with the code and cannot drift from it — while removing the only
   * reason this file needed `node:fs`. What is deliberately NOT done is reading the commit from a
   * deploy-time variable: variables outlive the deployment that set them, so one saying "commit X"
   * after the build for X failed is a lie of exactly the shape that caused the 2026-07-29 incident.
   */
  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    nowIso?: string,
    private readonly attestationDir?: string,
    private readonly attestationSource?: () => BuildAttestation | null,
  ) {
    this.startedAtIso = nowIso ?? new Date().toISOString();
  }

  recordSchema(migrationVersion: string | null, gateSchemaReady: boolean): void {
    this.migrationVersion = migrationVersion;
    this.gate = { ...this.gate, schemaReady: gateSchemaReady };
  }

  recordGateCode(present: boolean): void {
    this.gate = { ...this.gate, codePresent: present };
  }

  recordRails(rails: readonly string[]): void {
    this.rails = [...rails];
  }

  recordBaseTreasury(address: string | null): void {
    this.baseTreasuryAddress = address;
  }

  markReady(nowIso?: string): void {
    if (this.phase === "FAILED") return;
    this.phase = "READY";
    this.readyAtIso = nowIso ?? new Date().toISOString();
  }

  markFailed(reason: string): void {
    this.phase = "FAILED";
    this.failureReason = reason;
  }

  isReady(): boolean {
    return this.phase === "READY";
  }

  snapshot(): DeploymentInfo {
    const attestation = this.attestationSource
      ? this.attestationSource()
      : readBuildAttestation(this.attestationDir);
    return {
      app: "untch-asp",
      phase: this.phase,
      failureReason: this.failureReason,
      commit: attestation?.commit ?? null,
      commitShort: attestation ? attestation.commit.slice(0, 7) : null,
      branch: attestation?.branch ?? null,
      builtAt: attestation?.builtAt ?? null,
      attested: attestation !== null,
      // Railway populates this in the container. It identifies the deployment; it does not identify
      // the code, which is why it is reported ALONGSIDE the attested commit rather than instead of it.
      railwayDeploymentId: this.env.RAILWAY_DEPLOYMENT_ID?.trim() || null,
      startedAt: this.startedAtIso,
      readyAt: this.readyAtIso,
      migrationVersion: this.migrationVersion,
      settlementRails: this.rails,
      solana: solanaPostureOf(this.env, this.gate),
      baseTreasuryAddress: this.baseTreasuryAddress,
    };
  }
}

/** The startup banner. One block, greppable, and free of anything secret. */
export function describeDeployment(info: DeploymentInfo): string {
  const lines = [
    "UNTCH DEPLOYMENT READY",
    `  app                ${info.app}`,
    `  phase              ${info.phase}`,
    `  commit             ${info.commit ?? "UNATTESTED (not deployed via pnpm deploy:asp)"}`,
    `  branch             ${info.branch ?? "(none)"}`,
    `  builtAt            ${info.builtAt ?? "(unknown)"}`,
    `  deploymentId       ${info.railwayDeploymentId ?? "(not in a Railway container)"}`,
    `  startedAt          ${info.startedAt}`,
    `  readyAt            ${info.readyAt ?? "(not ready)"}`,
    `  migration          ${info.migrationVersion ?? "(unknown)"}`,
    `  proofGateCode      ${info.solana.codePresent ? "present" : "ABSENT"}`,
    `  proofGateSchema    ${info.solana.schemaReady ? "ready" : "NOT READY"}`,
    `  proofMode          ${info.solana.proofMode}`,
    `  solanaSigner       ${info.solana.signer}`,
    `  solanaExecution    ${info.solana.execution}`,
    `  solanaRpcHost      ${info.solana.rpcHost ?? "(unset)"} (${info.solana.rpcMode})`,
    `  settlementRails    ${info.settlementRails.length > 0 ? info.settlementRails.join(", ") : "NONE"}`,
    `  baseTreasury       ${info.baseTreasuryAddress ?? "(unset)"}`,
  ];
  if (info.failureReason) lines.push(`  failure            ${info.failureReason}`);
  return lines.join("\n");
}
