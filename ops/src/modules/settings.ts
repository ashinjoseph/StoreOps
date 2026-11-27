// Settings: what an admin may read and change in `ops.config` from the Settings screen (card P4-09).
// It exists only in the Operations app (ADR-0023): until now an admin changed a setting by editing a
// cell of the Sheet's config tab; with no Sheet there has to be a screen, and the screen has to refuse
// what a cell would have let through.
//
// What is kept apart:
//   - A SECRET (the credentials: the WhatsApp token, the two Clover tokens and the till key) lives in a Worker binding and never in this table. It is listed
//     by binding name and whether it holds a value, and nothing else (not the value, not its length).
//     It cannot be edited here. An unknown key whose name looks like a credential is treated the same
//     way: neither shown nor edited.
//   - A SETTING of the registry (lib/config-keys.ts) is listed with its default and how it is read, and
//     is checked against the rule of the code that reads it, so a value is refused here exactly where a
//     reader would misread it (a zero read as the default, a number that is not a number, an address the
//     token would not be sent to).
//   - OTHER rows (a key the registry does not know, e.g. the shopping-list template) can be edited as
//     plain text, but never invented.
//
// A blank value (empty, null, missing, only spaces) is stored as NULL: "use the default". Never ''. The
// database role cannot delete a config row, and none is ever deleted: blank is how a setting goes back
// to its default.
//
// A write locks the row first (inserting it, empty, when there is none), so two edits of one key cannot
// interleave and the audit rows chain: the second's `before` is the first's `after`. The audit row holds
// the old and new value, except for the recipients list: phone numbers are personal data, so there each
// number is masked to its last four digits and the count is kept.
//
// The time is the caller's `now`; no clock, no environment and no randomness is read here, and SQL
// takes values as parameters only.
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { CONFIG_KEYS, SECRET_KEYS, configKeySpec } from "../lib/config-keys";
import { maybeSecret } from "../lib/config";
import { isCloverUrl } from "./clover";
import { isMetaUrl } from "./notifier";
import { tillBaseUrl } from "../till/address";

export const GROUPS = ["Tills and cash", "Sign-in", "WhatsApp", "Clover", "Till", "Commissions", "Public report", "Other", "Assistants"] as const;
export type Group = (typeof GROUPS)[number];

/** The order the screen shows: group by group, the keys of each in this order. */
const LAYOUT: ReadonlyArray<readonly [Group, readonly string[]]> = [
  ["Tills and cash", ["cstore_default_opening_float", "vape_default_opening_float", "lotto_reserve_default", "variance_ok_threshold", "variance_minor_threshold", "card_variance_threshold", "cstore_card_split", "vape_card_split", "cstore_epos_from", "cash_manager_staff_id", "cash_handover_stale_days"]],
  ["Sign-in", ["session_hours", "login_max_fails", "login_lockout_mins"]],
  ["WhatsApp", ["notifier_enabled", "whatsapp_target_number", "whatsapp_api_url", "whatsapp_template_name", "whatsapp_template_lang", "whatsapp_template_shift_open", "whatsapp_template_shift_close", "whatsapp_template_shift_close_cstore", "whatsapp_template_shift_close_vape"]],
  ["Clover", ["clover_enabled", "clover_base_url", "clover_cstore_merchant_id", "clover_vape_merchant_id"]],
  ["Till", ["till_enabled", "till_api_url", "till_key_expires_on"]],
  ["Commissions", ["commission_run_day", "commission_run_hour"]],
  ["Public report", ["public_report_url"]],
  ["Other", ["cstore_business_name", "vape_business_name", "timezone"]],
  ["Assistants", ["assistants_enabled", "assistant_calls_per_minute", "assistant_proposals_per_day"]],
];

