// The audit log on a screen (card P4-13). It exists only in the Operations app (ADR-0023): in the Sheet an
// admin scrolled the audit_log tab; with no Sheet there has to be a page, and the page has to be careful,
// because the log holds who did what, pay changes included.
//
// What this module is:
//   - READ ONLY. It runs one kind of statement (a select) and takes no lock. The app's database role could
//     not change a row of the log anyway (grants), and this file has no statement that tries.
//   - Reading the log is not itself logged. That is deliberate: a log that wrote a row each time it was
//     read would be read by the next reader, and the page would never stop growing under the person
//     looking at it.
//
// Order and paging. Newest first by `seq`, the order the database numbered the rows in (migration 0004):
// never by time, because the rows of one change are written in one transaction and share a time. `before`
// is the `seq` of the last row of the previous page and the next page is the rows with a smaller one, so a
// row written between two page reads never shifts a page (there is no offset). The answer carries
// `nextBefore` (null at the end) and `total: null`: the table has no end, and a count would read all of it.
//
// Filters, all optional, all joined with AND, and every value goes to SQL as a parameter. Only the shape of
// the statement (which fragments are present) depends on the input, and each fragment is a fixed string
// written in this file. An `action` is checked for its shape first (lower-case letters, digits, `_` and
// `.`, 60 characters at most; one ending in `.` is a prefix such as `staff.`) and refused when it is not.
// A day is a real calendar day, read as the Toronto day: the two instants that bound it are compared with
// the row's time, so an index on time can be used (and the two clock-change days are 23 and 25 hours long).
//
// Masking, on the way out (a stored row is never changed):
//   1. A PHONE NUMBER: a run of 8 to 15 digits, optionally with a leading `+` and with single spaces,
//      dashes or brackets between the digits, inside any text of a row, is shown as bullets for all but its
//      last four digits (`•••••••0199`), the shape the Settings card gives a recipient. It is told from an
//      id, an amount or a date by what is around it, because those are what the log is full of:
//        - an ID has a letter or an underscore beside its digits (`PAY_20261120_ab1`, `S_001`, a hex hash):
//          a run is a phone number only when the character before it and the character after it are not
//          a letter, a digit or `_`;
//        - an AMOUNT has a decimal point (`1234567.89`, `0.12345678`): a run touching a `.` that has a
//          digit on its other side is left alone; amounts in this app are also under a million, so a whole
//          amount never has 8 digits. (One exception, 416.555.0199: three groups of 3, 3 and 4 digits with
//          two dots between is a phone number written with dots, and is masked.);
//        - a DATE (`2026-11-20`) is set aside before the phone rule looks at the text, so `2026-11-20 14`
//          is not read as ten digits with separators;
//        - a business number written `123456789 RT0001` is left alone (an `RT` and four digits follow);
//        - a bare date stamp (20261120) is left alone;
//        - a number inside the JSON (an amount, a count, an hour) is not text and is never touched;
//        - the target id of a `session` row is a few characters of a sign-in token and is not looked at.
//   2. A SECRET-LOOKING KEY: any object key matching /pin|hash|token|secret|password|key$/i has its value
//      replaced by "[hidden]", whatever it holds and however deep it sits. No writer puts such a value in
//      a row (checked: see the component page); this is the second line of defence.
//   Email addresses and pay rates are shown as they are: an admin sees both on the Staff screen, and
//   "who changed whose rate" is what the log is for.
import type { Db } from "../db/client";
import { parseDate } from "../lib/dates";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
/** How far back (in rows) the lists of actions and people for the filter controls look. */
export const LISTS_WINDOW = 20_000;
const LISTS_MAX = 200;
const ACTION_SHAPE = /^[a-z0-9_.]{1,60}$/;
const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TEXT_MAX = 200;
const HIDDEN = "[hidden]";
const SECRET_KEY = /pin|hash|token|secret|password|key$/i;
const MAX_DEPTH = 40;

export interface AuditRowOut {
  seq: number;
  at: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  details: string | null;
}

export interface AuditPageOut {
  rows: AuditRowOut[];
  nextBefore: number | null;
  total: null;
  actions: string[];
  actors: Array<{ id: string; name: string }>;
}

// ── Masking ────────────────────────────────────────────────

