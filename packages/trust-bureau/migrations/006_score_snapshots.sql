-- PRD §8 `score_snapshots` + §12 Untch Bureau. Added to the SAME shared Railway Postgres the receipt
-- writer (001), policy-store (002), and escalation (003/004) already use — NO second instance. This is
-- 006 in the shared, forward-only `schema_migrations` history (005 is receipt-writer's provenance
-- column). Idempotent (IF NOT EXISTS), safe to re-run.
--
-- One row per (subject, subject_id, epoch): the Bureau's deterministic score for that subject in that
-- 6h epoch. `lcb` (= score − z·σ) is stored alongside `score` and `sigma` because enforcement reads the
-- LCB, not the raw score, and we want the exact value that was in force at anchor time to be durable and
-- auditable — not recomputed later against possibly-changed constants. `features` carries the full
-- per-feature breakdown (value, σ, source, weightApplied) so "why this score" (§15) is answerable from
-- the row alone, including which features were cold-start priors vs observed. `anchored_root` is set
-- once the epoch's snapshot tree is merkle-rooted and anchored on-chain (UntchReceipts.anchorScore,
-- §10.3 ScoreAnchored); null until then.

CREATE TABLE IF NOT EXISTS score_snapshots (
  -- §8 subject{VENDOR|BUYER}.
  subject       TEXT        NOT NULL,
  -- §8 subject_id — the vendorId (keccak of canonical host) or agentId (bytes32(uint256)) as a 0x hex.
  subject_id    TEXT        NOT NULL,
  -- §12 6h epoch = floor(unix_seconds / 21600).
  epoch         BIGINT      NOT NULL,

  -- §8 score 0–100 (raw weighted point estimate), uncertainty σ, and lcb = score − z·σ (enforcement).
  score         DOUBLE PRECISION NOT NULL,
  sigma         DOUBLE PRECISION NOT NULL,
  lcb           DOUBLE PRECISION NOT NULL,
  -- The z used for this row's LCB (default 1.28, §12) — stored so the LCB is reproducible.
  z             DOUBLE PRECISION NOT NULL DEFAULT 1.28,
  band          TEXT        NOT NULL,

  -- §8 features JSONB — the full per-feature breakdown (observed vs cold-start-prior, value, σ, weight).
  features      JSONB       NOT NULL DEFAULT '[]'::jsonb,

  -- §8 anchored_root? — the merkle root this subject was anchored under (null until anchored on-chain).
  anchored_root TEXT,

  -- §8 computed_at.
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One authoritative snapshot per subject per epoch; a recompute in the same epoch overwrites it.
  PRIMARY KEY (subject, subject_id, epoch)
);

CREATE INDEX IF NOT EXISTS score_snapshots_epoch_idx    ON score_snapshots (subject, epoch);
CREATE INDEX IF NOT EXISTS score_snapshots_unanchored_idx
  ON score_snapshots (subject, epoch) WHERE anchored_root IS NULL;
