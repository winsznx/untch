/**
 * Classify a proposed git command by what it would DESTROY, not by what it is called.
 *
 * WHY A CLASSIFIER AND NOT A LIST
 *
 * `reset --hard` is the command that discarded six files' uncommitted work on 2026-07-30, so it is the
 * one everybody remembers. It is not the only one. `git clean -fd` deletes untracked files outright and
 * leaves no object behind at all; `git restore <path>` and `git checkout -- <path>` overwrite a modified
 * file from the index with no prompt and no reflog. A denylist of literal strings would catch the
 * remembered command and miss its three siblings, which is the failure mode that produced this file.
 *
 * So the unit here is an OUTCOME. Each rule answers one question — "would running this overwrite or
 * delete something the working tree is the only copy of" — and the answer is computed from the parsed
 * argv rather than matched against a phrase. `reset --hard`, `reset --hard=…`, `-C <dir> reset --hard`
 * and `reset --mixed --hard` all reach the same rule, because they all reach the same outcome.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM
 *
 * It is NOT a shell interceptor. Nothing in this repository routes arbitrary commands through it, and a
 * guard that advertised otherwise would be worse than no guard — it would tell an operator they were
 * protected while `git reset --hard` typed at a prompt sailed past. It refuses commands that are HANDED
 * to it: `pnpm guard:git -- <args>` in a script, and `pnpm guard:tracked` as a precondition step. The
 * protection is real exactly to the extent that the operation is routed through it, and the CLI says so
 * in its own output rather than leaving the reader to assume.
 */

export type DestructiveKind =
  | "reset-hard"
  | "clean-force"
  | "restore-worktree"
  | "checkout-overwrite"
  | "branch-switch-overwrite";

export interface DestructiveVerdict {
  readonly destructive: boolean;
  readonly kind: DestructiveKind | null;
  /** What it would destroy, phrased as an outcome. Empty when `destructive` is false. */
  readonly outcome: string;
  /** Paths the command names, when it names any. An empty list means "the whole tree". */
  readonly paths: readonly string[];
  /** The non-destructive command that achieves the same intent. */
  readonly alternative: string | null;
}

const SAFE: DestructiveVerdict = {
  destructive: false,
  kind: null,
  outcome: "",
  paths: [],
  alternative: null,
};

/**
 * Strip the options git itself takes before the subcommand — `-C <dir>`, `-c k=v`, `--git-dir=…`.
 *
 * Without this, `git -C /repo reset --hard` parses with `-C` as the subcommand and falls through as
 * safe. The forms that take a separate value are enumerated because skipping a value that does not
 * exist would swallow the subcommand itself.
 */
const GLOBAL_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

function subcommandAt(argv: readonly string[]): { readonly index: number; readonly name: string } | null {
  let i = 0;
  if (argv[i] === "git") i += 1;
  while (i < argv.length) {
    const token = argv[i] as string;
    if (!token.startsWith("-")) return { index: i, name: token };
    if (GLOBAL_WITH_VALUE.has(token)) i += 2;
    else i += 1;
  }
  return null;
}

/** Flags a subcommand takes, in both `--flag value` and `--flag=value` spellings. */
function hasFlag(args: readonly string[], ...names: readonly string[]): boolean {
  return args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
}

/**
 * Short flags cluster: `-fd`, `-fdx` and `-df` all mean force. Testing for the literal `-f` would pass
 * every one of them, and `git clean -fd` is the exact spelling the prompt names.
 */
function hasShort(args: readonly string[], letter: string): boolean {
  return args.some((a) => /^-[a-zA-Z]+$/.test(a) && !a.startsWith("--") && a.includes(letter));
}