/** What the Sheet's config tab said for each key (src/Setup.gs), used when the table row has no description. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  cstore_default_opening_float: "Cstore opening float (dollars)",
  vape_default_opening_float: "Vape opening float (dollars)",
  lotto_reserve_default: "Expected lotto reserve balance at cstore close (dollars)",
  variance_ok_threshold: "Variance under this = OK (green)",
  variance_minor_threshold: "Variance under this = Minor (yellow); over = investigate (red)",
  cstore_business_name: "Display name for cstore",
  vape_business_name: "Display name for vape",
  session_hours: "Login session lifetime (hours)",
  login_max_fails: "Failed login attempts before lockout",
  login_lockout_mins: "Minutes locked out after too many fails",
  commission_run_day: "Day of week for commission trigger (0=Sun..6=Sat)",
  commission_run_hour: "Hour of day for commission trigger (0-23)",
  notifier_enabled: "Toggle for WhatsApp / event notifications",
  whatsapp_target_number: "Recipient phone(s), E.164 e.g. 14165551234. Comma-separate for several: 14165551234,14169998888",
  whatsapp_api_url: "WhatsApp Cloud API endpoint: https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages",
  whatsapp_template_name: "Generic fallback template (body as {{1}}, flattened). Blank = plain text",
  whatsapp_template_lang: "Template language code (applies to all whatsapp_template_* names)",
  whatsapp_template_shift_open: "Approved template for shift-open notice: {{1}} name, {{2}} company, {{3}} time",
  whatsapp_template_shift_close: "Approved template for shift close/reconcile, 13 parameters (see docs/guides/whatsapp-templates.md)",
  clover_enabled: "Toggle Clover card reconciliation at end of day",
  clover_base_url: "Clover REST API base (sandbox: https://sandbox.dev.clover.com)",
  clover_cstore_merchant_id: "Clover merchant ID for cstore",
  clover_vape_merchant_id: "Clover merchant ID for vape (same as cstore = one shared account)",
  card_variance_threshold: "Card mismatch under this = OK (dollars). Only tills with card_split AND Clover are checked",
  cstore_card_split: "cstore till reports ONE card total (ePOS) — no credit/debit split",
  vape_card_split: "vape till reports credit and debit separately",
  cstore_epos_from: "Date cstore moved to ePOS (yyyy-MM-dd). Marks where the credit/debit split stops — reporting only",
  whatsapp_template_shift_close_cstore: "Close template for cstore. Blank = fall back to whatsapp_template_shift_close",
  whatsapp_template_shift_close_vape: "Close template for vape. Blank = fall back to whatsapp_template_shift_close",
  cash_manager_staff_id: "Staff who holds the business cash; shift takings are handed over to them. Blank = cash handling not configured",
  cash_handover_stale_days: "Flag cash still out with a cashier after this many days",
  public_report_url: "Deployed web app /exec URL. The reconcile message links to <url>?v=recon (7-day read-only report, no login). Blank = no link sent",
  timezone: "Default timezone (script setting overrides)",
  till_enabled: "Switch for the link to the till (reads its stores, staff, shifts and daily sales). Off until the key and address are set",
  till_api_url: "The till's Operations API address, e.g. https://office.scarbromart.ca/ops/v1 (staging: https://staging--scarbromart-office.netlify.app/ops/v1). Blank = the link is off",
  till_key_expires_on: "The day the till key in use expires (yyyy-MM-dd): type it in when the key is installed. Blank = not recorded",
  assistants_enabled: "Open the door for AI assistants (/mcp). Off: the address answers nothing to anyone, key or no key",
  assistant_calls_per_minute: "Tool calls one assistant key may make in a minute",
  assistant_proposals_per_day: "Proposals one assistant key may make in a Toronto day",
};

/** A sentence added to the description the screen shows, whatever the table row says. */
const NOTES: Readonly<Record<string, string>> = {
  commission_run_day: "The weekly run's time is fixed in the app's configuration (card P3-10b), so this does not move it.",
  commission_run_hour: "The weekly run's time is fixed in the app's configuration (card P3-10b), so this does not move it.",
  cstore_card_split: "Left blank, this is read as yes (as the old app did), whatever the default shown.",
  vape_card_split: "Left blank, this is read as yes.",
};

/** What a blank is actually read as, where that differs from the registry default (see NOTES). */
const BLANK_READS: Readonly<Record<string, string>> = { cstore_card_split: "true", vape_card_split: "true" };

