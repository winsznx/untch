import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pairwiseDistinct, type Role } from "./soak/role-lib";
import {
  isConfirmed,
  settlementToken,
  TOKENS,
  X_LAYER_MAINNET_ID,
  X_LAYER_TESTNET_ID,
  type ConfirmedToken,
} from "../packages/shared/src/chains";

/**
 * Deploy the Untch contract suite with SEPARATED role keys (the fix for the owner-key-loss incident).
 * Unlike the per-contract deploy scripts — which hardcode `owner = deployer` and would rebuild the
 * owner-lock — this sets the vault's `_owner` = OWNER_ADDRESS and `_oracle` = ORACLE_ADDRESS at
 * construction, authorizes WRITER_ADDRESS, and transfers admin to ADMIN_ADDRESS LAST, so the deployer
 * ends holding NO live role. Confirm afterward with `pnpm verify:deployment-roles`.
 *
 * TESTNET by default; refuses X Layer mainnet (196) unless ALLOW_MAINNET=1.
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY  signs the deploy (required to BROADCAST). Never committed; supplied at runtime.
 *   OWNER_ADDRESS / ORACLE_ADDRESS / ADMIN_ADDRESS / WRITER_ADDRESS   the four role PUBLIC addresses.
 *   RPC_URL               default X Layer testnet.
 *   TIMELOCK_DELAY        UntchReceipts timelock seconds (default 60).
 *   BROADCAST=1           actually send txs (else preflight: validate + distinctness + funding only).
 *   ALLOW_MAINNET=1       required to target chainId 196.
 *
 * PRODUCTION-SHAPED CONFIG:
 *   Settlement token — resolved from the shared chains.ts registry for the TARGET chain:
 *     • mainnet 196 → the real confirmed USDT0 (0x779Ded…, 6 dp); the token is NOT deployed, only referenced.
 *     • testnet 1952 → chains.ts has NO confirmed stablecoin, so a 6-dp MockERC20 stand-in is deployed and
 *       clearly labelled (mainnet would use USDT0). Override with TOKEN_ADDRESS to force a specific token.
 *   REQUIRE_ANCHORED_INTENT  default "true" (production). The vault is wired to a real SpendIntentRegistry:
 *     INTENT_REGISTRY (if set) else the suite's own freshly-deployed registry. Set "false" for a self-
 *     contained keying dry-run (registry unwired).
 */

const ART = (p: string) => fileURLToPath(new URL(`../contracts/out/${p}`, import.meta.url));
type Artifact = { abi: Abi; bytecode: { object: Hex } };
const load = (p: string): Artifact => JSON.parse(readFileSync(ART(p), "utf8")) as Artifact;

const OP = { ADD_WRITER: 1, TRANSFER_ADMIN: 3 } as const;
const EPOCH_LEN = 86_400n;

interface ResolvedToken {
  readonly decimals: number;
  readonly mode: "real-confirmed" | "testnet-standin" | "override";
  readonly label: string;
  /** Set when the token already exists (real/override); undefined ⇒ deploy a MockERC20 stand-in. */
  readonly address?: Address;
}

/** Production-shaped token selection: real USDT0 where chains.ts confirms one, honest stand-in otherwise. */
function resolveToken(chainId: number): ResolvedToken {
  const override = process.env.TOKEN_ADDRESS?.trim();
  if (override) {
    if (!isAddress(override)) throw new Error(`TOKEN_ADDRESS is not a valid address: "${override}"`);
    const decimals = Number(process.env.TOKEN_DECIMALS ?? "6");
    return { address: getAddress(override), decimals, mode: "override", label: `override ${getAddress(override)} (${decimals} dp)` };
  }
  try {
    const t: ConfirmedToken = settlementToken(chainId);
    return { address: t.address, decimals: t.decimals, mode: "real-confirmed", label: `${t.symbol} ${t.address} (${t.decimals} dp, chains.ts confirmed)` };
  } catch {
    // No confirmed stablecoin for this chain (testnet). Match the production token's decimals so caps are
    // sized identically; deploy a MockERC20 stand-in. Mainnet's real token is documented for contrast.
    const mainnetUSDT0 = TOKENS[X_LAYER_MAINNET_ID].USDT0;
    const decimals = isConfirmed(mainnetUSDT0) ? mainnetUSDT0.decimals : 6;
    return { decimals, mode: "testnet-standin", label: `MockERC20 stand-in (${decimals} dp) — no confirmed stablecoin on chainId ${chainId}; mainnet uses USDT0 ${isConfirmed(mainnetUSDT0) ? mainnetUSDT0.address : "?"}` };
  }
}

