// The files and the table the import tool leaves behind (card P4-02): rejects.csv,
// import-report.json and the lines it prints. Nothing here ever holds a cell value:
// a reject is a tab, a row number, a column and a reason; the report is counts, ids of
// re-keyed items, key names, checksums and the rules that were applied.
import { TZ } from "../lib/dates";
import type { RunResult } from "./run";
import type { Reject } from "./sheet-to-db";

export const REPORT_FORMAT = "storeops-import-report/1";

const csvField = (s: string | number): string => {
  const t = String(s);
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

/** tab,row,column,reason: one line per rejected cell; the header line even when there are none. */
export function rejectsCsv(rejects: readonly Reject[]): string {
  const lines = ["tab,row,column,reason", ...rejects.map((r) => [r.tab, r.row, r.column, r.reason].map(csvField).join(","))];
  return `${lines.join("\n")}\n`;
}

/** A Sheet header is printed only when it looks like one: nothing odd is echoed. */
const plainName = (s: string): string => (/^[A-Za-z0-9_ .-]{1,60}$/.test(s) ? s : "(unusual name)");

/** What every run says about the data it did not carry as it was. */
const NOTES = [
  "A blank cell is NULL, never 0 or an empty string (ADR-0004); a zero stays 0.",
  "Voided payments do not exist in the Sheet (the old app deleted a payment when it was undone): payments.voided_at, voided_by and void_reason load as NULL.",
  "Tabs were inserted top to bottom, so the seq columns (audit_log, payments, sales, cash_handovers, commission_runs) number the rows in the Sheet's own order. A dry run, or a run that did not commit, still uses up sequence numbers: the real numbers may start above 1. Only their order matters.",
  "Every business date is the Toronto day of the cell (a handover's handed_on and a commission run's week_end keep only that day).",
  "Nothing was deleted, truncated or updated by this tool: it only inserts, into tables that were empty.",
];

export function buildReport(run: RunResult): Record<string, unknown> {
  const sum = (k: "tabRows" | "loaded" | "rejected" | "reKeyed" | "blankKey" | "leftOut"): number => run.tables.reduce((n, t) => n + t[k], 0);
  const m = run.exportDir.manifest;
  const r = run.rules;
  return {
    format: REPORT_FORMAT,
    mode: run.options.dryRun ? "dry-run" : "import",
    outcome:
      run.outcome === "committed"
        ? "committed"
        : run.outcome === "dry-run"
          ? "rolled back: a dry run keeps nothing"
          : "rolled back: the number of rejects is not the number given to --accept-rejects",
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    timeZone: { export: m.timeZone, businessDates: TZ },
    options: { acceptRejects: run.options.acceptRejects, openSessionsBlank: run.options.openSessionsBlank },
    export: {
      manifestSha256: run.exportDir.manifestSha256,
      workbook: m.workbook,
      tabs: m.tabs.map((t) => ({ index: t.index, name: t.name, file: t.file, sha256: t.sha256, rows: t.rows, hidden: t.hidden, formulaCells: t.formulaCells })),
    },
    tables: run.tables.map((t) => ({ ...t })),
    totals: { tabRows: sum("tabRows"), loaded: sum("loaded"), rejected: sum("rejected"), reKeyed: sum("reKeyed"), blankKey: sum("blankKey"), leftOut: sum("leftOut") },
    skippedTabs: run.skippedTabs,
    rejects: { count: run.rejects.length, accepted: run.options.acceptRejects, file: "rejects.csv" },
    headerIssues: run.headerIssues.map((h) => ({ tab: h.tab, kind: h.kind, column: plainName(h.column) })),
    rules: {
      blankIsNull: "a blank cell is NULL; a figure that does not survive the round trip to its column's scale is rejected, not rounded",
      enums: "trimmed and compared without case; stored in the contract's spelling; anything else is rejected",
      foreignKeys: "a row whose parent was rejected or is missing is rejected, naming the parent's table and column",
      duplicateKeys: { rejectedLaterRows: r.duplicateKeyRejects, reKeyed: r.rekeyed },
      placeholders: { leftOut: r.leftOut },
      openSessions: r.openSessions,
      pins: {
        loginCodeNeverImported: true,
        hashed: r.pins.hashed,
        blank: r.pins.blank,
        unreadable: r.pins.unreadable,
        notFourToEightDigits: r.pins.notFourToEightDigits,
      },
      configKeysLeftOut: r.configKeysLeftOut,
      deprecatedTabsSkipped: run.skippedTabs.map((s) => s.tab),
    },
    notes: NOTES,
  };
}

/** The lines the command prints: names and counts only. */
export function summaryLines(run: RunResult, reportDir: string): string[] {
  const nameW = Math.max(5, ...run.tables.map((t) => t.table.length));
  const head = ["tab rows", "loaded", "rejected", "re-keyed", "left out", "blank key"];
  const widths = head.map((h) => Math.max(h.length, 8));
  const row = (name: string, cells: (string | number)[]): string => `${name.padEnd(nameW)}  ${cells.map((c, i) => String(c).padStart(widths[i] as number)).join("  ")}`;
  const lines = [row("table", head)];
  for (const t of run.tables) lines.push(row(t.table, [t.tabRows, t.loaded, t.rejected, t.reKeyed, t.leftOut, t.blankKey]));
  const total = (k: "tabRows" | "loaded" | "rejected" | "reKeyed" | "leftOut" | "blankKey"): number => run.tables.reduce((n, t) => n + t[k], 0);
  lines.push(row("total", [total("tabRows"), total("loaded"), total("rejected"), total("reKeyed"), total("leftOut"), total("blankKey")]));
  lines.push("");
  if (run.skippedTabs.length > 0) {
    lines.push(`skipped (deprecated) tabs: ${run.skippedTabs.length}`);
    for (const s of run.skippedTabs) lines.push(`  ${s.tab}: ${s.rows} rows`);
  }
  const r = run.rules;
  lines.push(`PINs: ${r.pins.hashed} hashed, ${r.pins.blank.length} blank (cannot sign in until a PIN is set)${r.pins.notFourToEightDigits > 0 ? `, ${r.pins.notFourToEightDigits} not 4 to 8 digits` : ""}`);
  lines.push(`config keys left out as secrets: ${r.configKeysLeftOut.length}`);
  lines.push(`placeholders left out: ${r.leftOut.length}`);
  lines.push(`ids re-keyed: ${r.rekeyed.length}`);
  lines.push(
    `open till sessions: ${r.openSessions.openRows}, ${r.openSessions.rowsWithClosingFigures} holding closing figures; ` +
      `${r.openSessions.flag ? `closing columns imported as NULL for ${r.openSessions.rowsWithClosingFigures}` : `copied as they are (--open-sessions-blank would change ${r.openSessions.rowsWithClosingFigures})`}`,
  );
  if (run.headerIssues.length > 0) {
    lines.push(`header differences between the Sheet and the contract: ${run.headerIssues.length} (listed in import-report.json)`);
  }
  lines.push(`rejects: ${run.rejects.length}${run.rejects.length > 0 ? " (rejects.csv)" : ""}`);
  lines.push(`report written to ${reportDir}`);
  return lines;
}
