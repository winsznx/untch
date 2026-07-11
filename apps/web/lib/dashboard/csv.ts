/**
 * Pure CSV serialization for the ledger export. Kept separate from the client component so it is
 * node-testable and has no DOM dependency.
 */

export interface ExportRow {
  type: string;
  amount: number;
  token: string;
  vendor: string;
  category: string;
  createdAt: string;
  txHash: string | null;
  receiptId: string;
}

export const EXPORT_COLUMNS: { key: keyof ExportRow; label: string }[] = [
  { key: "createdAt", label: "time" },
  { key: "type", label: "type" },
  { key: "amount", label: "amount" },
  { key: "token", label: "token" },
  { key: "vendor", label: "vendor" },
  { key: "category", label: "category" },
  { key: "receiptId", label: "receiptId" },
  { key: "txHash", label: "txHash" },
];

export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: ExportRow[]): string {
  const header = EXPORT_COLUMNS.map((c) => c.label).join(",");
  const lines = rows.map((r) => EXPORT_COLUMNS.map((c) => csvCell(r[c.key])).join(","));
  return [header, ...lines].join("\n");
}
