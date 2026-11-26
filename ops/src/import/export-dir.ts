// Read an export directory (what tools/export-sheet.ts wrote) for the import tool (card P4-02).
//
// The directory is trusted only as far as it checks out: the manifest must be in the format
// this reader knows, every tab file it names must exist, have exactly the SHA-256 the manifest
// records (compared BEFORE the file is parsed, and the parsed text is the very bytes that were
// hashed), and read back with the counts the manifest gives; no other file may be in the
// directory and no tab may be named twice. Anything else is a refusal that says what to do.
// No message quotes a cell.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readTabFile } from "../export/tab-file";
import { ImportRefused } from "./errors";
import type { SheetTab } from "./sheet-to-db";

/** The manifest format tools/export-sheet.ts writes (a test keeps the two equal). */
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

export interface ExportedTab {
  entry: ManifestTab;
  sheet: SheetTab;
}
export interface ExportDir {
  dir: string;
  manifest: Manifest;
  /** The SHA-256 of manifest.json itself. */
  manifestSha256: string;
  tabs: ExportedTab[];
}

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const wholeNumber = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const HEX = /^[0-9a-f]{64}$/;

const WORKBOOK_KEYS = ["file", "sha256", "bytes"];
const MANIFEST_KEYS = ["format", "workbook", "timeZone", "tabs"];
const TAB_KEYS = ["index", "name", "hidden", "file", "rows", "columns", "formulaCells", "dates", "errors", "sha256"];

function exactKeys(o: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const k of keys) if (!(k in o)) throw new ImportRefused(`manifest.json: ${where} has no "${k}".`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new ImportRefused(`manifest.json: ${where} has an unknown key "${k.slice(0, 40)}".`);
}

/** Validate the parsed manifest. Throws ImportRefused. */
export function checkManifest(o: unknown): Manifest {
  if (!isObject(o)) throw new ImportRefused("manifest.json is not a JSON object.");
  if (o["format"] !== MANIFEST_FORMAT) throw new ImportRefused(`manifest.json: its format is not ${MANIFEST_FORMAT}; this tool reads only that version.`);
  exactKeys(o, MANIFEST_KEYS, "the manifest");
  const wb = o["workbook"];
  if (!isObject(wb)) throw new ImportRefused('manifest.json: "workbook" is not an object.');
  exactKeys(wb, WORKBOOK_KEYS, "workbook");
  if (typeof wb["file"] !== "string" || typeof wb["sha256"] !== "string" || !HEX.test(wb["sha256"]) || !wholeNumber(wb["bytes"])) {
    throw new ImportRefused('manifest.json: "workbook" is not {file, sha256, bytes}.');
  }
  if (typeof o["timeZone"] !== "string" || o["timeZone"] === "") throw new ImportRefused('manifest.json: "timeZone" is missing.');
  const tabs = o["tabs"];
  if (!Array.isArray(tabs)) throw new ImportRefused('manifest.json: "tabs" is not a list.');
  const names = new Set<string>();
  const files = new Set<string>();
  const indexes = new Set<number>();
  const out: ManifestTab[] = [];
  for (const [i, t] of tabs.entries()) {
    const where = `tab ${i + 1}`;
    if (!isObject(t)) throw new ImportRefused(`manifest.json: ${where} is not an object.`);
    exactKeys(t, TAB_KEYS, where);
    const ok =
      wholeNumber(t["index"]) && t["index"] >= 1 && typeof t["name"] === "string" && t["name"] !== "" && typeof t["hidden"] === "boolean" &&
      typeof t["file"] === "string" && wholeNumber(t["rows"]) && wholeNumber(t["columns"]) && wholeNumber(t["formulaCells"]) &&
      wholeNumber(t["dates"]) && wholeNumber(t["errors"]) && typeof t["sha256"] === "string" && HEX.test(t["sha256"]);
    if (!ok) throw new ImportRefused(`manifest.json: ${where} has a value of the wrong type.`);
    const tab = t as unknown as ManifestTab;
    if (names.has(tab.name)) throw new ImportRefused(`manifest.json: the tab "${tab.name}" is named twice.`);
    names.add(tab.name);
    if (indexes.has(tab.index)) throw new ImportRefused(`manifest.json: two tabs have position ${tab.index}.`);
    indexes.add(tab.index);
    // A file name must be one plain name in this directory: nothing the manifest says may reach outside it.
    if (!/^[^/\\\0]+$/.test(tab.file) || tab.file === "." || tab.file === ".." || tab.file === "manifest.json") {
      throw new ImportRefused(`manifest.json: the file name of tab "${tab.name}" is not a plain file name.`);
    }
    if (files.has(tab.file)) throw new ImportRefused(`manifest.json: the file ${tab.file} is listed for two tabs.`);
    files.add(tab.file);
    out.push(tab);
  }
  return { format: o["format"], workbook: wb as unknown as Manifest["workbook"], timeZone: o["timeZone"], tabs: out };
}

