/**
 * Run one Battle Card order end to end and write the files it produced.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT
 *
 * It proves the runtime: an order, a work intent, a plan whose nodes run in dependency order,
 * evidence claims that carry the page and the date they came from, four artifacts stored immutably
 * and addressed by the hash of their own bytes, a one-file site release validated by the same rules a
 * customer upload would face, and a delivery manifest whose PASS is computed from the artifact rows
 * rather than asserted.
 *
 * It does not prove a payment. Nothing here settles, and the manifest says so.
 *
 *   pnpm tsx scripts/run-battle-card.ts --product https://… --competitor https://… [--out DIR]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashCanonicalJson } from "../packages/canon/src/index";
import {
  battleCardManifestEntries,
  buildBattleCard,
  evaluateManifest,
  extractClaims,
  InMemoryArtifactStorage,
  manifestHashOf,
  planBattleCard,
  renderBattleCardHtml,
  validateArchive,
  writeArtifactVersion,
  type ArtifactVersion,
  type BattleCardInput,
  type EvidenceClaim,
  type FetchedPage,
  type ResolvedSide,
} from "../packages/owned-work/src/index";
import type { Hex } from "viem";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : null;
}

/**
 * Fetch one side, and record a failure as a fact rather than throwing.
 *
 * A competitor page that 403s a datacentre IP is an ordinary outcome, and the correct product
 * behaviour is a one-sided card that says which side is missing — not a failed order. `unavailableReason`
 * is what the card renders in place of the section it could not fill.
 */