const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

function role(name: string): Address {
  const raw = process.env[name]?.trim();
  if (!raw || !isAddress(raw)) throw new Error(`${name} missing or not a valid address`);
  return getAddress(raw);
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? "https://testrpc.xlayer.tech";
  const broadcast = process.env.BROADCAST === "1";
  const timelock = BigInt(process.env.TIMELOCK_DELAY ?? "60");
  const owner = role("OWNER_ADDRESS");
  const oracle = role("ORACLE_ADDRESS");
  const admin = role("ADMIN_ADDRESS");
  const writer = role("WRITER_ADDRESS");

  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  if (chainId === X_LAYER_MAINNET_ID && process.env.ALLOW_MAINNET !== "1") {
    throw new Error("Refusing X Layer MAINNET (196) without ALLOW_MAINNET=1.");
  }
  const chain: Chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });

  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!pk) {
    console.log("── keyed-suite deploy — PREFLIGHT (no DEPLOYER_PRIVATE_KEY) ──");
    console.log(`chainId ${chainId} · timelock ${timelock}s`);
    console.log(`owner  ${owner}\noracle ${oracle}\nadmin  ${admin}\nwriter ${writer}`);
    console.log("Set DEPLOYER_PRIVATE_KEY + BROADCAST=1 to deploy.");
    return;
  }
  const deployer = privateKeyToAccount(pk).address;

  // Role separation must hold across ALL FIVE (deployer + the four role addresses) before any deploy.
  const five: Record<Role, Address> = { deployer, owner, admin, writer, oracle };
  const collisions = pairwiseDistinct(five).filter((c) => !c.distinct);
  if (collisions.length) {
    for (const c of collisions) console.error(`✗ ${c.a} == ${c.b} (${c.addrA})`);
    throw new Error("role collision — refusing to deploy (run pnpm verify:role-separation).");
  }

  console.log("── keyed-suite deploy (role-separated) ──");
  console.log(`chainId ${chainId}${chainId === X_LAYER_TESTNET_ID ? " (X Layer testnet)" : ""} · timelock ${timelock}s`);
  console.log(`deployer ${deployer}  (ends with NO role)`);
  console.log(`owner ${owner} · oracle ${oracle} · admin ${admin} · writer ${writer}`);

  const balance = await pub.getBalance({ address: deployer });
  console.log(`deployer balance ${formatUnits(balance, 18)} OKB`);
  if (!broadcast) {
    console.log("\nPreflight OK (BROADCAST!=1) — distinctness holds, deployer funded. Not sending.");
    return;
  }
  if (balance === 0n) throw new Error("deployer has 0 OKB — fund it for gas.");

  const wallet = createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(rpcUrl) });
  const send = async (call: Parameters<typeof wallet.writeContract>[0]): Promise<Hex> => {
    const h = await wallet.writeContract(call);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`tx reverted ${h}`);
    return h;
  };
  const deploy = async (art: Artifact, args: unknown[]): Promise<Address> => {
    const h = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (!r.contractAddress) throw new Error("deploy produced no address");
    return r.contractAddress;
  };

  const tokenArt = load("VaultMocks.sol/MockERC20.json");
  const regArt = load("SpendIntentRegistry.sol/SpendIntentRegistry.json");
  const recArt = load("UntchReceipts.sol/UntchReceipts.json");
  const vaultArt = load("UntchVault.sol/UntchVault.json");

  // Production-shaped config resolved for THIS chain.
  const tok = resolveToken(chainId);
  const perTxCap = parseUnits("100", tok.decimals);
  const epochBudget = parseUnits("250", tok.decimals);
  const requireAnchored = (process.env.REQUIRE_ANCHORED_INTENT ?? "true") !== "false";
  const registryOverride = process.env.INTENT_REGISTRY?.trim();
  if (registryOverride && !isAddress(registryOverride)) throw new Error(`INTENT_REGISTRY invalid: "${registryOverride}"`);
  console.log(`token   : ${tok.label}`);
  console.log(`intent  : requireAnchoredIntent=${requireAnchored}${requireAnchored ? ` → registry ${registryOverride ?? "(suite's own)"}` : " (unwired dry-run)"}`);

  console.log("\n[1/4] deploying token(if needed) · SpendIntentRegistry · UntchReceipts · UntchVault …");
  const token = tok.address ?? (await deploy(tokenArt, []));
  if (!tok.address) console.log(`  token ${token} (deployed — testnet stand-in)`);
  else console.log(`  token ${token} (referenced — not deployed)`);
  const registry = await deploy(regArt, []);
  const receipts = await deploy(recArt, [timelock]);
  // requireAnchoredIntent=true must reference a non-zero registry: the override, else the suite's own.
  const vaultRegistry: Address = requireAnchored ? (registryOverride ? getAddress(registryOverride) : registry) : zeroAddress;
  const vault = await deploy(vaultArt, [owner, oracle, vaultRegistry, perTxCap, epochBudget, EPOCH_LEN, [token], requireAnchored]);
  console.log(`  registry ${registry}\n  receipts ${receipts}\n  vault ${vault} (intentRegistry=${vaultRegistry}, requireAnchoredIntent=${requireAnchored})`);

  // ── SpendIntentRegistry (immediate admin): add writer, then transfer admin LAST ──
  console.log("[2/4] registry: addWriter(writer) → transferAdmin(admin) …");
  await send({ address: registry, abi: regArt.abi, functionName: "addWriter", args: [writer] });
  await send({ address: registry, abi: regArt.abi, functionName: "transferAdmin", args: [admin] });

  // ── UntchReceipts (timelocked admin): propose→wait→execute ADD_WRITER, then TRANSFER_ADMIN LAST ──
  console.log(`[3/4] receipts: propose ADD_WRITER + TRANSFER_ADMIN, wait ${timelock}s, execute (add first, admin last) …`);
  await send({ address: receipts, abi: recArt.abi, functionName: "propose", args: [OP.ADD_WRITER, writer] });
  await send({ address: receipts, abi: recArt.abi, functionName: "propose", args: [OP.TRANSFER_ADMIN, admin] });
  await wait(Number(timelock) + 4);
  await send({ address: receipts, abi: recArt.abi, functionName: "execute", args: [OP.ADD_WRITER, writer] });
  await send({ address: receipts, abi: recArt.abi, functionName: "execute", args: [OP.TRANSFER_ADMIN, admin] });

  // ── Independent readback ──
  console.log("[4/4] independent raw readback …");
  const read = (a: Address, abi: Abi, fn: string, args: unknown[] = []) => pub.readContract({ address: a, abi, functionName: fn, args });
  const state = {
    vaultOwner: await read(vault, vaultArt.abi, "owner"),
    vaultOracle: await read(vault, vaultArt.abi, "oracle"),
    vaultPending: await read(vault, vaultArt.abi, "pendingOwner"),
    vaultRequireAnchored: await read(vault, vaultArt.abi, "requireAnchoredIntent"),
    vaultIntentRegistry: await read(vault, vaultArt.abi, "intentRegistry"),
    vaultTokenAllowed: await read(vault, vaultArt.abi, "tokenAllowed", [token]),
    receiptsAdmin: await read(receipts, recArt.abi, "admin"),
    receiptsWriter: await read(receipts, recArt.abi, "isWriter", [writer]),
    registryAdmin: await read(registry, regArt.abi, "admin"),
    registryWriter: await read(registry, regArt.abi, "isWriter", [writer]),
  };
  const eq = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();
  const ok =
    eq(state.vaultOwner, owner) && eq(state.vaultOracle, oracle) && state.vaultPending === zeroAddress &&
    state.vaultRequireAnchored === requireAnchored && eq(state.vaultIntentRegistry, vaultRegistry) &&
    state.vaultTokenAllowed === true &&
    eq(state.receiptsAdmin, admin) && state.receiptsWriter === true &&
    eq(state.registryAdmin, admin) && state.registryWriter === true;

  console.log(JSON.stringify({ chainId, deployer, token, tokenMode: tok.mode, registry, receipts, vault, requireAnchoredIntent: requireAnchored, vaultIntentRegistry: vaultRegistry, roles: { owner, oracle, admin, writer }, readback: state, ok }, null, 2));
  console.log("\nverify independently:");
  console.log(`  RPC_URL=${rpcUrl} VAULT_ADDRESS=${vault} RECEIPTS_ADDRESS=${receipts} SPEND_INTENT_REGISTRY_ADDRESS=${registry} \\`);
  console.log(`  DEPLOYER_ADDRESS=${deployer} OWNER_ADDRESS=${owner} ADMIN_ADDRESS=${admin} WRITER_ADDRESS=${writer} ORACLE_ADDRESS=${oracle} \\`);
  console.log(`  pnpm verify:deployment-roles`);
  if (!ok) throw new Error("READBACK MISMATCH — roles not set as intended.");
  console.log("\n✓ suite deployed with separated roles; deployer holds no live role.");
}

main().catch((e) => { console.error(`\n✗ ${(e as Error).message}`); process.exit(1); });