// ── Number rules ───────────────────────────────────────────

interface NumberRule {
  min: number;
  max: number;
  /** A whole number only. */
  integer?: boolean;
  /** Zero is refused because the reader turns it into this default. */
  zeroReadsAs?: string;
}

const MONEY_MAX = 1_000_000;
const money = (): NumberRule => ({ min: 0, max: MONEY_MAX });
const threshold = (def: string): NumberRule => ({ min: 0, max: MONEY_MAX, zeroReadsAs: def });

const NUMBER_RULES: Readonly<Record<string, NumberRule>> = {
  cstore_default_opening_float: money(),
  vape_default_opening_float: money(),
  lotto_reserve_default: money(),
  variance_ok_threshold: threshold("1"),
  variance_minor_threshold: threshold("30"),
  card_variance_threshold: threshold("1"),
  session_hours: { min: 1, max: 720, integer: true },
  login_max_fails: { min: 1, max: 100, integer: true },
  login_lockout_mins: { min: 1, max: 10080, integer: true },
  commission_run_day: { min: 0, max: 6, integer: true },
  commission_run_hour: { min: 0, max: 23, integer: true },
  cash_handover_stale_days: { min: 1, max: 365, integer: true },
  assistant_calls_per_minute: { min: 1, max: 600, integer: true },
  assistant_proposals_per_day: { min: 1, max: 5000, integer: true },
};

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function checkNumber(key: string, text: string): string {
  const rule = NUMBER_RULES[key];
  if (!PLAIN_NUMBER.test(text) || !Number.isFinite(Number(text))) throw new Error(`${key} must be a plain number such as 250 or 250.50`);
  const n = Number(text);
  if (rule === undefined) return text;
  if (rule.integer) {
    if (!Number.isInteger(n) || n < rule.min || n > rule.max) throw new Error(`${key} must be a whole number from ${rule.min} to ${rule.max}`);
    return text;
  }
  if (rule.zeroReadsAs !== undefined) {
    if (n <= 0) throw new Error(`${key} must be more than 0 (a zero is read as the default, ${rule.zeroReadsAs})`);
  } else if (n < rule.min) {
    throw new Error(`${key} cannot be less than ${rule.min}`);
  }
  if (n > rule.max) throw new Error(`${key} cannot be more than ${rule.max}`);
  return text;
}

// ── Other rules ────────────────────────────────────────────

/** A control character (a line break, tab, escape, NUL…) or a Unicode line/paragraph separator. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const MAX_TEXT = 500;
const MAX_NUMBERS = 20;

/** The text rules every text value shares: trimmed (the caller has), 500 characters, no control characters. */
function checkText(key: string, text: string): string {
  if (CONTROL.test(text)) throw new Error(`${key} cannot contain a line break or other control character`);
  if ([...text].length > MAX_TEXT) throw new Error(`${key} must be ${MAX_TEXT} characters or fewer`);
  return text;
}

function checkBoolean(key: string, text: string): string {
  const v = text.toLowerCase();
  if (v !== "true" && v !== "false") throw new Error(`${key} must be true or false`);
  return v;
}

/** Digits only per entry, 8 to 15 of them, at most 20 entries, each kept once. */
function checkNumbers(key: string, text: string): string | null {
  const entries = text.split(/[,;\n]+/).map((e) => e.trim()).filter((e) => e !== "");
  const digits: string[] = [];
  entries.forEach((entry, i) => {
    const d = entry.replace(/[\s+\-()]/g, "");
    if (!/^\d{8,15}$/.test(d)) throw new Error(`${key}: number ${i + 1} must be 8 to 15 digits (spaces, +, - and brackets are fine)`);
    if (!digits.includes(d)) digits.push(d);
  });
  if (entries.length > MAX_NUMBERS) throw new Error(`${key}: at most ${MAX_NUMBERS} numbers`);
  return digits.length === 0 ? null : digits.join(",");
}

function checkDate(key: string, text: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new Error(`${key} must be a date written yyyy-mm-dd`);
  }
  return text;
}

function checkZone(key: string, text: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: text });
  } catch {
    throw new Error(`${key}: ${text} is not a time zone name such as America/Toronto`);
  }
  return text;
}

