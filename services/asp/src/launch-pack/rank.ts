/**
 * Rank brand names for a hireable launch pack: length, charset, pronounceability, domain-friendliness.
 */

export type RankedName = {
  readonly name: string;
  readonly score: number;
  readonly reasons: readonly string[];
};

const VOWELS = new Set("aeiouy");

function pronounceScore(name: string): { pts: number; ok: boolean } {
  const s = name.toLowerCase();
  let vowelRuns = 0;
  let consRuns = 0;
  let run = 1;
  for (let i = 1; i < s.length; i++) {
    const a = VOWELS.has(s[i - 1]!);
    const b = VOWELS.has(s[i]!);
    if (a === b) run++;
    else {
      if (a) vowelRuns = Math.max(vowelRuns, run);
      else consRuns = Math.max(consRuns, run);
      run = 1;
    }
  }
  const lastV = VOWELS.has(s[s.length - 1]!);
  if (lastV) vowelRuns = Math.max(vowelRuns, run);
  else consRuns = Math.max(consRuns, run);

  let pts = 25;
  if (consRuns >= 4) pts -= 12;
  if (vowelRuns >= 3) pts -= 6;
  if (consRuns <= 2 && vowelRuns <= 2) pts += 8;
  const hasVowel = [...s].some((c) => VOWELS.has(c));
  if (!hasVowel) pts -= 20;
  return { pts: Math.max(0, pts), ok: hasVowel && consRuns < 4 };
}

export function rankBrandNames(names: readonly string[]): {
  ranked: RankedName[];
  top: string | null;
} {
  const ranked = names
    .map((raw) => {
      const name = raw.trim();
      const reasons: string[] = [];
      let score = 0;
      const len = name.length;

      if (len >= 5 && len <= 10) {
        score += 35;
        reasons.push("ideal-length");
      } else if (len >= 4 && len <= 12) {
        score += 22;
        reasons.push("ok-length");
      } else {
        score += 8;
        reasons.push("awkward-length");
      }

      if (/^[A-Za-z]+$/.test(name)) {
        score += 25;
        reasons.push("alpha-only");
      } else if (/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
        score += 15;
        reasons.push("alphanumeric");
      } else {
        score += 5;
        reasons.push("messy-charset");
      }

      if (!name.includes("-") && !name.includes("_") && !/\s/.test(name)) {
        score += 15;
        reasons.push("single-token");
      }

      const pro = pronounceScore(name);
      score += pro.pts;
      if (pro.ok) reasons.push("pronounceable");
      else reasons.push("hard-to-say");

      // Prefer starting capital for brand feel
      if (/^[A-Z]/.test(name)) {
        score += 5;
        reasons.push("title-case");
      }

      return { name, score, reasons };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return { ranked, top: ranked[0]?.name ?? null };
}
