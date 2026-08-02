/**
 * Which service a deploy invocation ships, and what it attests about the artefact.
 *
 * WHY THIS IS A MODULE AND NOT TEN LINES INSIDE `deploy-asp.ts`
 *
 * `deploy-asp.ts` calls `main()` at the bottom of the file, unconditionally. Importing it to test the
 * target selection would RUN A DEPLOYMENT — which is a test that ships code. Resolution and
 * attestation are pure, so they live here where a test can reach them and reaching them costs nothing.
 *
 * WHY A FLAG RATHER THAN A SECOND SCRIPT
 *
 * Two services deploy from this one repository. `railway up` tarballs the working directory, which is
 * how an uncommitted dependency reached a build on 2026-07-29 and killed it; `deploy-asp.ts` exists
 * because of that. A second script for the web app would be a second place for that lesson to be
 * forgotten. One flag keeps the git-archive export, the lockfile gate and the attestation
 * byte-identical for both targets.
 */

export const DEFAULT_SERVICE = "untch-asp";

/**
 * The Railway PROJECT is named after the ASP and holds every service, so the link check is fixed and
 * does NOT follow the flag. Letting it follow would turn a typo into "this repo is linked to the
 * wrong project", which is a confusing way to report an unknown service name.
 */
export const PROJECT_NAME = DEFAULT_SERVICE;

export const KNOWN_SERVICES = ["untch-asp", "untch-web"] as const;
export type KnownService = (typeof KNOWN_SERVICES)[number];

export type ServiceResolution =
  | { readonly ok: true; readonly service: KnownService }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve `--service=` out of an argv, or default.
 *
 * Returns a refusal rather than throwing. The first version threw at module scope, which meant a
 * mistyped service name produced a Node stack trace BEFORE the script had printed a single line —
 * the operator saw a crash where every other failure in this script prints "DEPLOY REFUSED" and says
 * what to do. A deploy tool whose worst-formatted output is the one you get from a typo has the
 * priority backwards.
 */
export function resolveService(argv: readonly string[]): ServiceResolution {
  const flag = argv.find((a) => a.startsWith("--service="));
  if (flag === undefined) return { ok: true, service: DEFAULT_SERVICE };

  const value = flag.slice("--service=".length).trim();
  if (value === "") {
    return {
      ok: false,
      message: `--service was given with no value. Use one of: ${KNOWN_SERVICES.join(", ")}`,
    };
  }
  if (!(KNOWN_SERVICES as readonly string[]).includes(value)) {
    return {
      ok: false,
      message: `--service must be one of ${KNOWN_SERVICES.join(", ")}, received '${value}'`,
    };
  }
  return { ok: true, service: value as KnownService };
}

export interface BuildAttestation {
  readonly commit: string;
  readonly branch: string | null;
  readonly builtAt: string;
  readonly source: "git-archive-export";
  /** Which service this artefact was built for. Two services ship the same commit; only one serves it. */
  readonly service: KnownService;
}

/**
 * The attestation written INTO the artefact.
 *
 * Not a Railway variable: a variable outlives the deployment it was set for, so a variable naming a
 * commit whose build failed is exactly the lie that caused the 2026-07-29 incident. A file inside the
 * uploaded tree travels with the code and cannot describe a different build. `/internal/deployment-info`
 * reads it back, which is how "is the expected code serving" gets a real answer.
 *
 * `service` is recorded because two services now ship from one repository and one commit. Without it,
 * two artefacts built from the same commit are byte-identical apart from their upload target, and an
 * operator holding one cannot tell which surface it was meant for.
 */
export function buildAttestation(args: {
  readonly commit: string;
  readonly branch: string | null;
  readonly builtAt: string;
  readonly service: KnownService;
}): BuildAttestation {
  return {
    commit: args.commit,
    branch: args.branch,
    builtAt: args.builtAt,
    source: "git-archive-export",
    service: args.service,
  };
}
