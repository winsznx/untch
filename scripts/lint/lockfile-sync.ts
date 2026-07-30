/**
 * Does every workspace manifest agree with the COMMITTED lockfile?
 *
 * This exists because a production deployment failed for exactly this reason, and it failed in a way
 * that looked like something else entirely. The deploy was uploaded from a working directory whose
 * root `package.json` carried an uncommitted local dependency. The `pnpm-lock.yaml` in the same
 * upload was the committed one, which knew nothing about it, so Railway's
 * `pnpm install --frozen-lockfile` refused the install and the build died before a container existed.
 *
 * The visible symptom was two FAILED deployments while an older container kept serving. The invisible
 * consequence was worse: spending authority had already been granted to the service on the assumption
 * that the new code was live. Nothing about the error message pointed at the actual defect, which was
 * that the artefact being shipped was never the commit anyone had reviewed.
 *
 * WHY NOT JUST RUN PNPM
 *
 * `pnpm install --frozen-lockfile` is the authority here, and it already reports this. The problem is
 * WHEN it reports it: inside a remote builder, after an upload, at which point the operator is looking
 * at a failed deployment rather than at their own tree. This check answers the same question locally,
 * in milliseconds, with no network and no install, so it can run in CI on every push and as a hard
 * gate before an upload.
 *
 * WHY A HAND-WRITTEN PARSER
 *
 * Adding a YAML dependency to detect dependency drift would change the very lockfile under test, and
 * the repository deliberately carries almost no root dependencies. The `importers` block is not
 * general YAML: pnpm emits it with fixed two-space nesting, no anchors, no aliases and no multi-line
 * scalars. Parsing that narrow shape is a smaller risk than taking a dependency, and the fixtures in
 * the test suite pin the shape so a future lockfile format change fails loudly rather than silently
 * reporting "no drift".
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** The three dependency groups pnpm records per importer. `peerDependencies` is not one of them. */
const DEP_GROUPS = ["dependencies", "devDependencies", "optionalDependencies"] as const;
export type DepGroup = (typeof DEP_GROUPS)[number];

export type DriftKind = "missing-from-lockfile" | "missing-from-manifest" | "specifier-changed";

/**
 * Whether `pnpm install --frozen-lockfile` actually refuses this.
 *
 * The distinction is load-bearing rather than cosmetic. A gate that blocks on everything it notices
 * would block deployments that pnpm is perfectly happy with, and the first time that happened someone
 * would pass a flag to skip the gate, permanently. So "blocking" means verified to fail a real frozen
 * install, and everything else is reported without stopping the deploy.
 *
 * The one advisory case is a lockfile importer whose directory is absent. pnpm prunes it silently.
 * This was confirmed by running a real frozen install against a clean export of the deployed commit,
 * which contains exactly that condition for a gitignored app directory and installs without error.
 * It is still worth printing, because the workspace file's own header records that a lockfile importer
 * for a gitignored directory has broken CI here before.
 */
export type Severity = "blocking" | "advisory";

export interface Drift {
  readonly importer: string;
  readonly group: DepGroup;
  readonly name: string;
  readonly kind: DriftKind;
  readonly severity: Severity;
  readonly manifestSpec: string | null;
  readonly lockfileSpec: string | null;
}

/** One importer's recorded specifiers, by group. */
export type ImporterSpecs = Readonly<Record<DepGroup, ReadonlyMap<string, string>>>;

function emptyImporter(): Record<DepGroup, Map<string, string>> {
  return { dependencies: new Map(), devDependencies: new Map(), optionalDependencies: new Map() };
}

/**
 * Strip pnpm's key quoting.
 *
 * Scoped names arrive as `'@types/node'`. Nothing else in this block is quoted, but a specifier that
 * happens to be quoted is unwrapped by the same rule rather than by a second one.
 */
function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Split `key: value` on the FIRST separator only.
 *
 * Specifiers contain colons routinely (`workspace:*`, `npm:pkg@1`, `catalog:default`). Splitting on
 * every colon would silently truncate them, and a truncated specifier compares unequal to a correct
 * manifest entry, which would turn this check into a source of false alarms.
 */
function splitFirst(line: string): { key: string; value: string } | null {
  const i = line.indexOf(":");
  if (i === -1) return null;
  return { key: unquote(line.slice(0, i)), value: line.slice(i + 1).trim() };
}

/**
 * Read the `importers` block.
 *
 * Nesting is fixed by pnpm: importer paths at two spaces, group names at four, package names at six,
 * and `specifier` / `version` at eight. Anything shallower than two spaces ends the block, which is
 * how the top-level `packages:` section terminates the scan.
 */
