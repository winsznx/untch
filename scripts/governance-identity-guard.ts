/**
 * Prove a governance target is the address a named service actually signs with, and show every pending
 * operation that could conflict with the one you are about to propose.
 *
 *   pnpm gov:identity --service untch-receipt-writer --key-var WRITER_PRIVATE_KEY \
 *                     --expect 0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5 \
 *                     --contract UntchReceipts --role ADD_WRITER
 *
 * WHY THIS EXISTS
 *
 * On 2026-07-30 a timelocked `ADD_WRITER` executed exactly as approved — the opId, kind, target and eta
 * all matched what had been verified against chain — and it authorised the wrong account.
 *
 * Two failures compounded. The approved target came from the ASP's `MAINNET_WRITER_ADDRESS`, which is
 * the SpendIntentRegistry writer, not the receipt anchorer; nothing in the chain ever compared it to the
 * key `untch-receipt-writer` signs with. And the correct operation — `ADD_WRITER` for the anchorer's
 * real address, maturing 2026-07-31T11:46:46Z — was already pending and went unseen, because the check
 * looked up one opId rather than enumerating the board.
 *
 * Every check passed because every check asked "is this the operation that was approved?" and none asked
 * "is the approval about the right account, and is there already an operation that says so?".
 *
 * So this guard answers both, and refuses the inputs that produced each failure.
 *
 * WHAT IT CANNOT DO
 *
 * Sign, propose, execute or cancel. It reads and refuses. A guard that could also act would eventually
 * be run for its action and trusted for its check.
 */

export {};

import { createPublicClient, http, keccak256, encodeAbiParameters, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const RPC = process.env.XLAYER_RPC_URL?.trim() || "https://rpc.xlayer.tech";
const CHAIN_ID = 196;

const CONTRACTS = {
  UntchReceipts: "0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95",
  SpendIntentRegistry: "0x9c1f89dfddd9ae1f9adda4b30ff338e2aa2db202",
} as const;
type ContractName = keyof typeof CONTRACTS;

/** The timelock's kinds. `NONE` is the zero sentinel and is never a real queued operation. */
const KIND = { ADD_WRITER: 1, REMOVE_WRITER: 2, TRANSFER_ADMIN: 3 } as const;
type RoleName = keyof typeof KIND;

/**
 * Every service whose signing key can become a governance target, and the source path that uses it.
 *
 * This registry is what makes enumeration meaningful: the candidate set below is built from the
 * addresses these services ACTUALLY sign with, so the operation the 2026-07-30 check missed is
 * necessarily in it.
 */
const SERVICES: Readonly<
  Record<string, { readonly keyVar: string; readonly file: string; readonly mustContain: readonly string[] }>
> = {
  "untch-receipt-writer": {
    keyVar: "WRITER_PRIVATE_KEY",
    file: "packages/receipt-writer/src/chain.ts",
    mustContain: ["privateKeyToAccount(opts.writerPrivateKey)", 'functionName: "logReceipts"'],
  },
  "untch-asp": {
    keyVar: "INTENT_WRITER_PRIVATE_KEY",
    file: "services/asp/src/intent-registry.ts",
    mustContain: ["INTENT_WRITER_PRIVATE_KEY"],
  },
};

/** Names that mean "some address I found lying around". Refused as an expectation. */
const GENERIC_SOURCES = ["MAINNET_WRITER_ADDRESS", "WRITER_ADDRESS", "RECEIPT_WRITER_ADDRESS", "ADDRESS"];

const ABI = parseAbi([
  "function isWriter(address) view returns (bool)",
  "function admin() view returns (address)",
  "function opEta(bytes32) view returns (uint64)",
]);

const pub = createPublicClient({ transport: http(RPC) });
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const f = (k: string, v: unknown): void => console.log(`     ${k.padEnd(28)} ${String(v)}`);

const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
};

export function refuse(why: string, detail: readonly string[] = []): never {
  console.error(`\n${red("REFUSED")} ${why}`);
  for (const d of detail) console.error(`  ${d}`);
  process.exit(2);
}

/** `opId = keccak256(abi.encode(kind, target))`, recomputed locally so a chain read can be contradicted. */
export function opIdOf(kind: number, target: string): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "address" }], [kind, target as Hex]));
}

/**
 * The signing key, read from the named service's OWN environment.
 *
 * Never from `.env` and never from a variable that merely sounds right. The service name is part of the
 * question: "what does THIS service sign with", not "what key can I find".
 */
