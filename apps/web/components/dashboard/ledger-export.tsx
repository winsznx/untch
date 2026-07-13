"use client";

import { toCsv, type ExportRow } from "../../lib/dashboard/csv";

/**
 * CSV / JSON export for the ledger. This was previously disabled bundled with the wallet-dependent
 * actions, but exporting already-rendered rows needs no wallet and no live infra: it serializes the exact
 * data on the page and downloads it in the browser. So it is simply enabled.
 */

export type { ExportRow };

function download(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function LedgerExport({ rows }: { rows: ExportRow[] }) {
  const stamp = new Date().toISOString().slice(0, 10);
  return (
    <div className="flex flex-wrap gap-3">
      <button type="button" onClick={() => download(`untch-ledger-${stamp}.csv`, "text/csv", toCsv(rows))} style={btnStyle}>
        Export CSV
      </button>
      <button type="button" onClick={() => download(`untch-ledger-${stamp}.json`, "application/json", JSON.stringify(rows, null, 2))} style={btnStyle}>
        Export JSON
      </button>
    </div>
  );
}

const btnStyle = {
  borderRadius: "9999px",
  padding: "8px 20px",
  fontSize: 14,
  fontWeight: 500,
  background: "transparent",
  color: "var(--color-text)",
  border: "1px solid var(--color-border)",
  cursor: "pointer",
} as const;
