// Staff admin: add a person, change them, deactivate them, set their PIN, and give a raise that may
// reach back to days not yet paid (card P4-11). NEW in the Operations app (ADR-0023): in the Apps
// Script app an admin typed into the Sheet's staff tab, so there is nothing to port and nothing for the
// parity harness to compare; ops/test/staff-admin.test.ts is the specification. staff.ts (the port of
// Staff.gs's reads, which keeps the old `Number(x) || 0` for a blank rate) is not changed: this module
// reads the table itself, so a blank rate is null here, never 0 (ADR-0004).
//
// Who may do what (the owner, Nov 27): an admin does everything; a manager may add an EMPLOYEE, with no
// rate, email or notes, and sees no rate, email, notes or cash anywhere. Nobody changes their own PIN
// except an admin setting it (for anyone, themselves included).
//
// Locks, inside the router's one transaction:
//   - STAFF_LOCK, one advisory lock for "who is on the staff list": every add and every change takes it
//     before reading the names, the ids or the admins. Two adds at once therefore get two ids (the second
//     reads the first's row), the same name cannot be added twice, and two admins demoting each other at
//     once cannot leave no admin (the second counts after the first has committed).
//   - A change locks the person's staff row FIRST, then STAFF_LOCK. payShifts and Payments.undo also lock
//     the staff row first, so a payment and a re-rate of the same person are serialised: either the
//     payment reads the new rates, or the re-rate sees the payment and skips the day as paid.
//   - A deactivation also takes the two till-open locks (till-sessions.ts open takes one per till) and the
//     cash_manager_staff_id config row (settings.ts update locks it before writing): an open or a
//     cash-manager change that committed first is seen and refuses the deactivation.
//   - A re-rate also locks the person's in-progress days: a till close (attendance.complete locks the day,
//     then reads the rate) either finishes first, and its day is then re-rated, or waits and reads the new rate.
//
// The PIN: checked here (4 to 8 digits), hashed with pin.ts (hashPin / setPin), and never put into an
// audit row, a message, an answer or a log. Time is the caller's `now`; SQL takes values as parameters.
// No staff row is ever deleted (the app role cannot); deactivating sets `active = false`.
import { hashPin, setPin } from "../auth/pin";
import { ROLES, type Role } from "../auth/types";
import { companiesOf } from "../auth/sessions";
import type { Db } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { formatDate } from "../lib/dates";
import { roundMoney } from "../lib/money";
import * as cashHandling from "./cash-handling";

export const COMPANIES = ["cstore", "vape"] as const;
export const NAME_MAX = 80;
export const EMAIL_MAX = 200;
export const NOTES_MAX = 500;
export const RATE_MAX = 1000;
export const REASON_MIN = 3;
export const REASON_MAX = 300;
/** How far back a raise may reach. */
export const MAX_DAYS_BACK = 370;

const STAFF_LOCK = "select pg_advisory_xact_lock(hashtextextended('ops.staff.admin', 0))";
const TILL_LOCK = "select pg_advisory_xact_lock(hashtextextended('ops.till.open:' || $1, 0))";

export interface Viewer {
  staffId: string;
  role: Role | string;
}

/** One person as an admin sees them. */
export interface AdminView {
  staffId: string;
  name: string;
  role: string;
  companies: string[];
  active: boolean;
  /** null = no rate recorded ("no rate set"), never 0 for a blank. */
  hourlyRate: number | null;
  startDate: string | null;
  email: string;
  notes: string;
  hasPin: boolean;
  lockedOut: boolean;
  openTills: string[];
  cashHeld: number;
}

/** One person as a manager sees them: no pay, no contact details, no cash. */
export interface ManagerView {
  staffId: string;
  name: string;
  role: string;
  companies: string[];
  active: boolean;
  hasPin: boolean;
}

export type StaffList = { viewerRole: "admin"; cashManagerStaffId: string | null; staff: AdminView[] } | { viewerRole: "manager"; staff: ManagerView[] };

/** The stored record as the audit rows hold it (no hash). */
export interface StoredRecord {
  staffId: string;
  name: string;
  role: string;
  companies: string[];
  active: boolean;
  hourlyRate: number | null;
  startDate: string | null;
  email: string | null;
  notes: string | null;
  createdAt: string | null;
  hasPin: boolean;
}