export function parseImporters(lockfileText: string): ReadonlyMap<string, ImporterSpecs> {
  const out = new Map<string, Record<DepGroup, Map<string, string>>>();
  const lines = lockfileText.split("\n");

  let inBlock = false;
  let importer: string | null = null;
  let group: DepGroup | null = null;
  let pkg: string | null = null;

  for (const line of lines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    if (!inBlock) {
      if (indent === 0 && line.startsWith("importers:")) inBlock = true;
      continue;
    }

    // A new top-level key ends the importers block.
    if (indent === 0) break;

    if (indent === 2) {
      const kv = splitFirst(line.trim());
      if (!kv) continue;
      importer = kv.key;
      group = null;
      pkg = null;
      if (!out.has(importer)) out.set(importer, emptyImporter());
      continue;
    }

    if (indent === 4) {
      const name = unquote(line.trim().replace(/:$/, ""));
      group = (DEP_GROUPS as readonly string[]).includes(name) ? (name as DepGroup) : null;
      pkg = null;
      continue;
    }

    if (indent === 6) {
      if (group === null) continue;
      pkg = unquote(line.trim().replace(/:$/, ""));
      continue;
    }

    if (indent === 8) {
      if (importer === null || group === null || pkg === null) continue;
      const kv = splitFirst(line.trim());
      if (!kv || kv.key !== "specifier") continue;
      out.get(importer)?.[group].set(pkg, unquote(kv.value));
    }
  }

  return out;
}

/**
 * The top-level `overrides:` block.
 *
 * This is not a detail that can be skipped. An override REWRITES the specifier pnpm records for every
 * importer that depends on the named package, so a manifest saying `^5.4.2` against an override of
 * `5.10.1` is correct and expected. A checker that did not know this would report drift on every
 * overridden dependency, and a check that cries wolf is a check that gets skipped, which is how the
 * real signal would have been lost.
 *
 * Only the bare-name form is honoured. pnpm also accepts scoped selectors such as `pkg@1 > dep` and
 * ranged ones such as `dep@<1.2.3`, which do not straightforwardly rewrite a direct dependency's
 * recorded specifier. Those are deliberately left alone: failing to apply an override can only produce
 * a report to investigate, whereas applying one wrongly would silently mask genuine drift.
 */
export function parseOverrides(text: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  let inBlock = false;

  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      inBlock = line.startsWith("overrides:");
      continue;
    }
    if (!inBlock || indent !== 2) continue;

    const kv = splitFirst(line.trim());
    if (kv && kv.value !== "") out.set(kv.key, unquote(kv.value));
  }

  return out;
}

/** The `packages:` globs from pnpm-workspace.yaml, including `!` exclusions. */
export function parseWorkspaceGlobs(workspaceText: string): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  let inBlock = false;

  for (const line of workspaceText.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      inBlock = line.startsWith("packages:");
      continue;
    }
    if (!inBlock) continue;

    const item = line.trim();
    if (!item.startsWith("- ")) continue;
    const pattern = unquote(item.slice(2));
    if (pattern.startsWith("!")) exclude.push(pattern.slice(1));
    else include.push(pattern);
  }

  return { include, exclude };
}

/**
 * Expand the workspace globs to importer directories that actually hold a manifest.
 *
 * Only the single-level `dir/*` form pnpm uses here is expanded. An unexpected pattern is returned
 * verbatim rather than skipped, so it surfaces as a missing manifest instead of vanishing from the
 * comparison.
 */