function checkHttps(key: string, text: string): string {
  let ok = false;
  try {
    const u = new URL(text);
    ok = u.protocol === "https:" && u.hostname !== "" && u.username === "" && u.password === "";
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`${key} must be an https:// address`);
  return text;
}

/** An unknown key shaped like a credential (the registry's own rule for what a secret is called). */
function looksLikeCredential(key: string): boolean {
  return /(_token|_key|_secret)$/i.test(key) || /password/i.test(key);
}

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** The text of an input value: a string, number or boolean as typed; anything else is refused. Null for blank. */
function asText(key: string, v: unknown): string | null {
  if (blank(v)) return null;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  throw new Error(`${key} must be text, a number, or blank`);
}

// ── Reading ────────────────────────────────────────────────

export interface SettingRow {
  key: string;
  value: string | null;
  default: string;
  /** What a blank is read as, when that is not the default (the card-split switches). */
  blankReads: string;
  read: string;
  description: string;
  isDefault: boolean;
  group: Group;
}
export interface OtherRow {
  key: string;
  value: string | null;
  description: string;
}
export interface SecretRow {
  key: string;
  binding: string;
  isSet: boolean;
}
export interface SettingsList {
  settings: SettingRow[];
  other: OtherRow[];
  secrets: SecretRow[];
}

interface Row {
  key: string;
  value: string | null;
  description: string | null;
}

const present = (v: string | null | undefined): string | null => (v === null || v === undefined || v === "" ? null : v);

function describe(key: string, rowDescription: string | null | undefined): string {
  const base = (rowDescription ?? "").trim() || DESCRIPTIONS[key] || key;
  const note = NOTES[key];
  return note !== undefined && !base.includes(note) ? `${base} ${note}` : base;
}

export async function list(db: Db, env: Readonly<Record<string, unknown>>): Promise<SettingsList> {
  const rows = await db.query<Row>("select key, value, description from ops.config order by key");
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const settings: SettingRow[] = [];
  for (const [group, keys] of LAYOUT) {
    for (const key of keys) {
      const spec = configKeySpec(key);
      if (!spec || spec.kind !== "setting") continue;
      const row = byKey.get(key);
      const value = present(row?.value);
      settings.push({ key, value, default: spec.default, blankReads: BLANK_READS[key] ?? spec.default, read: spec.read, description: describe(key, row?.description), isDefault: value === null, group });
    }
  }
  // A registry setting the layout forgot would vanish from the screen: show it under Other instead.
  for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    if (spec.kind !== "setting" || settings.some((s) => s.key === key)) continue;
    const row = byKey.get(key);
    const value = present(row?.value);
    settings.push({ key, value, default: spec.default, blankReads: BLANK_READS[key] ?? spec.default, read: spec.read, description: describe(key, row?.description), isDefault: value === null, group: "Other" });
  }
  const other: OtherRow[] = rows
    .filter((r) => configKeySpec(r.key) === undefined && !looksLikeCredential(r.key))
    .map((r) => ({ key: r.key, value: present(r.value), description: (r.description ?? "").trim() }));
  const secrets: SecretRow[] = SECRET_KEYS.map((key) => ({ key, binding: key.toUpperCase(), isSet: maybeSecret(env, key) !== null }));
  return { settings, other, secrets };
}

// ── Writing ────────────────────────────────────────────────

export interface UpdateInput {
  key: unknown;
  value: unknown;
  actorId: string;
}
export interface UpdateResult {
  key: string;
  value: string | null;
  isDefault: boolean;
  changed: boolean;
}

/** `•••••••1234`: every digit but the last four hidden. */
function mask(number: string): string {
  return "•".repeat(Math.max(number.length - 4, 0)) + number.slice(-4);
}
function maskedList(value: string | null): { value: string | null; count: number } {
  const numbers = (value ?? "").split(/[,;\s]+/).filter(Boolean);
  return { value: numbers.length === 0 ? null : numbers.map(mask).join(","), count: numbers.length };
}