interface Row {
  staff_id: string;
  name: string;
  hourly_rate: number | null;
  active: boolean;
  role: string;
  companies_authorized: string | null;
  email: string | null;
  start_date: string | null;
  created_at: Date | null;
  notes: string | null;
  has_pin: boolean;
  name_key: string;
}

const ROW = `staff_id, name, hourly_rate, active, role, companies_authorized, email, start_date, created_at, notes,
             (pin_hash is not null and pin_hash <> '') as has_pin, lower(btrim(name)) as name_key`;

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const textOrNull = (v: string | null): string | null => (v === null || v.trim() === "" ? null : v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function stored(r: Row): StoredRecord {
  return {
    staffId: r.staff_id.trim(),
    name: r.name.trim(),
    role: r.role,
    companies: companiesOf(r.companies_authorized),
    active: r.active === true,
    hourlyRate: r.hourly_rate,
    startDate: r.start_date,
    email: textOrNull(r.email),
    notes: textOrNull(r.notes),
    createdAt: r.created_at ? r.created_at.toISOString() : null,
    hasPin: r.has_pin === true,
  };
}

function managerView(r: Row): ManagerView {
  return { staffId: r.staff_id.trim(), name: r.name.trim(), role: r.role, companies: companiesOf(r.companies_authorized), active: r.active === true, hasPin: r.has_pin === true };
}

// ── Reads ──────────────────────────────────────────────────

const MIN_MS = 60_000;

/** Name keys locked out now, by the sign-in rule of auth/login.ts (count >= login_max_fails within login_lockout_mins of the first). */
async function lockedOutKeys(db: Db, config: Config, now: Date): Promise<Set<string>> {
  const rows = await db.query<{ name_key: string; n: number; first: Date }>("select name_key, count(*)::int as n, min(failed_at) as first from ops.login_failures group by name_key");
  const maxFails = config.number("login_max_fails", 5);
  const lockoutMs = config.number("login_lockout_mins", 60) * MIN_MS;
  return new Set(rows.filter((r) => r.n >= maxFails && now.getTime() - r.first.getTime() < lockoutMs).map((r) => r.name_key));
}

function byActiveThenName(a: Row, b: Row): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  const n = a.name.trim().localeCompare(b.name.trim());
  if (n !== 0) return n;
  return a.staff_id < b.staff_id ? -1 : a.staff_id > b.staff_id ? 1 : 0;
}

/**
 * Everyone, active first then by name. An admin gets every field plus the cash manager's id; a manager
 * gets name, role, tills, active and whether a PIN is set, nothing else. A fixed number of queries
 * (six for an admin, one for a manager), whatever the number of people.
 */
export async function list(db: Db, config: Config, viewer: Viewer, now: Date): Promise<StaffList> {
  const rows = (await db.query<Row>(`select ${ROW} from ops.staff where btrim(staff_id) <> ''`)).sort(byActiveThenName);
  if (viewer.role !== "admin") return { viewerRole: "manager", staff: rows.map(managerView) };

  const locked = await lockedOutKeys(db, config, now);
  const open = await db.query<{ staff_id: string; company: string }>("select staff_id, company from ops.till_sessions where status = 'open' order by company, session_id");
  const outstanding = await cashHandling.getAllOutstanding(db, config, now);
  const held = new Map(outstanding.holders.map((h) => [h.staffId, h.total]));
  const tills = new Map<string, string[]>();
  for (const o of open) {
    const id = o.staff_id.trim();
    const list = tills.get(id) ?? [];
    if (!list.includes(o.company)) list.push(o.company);
    tills.set(id, list);
  }
  const cm = String(config.value("cash_manager_staff_id", "") || "").trim();
  return {
    viewerRole: "admin",
    cashManagerStaffId: cm || null,
    staff: rows.map((r) => {
      const s = stored(r);
      return {
        staffId: s.staffId,
        name: s.name,
        role: s.role,
        companies: s.companies,
        active: s.active,
        hourlyRate: s.hourlyRate,
        startDate: s.startDate,
        email: s.email ?? "",
        notes: s.notes ?? "",
        hasPin: s.hasPin,
        lockedOut: locked.has(r.name_key),
        openTills: tills.get(s.staffId) ?? [],
        cashHeld: held.get(s.staffId) ?? 0,
      };
    }),
  };
}

