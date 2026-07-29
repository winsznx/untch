/**
 * The public-copy linter.
 *
 * Enforces internal/public-copy-standard.md over the surfaces a person actually reads. The whole
 * design problem here is FALSE POSITIVES: a copy rule that fires on a transaction hash, a protocol
 * field name or a quoted provider string gets disabled within a week, and a disabled check is worse
 * than no check because it looks like coverage.
 *
 * So the pipeline is: pick a narrow set of files, strip everything that is not prose, then apply the
 * rules to what is left. Stripping happens first and is deliberately aggressive — a false negative
 * is a sentence somebody has to catch in review, while a false positive is the reason the whole
 * check gets deleted.
 *
 * Scope is a literal list of globs rather than "everything except". Adding a surface should be a
 * visible diff, not something that happens by accident when a directory is created.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.cwd();

/**
 * The surfaces in scope, as directory or file paths relative to the repo root.
 *
 * `docs/*.md` is the engineering reference: protocol prose written for people reading the protocol,
 * and out of scope for the same reason source comments are. The `.mdx` pages under `docs/` ARE in
 * scope, because those are the rendered marketing and proof pages.
 */
const SCOPE: readonly { readonly path: string; readonly exts: readonly string[]; readonly label: string }[] = [
  { path: "apps/web/app", exts: [".tsx", ".ts"], label: "website + dashboard" },
  { path: "apps/web/components", exts: [".tsx"], label: "website + dashboard" },
  { path: "apps/docs/app", exts: [".tsx"], label: "docs site shell" },
  { path: "docs", exts: [".mdx"], label: "rendered docs pages" },
  { path: "README.md", exts: [".md"], label: "repository front page" },
  { path: "internal/okx-ai-registration.md", exts: [".md"], label: "OKX.AI listing draft" },
  { path: "internal/social-copy-drafts.md", exts: [".md"], label: "social copy drafts" },
  { path: "scripts/untch-authored-copy.ts", exts: [".ts"], label: "Untch-authored email copy" },
];

/** Directories never worth walking, at any depth. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".next", "dist", "out", ".git", "__snapshots__", "test", "tests",
]);

interface Rule {
  readonly id: string;
  readonly test: RegExp;
  readonly message: string;
}

const RULES: readonly Rule[] = [
  {
    id: "em-dash",
    test: /—/,
    message: "em dash. Use a full stop, a comma, or brackets.",
  },
  {
    id: "semicolon",
    test: /;/,
    message: "semicolon in prose. Use two sentences.",
  },
  {
    id: "negation-reveal",
    // "X is not Y. It is Z." and its close relatives. Anchored on the sentence boundary so it
    // cannot fire on an ordinary negation that happens to be followed by another sentence.
    test: /\b(?:is|are|was|were)\s+not\s+[^.!?]{1,60}[.!?]\s+(?:It|They|This|That|These)\s+(?:is|are|was|were)\b/i,
    message: "the \"X is not Y. It is Z.\" construction. Say what it is, once.",
  },
  { id: "not-just", test: /\bthis is not just\b|\bit'?s not just\b|\bnot just a\b/i, message: "\"not just\" filler." },
  { id: "not-another", test: /\bnot another\b/i, message: "\"not another\" filler." },
  { id: "more-than-a", test: /\bmore than (?:a|an|just)\b/i, message: "\"more than a\" filler." },
  { id: "at-its-core", test: /\bat its core\b/i, message: "\"at its core\" filler." },
  { id: "rapidly-evolving", test: /\bin today'?s\b|\brapidly evolving\b|\bever[- ]changing landscape\b/i, message: "trend-piece opener." },
  { id: "revolutionary", test: /\brevolutionar(?:y|ise|ize)\b/i, message: "\"revolutionary\". Say what it does." },
  { id: "game-changing", test: /\bgame[- ]chang(?:ing|er)\b/i, message: "\"game-changing\". Say what changed." },
  { id: "seamless", test: /\bseamless(?:ly)?\b/i, message: "\"seamless\". Say what no longer needs doing." },
  { id: "unlock", test: /\bunlock(?:s|ing|ed)?\b/i, message: "\"unlock\". Say what becomes possible." },
  { id: "empower", test: /\bempower(?:s|ing|ed|ment)?\b/i, message: "\"empower\". Say what the user can now do." },
  { id: "future-of", test: /\bthe future of\b/i, message: "\"the future of\". Describe the present." },
  { id: "thrilled", test: /\bwe(?:'| a)re (?:thrilled|excited|delighted|proud) to\b/i, message: "launch filler. State the change." },
];

/**
 * `agentic` is allowed, but only next to a real action.
 *
 * The failure this catches is the word being used as a substitute for saying what happens. A
 * sentence naming one of these verbs is describing behaviour; a sentence without one is decorating.
 */
const AGENTIC = /\bagentic\b/i;
const CONCRETE_VERB =
  /\b(pays?|paid|signs?|signed|settles?|settled|approves?|approved|refus\w+|executes?|executed|sends?|sent|buys?|bought|registers?|registered|anchors?|anchored|verif\w+|funds?|funded|quotes?|quoted|decides?|decided|blocks?|blocked|proposes?|proposed)\b/i;

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly ruleId: string;
  readonly message: string;
  readonly text: string;
}

const DISABLE = /copy-lint-disable-next-line\s+(.*?)(?:\s*-->|\s*\*\/|$)/;