/** Read and check the export in `dir`. Throws ImportRefused on anything that does not match. */
export function readExportDir(dir: string): ExportDir {
  let names: string[];
  try {
    if (!lstatSync(dir).isDirectory()) throw new ImportRefused(`${dir} is not a directory.`);
    names = readdirSync(dir);
  } catch (e) {
    if (e instanceof ImportRefused) throw e;
    throw new ImportRefused(`cannot read the export directory ${dir} (${(e as NodeJS.ErrnoException).code ?? "unreadable"}).`);
  }
  if (!names.includes("manifest.json")) throw new ImportRefused(`${dir} has no manifest.json: it is not an export made by export:sheet.`);

  const manifestBytes = readFileSync(join(dir, "manifest.json"));
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new ImportRefused("manifest.json is not valid JSON.");
  }
  const manifest = checkManifest(parsed);

  const listed = new Set(["manifest.json", ...manifest.tabs.map((t) => t.file)]);
  const missing = manifest.tabs.filter((t) => !names.includes(t.file)).map((t) => t.file);
  if (missing.length > 0) throw new ImportRefused(`the export is missing ${missing.length} file(s) the manifest lists: ${missing.join(", ")}.`);
  const extra = names.filter((n) => !listed.has(n));
  if (extra.length > 0) throw new ImportRefused(`the export directory holds ${extra.length} file(s) the manifest does not list: ${extra.join(", ")}. Remove them, or export again into an empty directory.`);

  const tabs: ExportedTab[] = [];
  for (const entry of manifest.tabs) {
    const path = join(dir, entry.file);
    if (!lstatSync(path).isFile()) throw new ImportRefused(`${entry.file} is not a regular file.`);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== entry.sha256) {
      throw new ImportRefused(`${entry.file} (tab "${entry.name}") does not match its checksum in manifest.json: the file was changed or damaged after the export. Export the workbook again.`);
    }
    let file: ReturnType<typeof readTabFile>;
    try {
      file = readTabFile(bytes.toString("utf8"));
    } catch (e) {
      throw new ImportRefused(`${entry.file} (tab "${entry.name}"): ${e instanceof Error ? e.message : "cannot be read"}.`);
    }
    const disagrees =
      file.tab !== entry.name || file.index !== entry.index || file.hidden !== entry.hidden || file.counts.rows !== entry.rows || file.counts.columns !== entry.columns ||
      file.counts.formulaCells !== entry.formulaCells || file.counts.dates !== entry.dates || file.counts.errors !== entry.errors;
    if (disagrees) throw new ImportRefused(`${entry.file}: what the file says about itself differs from manifest.json (name, position, hidden flag or counts).`);
    tabs.push({ entry, sheet: { tab: file.tab, header: file.header, rows: file.rows } });
  }
  return { dir, manifest, manifestSha256: sha256(manifestBytes), tabs };
}