async function viewOf(db: Db, config: Config, viewer: Viewer, staffId: string, now: Date): Promise<AdminView | ManagerView> {
  const all = await list(db, config, viewer, now);
  const one = (all.staff as Array<AdminView | ManagerView>).find((p) => p.staffId === staffId);
  if (!one) throw new Error("Staff not found: " + staffId);
  return one;
}

const readRow = (db: Db, staffId: string) => db.maybeOne<Row>(`select ${ROW} from ops.staff where staff_id = $1`, [staffId]);

// ── Checks ─────────────────────────────────────────────────

const comparable = (name: string): string => name.replace(/\s+/g, " ").trim().toLowerCase();

function checkName(v: unknown): string {
  const text = typeof v === "string" ? v.trim() : "";
  if (text === "") throw new Error("A name is required.");
  if (text.length > NAME_MAX) throw new Error(`A name can be at most ${NAME_MAX} characters.`);
  if (CONTROL.test(text)) throw new Error("A name cannot contain control characters (such as a line break).");
  return text;
}

function checkRole(v: unknown): Role {
  if (typeof v !== "string" || !(ROLES as readonly string[]).includes(v)) throw new Error("role must be one of employee, manager, payroll_admin, admin.");
  return v as Role;
}

/** The tills as the table keeps them: "cstore,vape" in that order, or NULL for none. */
function checkCompanies(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new Error("Tills must be a list (cstore, vape, both or none).");
  if (v.some((c) => typeof c !== "string" || !(COMPANIES as readonly string[]).includes(c))) throw new Error("Tills must be cstore and/or vape.");
  if (new Set(v).size !== v.length) throw new Error("Each till can be listed once.");
  const list = COMPANIES.filter((c) => v.includes(c));
  return list.length ? list.join(",") : null;
}

const RATE_TEXT = /^\d{1,4}(\.\d{1,4})?$/;
const RATE_MESSAGE = `The hourly rate must be a plain number from 0 to ${RATE_MAX}, with at most 4 decimals, or blank.`;

/** A blank rate is null ("no rate yet"), never 0. */
export function checkRate(v: unknown): number | null {
  if (blank(v)) return null;
  let text: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(RATE_MESSAGE);
    text = String(v);
  } else if (typeof v === "string") {
    text = v.trim();
  } else {
    throw new Error(RATE_MESSAGE);
  }
  if (!RATE_TEXT.test(text)) throw new Error(RATE_MESSAGE);
  const n = Number(text);
  if (!(n >= 0 && n <= RATE_MAX)) throw new Error(RATE_MESSAGE);
  return n;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** "YYYY-MM-DD" that is a real calendar day, or null. */
function realDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = DAY.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return value.trim();
}
function daysBetween(a: string, b: string): number {
  const ms = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

function checkStartDate(v: unknown): string | null {
  if (blank(v)) return null;
  const day = realDay(v);
  if (!day) throw new Error("The start date must be a real date (YYYY-MM-DD), or blank.");
  return day;
}

const EMAIL = /^[^\s@,;<>"'()[\]\\]+@[^\s@,;<>"'()[\]\\]+\.[^\s@,;<>"'()[\]\\.]+$/;
function checkEmail(v: unknown): string | null {
  if (blank(v)) return null;
  const text = typeof v === "string" ? v.trim() : "";
  if (text.length > EMAIL_MAX || !EMAIL.test(text)) throw new Error(`The email must be one address such as name@example.com, at most ${EMAIL_MAX} characters, or blank.`);
  return text;
}

function checkNotes(v: unknown): string | null {
  if (blank(v)) return null;
  if (typeof v !== "string") throw new Error("Notes must be text.");
  const text = v.trim();
  if (text.length > NOTES_MAX) throw new Error(`Notes can be at most ${NOTES_MAX} characters.`);
  if (CONTROL.test(text)) throw new Error("Notes cannot contain control characters (such as a line break).");
  return text;
}

const PIN_MESSAGE = "The PIN must be 4 to 8 digits.";
/** The PIN as text, 4 to 8 digits. The message never repeats what was sent. */
function checkPin(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9]{4,8}$/.test(v.trim())) throw new Error(PIN_MESSAGE);
  return v.trim();
}

