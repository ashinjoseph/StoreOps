// The repo's fictional fixture, from the old server to the new database.
//
//   const loaded = await loadFixture(db);   // db from createTestDb()
//   loaded.api      the old server's functions (Util, rpc*, every module)
//   loaded.tabs     every tab's header and rows exactly as the Sheet holds them
//   loaded.counts   per table: read, inserted, skipped, rejected, left out
//
// The parity harness calls this: the same rows are in the old runtime's
// in-memory spreadsheet and in Postgres, so old and new answers can be compared.
import { createRequire } from "node:module";
import pg from "pg";
import { loadTabs, readContract, type LoadResult } from "../../src/import/load";
import type { SheetTab } from "../../src/import/sheet-to-db";
import type { TestDb } from "./db";

export interface BootedFixture {
  /** The old server's globals: modules and rpc* functions. */
  api: Record<string, unknown>;
  tabs: SheetTab[];
}
export type FixtureLoad = BootedFixture & LoadResult;

interface Range {
  getValues(): unknown[][];
}
interface OldSheet {
  getName(): string;
  getLastRow(): number;
  getLastColumn(): number;
  getRange(row: number, col: number, rows: number, cols: number): Range;
}
interface OldRuntime {
  boot(): { api: Record<string, unknown>; ss: { getSheets(): OldSheet[] } };
}
interface OldFixtures {
  seed(api: Record<string, unknown>, ss: unknown): void;
}

/**
 * Boot the old server in Node over its in-memory spreadsheet and seed the
 * fictional data. The old server ran in America/Toronto (its manifest says
 * so), and its Date cells are Toronto midnights; so the process time zone is
 * set to Toronto, and stays that way, for the old code to behave as it did.
 */
export function bootFixture(): BootedFixture {
  process.env["TZ"] = "America/Toronto";
  if (new Date(2026, 0, 15).getTimezoneOffset() !== 300) {
    throw new Error("could not switch this process to America/Toronto; run with TZ=America/Toronto");
  }
  const req = createRequire(import.meta.url);
  const runtime = req("../../../scripts/docs/runtime") as OldRuntime;
  const fixtures = req("../../../scripts/docs/fixtures") as OldFixtures;
  // Util.newId_ is a second-resolution stamp plus three random base-36 characters,
  // and the fixture creates hundreds of payment and handover items inside one
  // second, so two of them share an id in most runs (a finding: see the
  // report of card P2-09a). Draw the characters from a sequence that never
  // repeats instead, so the fixture is the same every run.
  const realRandom = Math.random;
  let draw = 0;
  Math.random = () => (((draw++ * 7919) % 46656) + 0.5) / 46656;
  let booted: ReturnType<OldRuntime["boot"]>;
  try {
    booted = runtime.boot();
    fixtures.seed(booted.api, booted.ss);
  } finally {
    Math.random = realRandom;
  }
  const { api, ss } = booted;

  const tabs: SheetTab[] = ss.getSheets().map((s) => {
    const lastRow = s.getLastRow();
    const lastCol = Math.max(s.getLastColumn(), 1);
    const header = s.getRange(2, 1, 1, lastCol).getValues()[0] ?? [];
    const rows = lastRow >= 3 ? s.getRange(3, 1, lastRow - 2, lastCol).getValues() : [];
    return { tab: s.getName(), header, rows };
  });
  return { api, tabs };
}

/** Translate the fixture's tabs and load them into `db` (as ops_app, in one transaction). */
export async function loadFixture(db: TestDb, from: BootedFixture = bootFixture()): Promise<FixtureLoad> {
  const client = new pg.Client({ connectionString: db.appUrl });
  await client.connect();
  try {
    const result = await loadTabs(client, from.tabs, { contract: readContract() });
    return { ...from, ...result };
  } finally {
    await client.end();
  }
}