const DATE_IN_TEXT = /(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/;
// Optional + or (, a digit, then digits with up to two spaces, dashes or brackets between them, ending on a
// digit; not part of a token (a letter, digit or _ beside it, or a letter, digit or _ on the other side of a dash).
const PHONE_RUN = /(?<![A-Za-z0-9_]|[A-Za-z0-9_]-)[+(]?\d(?:[ \-()]{0,2}\d)+(?![A-Za-z0-9_]|-[A-Za-z0-9_])/g;
/** A date stamp written yyyymmdd (as inside ids): not a phone number. */
const DATE_STAMP = /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

/** `•••••••0199`: every digit but the last four hidden (the Settings card's shape). */
function bullets(digits: string): string {
  return "•".repeat(Math.max(digits.length - 4, 0)) + digits.slice(-4);
}

/** A North American number written with dots, 416.555.0199: two dots between digit groups are not an amount. */
const PHONE_DOTTED = /(?<![A-Za-z0-9_.])\d{3}\.\d{3}\.\d{4}(?![A-Za-z0-9_]|\.\d)/g;

function maskPhones(part: string): string {
  part = part.replace(PHONE_DOTTED, (match) => bullets(match.replace(/\D/g, "")));
  return part.replace(PHONE_RUN, (match, offset: number, whole: string) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return match;
    if (DATE_STAMP.test(match)) return match;
    // A decimal point on either side makes it an amount, not a phone number.
    const before = whole[offset - 1];
    const after = whole[offset + match.length];
    const next = whole[offset + match.length + 1];
    const prev2 = whole[offset - 2];
    if (before === "." && prev2 !== undefined && /\d/.test(prev2)) return match;
    if (after === "." && next !== undefined && /\d/.test(next)) return match;
    // A business number: 123456789 RT0001.
    if (/^\s?RT\s?\d{4}/.test(whole.slice(offset + match.length))) return match;
    return bullets(digits);
  });
}

/** One piece of text of a row, with phone numbers masked. Dates are carried through whole. */
export function maskText(text: string): string {
  // split with one capture group: odd entries are the dates.
  return text
    .split(DATE_IN_TEXT)
    .map((piece, i) => (i % 2 === 1 ? piece : maskPhones(piece)))
    .join("");
}

/** A parsed JSON value with every string masked and every secret-looking key hidden, at any depth. */
export function maskValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return maskText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (Array.isArray(value)) return value.map((v) => maskValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  // A yes/no under such a key (`hasPin: true`) is a flag about a secret, not the secret: it is shown.
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && typeof v !== "boolean" ? HIDDEN : maskValue(v, depth + 1);
  return out;
}

/** The stored text of `before` or `after`: its JSON, masked; text that is not JSON (an old row) as masked text; blank as null. */
function shownJson(stored: string | null): unknown {
  if (stored === null || stored === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return maskText(stored);
  }
  return maskValue(parsed);
}

// ── Reading the question ───────────────────────────────────

interface Query {
  limit: number;
  before: string | null;
  actorId: string | null;
  action: string | null;
  actionIsPrefix: boolean;
  targetType: string | null;
  targetId: string | null;
  from: Date | null;
  to: Date | null;
}

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

function text(name: string, v: unknown): string | null {
  if (blank(v)) return null;
  if (typeof v !== "string") throw new Error(`${name} must be text`);
  const t = v.trim();
  if ([...t].length > TEXT_MAX) throw new Error(`${name} must be ${TEXT_MAX} characters or fewer`);
  return t;
}

function realDay(v: string): boolean {
  const m = DAY_SHAPE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function readQuery(input: unknown): Query {
  if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) throw new Error("The question must be an object.");
  const o = (input ?? {}) as Record<string, unknown>;

  let limit = DEFAULT_LIMIT;
  if (!blank(o["limit"])) {
    const n = o["limit"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw new Error(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
    limit = n;
  }

  let before: string | null = null;
  if (!blank(o["before"])) {
    const b = o["before"];
    const ok = (typeof b === "number" && Number.isSafeInteger(b) && b >= 1) || (typeof b === "string" && /^[1-9][0-9]{0,15}$/.test(b));
    if (!ok) throw new Error("before must be the number of the last row of the page before");
    before = String(b);
  }

  const actorId = text("actorId", o["actorId"]);
  const targetType = text("targetType", o["targetType"]);
  const targetId = text("targetId", o["targetId"]);

  let action = text("action", o["action"]);
  let actionIsPrefix = false;
  if (action !== null) {
    if (!ACTION_SHAPE.test(action)) throw new Error("action must be lower-case letters, digits, _ and . only (60 characters at most), such as till.correct or staff.");
    actionIsPrefix = action.endsWith(".");
    if (action === ".") action = null;
  }

  let from: Date | null = null;
  let to: Date | null = null;
  const day = text("day", o["day"]);
  if (day !== null) {
    if (!realDay(day)) throw new Error("day must be a real date written yyyy-mm-dd");
    const m = DAY_SHAPE.exec(day) as RegExpExecArray;
    const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
    const nextText = `${String(next.getUTCFullYear()).padStart(4, "0")}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
    from = parseDate(day);
    to = parseDate(nextText);
    if (from === null || to === null || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error("day must be a real date written yyyy-mm-dd");
  }
  return { limit, before, actorId, action, actionIsPrefix, targetType, targetId, from, to };
}

// ── The page ───────────────────────────────────────────────

interface Row {
  seq: string;
  timestamp: Date;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before: string | null;
  after: string | null;
  details: string | null;
}

const SYSTEM_NAMES: Readonly<Record<string, string>> = { SYSTEM: "System", SYSTEM_TRIGGER: "System (Monday run)" };

function actorName(id: string | null, staffName: string | null): string | null {
  if (id === null || id === "") return null;
  const system = SYSTEM_NAMES[id];
  if (system !== undefined) return system;
  const n = (staffName ?? "").trim();
  return n === "" ? id : n;
}

const nullIfBlank = (v: string | null): string | null => (v === null || v === "" ? null : v);

/** One page of the log, newest first, with the lists for the filter controls. `input` is the page's question; see the header. */
export async function page(db: Db, input: unknown): Promise<AuditPageOut> {
  const q = readQuery(input);

  const where: string[] = [];
  const params: unknown[] = [];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    where.push(fragment.replace("?", `$${params.length}`));
  };
  if (q.before !== null) add("a.seq < ?::bigint", q.before);
  if (q.actorId !== null) add("a.actor_id = ?", q.actorId);
  if (q.action !== null) add(q.actionIsPrefix ? "starts_with(a.action, ?)" : "a.action = ?", q.action);
  if (q.targetType !== null) add("a.target_type = ?", q.targetType);
  if (q.targetId !== null) add("a.target_id = ?", q.targetId);
  if (q.from !== null && q.to !== null) {
    add('a."timestamp" >= ?', q.from);
    add('a."timestamp" < ?', q.to);
  }
  params.push(q.limit + 1);
  const rows = await db.query<Row>(
    `select a.seq::text as seq, a."timestamp", a.actor_id, s.name as actor_name, a.action, a.target_type, a.target_id, a."before", a."after", a.details
       from ops.audit_log a
       left join ops.staff s on s.staff_id = a.actor_id
      ${where.length > 0 ? "where " + where.join(" and ") : ""}
      order by a.seq desc
      limit $${params.length}`,
    params,
  );

  const more = rows.length > q.limit;
  const shown = more ? rows.slice(0, q.limit) : rows;
  const out: AuditRowOut[] = shown.map((r) => ({
    seq: Number(r.seq),
    at: r.timestamp.toISOString(),
    actorId: nullIfBlank(r.actor_id),
    actorName: actorName(nullIfBlank(r.actor_id), r.actor_name),
    action: r.action,
    targetType: nullIfBlank(r.target_type),
    targetId: r.target_type === "session" || r.target_id === null ? nullIfBlank(r.target_id) : nullIfBlank(maskText(r.target_id)),
    before: shownJson(r.before),
    after: shownJson(r.after),
    details: r.details === null || r.details === "" ? null : maskText(r.details),
  }));

  // The lists for the filter controls: from the newest LISTS_WINDOW rows, one query each.
  const actionRows = await db.query<{ action: string }>(
    `select distinct action from (select action from ops.audit_log order by seq desc limit ${LISTS_WINDOW}) w where action <> '' order by action limit ${LISTS_MAX}`,
  );
  const actorRows = await db.query<{ id: string; name: string | null }>(
    `select w.actor_id as id, s.name
       from (select distinct actor_id from (select actor_id from ops.audit_log order by seq desc limit ${LISTS_WINDOW}) r where actor_id is not null and actor_id <> '') w
       left join ops.staff s on s.staff_id = w.actor_id
      limit ${LISTS_MAX}`,
  );
  const actors = actorRows
    .map((r) => ({ id: r.id, name: actorName(r.id, r.name) as string }))
    .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.id < y.id ? -1 : 1));

  return {
    rows: out,
    nextBefore: more && out.length > 0 ? (out[out.length - 1] as AuditRowOut).seq : null,
    total: null,
    actions: actionRows.map((r) => r.action),
    actors,
  };
}