function checkReason(v: unknown, required: boolean): string | null {
  const text = typeof v === "string" ? v.trim() : "";
  if (text === "" && !required) return null;
  if (CONTROL.test(text)) throw new Error("The reason cannot contain control characters (such as a line break).");
  if (text.length < REASON_MIN || text.length > REASON_MAX) {
    if (required) throw new Error(`A reason is required (${REASON_MIN} to ${REASON_MAX} characters) when the rate, the role or active changes.`);
    throw new Error(`A reason must be ${REASON_MIN} to ${REASON_MAX} characters.`);
  }
  return text;
}

const APPLY_MESSAGE = "Unpaid days can take a new rate only when the rate changes to an amount: change the rate, or leave the date blank.";
function checkApplyFrom(v: unknown, now: Date): string {
  const day = realDay(v);
  if (!day) throw new Error("The date to apply the rate from must be a real date (YYYY-MM-DD), or blank.");
  const today = formatDate(now);
  if (day > today) throw new Error("The date to apply the rate from cannot be in the future.");
  if (daysBetween(day, today) > MAX_DAYS_BACK) throw new Error(`The date to apply the rate from cannot be more than ${MAX_DAYS_BACK} days ago.`);
  return day;
}

const asObject = (input: unknown): Record<string, unknown> => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("input is required");
  return input as Record<string, unknown>;
};

/** Refused when another ACTIVE person (not `self`) has the same name, ignoring case and repeated spaces. */
async function checkNameFree(db: Db, name: string, self: string | null): Promise<void> {
  const rows = await db.query<{ staff_id: string; name: string }>("select staff_id, name from ops.staff where active = true");
  const want = comparable(name);
  const clash = rows.find((r) => r.staff_id !== self && comparable(r.name) === want);
  if (clash) throw new Error(`There is already an active person called ${clash.name.trim()}.`);
}

/** The next S_NNN after the highest id of that shape (three digits, more past 999). Call under STAFF_LOCK. */
async function nextId(db: Db): Promise<string> {
  const rows = await db.query<{ staff_id: string }>("select staff_id from ops.staff where staff_id ~ '^S_[0-9]{3,}$'");
  const highest = rows.reduce((m, r) => Math.max(m, Number(r.staff_id.slice(2))), 0);
  return "S_" + String(highest + 1).padStart(3, "0");
}

// ── Add ────────────────────────────────────────────────────

export interface CreateDeps {
  pepper: string;
  config: Config;
  now: Date;
}

/** rpcCreateStaff. A manager may add an employee only, with no rate, email or notes. */
export async function create(db: Tx, input: unknown, viewer: Viewer, deps: CreateDeps): Promise<AdminView | ManagerView> {
  const i = asObject(input);
  const isAdmin = viewer.role === "admin";
  if (!isAdmin) {
    if (!blank(i["role"]) && i["role"] !== "employee") throw new Error("A manager can add an employee only.");
    if (!blank(i["hourlyRate"])) throw new Error("Only an admin sets a pay rate.");
    if (!blank(i["email"]) || !blank(i["notes"])) throw new Error("Only an admin sets an email or notes.");
  }
  const name = checkName(i["name"]);
  const role = isAdmin ? checkRole(i["role"]) : "employee";
  const companies = checkCompanies(i["companies"]);
  const rate = isAdmin ? checkRate(i["hourlyRate"]) : null;
  const startDate = checkStartDate(i["startDate"]);
  const email = isAdmin ? checkEmail(i["email"]) : null;
  const notes = isAdmin ? checkNotes(i["notes"]) : null;
  const pin = checkPin(i["pin"]);
  // Slow on purpose (PBKDF2): before the lock, so others are not kept waiting for it.
  const hash = await hashPin(pin, deps.pepper);

  await db.query(STAFF_LOCK);
  await checkNameFree(db, name, null);
  const staffId = await nextId(db);
  const row = await db.one<Row>(
    `insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized, email, start_date, created_at, notes, pin_hash)
     values ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10) returning ${ROW}`,
    [staffId, name, rate, role, companies, email, startDate, deps.now, notes, hash],
  );
  await audit.write(db, { actorId: viewer.staffId, action: "staff.create", targetType: "staff", targetId: staffId, after: stored(row) }, { now: deps.now });
  return viewOf(db, deps.config, viewer, staffId, deps.now);
}

