/**
 * Untch-style naming discipline.
 *
 * How Untch was named: untouched → untouch → untch.
 * Compress the idea into a short, ownable, human brand. Not two-word AI cosplay.
 */

/** Hard ban: common AI-slop stems and compounds. */
export const BANNED_NAME_STEMS = [
  "aegis",
  "sentinel",
  "nexus",
  "quantum",
  "synergy",
  "synerg",
  "nova",
  "apex",
  "vanguard",
  "vortex",
  "cipher",
  "crypto",
  "block",
  "chain",
  "defi",
  "meta",
  "ultra",
  "hyper",
  "omni",
  "proto",
  "neo",
  "cyber",
  "smart",
  "intel",
  "genius",
  "wizard",
  "oracle", // reserved product language elsewhere; too generic as brand
  "guardian",
  "shield",
  "fortress",
  "castle",
  "titan",
  "phoenix",
  "dragon",
  "wolf",
  "hawk",
  "eagle",
  "pulse",
  "spark",
  "flux",
  "vertex",
  "zenith",
  "horizon",
  "infinity",
  "eternal",
  "prime",
  "coreai",
  "agentai",
  "aiagent",
  "botify",
  "ify",
  "lytic",
  "ytics",
] as const;

/** Full banned exact names (case-insensitive). */
export const BANNED_EXACT = new Set(
  [
    "chatgpt",
    "openai",
    "anthropic",
    "claude",
    "gemini",
    "copilot",
    "untch", // own brand
    "okx",
    "google",
    "apple",
    "amazon",
    "microsoft",
    "stripe",
    "paypal",
  ].map((s) => s.toLowerCase()),
);

export function isBannedBrand(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n || n.length < 3) return true;
  if (BANNED_EXACT.has(n)) return true;
  for (const stem of BANNED_NAME_STEMS) {
    if (n === stem || n.startsWith(stem) || n.endsWith(stem) || n.includes(stem)) {
      // allow short accidental substrings only if stem is very short? no — ban
      if (stem.length >= 3 && n.includes(stem)) return true;
    }
  }
  // Two-word camel like SpendGuard is OK; AegisSentinel-style double-epic is not
  if (/[A-Z][a-z]+[A-Z][a-z]+[A-Z]/.test(name)) return true; // TripleCamel
  return false;
}

/** System prompt for LLM naming — Untch origin story + hard rules. */
export function namingSystemPrompt(): string {
  return [
    "You name products the way Untch was named.",
    "Story: the founders brainstormed 'untouched', shortened to 'untouch', then bought untch.xyz.",
    "The brand is short, human, ownable, one token, easy to say. It sells a clean story. It is not AI cosplay.",
    "Return JSON only: {\"suggestions\":[{\"name\",\"score\",\"style\",\"rationale\"}]}",
    "Hard rules:",
    "- 4 to 10 letters preferred; absolute max 12; single alphanumeric token only (no spaces, hyphens, underscores).",
    "- Prefer compression or truncation of the real idea (like untouched→untch), not two epic fantasy words glued together.",
    "- Pronounceable. Looks good as a domain (.xyz / .com).",
    "- NEVER use these stems or compounds: Aegis, Sentinel, Nexus, Quantum, Synergy, Nova, Apex, Vanguard, Vortex, Cipher, Meta, Ultra, Hyper, Omni, Neo, Cyber, Guardian, Shield, Fortress, Titan, Phoenix, Dragon, Pulse, Spark, Flux, Vertex, Zenith, Infinity, AgentAI, Botify.",
    "- No trademark mega-brands. No pure dictionary spam. No ending every name in -ly, -ify, -ai, -io.",
    "- score 1-100; style one of: compress, truncate, compound, coined; rationale one plain sentence.",
    "- Prefer names a human would actually put on a storefront sign.",
  ].join(" ");
}