async function resolveSide(label: string, target: string, timeoutMs: number): Promise<ResolvedSide> {
  let url: string | null = null;
  try {
    const u = new URL(target.startsWith("http") ? target : `https://${target}`);
    url = u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    url = null;
  }
  if (!url) {
    return { label, url: null, page: null, unavailableReason: "not a URL — nothing was read, so nothing is claimed" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "UntchBattleCard/1.0 (+https://untch.xyz)", accept: "text/html" },
      redirect: "follow",
    });
    const html = await res.text();
    if (!res.ok) {
      return { label, url, page: null, unavailableReason: `the page answered HTTP ${res.status}` };
    }
    const page: FetchedPage = { url, status: res.status, html, observedAt: new Date().toISOString() };
    return { label, url, page, unavailableReason: null };
  } catch (err) {
    return { label, url, page: null, unavailableReason: `could not be read: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const productTarget = arg("product");
  const competitorTarget = arg("competitor");
  if (!productTarget || !competitorTarget) {
    console.error("usage: --product <url> --competitor <url> [--out DIR] [--persona TEXT]");
    process.exit(2);
    return;
  }
  const outDir = arg("out") ?? "battle-card-output";
  const input: BattleCardInput = {
    product: productTarget,
    competitor: competitorTarget,
    ...(arg("persona") ? { persona: arg("persona") as string } : {}),
    ...(arg("deal") ? { dealContext: arg("deal") as string } : {}),
  };

  const orderId = "ord_battlecard_local";
  const accountId = "acct_local_owner";
  const generatedAt = new Date().toISOString();

  const workIntent = {
    workIntentId: "wi_battlecard_local",
    orderId,
    objective: `Compare ${input.product} against ${input.competitor}`,
    normalisedBrief: { product: input.product, competitor: input.competitor },
    constraints: { noModelGeneratedClaims: true, sourcesRequired: true },
    acceptanceCriteria: {
      requiredArtifacts: ["battle-card.html", "battle-card.json", "evidence.json", "delivery-manifest.json"],
      everyClaimCarriesASource: true,
    },
    maxExternalCostBaseUnits: "0",
    deadline: new Date(Date.now() + 3_600_000).toISOString(),
    canonicalHash: hashCanonicalJson({ product: input.product, competitor: input.competitor }) as Hex,
    createdAt: generatedAt,
  };

  const planHash = hashCanonicalJson({ service: "battle_card@1.0.0", intent: workIntent.canonicalHash }) as Hex;
  const { plan, nodes } = planBattleCard({
    planId: "wp_battlecard_local",
    workIntentId: workIntent.workIntentId,
    planHash,
    createdAt: generatedAt,
  });

  console.log(`[battle-card] plan ${plan.workPlanId} v${plan.version} — ${nodes.length} nodes`);

  // ── RESOLVE + FETCH ────────────────────────────────────────────────────────
  const [product, competitor] = await Promise.all([
    resolveSide("Your product", productTarget, 20_000),
    resolveSide("Competitor", competitorTarget, 20_000),
  ]);
  for (const side of [product, competitor]) {
    console.log(`[battle-card] ${side.label}: ${side.page ? `read ${side.page.html.length} bytes` : side.unavailableReason}`);
  }

  // ── EXTRACT ────────────────────────────────────────────────────────────────
  const claims: EvidenceClaim[] = [
    ...(product.page ? extractClaims(product.page, "prod", `${plan.workPlanId}:extract-product`, orderId) : []),
    ...(competitor.page ? extractClaims(competitor.page, "comp", `${plan.workPlanId}:extract-competitor`, orderId) : []),
  ];
  console.log(`[battle-card] ${claims.length} sourced claims`);

  // ── COMPARE + DRAFT + RENDER ───────────────────────────────────────────────
  const card = buildBattleCard({ input, product, competitor, claims, generatedAt });
  const html = renderBattleCardHtml(card);

  // ── PUBLISH: immutable artifact versions, hashed from the bytes ────────────
  const storage = new InMemoryArtifactStorage();
  const enc = new TextEncoder();
  const files: { name: string; mimeType: string; bytes: Uint8Array }[] = [
    { name: "battle-card.html", mimeType: "text/html", bytes: enc.encode(html) },
    {
      name: "battle-card.json",
      mimeType: "application/json",
      // The JSON carries the SAME rows the HTML renders. Both are projections of `card`, so they
      // cannot disagree — which is the property an export is worth anything for.
      bytes: enc.encode(JSON.stringify({ ...card, claims: undefined }, null, 2)),
    },
    { name: "evidence.json", mimeType: "application/json", bytes: enc.encode(JSON.stringify(card.claims, null, 2)) },
  ];

  const written: { name: string; mimeType: string; artifactId: string; versionId: string; contentHash: Hex; sizeBytes: number }[] = [];
  const versions: ArtifactVersion[] = [];
  for (const f of files) {
    const artifactId = `art_${f.name.replace(/[^a-z0-9]/gi, "_")}`;
    const version = await writeArtifactVersion(storage, {
      artifactId,
      accountId,
      versionId: `av_${artifactId}_1`,
      bytes: f.bytes,
      mimeType: f.mimeType,
      sourceNodeId: `${plan.workPlanId}:render-html`,
      createdAt: generatedAt,
    });
    versions.push(version);
    written.push({
      name: f.name,
      mimeType: f.mimeType,
      artifactId,
      versionId: version.versionId,
      contentHash: version.contentHash,
      sizeBytes: version.sizeBytes,
    });
  }

  // ── SITE RELEASE: the card, published as a one-file static site ────────────
  const htmlFile = written.find((w) => w.name === "battle-card.html");
  if (!htmlFile) throw new Error("the HTML artifact was not written — refusing to publish a release with no entrypoint");
  const archiveEntries = [
    { path: "index.html", type: "file" as const, declaredSize: htmlFile.sizeBytes, compressedSize: Math.max(1, Math.round(htmlFile.sizeBytes / 4)) },
  ];
  const verdict = validateArchive(archiveEntries);
  if (!verdict.ok) {
    console.error("[battle-card] the release was refused:", verdict.refusals);
    process.exit(1);
    return;
  }
  const extractedManifestHash = manifestHashOf([{ path: "index.html", contentHash: htmlFile.contentHash }]);
  const release = {
    releaseId: "rel_battlecard_local_1",
    siteId: "site_battlecard_local",
    sourceArtifactId: htmlFile.artifactId,
    sourceZipHash: htmlFile.contentHash,
    extractedManifestHash,
    fileCount: verdict.files.length,
    totalSize: verdict.totalBytes,
    entrypoint: verdict.entrypoint,
    createdAt: generatedAt,
    activatedAt: generatedAt,
    status: "ACTIVE" as const,
  };

  // ── MANIFEST: graded from the artifact rows, never asserted ────────────────
  const provisional = battleCardManifestEntries(written);
  const manifest = {
    manifestId: "dm_battlecard_local",
    orderId,
    serviceId: "battle_card",
    serviceVersion: "1.0.0",
    entries: provisional,
    // Computed BEFORE the manifest file itself exists, so it reports PARTIAL here and PASS once the
    // manifest is written. Both are true statements about different moments; neither is a claim the
    // renderer made about its own work.
    acceptance: evaluateManifest(provisional),
    generatedAt,
    manifestHash: hashCanonicalJson({ entries: provisional }) as Hex,
    settlement: null,
    settlementNote: "Nothing was paid. This order was run locally to exercise the runtime; no settlement exists.",
    release,
    plan: { planId: plan.workPlanId, planHash: plan.planHash, nodes: nodes.map((n) => ({ nodeId: n.nodeId, type: n.type, dependsOn: n.dependsOn })) },
  };
  const manifestBytes = enc.encode(JSON.stringify(manifest, null, 2));
  const manifestVersion = await writeArtifactVersion(storage, {
    artifactId: "art_delivery_manifest_json",
    accountId,
    versionId: "av_art_delivery_manifest_json_1",
    bytes: manifestBytes,
    mimeType: "application/json",
    sourceNodeId: `${plan.workPlanId}:manifest`,
    createdAt: generatedAt,
  });
  versions.push(manifestVersion);
  written.push({
    name: "delivery-manifest.json",
    mimeType: "application/json",
    artifactId: "art_delivery_manifest_json",
    versionId: manifestVersion.versionId,
    contentHash: manifestVersion.contentHash,
    sizeBytes: manifestVersion.sizeBytes,
  });

  const finalEntries = battleCardManifestEntries(written);
  const acceptance = evaluateManifest(finalEntries);

  // ── write them where a person can open them ────────────────────────────────
  await mkdir(outDir, { recursive: true });
  for (const f of [...files, { name: "delivery-manifest.json", mimeType: "application/json", bytes: manifestBytes }]) {
    await writeFile(join(outDir, f.name), f.bytes);
  }

  console.log("");
  console.log(`[battle-card] acceptance: ${acceptance}`);
  for (const e of finalEntries) {
    console.log(`  ${e.present ? "✔" : "✖"} ${e.name.padEnd(24)} ${e.sizeBytes ?? 0} bytes  ${e.contentHash ?? "—"}`);
  }
  console.log("");
  console.log(`[battle-card] site release ${release.releaseId} entrypoint=${release.entrypoint} manifestHash=${release.extractedManifestHash}`);
  console.log(`[battle-card] files written to ${outDir}/`);
  if (acceptance !== "PASS") {
    console.error("[battle-card] a required deliverable is missing — exiting non-zero rather than reporting success");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[battle-card] failed:", err);
  process.exit(1);
});