// ── The raise on unpaid days ───────────────────────────────

/** Paid against each day, from payments that stand (a voided payment counts for nothing). $1 = staff id. */
const PAID = `select i.ref_id, sum(i.amount) as paid
                from ops.payment_items i
                join ops.payments p on p.payment_id = i.payment_id
               where p.voided_at is null and i.item_type = 'shift' and p.staff_id = $1
               group by i.ref_id`;

/** The person's worked days from $2, with what is paid against each. */
const WORKED_FROM = `select a.attendance_id, a.date, a.hours_worked, a.rate_at_attendance, coalesce(paid.paid, 0) as paid
                       from ops.attendance a
                       left join (${PAID}) paid on paid.ref_id = a.attendance_id
                      where a.staff_id = $1 and a.status = 'worked' and a.date >= $2`;

interface DayRow {
  attendance_id: string;
  date: string;
  hours_worked: number | null;
  rate_at_attendance: number | null;
  paid: number;
}

export interface RatePreview {
  days: number;
  owedBefore: number | null;
  owedAfter: number | null;
  skippedPaid: Array<{ date: string; paid: number }>;
}

const dayValue = (hours: number | null, rate: number | null): number => roundMoney((hours ?? 0) * (rate ?? 0));
function sums(days: ReadonlyArray<{ hours: number | null; before: number | null }>, rate: number): { owedBefore: number | null; owedAfter: number | null } {
  if (days.length === 0) return { owedBefore: null, owedAfter: null };
  let before = 0;
  let after = 0;
  for (const d of days) {
    before = roundMoney(before + dayValue(d.hours, d.before));
    after = roundMoney(after + dayValue(d.hours, rate));
  }
  return { owedBefore: before, owedAfter: after };
}

async function skippedPaid(db: Db, staffId: string, from: string): Promise<Array<{ date: string; paid: number }>> {
  const rows = await db.query<DayRow>(`${WORKED_FROM} and coalesce(paid.paid, 0) > 0 order by a.date, a.attendance_id collate "C"`, [staffId, from]);
  return rows.map((r) => ({ date: r.date, paid: roundMoney(r.paid) }));
}

/** rpcPreviewRateChange: what a save with this rate and date would do. Changes nothing. */
export async function previewRateChange(db: Db, input: unknown, now: Date): Promise<RatePreview> {
  const i = asObject(input);
  const staffId = typeof i["staffId"] === "string" ? i["staffId"] : "";
  const person = staffId ? await readRow(db, staffId) : null;
  if (!person) throw new Error("Staff not found: " + String(i["staffId"]));
  const rate = checkRate(i["hourlyRate"]);
  if (rate === null || rate === person.hourly_rate) throw new Error(APPLY_MESSAGE);
  const from = checkApplyFrom(i["applyRateFrom"], now);
  const days = await db.query<DayRow>(`${WORKED_FROM} and coalesce(paid.paid, 0) = 0 order by a.date, a.attendance_id collate "C"`, [staffId, from]);
  return { days: days.length, ...sums(days.map((d) => ({ hours: d.hours_worked, before: d.rate_at_attendance })), rate), skippedPaid: await skippedPaid(db, staffId, from) };
}

// ── Change ─────────────────────────────────────────────────

export interface UpdateDeps {
  config: Config;
  now: Date;
}