/** Check `key` and `value` and return the text to store (null = blank), or throw a message for the person. */
async function validate(db: Tx, key: string, raw: unknown): Promise<string | null> {
  const spec = configKeySpec(key);
  const text = asText(key, raw);
  if (text === null) return null;
  if (spec === undefined) return checkText(key, text);
  switch (key) {
    case "whatsapp_target_number":
      return checkNumbers(key, text);
    case "whatsapp_api_url":
      if (!isMetaUrl(text)) throw new Error("whatsapp_api_url must be an https://graph.facebook.com address (the token is only ever sent there)");
      return checkText(key, text);
    case "clover_base_url":
      if (!isCloverUrl(text)) throw new Error("clover_base_url must be a Clover address (https://api.clover.com or https://sandbox.dev.clover.com); the token is only ever sent there");
      return checkText(key, text);
    case "till_api_url":
      if (tillBaseUrl(text) === null) throw new Error("till_api_url must be one of the till's own addresses (https://office.scarbromart.ca/ops/v1 or the staging one, with no port, user name or query); the key is only ever sent there");
      return checkText(key, text);
    case "till_key_expires_on":
      return checkDate(key, text);
    case "public_report_url":
      return checkText(key, checkHttps(key, text));
    case "cash_manager_staff_id": {
      checkText(key, text);
      const found = await db.maybeOne("select 1 as found from ops.staff where staff_id = $1 and active = true", [text]);
      if (found === null) throw new Error(`${key}: ${text} is not an active person on the staff list`);
      return text;
    }
    case "cstore_epos_from":
      return checkDate(key, text);
    case "timezone":
      return checkZone(key, checkText(key, text));
  }
  switch (spec.read) {
    case "boolean":
      return checkBoolean(key, text);
    case "number":
      return checkNumber(key, text);
    case "list":
      return checkNumbers(key, text);
    default:
      return checkText(key, text);
  }
}

/**
 * Change one setting. Must run in the caller's transaction (the router's). Returns what is stored now;
 * `changed` is false (and nothing is written, audit included) when the new value is the one already there.
 */
export async function update(db: Tx, input: UpdateInput, deps: { now: Date }): Promise<UpdateResult> {
  const key = typeof input.key === "string" ? input.key : "";
  const spec = key === "" ? undefined : configKeySpec(key);
  if (spec !== undefined && spec.kind === "secret") throw new Error(`${key} is kept by Cloudflare, not in settings`);
  if (key !== "" && spec === undefined && looksLikeCredential(key)) throw new Error(`${key} is kept by Cloudflare, not in settings`);
  let known = spec !== undefined;
  if (!known && key !== "") known = (await db.maybeOne("select 1 as found from ops.config where key = $1", [key])) !== null;
  if (!known) throw new Error(`Unknown setting: ${typeof input.key === "string" ? input.key : String(input.key)}`);

  const next = await validate(db, key, input.value);

  // Nothing stored and nothing to store: the row is not created just to say so.
  if (next === null && (await db.maybeOne("select 1 as found from ops.config where key = $1", [key])) === null) {
    return { key, value: null, isDefault: true, changed: false };
  }

  // Lock: make sure the row exists (empty), then lock it. After a wait for another edit, the select
  // sees that edit's committed value, so `before` is always what the row held when this edit applied.
  await db.query("insert into ops.config (key, value, description) values ($1, null, $2) on conflict (key) do nothing", [key, DESCRIPTIONS[key] ?? null]);
  const current = await db.one<{ value: string | null }>("select value from ops.config where key = $1 for update", [key]);
  const before = present(current.value);
  if (before === next) return { key, value: next, isDefault: next === null, changed: false };

  await db.query("update ops.config set value = $2 where key = $1", [key, next]);

  const recipients = key === "whatsapp_target_number";
  await audit.write(
    db,
    {
      actorId: input.actorId,
      action: "config.update",
      targetType: "config",
      targetId: key,
      before: recipients ? maskedList(before) : { value: before },
      after: recipients ? maskedList(next) : { value: next },
    },
    { now: deps.now },
  );
  return { key, value: next, isDefault: next === null, changed: true };
}
