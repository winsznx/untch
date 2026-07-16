/**
 * Product name generation: LLM when configured (Untch-style anti-slop),
 * high-quality deterministic fallback otherwise.
 */

import { isBannedBrand, namingSystemPrompt } from "./anti-slop";
import { chatJson, loadLlmConfig, type LlmConfig } from "./llm";

export type NameSuggestion = {
  readonly name: string;
  readonly score: number;
  readonly style: string;
  readonly rationale: string;
};

/** Everyday stems — avoid epic fantasy lists. */
const ADJECTIVES = [
  "clear", "quiet", "solid", "open", "true", "field", "harbor", "grain", "cedar", "copper",
  "amber", "flint", "ridge", "plain", "brief", "tight", "calm", "fair", "keen", "mild",
  "north", "south", "inner", "outer", "first", "ready", "steady", "simple", "honest", "direct",
];
const NOUNS = [
  "kit", "lab", "desk", "node", "base", "line", "stack", "gate", "lane", "mill",
  "yard", "form", "loop", "path", "dock", "grid", "core", "mint", "folio", "atlas",
  "loom", "span", "dock", "room", "shop", "post", "mark", "hold", "bind", "rail",
];

function titleCaseToken(s: string): string {
  const t = s.replace(/[^a-zA-Z0-9]/g, "");
  if (!t) return s;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function cleanBrandName(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, "");
  if (t.length < 3 || t.length > 14) return null;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(t)) return null;
  const titled = titleCaseToken(t);
  if (isBannedBrand(titled)) return null;
  return titled;
}

/**
 * Deterministic fallback: compress idea stems (untouched→untch style) + quiet compounds.
 */
export function fallbackSuggestNames(idea: string, count = 6): NameSuggestion[] {
  const seed = [...idea.toLowerCase()].reduce((a, c) => a + c.charCodeAt(0), 0);
  const words = idea
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "with", "from", "that", "this"].includes(w))
    .slice(0, 8);
  const stems = words.length > 0 ? words : ["launch"];
  const out: string[] = [];

  // Compression pass first (Untch-style)
  for (const w of stems) {
    const compressions = [
      w.slice(0, 5),
      w.slice(0, 4),
      w.slice(0, 6),
      w.replace(/[aeiou]/g, "").slice(0, 5),
      w.slice(0, 3) + w.slice(-2),
    ];
    for (const c of compressions) {
      const cleaned = cleanBrandName(c);
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
      if (out.length >= count) break;
    }
    if (out.length >= count) break;
  }

  for (let i = 0; i < count * 4 && out.length < count; i++) {
    const stem = stems[i % stems.length]!.slice(0, 7);
    const a = ADJECTIVES[(seed + i * 7) % ADJECTIVES.length]!;
    const n = NOUNS[(seed + i * 13) % NOUNS.length]!;
    const candidates = [
      `${stem}${n}`.slice(0, 12),
      `${a}${stem}`.slice(0, 12),
      `${stem}${a.slice(0, 3)}`.slice(0, 12),
      `${a.slice(0, 4)}${n}`,
    ];
    for (const c of candidates) {
      const cleaned = cleanBrandName(c);
      if (cleaned && !out.includes(cleaned)) out.push(cleaned);
      if (out.length >= count) break;
    }
  }

  // last-resort fill without banned filter failure
  let j = 0;
  while (out.length < count && j < 40) {
    const a = ADJECTIVES[(seed + j * 3) % ADJECTIVES.length]!;
    const n = NOUNS[(seed + j * 5) % NOUNS.length]!;
    const cleaned = cleanBrandName(`${a.slice(0, 4)}${n}`);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    j++;
  }

  return out.map((name, i) => ({
    name,
    score: 88 - i * 5,
    style: i < 2 ? "compress" : "compound",
    rationale: `Compressed from “${idea.slice(0, 40)}” the Untch way (short, ownable, human).`,
  }));
}

function parseLlmSuggestions(raw: unknown, idea: string): NameSuggestion[] {
  const obj = raw as { suggestions?: unknown };
  const list = Array.isArray(obj.suggestions) ? obj.suggestions : Array.isArray(raw) ? raw : [];
  const out: NameSuggestion[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      const name = cleanBrandName(item);
      if (name) out.push({ name, score: 80, style: "llm", rationale: `For: ${idea.slice(0, 60)}` });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = cleanBrandName(String(rec.name ?? rec.brand ?? ""));
    if (!name) continue;
    const score = typeof rec.score === "number" ? Math.max(1, Math.min(100, rec.score)) : 85;
    const style = typeof rec.style === "string" ? rec.style.slice(0, 40) : "llm";
    const rationale =
      typeof rec.rationale === "string"
        ? rec.rationale.slice(0, 200)
        : typeof rec.why === "string"
          ? rec.why.slice(0, 200)
          : `Fits: ${idea.slice(0, 60)}`;
    if (!out.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      out.push({ name, score, style, rationale });
    }
  }
  return out.slice(0, 8);
}

export async function suggestProductNames(
  idea: string,
  opts: { count?: number; llm?: LlmConfig | null } = {},
): Promise<{ suggestions: NameSuggestion[]; engine: "llm" | "fallback"; model?: string; provider?: string }> {
  const count = opts.count ?? 6;
  const llm = opts.llm === undefined ? loadLlmConfig() : opts.llm;

  if (llm) {
    try {
      const raw = await chatJson({
        config: llm,
        system: namingSystemPrompt(),
        user: [
          `Product idea: ${idea}`,
          `Return ${count} brandable product names as JSON.`,
          "Remember: untouched→untch quality. Short compressions beat epic compounds.",
        ].join("\n"),
      });
      const suggestions = parseLlmSuggestions(raw, idea);
      if (suggestions.length >= 3) {
        return {
          suggestions: suggestions.slice(0, count),
          engine: "llm",
          model: llm.model,
          provider: llm.provider,
        };
      }
    } catch {
      // fall through
    }
  }

  return { suggestions: fallbackSuggestNames(idea, count), engine: "fallback" };
}