export interface UpdateResult {
  record: AdminView;
  changed: boolean;
  daysChanged: number;
  owedBefore: number | null;
  owedAfter: number | null;
  skippedPaid: Array<{ date: string; paid: number }>;
  cashHeld: number;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** rpcUpdateStaff (admin): the person set to exactly what the input says. */
export async function update(db: Tx, input: unknown, viewer: Viewer, deps: UpdateDeps): Promise<UpdateResult> {
  const i = asObject(input);
  const now = deps.now;
  const actorId = viewer.staffId;
  if (!actorId) throw new Error("actorId required");

  // 1. The person's row, locked first: payments, undos and corrections of this person wait here.
  const staffId = typeof i["staffId"] === "string" ? i["staffId"] : "";
  const exists = staffId !== "" && (await lockRow(db, "staff", staffId));
  const beforeRow = exists ? await readRow(db, staffId) : null;
  if (!beforeRow) throw new Error("Staff not found: " + String(i["staffId"]));
  const before = stored(beforeRow);

  // 2. The fields, by the same rules as an add.
  const name = checkName(i["name"]);
  const role = checkRole(i["role"]);
  const companies = checkCompanies(i["companies"]);
  const rate = checkRate(i["hourlyRate"]);
  const startDate = checkStartDate(i["startDate"]);
  const email = checkEmail(i["email"]);
  const notes = checkNotes(i["notes"]);
  if (typeof i["active"] !== "boolean") throw new Error("active must be true or false.");
  const active = i["active"];

  const rateChanged = rate !== before.hourlyRate;
  const roleChanged = role !== before.role;
  const activeChanged = active !== before.active;
  const reason = checkReason(i["reason"], rateChanged || roleChanged || activeChanged);
  const applyFrom = blank(i["applyRateFrom"]) ? null : checkApplyFrom(i["applyRateFrom"], now);
  if (applyFrom !== null && (!rateChanged || rate === null)) throw new Error(APPLY_MESSAGE);

  // 3. Who is on the list, one change at a time from here (see the header).
  await db.query(STAFF_LOCK);
  // Checked when the name changes or the person comes back: an old duplicate from the Sheet does not block other edits.
  if (active && (comparable(name) !== comparable(before.name) || !before.active)) await checkNameFree(db, name, before.staffId);

  // 4. The guards. The last admin first: it is what is at stake even when the admin is acting on themselves.
  const losesAdmin = before.role === "admin" && before.active && (role !== "admin" || !active);
  if (losesAdmin) {
    const others = await db.one<{ n: number }>("select count(*)::int as n from ops.staff where role = 'admin' and active = true and staff_id <> $1", [before.staffId]);
    if (others.n === 0) throw new Error(`${before.name} is the only active admin.`);
  }
  if (before.staffId === actorId && before.active && !active) throw new Error("You cannot deactivate yourself: ask another admin.");
  if (before.staffId === actorId && roleChanged) throw new Error("You cannot change your own role: ask another admin.");
  const deactivating = before.active && !active;
  if (deactivating) {
    for (const c of COMPANIES) await db.query(TILL_LOCK, [c]);
    const open = await db.query("select session_id from ops.till_sessions where staff_id = $1 and status = 'open'", [before.staffId]);
    if (open.length > 0) throw new Error(`Close ${before.name}'s till first.`);
    const cm = await db.maybeOne<{ value: string | null }>("select value from ops.config where key = 'cash_manager_staff_id' for update");
    if (cm && (cm.value ?? "").trim() === before.staffId) throw new Error(`${before.name} is the cash manager: name someone else in Settings first.`);
  }

  // 5. The write.
  const afterRow = await db.one<Row>(
    `update ops.staff set name = $2, role = $3, companies_authorized = $4, hourly_rate = $5, start_date = $6, email = $7, notes = $8, active = $9
      where staff_id = $1 returning ${ROW}`,
    [before.staffId, name, role, companies, rate, startDate, email, notes, active],
  );
  const after = stored(afterRow);
  const changed = !sameJson(before, after);
  if (changed) {
    await audit.write(db, { actorId, action: "staff.update", targetType: "staff", targetId: before.staffId, before, after, details: reason ?? "" }, { now });
  }
  // Signed out everywhere at once (validateSession also refuses an inactive person on every call).
  if (deactivating) await db.query("delete from ops.sessions where staff_id = $1", [before.staffId]);

  // 6. The raise on unpaid days: one UPDATE, the audit row built from its RETURNING.
  let daysChanged = 0;
  let owed: { owedBefore: number | null; owedAfter: number | null } = { owedBefore: null, owedAfter: null };
  let skipped: Array<{ date: string; paid: number }> = [];
  if (applyFrom !== null && rate !== null) {
    await db.query("select attendance_id from ops.attendance where staff_id = $1 and status = 'in_progress' for update", [before.staffId]);
    const days = await db.query<{ attendance_id: string; date: string; hours_worked: number | null; old_rate: number | null }>(
      `update ops.attendance a
          set rate_at_attendance = $3, modified_by = $4, modified_at = $5
         from (${WORKED_FROM} and coalesce(paid.paid, 0) = 0) d
        where a.attendance_id = d.attendance_id
        returning a.attendance_id, a.date, a.hours_worked, d.rate_at_attendance as old_rate`,
      [before.staffId, applyFrom, rate, actorId, now],
    );
    days.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.attendance_id < y.attendance_id ? -1 : 1));
    daysChanged = days.length;
    owed = sums(days.map((d) => ({ hours: d.hours_worked, before: d.old_rate })), rate);
    skipped = await skippedPaid(db, before.staffId, applyFrom);
    if (daysChanged > 0) {
      await audit.write(
        db,
        {
          actorId,
          action: "staff.rate_applied",
          targetType: "staff",
          targetId: before.staffId,
          after: {
            applyRateFrom: applyFrom,
            oldRate: before.hourlyRate,
            newRate: rate,
            owedBefore: owed.owedBefore,
            owedAfter: owed.owedAfter,
            days: days.map((d) => ({ attendanceId: d.attendance_id, date: d.date, hours: d.hours_worked, rateBefore: d.old_rate })),
            skippedPaid: skipped,
          },
          details: reason ?? "",
        },
        { now },
      );
    }
  }

  const record = (await viewOf(db, deps.config, { staffId: actorId, role: "admin" }, before.staffId, now)) as AdminView;
  return { record, changed, daysChanged, owedBefore: owed.owedBefore, owedAfter: owed.owedAfter, skippedPaid: skipped, cashHeld: record.cashHeld };
}

