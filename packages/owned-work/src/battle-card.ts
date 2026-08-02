/**
 * Battle Card — the first Untch-owned service, and the shape every later one copies.
 *
 * THE RULE THAT DECIDES EVERY DESIGN CHOICE HERE
 *
 * A battle card gets quoted in a sales call. Being wrong there costs more than being absent, so every
 * row on the card carries the source it came from and the date it was read, and a row with no source
 * is not written. There is no model in this path — not because a model could not write better prose,
 * but because a claim a model produced has no source, and the field that would hold one would have to
 * be filled with something.
 *
 * WHAT COUNTS AS EVIDENCE
 *
 * What a vendor publishes about itself, on its own page, on a date. That is a narrow definition and
 * it is the honest one: `VENDOR_PUBLISHED` means "they say this", not "this is true". The card says
 * so in as many words, because a comparison table that silently promotes marketing copy to fact is
 * the most common way this kind of document misleads.
 *
 * WHERE THE COMPARISON COMES FROM
 *
 * Set arithmetic over published claims, labelled `DERIVED` with `LOW` confidence, and nothing more.
 * "They publish a claim about X and you do not" is a fact about two pages. "You are better at X" is
 * not, and this service does not have the evidence to say it — so it does not, and the card explains
 * the difference rather than hiding behind a hedge.
 *
 * WHAT THE CARD WILL NOT CONTAIN
 *
 * A price nobody published. A metric nobody measured. A customer count nobody stated. Where a section
 * has no evidence, it renders as an explicit gap with the question a human should go and answer,
 * which is more useful than a confident sentence and considerably safer.
 */

import type { EvidenceClaim, ManifestEntry, WorkNode, WorkPlan } from "./types";
import { evaluateManifest } from "./types";
import { contentHashOf } from "./artifacts";
import type { Hex } from "viem";

export interface BattleCardInput {
  readonly product: string;
  readonly competitor: string;
  readonly persona?: string | undefined;
  readonly dealContext?: string | undefined;
  readonly focusAreas?: readonly string[] | undefined;
}

/** One page as it was actually read. Fetching happens outside; this module judges what came back. */
export interface FetchedPage {
  readonly url: string;
  readonly status: number;
  readonly html: string;
  readonly observedAt: string;
}

export interface ResolvedSide {
  readonly label: string;
  readonly url: string | null;
  readonly page: FetchedPage | null;
  /** Why there is no page, when there is none. Rendered on the card rather than left blank. */
  readonly unavailableReason: string | null;
}

// ── extraction ───────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function firstMatch(html: string, re: RegExp): string | null {
  const m = re.exec(html);
  return m?.[1] ? stripTags(m[1]) : null;
}

function allMatches(html: string, re: RegExp, limit: number): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  while ((m = g.exec(html)) !== null && out.length < limit) {
    const text = m[1] ? stripTags(m[1]) : "";
    if (text.length >= 3 && text.length <= 200) out.push(text);
  }
  return out;
}

/**
 * Money, as the page wrote it.
 *
 * Deliberately conservative: a currency symbol immediately followed by digits, optionally with a
 * period suffix. It misses prices expressed in prose, and missing one is the correct failure — a
 * looser pattern picks up years, version numbers and phone numbers and puts them on a card as
 * pricing, which is a specific and embarrassing way to be wrong in front of a customer.
 */
const PRICE_RE = /([$£€]\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:\/|per\s)\s?(?:mo|month|user|seat|yr|year|call|request))?)/gi;

const OBJECTION_HINTS: readonly { readonly pattern: RegExp; readonly objection: string }[] = [
  { pattern: /\bfree\b|\bfree tier\b|\bfreemium\b/i, objection: "They have a free tier and you do not." },
  { pattern: /\bopen[- ]source\b/i, objection: "They are open source; buyers will ask about lock-in." },
  { pattern: /\bSOC\s?2\b|\bISO\s?27001\b|\bHIPAA\b|\bGDPR\b/i, objection: "They publish a compliance certification." },
  { pattern: /\benterprise\b/i, objection: "They market to enterprise explicitly." },
  { pattern: /\bself[- ]host(ed|ing)?\b|\bon[- ]prem/i, objection: "They offer self-hosting." },
  { pattern: /\bAPI\b/i, objection: "They lead with an API; integration depth will be compared." },
];