/** Everything after the subcommand that is not a flag and not the `--` separator. */
function positionals(args: readonly string[]): readonly string[] {
  const out: string[] = [];
  let afterSeparator = false;
  for (const a of args) {
    if (a === "--") {
      afterSeparator = true;
      continue;
    }
    if (!afterSeparator && a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

/**
 * Judge one command.
 *
 * `argv` is the command as an argument vector — already word-split, never a shell string. Re-splitting
 * a string here would mean re-implementing quoting, and a guard that disagrees with the shell about
 * where a word ends is a guard that can be walked past with a quote mark.
 */
export function classifyGitCommand(argv: readonly string[]): DestructiveVerdict {
  const sub = subcommandAt(argv);
  if (!sub) return SAFE;
  const args = argv.slice(sub.index + 1);

  switch (sub.name) {
    case "reset":
      // `--hard` discards working-tree and index changes together. `--merge` and `--keep` refuse when
      // they would lose a local modification, so they are not this rule's business.
      if (hasFlag(args, "--hard")) {
        return {
          destructive: true,
          kind: "reset-hard",
          outcome:
            "discards every uncommitted change to every tracked file. A file modified but never staged " +
            "leaves no object in the store, so there is nothing to recover it from afterwards.",
          paths: [],
          alternative: "git switch -c <branch> origin/main   (moves the ref, refuses rather than overwrites)",
        };
      }
      return SAFE;

    case "clean":
      // Untracked files have never been in the object store by definition. `clean -f` is the only
      // command here whose loss is unconditional and total.
      if (hasShort(args, "f") || hasFlag(args, "--force")) {
        return {
          destructive: true,
          kind: "clean-force",
          outcome:
            "deletes untracked files outright" +
            (hasShort(args, "d") ? " and untracked directories with them" : "") +
            (hasShort(args, "x") ? ", including ignored files such as .env" : "") +
            ". Untracked content has never been committed, so it is not in the object store and cannot be recovered.",
          paths: positionals(args),
          alternative: "git clean -nd   (prints what it would delete and deletes nothing)",
        };
      }
      return SAFE;

    case "restore": {
      // `--staged` alone only rewrites the index; the working tree is untouched, so nothing is lost.
      // The default target IS the working tree, which is why the absence of a flag is destructive here.
      const worktree = hasFlag(args, "--worktree", "-W") || !hasFlag(args, "--staged", "-S");
      if (!worktree) return SAFE;
      return {
        destructive: true,
        kind: "restore-worktree",
        outcome:
          "overwrites the named paths in the working tree from the index or a commit, discarding the " +
          "modifications they currently hold.",
        paths: positionals(args),
        alternative: "git diff -- <paths>   (read what would be discarded first)",
      };
    }

    case "checkout": {
      const pos = positionals(args);
      // `checkout -- <path>` and `checkout <ref> -- <path>` are `restore` under the old name: they
      // overwrite a path in the working tree. The `--` is what distinguishes them from a branch switch.
      if (argv.includes("--")) {
        return {
          destructive: true,
          kind: "checkout-overwrite",
          outcome:
            "overwrites the named paths in the working tree, discarding the modifications they hold. " +
            "This is `git restore` under its older name.",
          paths: pos,
          alternative: "git diff -- <paths>   (read what would be discarded first)",
        };
      }
      // A plain `checkout <branch>` REFUSES when a local modification would be lost — it is only
      // destructive with `--force`, which turns the refusal off.
      if (hasFlag(args, "--force") || hasShort(args, "f")) {
        return {
          destructive: true,
          kind: "branch-switch-overwrite",
          outcome:
            "switches branches and discards local modifications instead of refusing, which is precisely " +
            "the refusal that makes an ordinary checkout safe.",
          paths: [],
          alternative: "git switch <branch>   (refuses when a modification would be lost)",
        };
      }
      return SAFE;
    }

    case "switch":
      if (hasFlag(args, "--discard-changes") || hasFlag(args, "--force") || hasShort(args, "f")) {
        return {
          destructive: true,
          kind: "branch-switch-overwrite",
          outcome: "switches branches and discards local modifications instead of refusing.",
          paths: [],
          alternative: "git switch <branch>   (without --discard-changes)",
        };
      }
      return SAFE;

    default:
      return SAFE;
  }
}

/**
 * Would this command, run now, destroy any of `protectedPaths`?
 *
 * A whole-tree command (`reset --hard`, `clean -f` with no arguments) endangers everything, so any
 * protected path at all is a hit. A path-scoped command endangers only what it names — and the naming
 * is compared by prefix, because `git restore packages/` reaches `packages/consumer-core/src/db.ts`.
 */
export function endangered(
  verdict: DestructiveVerdict,
  protectedPaths: readonly string[],
): readonly string[] {
  if (!verdict.destructive) return [];
  if (verdict.paths.length === 0) return protectedPaths;
  const normalise = (p: string): string => p.replace(/^\.\//, "").replace(/\/+$/, "");
  return protectedPaths.filter((p) =>
    verdict.paths.some((named) => {
      const n = normalise(named);
      const t = normalise(p);
      return n === "." || t === n || t.startsWith(`${n}/`);
    }),
  );
}
