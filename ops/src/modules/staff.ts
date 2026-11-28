// Staff: the read side of Staff.gs (getAll, getActive, getById) over ops.staff.
//
// Records have the field names and shapes Staff.gs rowToRecord_ returns, with two
// differences: no login code field (the new app stores no plain PIN, only a hash that
// never leaves auth/), and no _rowIndex (a Sheet row number means nothing here).
//
// Same as the old code, deliberately: a blank rate reads as 0 (`Number(x) || 0`,
// which ADR-0004 warns about; parity decides, so it is kept and the Staff
// screens still show 0), and only `active = true` counts as active.
//
// Order: the Sheet returns rows as typed, which is the order they were created,
// which is staff_id order (create_ numbers them S_001, S_002, ...). SQL has no
// implicit order, so every query says `order by staff_id collate "C"`.
//
// Not ported (no RPC being moved calls them): create_ (a write; the Staff write
// card ports it with its PIN handling), verifyLoginCode_ (sign-in compares hashes
// in auth/pin.ts), getByName_ (sign-in looks the name up itself in auth/login.ts),
// and the 10-minute script cache (a Sheet read cost; a query is cheap).
import type { Db } from "../db/client";
import { companiesOf } from "../auth/sessions";

export interface StaffRecord {
  staffId: string;
  name: string;
  /** Blank in the database reads as 0, as in the old app. */
  hourlyRate: number;
  active: boolean;
  role: string;
  companiesAuthorized: string[];
  email: string;
  /** "YYYY-MM-DD", or null. (A Date in the old app.) */
  startDate: string | null;
  createdAt: Date | null;
  notes: string;
}

interface StaffRow {
  staff_id: string;
  name: string;
  hourly_rate: number | null;
  active: boolean;
  role: string | null;
  companies_authorized: string | null;
  email: string | null;
  start_date: string | null;
  created_at: Date | null;
  notes: string | null;
}

const COLUMNS = "staff_id, name, hourly_rate, active, role, companies_authorized, email, start_date, created_at, notes";
const trimmed = (v: string | null): string => (v || "").toString().trim();

function toRecord(r: StaffRow): StaffRecord {
  return {
    staffId: trimmed(r.staff_id),
    name: trimmed(r.name),
    hourlyRate: Number(r.hourly_rate) || 0,
    active: r.active === true,
    role: trimmed(r.role) || "employee",
    companiesAuthorized: companiesOf(r.companies_authorized),
    email: trimmed(r.email),
    startDate: r.start_date,
    createdAt: r.created_at,
    notes: (r.notes || "").toString(),
  };
}

/** Everyone, active or not. (Staff.getAll) */
export async function getAll(db: Db): Promise<StaffRecord[]> {
  const rows = await db.query<StaffRow>(`select ${COLUMNS} from ops.staff order by staff_id collate "C"`);
  return rows.map(toRecord).filter((s) => s.staffId);
}

/** Active people only. (Staff.getActive) */
export async function getActive(db: Db): Promise<StaffRecord[]> {
  return (await getAll(db)).filter((s) => s.active);
}

/** One person by id, active or not, or null. (Staff.getById) */
export async function getById(db: Db, staffId: string): Promise<StaffRecord | null> {
  const row = await db.maybeOne<StaffRow>(`select ${COLUMNS} from ops.staff where staff_id = $1`, [staffId]);
  return row ? toRecord(row) : null;
}

/**
 * The hourly rate of each id that names a person, as stored: null when blank ("no rate set"; ADR-0031),
 * never 0 for a blank (a real 0 stays 0). An id that names nobody is absent from the map. One query.
 * For the pay screens and the till close; the records above keep the old `Number(x) || 0`.
 */
export async function hourlyRatesOf(db: Db, staffIds: readonly string[]): Promise<Map<string, number | null>> {
  const ids = [...new Set(staffIds.filter((x) => typeof x === "string"))];
  if (ids.length === 0) return new Map();
  const rows = await db.query<{ staff_id: string; hourly_rate: number | null }>("select staff_id, hourly_rate from ops.staff where staff_id = any($1::text[])", [ids]);
  return new Map(rows.map((r) => [r.staff_id, r.hourly_rate === null ? null : Number(r.hourly_rate) || 0]));
}

/** What rpcGetStaffDirectory returns: everyone, sorted by name as JavaScript's localeCompare does. */
export async function directory(db: Db): Promise<Array<{ staffId: string; name: string; active: boolean }>> {
  return (await getAll(db)).map((s) => ({ staffId: s.staffId, name: s.name, active: s.active })).sort((a, b) => a.name.localeCompare(b.name));
}
