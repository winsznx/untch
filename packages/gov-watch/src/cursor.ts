import { readFileSync, writeFileSync } from "node:fs";
import type { CursorStore } from "./watcher";

/**
 * The watcher's one piece of durable state: the last block fully scanned AND delivered.
 *
 * A file, not Postgres — deliberately. The escalation service's Postgres holds escalation records
 * because they are money-decision state that must survive and be audited. This is a single integer
 * whose worst-case loss is re-alerting or a gap the operator can close by hand with `FROM_BLOCK`.
 * Adding a table (and a migration, and a connection) for one number would make a lightweight poller
 * depend on the database being up in order to notice a stolen admin key. Fewer moving parts is the
 * safer posture here.
 */
export class FileCursor implements CursorStore {
  constructor(private readonly path: string) {}

  async read(): Promise<bigint | null> {
    try {
      const raw = readFileSync(this.path, "utf8").trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { lastScannedBlock?: string };
      return parsed.lastScannedBlock ? BigInt(parsed.lastScannedBlock) : null;
    } catch {
      return null;
    }
  }

  async write(block: bigint): Promise<void> {
    writeFileSync(
      this.path,
      JSON.stringify({ lastScannedBlock: block.toString(), updatedAt: new Date().toISOString() }, null, 2),
    );
  }
}

/** A cursor that never persists — for tests and one-shot replays. */
export class MemoryCursor implements CursorStore {
  constructor(private block: bigint | null = null) {}
  async read(): Promise<bigint | null> {
    return this.block;
  }
  async write(block: bigint): Promise<void> {
    this.block = block;
  }
}
