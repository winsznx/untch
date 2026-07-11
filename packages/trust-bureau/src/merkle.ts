import {
  encodeAbiParameters,
  keccak256,
  concatHex,
  type Hex,
} from "viem";
import { SUBJECT_KIND_CODE, type ScoreSnapshotRow } from "./types";

/**
 * A deterministic keccak256 merkle tree over an epoch's score snapshots, so `ScoreAnchored(root, epoch,
 * subjectKind)` commits to the exact set of scores that were in force — a third party can re-derive the
 * root from the snapshots and check it matches the on-chain event. Internal-node hashing is COMMUTATIVE
 * (sort the pair before hashing), the same convention OpenZeppelin's MerkleProof uses, so proof order
 * never matters. An odd node is promoted (carried) to the next level, not duplicated.
 *
 * The leaf binds every enforcement-relevant field — kind, subject, epoch, and the fixed-point score / σ
 * / LCB — so a snapshot cannot be altered after anchoring without changing the root.
 */

const SCALE = 1_000_000n;

function toScaled(v: number): bigint {
  return BigInt(Math.round(v * Number(SCALE)));
}

/** The leaf for one snapshot: keccak256 over the abi-encoded (kind, subjectId, epoch, score, σ, lcb). */
export function leafOf(row: ScoreSnapshotRow): Hex {
  const encoded = encodeAbiParameters(
    [
      { name: "subjectKind", type: "uint8" },
      { name: "subjectId", type: "bytes32" },
      { name: "epoch", type: "uint64" },
      { name: "scoreScaled", type: "uint256" },
      { name: "sigmaScaled", type: "uint256" },
      { name: "lcbScaled", type: "uint256" },
    ],
    [
      SUBJECT_KIND_CODE[row.subject],
      row.subjectId as Hex,
      BigInt(row.epoch),
      toScaled(row.score),
      toScaled(row.sigma),
      toScaled(row.lcb),
    ],
  );
  return keccak256(encoded);
}

/** Commutative internal-node hash: keccak256(min(a,b) ‖ max(a,b)). */
export function hashPair(a: Hex, b: Hex): Hex {
  const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concatHex([lo, hi]));
}

/** The merkle root over an ordered set of leaves. Throws on empty (a zero/absent root is meaningless —
 *  and `anchorScore` reverts on a zero root). A single leaf is its own root. */
export function merkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) throw new Error("merkleRoot: no leaves (nothing to anchor)");
  let level = [...leaves];
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = i + 1 < level.length ? level[i + 1]! : undefined;
      next.push(b === undefined ? a : hashPair(a, b));
    }
    level = next;
  }
  return level[0]!;
}

/** Convenience: root over a set of snapshots, leaves sorted for a canonical, reproducible tree. */
export function rootOfSnapshots(rows: readonly ScoreSnapshotRow[]): Hex {
  const leaves = rows.map(leafOf).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return merkleRoot(leaves);
}
