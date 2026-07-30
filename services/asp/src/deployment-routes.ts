/**
 * `GET /healthz` and `GET /internal/deployment-info`.
 *
 * These are the two halves of the same control, and they are deliberately not one route.
 *
 * `/healthz` is what the PLATFORM asks. It must be answerable with no credential, because a Railway
 * health probe cannot present one, and it must be the single thing that decides whether a container is
 * allowed to take traffic. It says as little as possible: a deployment posture is not something to
 * publish on an unauthenticated endpoint.
 *
 * `/internal/deployment-info` is what an OPERATOR asks before granting spending authority. It answers
 * the question that was answered by assumption on 2026-07-29: which commit is serving, is the migration
 * that the new gate needs actually applied, and is the gate loaded and disabled. It requires a token,
 * because the answer is a map of what is and is not armed.
 */

import type { Express, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { DeploymentLifecycle, type DeploymentInfo } from "./deployment-info";

export const HEALTH_ROUTE = "/healthz";
export const DEPLOYMENT_INFO_ROUTE = "/internal/deployment-info";

/**
 * Constant-time comparison that does not leak length.
 *
 * `timingSafeEqual` throws on unequal lengths, and catching that throw would itself be a length
 * oracle. Comparing fixed-width digests of both sides removes the difference.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

function presentedToken(req: Request): string | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1];
  if (bearer) return bearer.trim();
  const header = req.header("x-untch-ops-token");
  return header ? header.trim() : null;
}

/**
 * Everything the endpoint is allowed to say.
 *
 * Built by naming fields IN rather than by deleting fields out. A deny-list would silently start
 * publishing any field a later change adds to DeploymentInfo, and the fields most likely to be added
 * near this code are the ones that must never be published.
 */
function redact(info: DeploymentInfo): Record<string, unknown> {
  return {
    app: info.app,
    phase: info.phase,
    failureReason: info.failureReason,
    commit: info.commit,
    commitShort: info.commitShort,
    branch: info.branch,
    builtAt: info.builtAt,
    attested: info.attested,
    railwayDeploymentId: info.railwayDeploymentId,
    startedAt: info.startedAt,
    readyAt: info.readyAt,
    migrationVersion: info.migrationVersion,
    settlementRails: info.settlementRails,
    proofGate: {
      code: info.solana.codePresent ? "present" : "absent",
      schema: info.solana.schemaReady ? "ready" : "not-ready",
      proofMode: info.solana.proofMode,
    },
    solana: {
      signer: info.solana.signer,
      execution: info.solana.execution,
      // Host only. The Alchemy key lives in the URL path, so the URL itself can never appear here.
      rpcHost: info.solana.rpcHost,
      rpcMode: info.solana.rpcMode,
    },
    // A public chain address is not a credential. The private keys behind it are never read here.
    baseTreasuryAddress: info.baseTreasuryAddress,
  };
}

export function registerDeploymentRoutes(app: Express, lifecycle: DeploymentLifecycle | null): void {
  /**
   * Railway's health gate.
   *
   * A null lifecycle reports STARTING, not ready. That default matters: it means a code path that
   * forgets to construct a lifecycle fails the health check rather than silently declaring itself
   * healthy, so the mistake shows up as a failed deployment instead of as a process taking traffic
   * mid-migration.
   */
  app.get(HEALTH_ROUTE, (_req: Request, res: Response) => {
    const info = lifecycle?.snapshot() ?? null;
    const phase = info?.phase ?? "STARTING";
    const ready = phase === "READY";
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : phase.toLowerCase(),
      phase,
      // Deliberately nothing else. This route is unauthenticated.
    });
  });

  app.get(DEPLOYMENT_INFO_ROUTE, (req: Request, res: Response) => {
    const expected = process.env.INTERNAL_OPS_TOKEN?.trim();

    // Fail CLOSED. With no token configured the endpoint is unavailable rather than public, because
    // the alternative is an internal posture map served to anyone who finds the path.
    if (!expected) {
      res.status(503).json({
        code: "OPS_AUTH_NOT_CONFIGURED",
        message: "INTERNAL_OPS_TOKEN is unset on this instance, so deployment info cannot be served",
        retryable: false,
        docsUrl: null,
      });
      return;
    }

    const presented = presentedToken(req);
    if (!presented || !tokenMatches(presented, expected)) {
      res.status(401).json({
        code: "OPS_AUTH_REQUIRED",
        message: "send the operator token as `Authorization: Bearer <token>`",
        retryable: false,
        docsUrl: null,
      });
      return;
    }

    if (!lifecycle) {
      res.status(503).json({
        code: "LIFECYCLE_NOT_TRACKED",
        message: "this process was constructed without a deployment lifecycle",
        retryable: false,
        docsUrl: null,
      });
      return;
    }

    res.status(200).json(redact(lifecycle.snapshot()));
  });
}
