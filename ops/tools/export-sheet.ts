/// <reference types="node" />
/**
 * Sheet export tool (card P4-01).
 *
 * Turns the downloaded workbook (File > Download > Microsoft Excel (.xlsx)) into
 * one JSON file per tab, plus manifest.json. Every tab is exported, hidden and
 * deprecated ones included: the export is also the permanent archive of the
 * Sheet. Values are exactly as stored: a blank stays "", a date stays a date, a
 * number keeps every digit, text keeps its leading zeros and spaces (format:
 * ops/src/export/tab-file.ts; reading the workbook: ops/src/export/xlsx.ts).
 *
 *   node --experimental-strip-types tools/export-sheet.ts <workbook.xlsx> <out-dir>
 *   npm --prefix ops run export:sheet -- <workbook.xlsx> <out-dir>
 *
 * It reads one file and writes into an empty (or new) directory. It never
 * modifies the workbook, never contacts Google, and never prints a cell value
 * (they are pay and takings): the table is names and counts.
 *
 * Exit code: 0 done, 1 a problem (nothing is written), 2 wrong usage.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readTabFile, writeTabFile } from "../src/export/tab-file.ts";
import { readWorkbook, SHEET_ZONE, XlsxError, type SheetCell } from "../src/export/xlsx.ts";

export const MANIFEST_FORMAT = "storeops-sheet-export-manifest/1";

export interface ManifestTab {
  index: number;
  name: string;
  hidden: boolean;
  file: string;
  rows: number;
  columns: number;
  formulaCells: number;
  dates: number;
  errors: number;
  sha256: string;
}
export interface Manifest {
  format: string;
  workbook: { file: string; sha256: string; bytes: number };
  timeZone: string;
  tabs: ManifestTab[];
}
export interface ExportResult {
  manifest: Manifest;
  /** The lines the command prints. Names and counts only. */
  report: string[];
}

const sha256 = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/**
 * A tab name as a file name part: letters, digits, "." "_" "-" kept (any script), every
 * other run of characters one "_", no leading or trailing dot, at most 80 characters.
 * Two names can give the same part ("a/b c" and "a b/c"); the position that starts
 * every file name keeps them apart, and the real name is inside the file.
 */
export function safeFileName(name: string): string {
  const s = name
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^\.+|\.+$/g, "_");
  const cut = Array.from(s).slice(0, 80).join("");
  return cut === "" ? "_" : cut;
}

function checkOutDir(outDir: string): void {
  if (!existsSync(outDir)) return;
  if (!statSync(outDir).isDirectory()) throw new Error(`${outDir} exists and is not a directory`);
  if (readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty; export into a new or empty directory`);
}

const pad = (cells: readonly SheetCell[], width: number): SheetCell[] => Array.from({ length: width }, (_, i) => cells[i] ?? "");

/** Export `workbookPath` into `outDir`. Throws, and writes nothing, on any problem. */
export function exportWorkbook(workbookPath: string, outDir: string): ExportResult {
  checkOutDir(outDir);
  let bytes: Buffer;
  try {
    bytes = readFileSync(workbookPath);
  } catch (e) {
    throw new Error(`cannot read ${workbookPath}: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
  const file = basename(workbookPath);
  let wb: ReturnType<typeof readWorkbook>;
  try {
    wb = readWorkbook(bytes);
  } catch (e) {
    if (e instanceof XlsxError) throw new Error(`${file}: ${e.message}`);
    throw e;
  }
  if (wb.sheets.length === 0) throw new Error(`${file}: the workbook has no tabs`);

  const digits = Math.max(2, String(wb.sheets.length).length);
  const files: { name: string; text: string }[] = [];
  const tabs: ManifestTab[] = [];
  for (const s of wb.sheets) {
    const width = Math.max(s.columns, 1);
    const text = writeTabFile({
      tab: s.name,
      index: s.index,
      hidden: s.hidden,
      title: pad(s.cells[0] ?? [], width),
      header: pad(s.cells[1] ?? [], width),
      rows: s.cells.slice(2).map((r) => pad(r, width)),
      formulaCells: s.formulaCells,
    });
    const back = readTabFile(text); // what is written must read back, and agree with itself
    if (back.rows.length !== Math.max(s.cells.length - 2, 0) || back.header.length !== width) throw new Error(`tab "${s.name}": the file written for it does not read back`);
    const name = `${String(s.index).padStart(digits, "0")}-${safeFileName(s.name)}.json`;
    files.push({ name, text });
    tabs.push({ index: s.index, name: s.name, hidden: s.hidden, file: name, rows: back.counts.rows, columns: back.counts.columns, formulaCells: back.counts.formulaCells, dates: back.counts.dates, errors: back.counts.errors, sha256: sha256(text) });
  }
  const manifest: Manifest = { format: MANIFEST_FORMAT, workbook: { file, sha256: sha256(bytes), bytes: bytes.length }, timeZone: SHEET_ZONE, tabs };

  // Everything is built and checked. Now write; if that fails part way, take back what was written.
  const created = existsSync(outDir) ? undefined : mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  try {
    for (const f of files) {
      writeFileSync(join(outDir, f.name), f.text, { flag: "wx" });
      written.push(join(outDir, f.name));
    }
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  } catch (e) {
    if (created !== undefined) rmSync(created, { recursive: true, force: true });
    else for (const p of written) rmSync(p, { force: true });
    throw new Error(`cannot write into ${outDir}: ${(e as NodeJS.ErrnoException).code ?? "failed"}`);
  }
  return { manifest, report: table(manifest, outDir) };
}

function table(m: Manifest, outDir: string): string[] {
  const nameW = Math.max(3, ...m.tabs.map((t) => Array.from(t.name).length));
  const row = (cells: (string | number)[]): string => {
    const [idx, name, ...nums] = cells as [string | number, string, ...(string | number)[]];
    const last = nums.pop();
    return `${String(idx).padStart(3)}  ${name.padEnd(nameW)}  ${nums.map((n, i) => String(n).padStart([6, 8, 6, 9, 7][i] as number)).join("  ")}  ${last}`.trimEnd();
  };
  const lines = [row(["#", "tab", "rows", "columns", "dates", "formulas", "errors", "note"])];
  for (const t of m.tabs) lines.push(row([t.index, t.name, t.rows, t.columns, t.dates, t.formulaCells, t.errors, t.hidden ? "hidden" : ""]));
  const sum = (k: "rows" | "dates" | "formulaCells" | "errors"): number => m.tabs.reduce((n, t) => n + t[k], 0);
  lines.push("");
  lines.push(`${m.tabs.length} tabs (${m.tabs.filter((t) => t.hidden).length} hidden), ${sum("rows")} data rows, ${sum("dates")} date cells.`);
  if (sum("formulaCells") > 0) lines.push(`${sum("formulaCells")} formula cells: their cached values are exported.`);
  if (sum("errors") > 0) lines.push(`${sum("errors")} error cells: exported as error cells, with their error code.`);
  lines.push(`wrote ${m.tabs.length} tab files and manifest.json to ${resolve(outDir)}`);
  lines.push(`workbook sha256 ${m.workbook.sha256}`);
  return lines;
}

function main(argv: string[]): number {
  if (argv.length !== 2) {
    console.error("usage: node --experimental-strip-types tools/export-sheet.ts <workbook.xlsx> <out-dir>");
    return 2;
  }
  try {
    const { report } = exportWorkbook(argv[0] as string, argv[1] as string);
    for (const line of report) console.log(line);
    return 0;
  } catch (e) {
    console.error(`export-sheet: ${e instanceof Error ? e.message : "failed"}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