// ── PIN ────────────────────────────────────────────────────

export interface SetPinResult {
  staffId: string;
  sessionsEnded: number;
  lockoutCleared: boolean;
}

/**
 * rpcSetStaffPin (admin, for anyone, themselves included): the PIN hashed by pin.ts setPin (which writes the
 * audit row staff.pin_set naming the admin, with neither PIN nor hash); every session of that person
 * deleted, except, when the admin sets their own, the session making the call; and that person's failed
 * sign-ins (ops.login_failures, keyed by the lower-cased trimmed name) deleted, which lifts a lockout.
 *
 * The calling session is recognised by its staff id and its end time (`expiresAt`, read from the row and
 * renewed by validateSession before this runs): a session does not carry its token to a handler.
 */
export async function setStaffPin(db: Tx, input: unknown, viewer: Viewer & { expiresAt: number }, deps: { pepper: string; config: Config; now: Date }): Promise<SetPinResult> {
  const i = asObject(input);
  const staffId = typeof i["staffId"] === "string" ? i["staffId"] : "";
  const pin = checkPin(i["pin"]);
  const exists = staffId !== "" && (await lockRow(db, "staff", staffId));
  const person = exists ? await readRow(db, staffId) : null;
  if (!person) throw new Error("Staff not found: " + String(i["staffId"]));
  await setPin(db, person.staff_id, pin, deps.pepper, { actorId: viewer.staffId, now: deps.now });
  const ended = await db.query<{ staff_id: string }>(
    viewer.staffId === person.staff_id
      ? "delete from ops.sessions where staff_id = $1 and expires_at <> $2 returning staff_id"
      : "delete from ops.sessions where staff_id = $1 returning staff_id",
    viewer.staffId === person.staff_id ? [person.staff_id, new Date(viewer.expiresAt)] : [person.staff_id],
  );
  const wasLocked = (await lockedOutKeys(db, deps.config, deps.now)).has(person.name_key);
  await db.query("delete from ops.login_failures where name_key = lower(btrim($1))", [person.name]);
  return { staffId: person.staff_id, sessionsEnded: ended.length, lockoutCleared: wasLocked };
}