export function resolveImporterDirs(root: string, globs: { include: string[]; exclude: string[] }): string[] {
  const found = new Set<string>(["."]);

  for (const pattern of globs.include) {
    if (!pattern.endsWith("/*")) {
      found.add(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    const abs = join(root, parent);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${parent}/${entry.name}`;
      if (existsSync(join(root, rel, "package.json"))) found.add(rel);
    }
  }

  for (const pattern of globs.exclude) found.delete(pattern);
  return [...found].sort();
}

function readManifestSpecs(root: string, importer: string): Record<DepGroup, Map<string, string>> | null {
  const path = importer === "." ? join(root, "package.json") : join(root, importer, "package.json");
  if (!existsSync(path)) return null;

  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<DepGroup, Record<string, string>>>;
  const specs = emptyImporter();
  for (const group of DEP_GROUPS) {
    for (const [name, spec] of Object.entries(parsed[group] ?? {})) specs[group].set(name, spec);
  }
  return specs;
}

/**
 * Compare every importer's manifest against the lockfile.
 *
 * The union of on-disk importer directories and lockfile importer keys is used, not either alone. A
 * manifest with no lockfile entry and a lockfile entry with no manifest are both real drift, and each
 * one breaks `--frozen-lockfile` on its own.
 */
export function findDrift(root: string): Drift[] {
  const lockPath = join(root, "pnpm-lock.yaml");
  const wsPath = join(root, "pnpm-workspace.yaml");
  if (!existsSync(lockPath)) throw new Error(`no pnpm-lock.yaml at ${lockPath}`);

  const lockText = readFileSync(lockPath, "utf8");
  const lockImporters = parseImporters(lockText);
  const overrides = parseOverrides(lockText);
  const globs = existsSync(wsPath)
    ? parseWorkspaceGlobs(readFileSync(wsPath, "utf8"))
    : { include: [], exclude: [] };
  const onDisk = resolveImporterDirs(root, globs);

  const importers = [...new Set([...onDisk, ...lockImporters.keys()])].sort();
  const drift: Drift[] = [];

  // The manifest's own override table must match the lockfile's. They are the same declaration in two
  // places, and a change to one without the other is the same class of defect this check exists for.
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    pnpm?: { overrides?: Record<string, string> };
  };
  const declared = rootManifest.pnpm?.overrides ?? {};
  for (const [name, spec] of Object.entries(declared)) {
    const locked = overrides.get(name);
    if (locked === undefined) {
      drift.push({ importer: "(overrides)", group: "dependencies", name, kind: "missing-from-lockfile", severity: "blocking", manifestSpec: spec, lockfileSpec: null });
    } else if (locked !== spec) {
      drift.push({ importer: "(overrides)", group: "dependencies", name, kind: "specifier-changed", severity: "blocking", manifestSpec: spec, lockfileSpec: locked });
    }
  }
  for (const [name, spec] of overrides) {
    if (!(name in declared)) {
      drift.push({ importer: "(overrides)", group: "dependencies", name, kind: "missing-from-manifest", severity: "blocking", manifestSpec: null, lockfileSpec: spec });
    }
  }

  for (const importer of importers) {
    const manifest = readManifestSpecs(root, importer);
    const locked = lockImporters.get(importer);

    // An importer the lockfile records but no manifest exists for, or the reverse. Reported once
    // against the importer rather than once per dependency, because the actionable fact is the
    // directory, not the list.
    if (manifest === null || locked === undefined) {
      drift.push({
        importer,
        group: "dependencies",
        name: "(importer)",
        kind: manifest === null ? "missing-from-manifest" : "missing-from-lockfile",
        // A manifest with no lockfile importer forces pnpm to resolve, which a frozen install refuses.
        // The reverse, a recorded importer whose directory is gone, is pruned without complaint.
        severity: manifest === null ? "advisory" : "blocking",
        manifestSpec: manifest === null ? null : "present",
        lockfileSpec: locked === undefined ? null : "present",
      });
      continue;
    }

    for (const group of DEP_GROUPS) {
      const mine = manifest[group];
      const theirs = locked[group];

      for (const [name, spec] of mine) {
        const lockSpec = theirs.get(name);
        // An overridden package is recorded under the override's specifier, so that is what the
        // lockfile is expected to hold rather than whatever the manifest asks for.
        const expected = overrides.get(name) ?? spec;
        if (lockSpec === undefined) {
          drift.push({ importer, group, name, kind: "missing-from-lockfile", severity: "blocking", manifestSpec: spec, lockfileSpec: null });
        } else if (lockSpec !== expected) {
          drift.push({ importer, group, name, kind: "specifier-changed", severity: "blocking", manifestSpec: expected, lockfileSpec: lockSpec });
        }
      }

      for (const [name, spec] of theirs) {
        if (!mine.has(name)) {
          drift.push({ importer, group, name, kind: "missing-from-manifest", severity: "blocking", manifestSpec: null, lockfileSpec: spec });
        }
      }
    }
  }

  return drift;
}

export function describeDrift(d: Drift): string {
  const where = `${d.importer === "." ? "<root>" : d.importer}  ${d.group}  ${d.name}`;
  switch (d.kind) {
    case "missing-from-lockfile":
      return `${where}\n      manifest has ${d.manifestSpec}, the lockfile has no entry`;
    case "missing-from-manifest":
      return `${where}\n      lockfile has ${d.lockfileSpec}, the manifest has no entry`;
    case "specifier-changed":
      return `${where}\n      manifest wants ${d.manifestSpec}, the lockfile records ${d.lockfileSpec}`;
  }
}