function signingKeyOf(service: string, keyVar: string): string {
  let out: string;
  try {
    out = execFileSync("railway", ["variables", "--service", service, "--kv"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    refuse(`could not read variables for service '${service}'`, [String((err as Error).message).slice(0, 120)]);
  }
  const line = out.split("\n").find((l) => l.startsWith(`${keyVar}=`));
  if (!line) refuse(`service '${service}' has no ${keyVar}`);
  const value = line.slice(keyVar.length + 1).trim();
  // Never echoes the value, even when it is malformed.
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(value)) refuse(`${keyVar} on '${service}' is not a 32-byte private key`);
  return value.startsWith("0x") ? value : `0x${value}`;
}

/** The signing path, verified against source rather than described from memory. */
function assertCallPath(service: string): string {
  const spec = SERVICES[service];
  if (!spec) {
    refuse(`no recorded signing call path for '${service}'`, [
      `known services: ${Object.keys(SERVICES).join(", ")}`,
      "Record its signing path before governing its key.",
    ]);
  }
  let src: string;
  try {
    src = readFileSync(spec.file, "utf8");
  } catch {
    refuse(`the recorded call path file is missing: ${spec.file}`);
  }
  for (const needle of spec.mustContain) {
    if (!src.includes(needle)) {
      refuse(`'${service}' no longer signs the way this guard records`, [
        `${spec.file} does not contain: ${needle}`,
        "Re-read the service before trusting any address derived for it.",
      ]);
    }
  }
  return spec.file;
}

export interface PendingOp {
  readonly kind: number;
  readonly kindName: RoleName;
  readonly target: string;
  readonly targetLabel: string;
  readonly opId: Hex;
  readonly eta: bigint;
  readonly matured: boolean;
}

/**
 * Every pending operation over a DERIVED candidate set, with its honest limitation stated.
 *
 * A Solidity mapping cannot be enumerated on chain, and this RPC caps `getLogs` at 100 blocks, so
 * scanning `OpProposed` from deployment is not practical. Instead the candidates are every address that
 * could plausibly be governed — the service signers this guard derives, every current role holder, and
 * whatever the caller named — crossed with all three kinds.
 *
 * That set necessarily contains the operation missed on 2026-07-30, because it contains the receipt
 * writer's own derived signer. It is NOT a proof that no other operation exists for some address nobody
 * has mentioned, and this function does not claim to be one.
 */
export async function enumeratePending(
  contract: string,
  candidates: readonly { readonly address: string; readonly label: string }[],
  nowTs: number,
): Promise<readonly PendingOp[]> {
  const found: PendingOp[] = [];
  for (const c of candidates) {
    for (const [kindName, kind] of Object.entries(KIND) as [RoleName, number][]) {
      const id = opIdOf(kind, c.address);
      const eta = await pub.readContract({ address: contract as Hex, abi: ABI, functionName: "opEta", args: [id] });
      if (eta !== 0n) {
        found.push({
          kind,
          kindName,
          target: c.address,
          targetLabel: c.label,
          opId: id,
          eta,
          matured: nowTs >= Number(eta),
        });
      }
    }
  }
  return found;
}

async function main(): Promise<void> {
  const service = arg("service");
  const keyVar = arg("key-var");
  const expect = arg("expect");
  const contractName = arg("contract") as ContractName | null;
  const role = arg("role") as RoleName | null;

  /**
   * All five are REQUIRED, and each one closes a different way the incident happened.
   *
   * "Which address does the receipt writer use" is answerable. "What is the writer address" is the
   * question that authorised the wrong account, because it has more than one true answer.
   */
  if (!service) refuse("--service is required: a governance target must be tied to a named service");
  if (!keyVar) refuse("--key-var is required: name the variable that actually signs");
  if (!expect) refuse("--expect is required: state the address you believe it is, so it can be contradicted");
  if (!contractName) refuse(`--contract is required: one of ${Object.keys(CONTRACTS).join(", ")}`);
  if (!role) refuse(`--role is required: one of ${Object.keys(KIND).join(", ")}`);
  if (!CONTRACTS[contractName]) refuse(`unknown contract '${contractName}'`);
  if (!KIND[role]) refuse(`unknown role '${role}'`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(expect)) {
    // A variable NAME here is the 2026-07-30 mistake in its purest form.
    if (GENERIC_SOURCES.includes(expect.toUpperCase())) {
      refuse(`--expect must be an address, not the name of an environment variable`, [
        `'${expect}' is exactly the kind of remembered source that authorised the wrong account.`,
      ]);
    }
    refuse("--expect is not an address");
  }
  if (SERVICES[service]?.keyVar !== keyVar) {
    refuse(`'${service}' does not sign with ${keyVar}`, [
      `recorded signing variable: ${SERVICES[service]?.keyVar ?? "(service unknown)"}`,
    ]);
  }

  const contract = CONTRACTS[contractName];

  console.log(`\n\x1b[1mGOVERNANCE IDENTITY GUARD\x1b[0m`);
  f("service", service);
  f("signing variable", keyVar);
  f("contract", `${contractName} ${contract}`);
  f("intended role", role);

  const callPath = assertCallPath(service);
  f("signing call path", `${callPath} ${green("verified in source")}`);

  const derived = privateKeyToAccount(signingKeyOf(service, keyVar) as Hex).address;
  f("derived from that key", derived);
  f("you expected", expect);

  if (derived.toLowerCase() !== expect.toLowerCase()) {
    refuse("the service does not sign with the address you named", [
      `'${service}'.${keyVar} derives to ${derived}`,
      `you supplied                        ${expect}`,
      "This is the exact mismatch that authorised the wrong account on 2026-07-30.",
    ]);
  }
  console.log(`     ${green("MATCH")} — the named service signs with the address you named`);

  const chainId = await pub.getChainId();
  if (chainId !== CHAIN_ID) refuse(`wrong chain: ${chainId}`);

  // ── current roles, everywhere they could matter ──
  console.log("\n\x1b[1mCURRENT ROLES\x1b[0m");
  for (const [name, address] of Object.entries(CONTRACTS)) {
    const isWriter = await pub.readContract({ address: address as Hex, abi: ABI, functionName: "isWriter", args: [derived] });
    let admin = "n/a";
    try {
      admin = String(await pub.readContract({ address: address as Hex, abi: ABI, functionName: "admin" }));
    } catch {
      // Not every registry exposes admin; absence is not a failure of this check.
    }
    f(name, `isWriter=${isWriter ? green("true") : dim("false")}  admin=${admin}`);
  }

  // ── the board ──
  const candidates: { address: string; label: string }[] = [{ address: derived, label: `${service} signer` }];
  for (const [otherService, spec] of Object.entries(SERVICES)) {
    if (otherService === service) continue;
    try {
      const a = privateKeyToAccount(signingKeyOf(otherService, spec.keyVar) as Hex).address;
      candidates.push({ address: a, label: `${otherService} signer` });
    } catch {
      // A service we cannot read is reported as a gap below rather than silently skipped.
      candidates.push({ address: "0x0000000000000000000000000000000000000000", label: `${otherService} (UNREADABLE)` });
    }
  }
  for (const [name, address] of Object.entries(CONTRACTS)) {
    try {
      const admin = String(await pub.readContract({ address: address as Hex, abi: ABI, functionName: "admin" }));
      if (!candidates.some((c) => c.address.toLowerCase() === admin.toLowerCase())) {
        candidates.push({ address: admin, label: `${name} admin` });
      }
    } catch {
      /* no admin surface */
    }
  }

  const nowTs = Number((await pub.getBlock()).timestamp);
  const pending = await enumeratePending(contract, candidates, nowTs);

  console.log(`\n\x1b[1mPENDING OPERATIONS ON ${contractName}\x1b[0m`);
  console.log(dim(`     candidate set: ${candidates.map((c) => c.label).join(", ")}`));
  if (pending.length === 0) {
    console.log(dim("     none pending across the candidate set"));
  }
  for (const p of pending) {
    const when = new Date(Number(p.eta) * 1000).toISOString();
    const state = p.matured ? yellow("MATURED — executable now") : dim(`matures ${((Number(p.eta) - nowTs) / 3600).toFixed(1)}h`);
    console.log(`     ${p.kindName.padEnd(15)} ${p.target}  ${dim(p.targetLabel)}`);
    console.log(`       opId ${p.opId}`);
    console.log(`       eta  ${when}  ${state}`);
  }

  /**
   * The refusal that would have prevented the incident.
   *
   * An operation achieving what you are about to propose already exists. Proposing another would revert
   * on `OpAlreadyPending`; proposing a DIFFERENT one — which is what happened — quietly widens authority
   * while the operation that was actually needed sits unexecuted.
   */
  const equivalent = pending.find((p) => p.kindName === role && p.target.toLowerCase() === derived.toLowerCase());
  if (equivalent) {
    refuse(`a ${role} operation for this exact address is ALREADY pending`, [
      `opId ${equivalent.opId}`,
      `eta  ${new Date(Number(equivalent.eta) * 1000).toISOString()}${equivalent.matured ? " (matured)" : ""}`,
      "Execute the existing operation. Do not propose a second one.",
    ]);
  }

  // Already in the intended state: the operation would revert at execute, so say so now.
  const isWriterNow = await pub.readContract({ address: contract as Hex, abi: ABI, functionName: "isWriter", args: [derived] });
  if (role === "ADD_WRITER" && isWriterNow) refuse("this address is ALREADY a writer on this contract");
  if (role === "REMOVE_WRITER" && !isWriterNow) refuse("this address is NOT a writer on this contract");

  // Overlapping operations on the same contract, reported rather than blocked: two different addresses
  // being governed at once is legitimate, and is also how one of them gets forgotten.
  const others = pending.filter((p) => p.target.toLowerCase() !== derived.toLowerCase());
  if (others.length > 0) {
    console.log(`\n  ${yellow("NOTE")} ${others.length} other operation(s) are pending on ${contractName}:`);
    for (const o of others) console.log(`     ${o.kindName} → ${o.target} ${dim(o.targetLabel)}`);
    console.log(dim("     Confirm each is still intended before adding another."));
  }

  console.log(`\n  ${green("PASS")} ${derived} is the signer for '${service}', and no ${role} for it is pending.`);
  console.log(dim("  This guard signs nothing. Governance remains a separate, explicit step."));
  console.log(
    dim(
      "  Enumeration covers a derived candidate set (service signers, role holders, the named target),\n" +
        "  not an exhaustive scan: a mapping cannot be enumerated on chain and this RPC caps getLogs at 100 blocks.",
    ),
  );
}

if (process.argv[1]?.includes("governance-identity-guard")) {
  main().catch((err: unknown) => {
    console.error(`\n${red("FAILED")} ${(err as Error).message}`);
    process.exit(1);
  });
}