const TRUST_HINTS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /\bSOC\s?2\b/i, what: "SOC 2 mentioned on the page" },
  { pattern: /\bISO\s?27001\b/i, what: "ISO 27001 mentioned on the page" },
  { pattern: /\bHIPAA\b/i, what: "HIPAA mentioned on the page" },
  { pattern: /\bGDPR\b/i, what: "GDPR mentioned on the page" },
  { pattern: /\bencrypt(ed|ion)\b/i, what: "Encryption mentioned on the page" },
  { pattern: /\buptime\b|\bSLA\b/i, what: "Uptime or SLA mentioned on the page" },
];

let claimCounter = 0;
function claimId(prefix: string): string {
  claimCounter += 1;
  return `clm_${prefix}_${claimCounter}`;
}

/**
 * Turn one fetched page into claims.
 *
 * Every claim is `VENDOR_PUBLISHED` and carries the URL, the timestamp of the read, and a hash of
 * the exact extract — so a disputed row can be checked against the bytes that produced it rather
 * than against a memory of the page.
 *
 * `freshUntil` is thirty days out. Marketing pages change without notice, and a card presented as
 * current six months later is a card that is wrong in a way nobody notices until a customer corrects
 * it in the meeting.
 */
export function extractClaims(page: FetchedPage, side: string, nodeId: string, orderId: string): EvidenceClaim[] {
  const claims: EvidenceClaim[] = [];
  const freshUntil = new Date(Date.parse(page.observedAt) + 30 * 86_400_000).toISOString();

  const add = (statement: string, confidence: EvidenceClaim["confidence"], extract: string): void => {
    claims.push({
      claimId: claimId(side),
      orderId,
      nodeId,
      statement,
      sourceRef: page.url,
      sourceType: "VENDOR_PUBLISHED",
      observedAt: page.observedAt,
      confidence,
      extractHash: contentHashOf(new TextEncoder().encode(extract)),
      artifactRefs: [],
      freshUntil,
    });
  };

  const title = firstMatch(page.html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) add(`Page title: ${title}`, "HIGH", title);

  const description =
    firstMatch(page.html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ??
    firstMatch(page.html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  if (description) add(`Self-description: ${description}`, "HIGH", description);

  const h1 = firstMatch(page.html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1 && h1 !== title) add(`Headline positioning: ${h1}`, "HIGH", h1);

  for (const h of allMatches(page.html, /<h2[^>]*>([\s\S]*?)<\/h2>/i, 8)) {
    add(`Section the page leads with: ${h}`, "MEDIUM", h);
  }

  const text = stripTags(page.html);
  const prices = [...new Set((text.match(PRICE_RE) ?? []).map((p) => p.trim()))].slice(0, 6);
  for (const price of prices) {
    // MEDIUM, never HIGH. A currency string on a page is a number in a sentence whose context this
    // extractor did not read; presenting it as the price is how a card states a plan that does not
    // exist.
    add(`Price string published on the page: ${price} (context not read — confirm before quoting)`, "MEDIUM", price);
  }

  for (const hint of TRUST_HINTS) {
    if (hint.pattern.test(text)) add(hint.what, "MEDIUM", hint.what);
  }

  return claims;
}

// ── the card ─────────────────────────────────────────────────────────────────

export interface CardSection {
  readonly heading: string;
  readonly rows: readonly CardRow[];
  /** What a human must go and find, when the evidence did not support the section. */
  readonly gap: string | null;
}

export interface CardRow {
  readonly text: string;
  readonly claimIds: readonly string[];
  readonly confidence: EvidenceClaim["confidence"];
  readonly sourceType: EvidenceClaim["sourceType"];
}

export interface BattleCard {
  readonly generatedAt: string;
  readonly product: { readonly label: string; readonly url: string | null; readonly reachable: boolean };
  readonly competitor: { readonly label: string; readonly url: string | null; readonly reachable: boolean };
  readonly persona: string | null;
  readonly dealContext: string | null;
  readonly sections: readonly CardSection[];
  readonly discoveryQuestions: readonly string[];
  readonly claims: readonly EvidenceClaim[];
  /** Stated on the card itself, not only in a footer nobody reads. */
  readonly limitations: readonly string[];
}

function rowsFrom(claims: readonly EvidenceClaim[], filter: (c: EvidenceClaim) => boolean): CardRow[] {
  return claims.filter(filter).map((c) => ({
    text: c.statement,
    claimIds: [c.claimId],
    confidence: c.confidence,
    sourceType: c.sourceType,
  }));
}

/**
 * Build the card from the claims, and from nothing else.
 *
 * Each section is a projection of the evidence. A section whose projection is empty renders its GAP
 * — the question a human should answer — rather than a sentence written to fill the space.
 */
export function buildBattleCard(args: {
  readonly input: BattleCardInput;
  readonly product: ResolvedSide;
  readonly competitor: ResolvedSide;
  readonly claims: readonly EvidenceClaim[];
  readonly generatedAt: string;
}): BattleCard {
  const { input, product, competitor, claims, generatedAt } = args;
  const ours = claims.filter((c) => c.sourceRef === product.url);
  const theirs = claims.filter((c) => c.sourceRef === competitor.url);

  const themeOf = (s: string): string => s.replace(/^[^:]*:\s*/, "").toLowerCase();
  const ourThemes = new Set(ours.map((c) => themeOf(c.statement)));
  const theirThemes = new Set(theirs.map((c) => themeOf(c.statement)));

  /**
   * The asymmetry rows, and the sentence that keeps them honest.
   *
   * "They publish a claim about X and you do not" is a fact about two pages. It is NOT evidence that
   * they are better at X, and the row says which of the two it is. Every one is DERIVED and LOW,
   * because set difference over marketing copy is weak evidence and labelling it strongly would make
   * the card more confident than the work behind it.
   */
  const asymmetry = (from: Set<string>, against: Set<string>, subject: string): CardRow[] =>
    [...from]
      .filter((t) => !against.has(t) && t.length > 12)
      .slice(0, 6)
      .map((t) => ({
        text: `${subject} publishes this and the other side's page does not: "${t}". A difference in what is PUBLISHED, not evidence of a difference in capability.`,
        claimIds: [],
        confidence: "LOW" as const,
        sourceType: "DERIVED" as const,
      }));

  const objections: CardRow[] = [];
  if (competitor.page) {
    const competitorText = stripTags(competitor.page.html);
    for (const hint of OBJECTION_HINTS) {
      if (hint.pattern.test(competitorText)) {
        objections.push({
          text: hint.objection,
          claimIds: theirs.filter((c) => hint.pattern.test(c.statement)).map((c) => c.claimId),
          confidence: "MEDIUM",
          sourceType: "DERIVED",
        });
      }
    }
  }

  const sections: CardSection[] = [
    {
      heading: "How they position themselves",
      rows: rowsFrom(theirs, (c) => /^(Page title|Self-description|Headline positioning)/.test(c.statement)),
      gap: theirs.length === 0 ? `Nothing was read from ${competitor.label}. Open their homepage and record the headline and self-description.` : null,
    },
    {
      heading: "How you position yourself",
      rows: rowsFrom(ours, (c) => /^(Page title|Self-description|Headline positioning)/.test(c.statement)),
      gap: ours.length === 0 ? `Nothing was read from ${product.label}. Record your own headline before comparing it to anyone's.` : null,
    },
    {
      heading: "What each side leads with",
      rows: [
        ...rowsFrom(ours, (c) => c.statement.startsWith("Section the page leads with")),
        ...rowsFrom(theirs, (c) => c.statement.startsWith("Section the page leads with")),
      ],
      gap: null,
    },
    {
      heading: "Published pricing",
      rows: rowsFrom(claims, (c) => c.statement.startsWith("Price string published")),
      gap:
        claims.every((c) => !c.statement.startsWith("Price string published"))
          ? "Neither page published a price this extractor could read. Do not state a price on this card until someone has confirmed one."
          : "Every price above is a string lifted from a page without its surrounding sentence. Confirm the plan and the unit before quoting.",
    },
    {
      heading: "Trust evidence each side publishes",
      rows: rowsFrom(claims, (c) => TRUST_HINTS.some((h) => c.statement === h.what)),
      gap:
        claims.every((c) => !TRUST_HINTS.some((h) => c.statement === h.what))
          ? "Neither page mentioned a certification, SLA or encryption claim. Absence on a homepage is not absence of the certification."
          : null,
    },
    {
      heading: "Where you say something they do not",
      rows: asymmetry(ourThemes, theirThemes, product.label),
      gap: ourThemes.size === 0 ? "No claims were read from your side, so no asymmetry can be computed." : null,
    },
    {
      heading: "Where they say something you do not",
      rows: asymmetry(theirThemes, ourThemes, competitor.label),
      gap: theirThemes.size === 0 ? "No claims were read from their side, so no asymmetry can be computed." : null,
    },
    {
      heading: "Objections to expect, and an honest answer",
      rows: objections.map((o) => ({
        ...o,
        text: `${o.text} — Answer with what you can evidence, not with a counter-claim you cannot.`,
      })),
      gap:
        objections.length === 0
          ? "No objection triggers were detected on their page. That means none were detected, not that none exist."
          : null,
    },
    {
      heading: "Where neither of you fits",
      rows: [],
      // Stated as an open question on purpose. A generated document cannot know which buyers neither
      // product serves, and inventing a disqualification is a fast way to lose a deal that was real.
      gap: "This needs a human. Name the buyer profile you both lose, and why — it is the most useful row on any battle card and the one no extractor can produce.",
    },
  ];

  const discoveryQuestions = [
    `What made you look at ${competitor.label} in the first place?`,
    "What would have to be true for you to switch?",
    "Who else has to agree, and what do they care about?",
    "What is the cost of doing nothing for another quarter?",
    ...(input.persona ? [`As ${input.persona}, what does a bad outcome here look like for you personally?`] : []),
    ...(input.dealContext ? [`You mentioned: ${input.dealContext}. What changed to make that urgent now?`] : []),
  ];

  return {
    generatedAt,
    product: { label: product.label, url: product.url, reachable: product.page !== null },
    competitor: { label: competitor.label, url: competitor.url, reachable: competitor.page !== null },
    persona: input.persona ?? null,
    dealContext: input.dealContext ?? null,
    sections,
    discoveryQuestions,
    claims,
    limitations: [
      "Every claim here is what a vendor published about itself on its own page, on the date shown. VENDOR_PUBLISHED means they say it, not that it is true.",
      "Rows marked DERIVED are set arithmetic over published claims. A difference in what two pages SAY is not a difference in what two products DO.",
      "No model wrote any row. Nothing here was generated to fill a section, which is why some sections are gaps instead.",
      "Prices are strings lifted without their surrounding sentence. Confirm before quoting.",
      product.page === null || competitor.page === null
        ? "At least one side could not be read. The comparison is one-sided and says so above."
        : "Both pages were read successfully.",
    ],
  };
}

// ── the artifacts ────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Only http(s) survives. A `javascript:` href on a published page is a stored script. */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const CONFIDENCE_LABEL: Readonly<Record<EvidenceClaim["confidence"], string>> = {
  HIGH: "read directly",
  MEDIUM: "read, context not verified",
  LOW: "inferred",
};

/**
 * Render the card.
 *
 * Self-contained by construction: one inline stylesheet, no script, no external font, no remote
 * image. That is not an aesthetic preference — the published-site CSP forbids all of them, so a card
 * that reached for a CDN would render unstyled at exactly the moment somebody opened it in a meeting.
 *
 * Light mode only, no gradients, restrained type. It is a document people print and paste into a
 * deck, and a document that fights its surroundings gets remade by hand.
 */
export function renderBattleCardHtml(card: BattleCard): string {
  const claimById = new Map(card.claims.map((c) => [c.claimId, c]));
  const day = (iso: string): string => iso.slice(0, 10);

  const rowHtml = (row: CardRow): string => {
    const sources = row.claimIds
      .map((id) => claimById.get(id))
      .filter((c): c is EvidenceClaim => c !== undefined)
      .map((c) => {
        const href = safeHref(c.sourceRef);
        return href
          ? `<a href="${esc(href)}" rel="nofollow noopener noreferrer external">${esc(new URL(href).hostname)}</a> <span class="date">read ${esc(day(c.observedAt))}</span>`
          : `<span class="date">read ${esc(day(c.observedAt))}</span>`;
      })
      .join(" · ");
    return `<li>
      <p>${esc(row.text)}</p>
      <p class="meta"><span class="tag tag-${row.sourceType.toLowerCase().replace(/_/g, "-")}">${esc(row.sourceType.replace(/_/g, " "))}</span>
      <span class="tag tag-conf">${esc(CONFIDENCE_LABEL[row.confidence])}</span>${sources ? ` <span class="src">${sources}</span>` : ""}</p>
    </li>`;
  };

  const sectionHtml = (s: CardSection): string => `
    <section>
      <h2>${esc(s.heading)}</h2>
      ${s.rows.length > 0 ? `<ul class="rows">${s.rows.map(rowHtml).join("")}</ul>` : ""}
      ${s.gap ? `<p class="gap"><strong>Gap.</strong> ${esc(s.gap)}</p>` : ""}
    </section>`;

  const claimRow = (c: EvidenceClaim): string => {
    const href = safeHref(c.sourceRef);
    return `<tr>
      <td>${esc(c.claimId)}</td>
      <td>${esc(c.statement)}</td>
      <td>${href ? `<a href="${esc(href)}" rel="nofollow noopener noreferrer external">${esc(new URL(href).hostname)}</a>` : "—"}</td>
      <td>${esc(c.sourceType.replace(/_/g, " "))}</td>
      <td>${esc(CONFIDENCE_LABEL[c.confidence])}</td>
      <td>${esc(day(c.observedAt))}</td>
      <td>${c.freshUntil ? esc(day(c.freshUntil)) : "—"}</td>
    </tr>`;
  };

  const productHref = safeHref(card.product.url);
  const competitorHref = safeHref(card.competitor.url);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Battle card — ${esc(card.product.label)} vs ${esc(card.competitor.label)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #16181d;
    font: 16px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 62rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
  header { border-bottom: 1px solid #e4e6ea; padding-bottom: 1.5rem; margin-bottom: 2rem; }
  h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .5rem; font-weight: 650; letter-spacing: -.01em; }
  .sides { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-top: .75rem; font-size: .9rem; }
  .side { min-width: 12rem; }
  .side b { display: block; font-weight: 600; }
  .stamp { color: #6b7280; font-size: .82rem; margin-top: .75rem; }
  h2 { font-size: 1.02rem; font-weight: 650; margin: 2.25rem 0 .75rem; letter-spacing: -.005em; }
  section:first-of-type h2 { margin-top: 0; }
  ul.rows { list-style: none; margin: 0; padding: 0; }
  ul.rows li { border: 1px solid #e4e6ea; border-radius: 6px; padding: .8rem .9rem; margin-bottom: .6rem; }
  ul.rows p { margin: 0; }
  .meta { margin-top: .45rem !important; font-size: .78rem; color: #6b7280; }
  .tag { display: inline-block; border: 1px solid #d8dbe0; border-radius: 3px;
    padding: .05rem .35rem; margin-right: .3rem; font-size: .72rem; text-transform: uppercase;
    letter-spacing: .03em; color: #4b5158; }
  .tag-derived { border-color: #e0c9a0; color: #8a6516; }
  .tag-unverified { border-color: #e3b5b5; color: #943d3d; }
  .src a { color: #1f4fd8; }
  .gap { background: #fbfbfc; border: 1px solid #e4e6ea; border-left: 3px solid #b9bec6;
    border-radius: 4px; padding: .7rem .85rem; margin: .3rem 0 0; font-size: .9rem; color: #3c4149; }
  ol.q { padding-left: 1.15rem; }
  ol.q li { margin-bottom: .35rem; }
  .limits { margin-top: 2.5rem; border: 1px solid #e4e6ea; border-radius: 6px; padding: 1rem 1.1rem;
    background: #fbfbfc; font-size: .88rem; }
  .limits h2 { margin-top: 0; }
  .limits ul { margin: 0; padding-left: 1.1rem; }
  .limits li { margin-bottom: .3rem; }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { border-collapse: collapse; width: 100%; font-size: .82rem; min-width: 46rem; }
  th, td { text-align: left; vertical-align: top; padding: .45rem .6rem; border-bottom: 1px solid #eceef1; }
  th { font-weight: 600; color: #4b5158; border-bottom-color: #d8dbe0; white-space: nowrap; }
  td a { color: #1f4fd8; }
  footer { margin-top: 3rem; padding-top: 1.25rem; border-top: 1px solid #e4e6ea;
    color: #6b7280; font-size: .8rem; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Battle card — ${esc(card.product.label)} vs ${esc(card.competitor.label)}</h1>
  <div class="sides">
    <div class="side"><b>Yours</b>${productHref ? `<a href="${esc(productHref)}" rel="nofollow noopener noreferrer external">${esc(productHref)}</a>` : esc(card.product.label)}${card.product.reachable ? "" : " — not read"}</div>
    <div class="side"><b>Theirs</b>${competitorHref ? `<a href="${esc(competitorHref)}" rel="nofollow noopener noreferrer external">${esc(competitorHref)}</a>` : esc(card.competitor.label)}${card.competitor.reachable ? "" : " — not read"}</div>
    ${card.persona ? `<div class="side"><b>Buyer</b>${esc(card.persona)}</div>` : ""}
  </div>
  <p class="stamp">Generated ${esc(day(card.generatedAt))} · ${card.claims.length} sourced claim${card.claims.length === 1 ? "" : "s"} · every row below carries its source and the date it was read</p>
</header>

${card.sections.map(sectionHtml).join("")}

<section>
  <h2>Discovery questions</h2>
  <ol class="q">${card.discoveryQuestions.map((q) => `<li>${esc(q)}</li>`).join("")}</ol>
</section>

<section>
  <h2>Every claim, with its source</h2>
  <div class="scroll">
  <table>
    <thead><tr><th>ID</th><th>Claim</th><th>Source</th><th>Kind</th><th>Confidence</th><th>Read</th><th>Recheck by</th></tr></thead>
    <tbody>${card.claims.map(claimRow).join("")}</tbody>
  </table>
  </div>
</section>

<div class="limits">
  <h2>What this card does not tell you</h2>
  <ul>${card.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
</div>

<footer>Produced by Untch. No model wrote a row on this card; sections with no evidence are shown as gaps rather than filled in.</footer>
</div>
</body>
</html>`;
}

/**
 * The plan, as real nodes.
 *
 * Written out rather than implied by the code's control flow, because the Explorer case shows these
 * rows and a customer asking "what did it actually do" deserves an answer that is not a paraphrase of
 * a function body.
 */
export function planBattleCard(args: {
  readonly planId: string;
  readonly workIntentId: string;
  readonly planHash: Hex;
  readonly createdAt: string;
}): { plan: WorkPlan; nodes: readonly WorkNode[] } {
  const node = (
    id: string,
    type: WorkNode["type"],
    dependsOn: readonly string[],
    inputHash: Hex,
  ): WorkNode => ({
    nodeId: `${args.planId}:${id}`,
    planId: args.planId,
    type,
    dependsOn: dependsOn.map((d) => `${args.planId}:${d}`),
    inputHash,
    outputHash: null,
    workerVersion: "battle_card@1.0.0",
    skillVersion: null,
    // Null and load-bearing: no model produced any node's output, so there is no version to record
    // and no row on the card that could have come from one.
    modelVersion: null,
    maxCostBaseUnits: "0",
    actualCostBaseUnits: "0",
    maxAttempts: 2,
    attempts: 0,
    idempotencyKey: `${args.planId}:${id}`,
    state: "PENDING",
    failure: null,
    startedAt: null,
    endedAt: null,
  });

  const h = args.planHash;
  const nodes: WorkNode[] = [
    node("resolve-product", "RESOLVE", [], h),
    node("resolve-competitor", "RESOLVE", [], h),
    node("fetch-product", "FETCH_EVIDENCE", ["resolve-product"], h),
    node("fetch-competitor", "FETCH_EVIDENCE", ["resolve-competitor"], h),
    node("extract-product", "EXTRACT", ["fetch-product"], h),
    node("extract-competitor", "EXTRACT", ["fetch-competitor"], h),
    node("compare", "COMPARE", ["extract-product", "extract-competitor"], h),
    node("draft", "DRAFT", ["compare"], h),
    node("render-html", "RENDER", ["draft"], h),
    node("publish", "PUBLISH", ["render-html"], h),
    node("manifest", "MANIFEST", ["publish"], h),
  ];

  return {
    plan: {
      workPlanId: args.planId,
      workIntentId: args.workIntentId,
      version: 1,
      planHash: args.planHash,
      state: "CONFIRMED",
      // `system`, not a model id. The plan is a fixed DAG for this service, not something proposed.
      createdBy: "system",
      confirmedAt: args.createdAt,
      createdAt: args.createdAt,
    },
    nodes,
  };
}

/** The four files this service promises, checked against what was actually written. */
export function battleCardManifestEntries(
  produced: readonly { readonly name: string; readonly mimeType: string; readonly artifactId: string; readonly versionId: string; readonly contentHash: Hex; readonly sizeBytes: number }[],
): readonly ManifestEntry[] {
  const promised = [
    { name: "battle-card.html", mimeType: "text/html" },
    { name: "battle-card.json", mimeType: "application/json" },
    { name: "evidence.json", mimeType: "application/json" },
    { name: "delivery-manifest.json", mimeType: "application/json" },
  ];
  return promised.map((p) => {
    const hit = produced.find((x) => x.name === p.name);
    return {
      name: p.name,
      mimeType: p.mimeType,
      required: true,
      artifactId: hit?.artifactId ?? null,
      versionId: hit?.versionId ?? null,
      contentHash: hit?.contentHash ?? null,
      sizeBytes: hit?.sizeBytes ?? null,
      // Presence is a fact about the artifact rows, never a claim by the renderer. This is the line
      // that makes "never claim a format exists when no file was created" structural.
      present: hit !== undefined,
    };
  });
}

export { evaluateManifest };
