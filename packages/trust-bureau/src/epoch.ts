import { EPOCH_SECONDS } from "./weights";

/** §12 "Epoch 6h" — the epoch a unix-seconds timestamp falls in. Deterministic; injectable clock keeps
 *  tests and the anchor proof reproducible (no bare Date.now in the scoring path). */
export function epochOf(unixSeconds: number): number {
  return Math.floor(unixSeconds / EPOCH_SECONDS);
}

/** Current epoch from an injectable clock (defaults to wall-clock). */
export function currentEpoch(nowMs: () => number = Date.now): number {
  return epochOf(Math.floor(nowMs() / 1000));
}