/**
 * Reduce a source line to the prose it contains, or to empty when it holds none.
 *
 * Order matters. Code spans and fences go first so their contents cannot be examined at all; then
 * data that is legitimately punctuation-dense (hashes, addresses, URLs, SCREAMING_CASE identifiers);
 * then, for TSX, everything that is not visible text.
 */
export function proseOf(line: string, ext: string): string {
  let s = line;

  // A table cell holding nothing but a dash is a NOT-APPLICABLE marker, which is data. Blanking the
  // cell rather than the whole row keeps the rest of the row's prose under the rules.
  s = s.replace(/\|\s*[—–-]\s*(?=\|)/g, "| ");
  s = s.replace(/\|\s*[—–-]\s*$/, "|");

  // HTML entities are markup. `&apos;` and `&amp;` end in a semicolon that belongs to the encoding,
  // not to the sentence, and flagging them would push authors towards raw apostrophes in JSX.
  s = s.replace(/&[a-zA-Z][a-zA-Z0-9]{1,10};|&#\d{1,6};/g, "'");

  // Product names that happen to contain a banned word. `Agentic Wallet` is OKX's product, and a
  // proper noun is not a claim about behaviour — which is the thing the `agentic` rule polices.
  s = s.replace(/\b(?:OKX\s+)?Agentic Wallet\b/g, " ");

  s = s.replace(/`[^`]*`/g, " ");                     // inline code
  s = s.replace(/```[\s\S]*?```/g, " ");              // fenced code on one line
  s = s.replace(/\bhttps?:\/\/\S+/gi, " ");           // URLs
  s = s.replace(/\b0x[0-9a-fA-F]{6,}\b/g, " ");       // hashes and addresses
  s = s.replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, " "); // MACHINE_READABLE_CODES
  s = s.replace(/\b[a-z0-9]+(?:\.[a-z0-9_]+){1,}\b/gi, " "); // field.paths and host.names
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");      // markdown links, keep the label

  if (ext === ".tsx" || ext === ".ts") {
    // Only two things in a component are read by a person: a quoted string, and the text between
    // JSX tags. Everything else — imports, props, class names, logic — is code.
    const strings = [...s.matchAll(/"([^"\\]{6,})"|'([^'\\]{6,})'/g)].map((m) => m[1] ?? m[2] ?? "");
    const jsxText = [...s.matchAll(/>([^<>{}]{6,})</g)].map((m) => m[1] ?? "");
    s = [...strings, ...jsxText].filter(isEnglishProse).join(" ");
  }

  return s;
}

/**
 * Does this string read like a sentence, or like a value?
 *
 * The problem case is a Tailwind class list: `flex items-center gap-2; rounded-md` is several
 * lowercase words and a semicolon, and a word-count heuristic happily calls it prose and then fails
 * the build over CSS. What separates copy from a value is not length but FUNCTION WORDS — English
 * sentences are full of `the`, `to`, `of`, `is`, and class lists, paths and identifiers have none.
 *
 * Requiring one is a little conservative: a three-word headline with no function word slips through.
 * That direction is the right one to be wrong in. A missed headline is caught in review; a linter
 * that fails on `className` is a linter somebody deletes.
 */
const FUNCTION_WORD =
  /\b(?:the|a|an|to|of|and|or|is|are|was|were|be|been|for|with|that|this|it|its|in|on|at|by|from|you|your|we|our|they|their|not|no|when|if|but|so|as|has|have|had|will|can|any|every|each|which|what|who|how|why)\b/i;

function isEnglishProse(s: string): boolean {
  const words = s.trim().split(/\s+/);
  if (words.length < 3) return false;
  return FUNCTION_WORD.test(s);
}

export function lintText(text: string, file: string, ext: string): readonly Violation[] {
  const out: Violation[] = [];
  const lines = text.split(/\r?\n/);
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";

    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const prev = lines[i - 1] ?? "";
    const disable = DISABLE.exec(prev);
    if (disable) {
      const reason = (disable[1] ?? "").trim();
      if (reason.length >= 4) continue;
      out.push({
        file, line: i + 1, ruleId: "disable-needs-reason",
        message: "a copy-lint-disable needs a reason of at least four characters.",
        text: prev.trim(),
      });
      continue;
    }

    const prose = proseOf(raw, ext);
    if (prose.trim() === "") continue;

    for (const rule of RULES) {
      if (rule.test.test(prose)) {
        out.push({ file, line: i + 1, ruleId: rule.id, message: rule.message, text: raw.trim().slice(0, 120) });
      }
    }
    if (AGENTIC.test(prose) && !CONCRETE_VERB.test(prose)) {
      out.push({
        file, line: i + 1, ruleId: "agentic-without-action",
        message: "\"agentic\" with no action named. Say what the agent does.",
        text: raw.trim().slice(0, 120),
      });
    }
  }
  return out;
}

function* walk(path: string, exts: readonly string[]): Generator<string> {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (exts.includes(extname(path))) yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    yield* walk(join(path, entry), exts);
  }
}

export function collectFiles(): readonly { readonly file: string; readonly label: string }[] {
  const out: { file: string; label: string }[] = [];
  for (const s of SCOPE) {
    for (const f of walk(join(ROOT, s.path), s.exts)) out.push({ file: f, label: s.label });
  }
  return out;
}

export { SCOPE, RULES };
