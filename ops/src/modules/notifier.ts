// Notifier: the port of src/Notifier.gs. WhatsApp sends through Meta's Cloud API,
// the setup check behind "Check WhatsApp setup", and the internal event log.
//
// Everything the module needs is passed in (`NotifierDeps`): the settings snapshot,
// the Worker's bindings, the `fetch` to use, a database handle and the clock. Nothing
// is global, so tests and the parity harness see every request.
//
// What is ported, and how it answers (the shapes match the old module field for field):
//   sendOp / sendTemplate / sendWhatsApp   { sent:false, reason } before any request, else
//                                          { sent, sentCount, total, results:[{ to, sent, reason?, detail? }] }.
//                                          They report a failure in the return value and never throw for one
//                                          (hard rule 7, ADR-0007): a caller that ignores `sent` has lost a message.
//   diagnose                               { ok, checks:[{ name, label, ok, detail, fix }] }; never returns the token.
//   notify                                 writes the audit row and sends nothing, as before.
//
// Left out on purpose: the SHOPPING LIST message. The shopping list is not being moved (plan
// "Not migrated"), so `shopping_list` is not an op key here: sendOp refuses it, and the setup
// check does not list its template. (The old check listed it; the answer's "templates" detail
// therefore differs from the old one in that one sentence.)
//
// The token comes only from the Worker binding WHATSAPP_API_TOKEN (`maybeSecret`), never from the
// settings table. A missing one gives what a blank cell gave: `not_configured` from a send, a
// failed "token" check from the setup check, and no request.
//
// Not logged, returned or put in an error: the token (any text that carries it has it replaced),
// and Meta's raw answer (only the sentence `apiError` picks out, at most 400 characters). The old
// code masked no phone number: a send result names each recipient in full, and so does this. The
// setup check only counts them.
//
// One deliberate addition, not in the old code: every outbound request has a 10-second limit
// (UrlFetchApp had its own). A request that does not finish is a failed send, reported like any
// other ("timed out after 10 seconds"), and it never holds the others up.
import type { Db } from "../db/client";
import * as audit from "../lib/audit";
import { maybeSecret, type Config } from "../lib/config";
import type { ConfigKey } from "../lib/config-keys";

export interface NotifierDeps {
  /** The settings snapshot for this call. */
  config: Config;
  /** The Worker's bindings: the token is `WHATSAPP_API_TOKEN`. */
  env: Readonly<Record<string, unknown>>;
  /** Outbound HTTP. Never the global `fetch`. */
  fetch: typeof fetch;
  /** Only `notify` uses it (the audit row). */
  db: Db;
  /** The clock for the audit row. */
  now: Date;
}

/** The messages that have an approved template of their own. `shopping_list` is deliberately not here. */
export const OP_KEYS = ["shift_open", "shift_close", "shift_close_cstore", "shift_close_vape"] as const;
export type OpKey = (typeof OP_KEYS)[number];

export interface SendRow {
  to: string;
  sent: boolean;
  reason?: string;
  detail?: string;
}
/** Not sent before any request (`reason`), or the outcome of one request per recipient. */
export type SendResult = { sent: false; reason: "disabled" | "not_configured" | "no_template" } | { sent: boolean; sentCount: number; total: number; results: SendRow[] };

export interface Check {
  name: string;
  label: string;
  ok: boolean;
  detail: string;
  fix: string;
}
export interface Diagnosis {
  ok: boolean;
  checks: Check[];
}

/** Each outbound request's limit. (Added in the move: see the header.) */
export const REQUEST_TIMEOUT_MS = 10_000;

const templateKey = (op: OpKey): ConfigKey => `whatsapp_template_${op}`;
const isOpKey = (k: string): k is OpKey => (OP_KEYS as readonly string[]).includes(k);

function isEnabled(deps: NotifierDeps): boolean {
  return deps.config.boolean("notifier_enabled", "false");
}

/** The token as the old `configValue_('whatsapp_api_token', '')` gave it: its text, or '' when there is none. */
function token(deps: NotifierDeps): string {
  return maybeSecret(deps.env, "whatsapp_api_token") ?? "";
}

/** `text` with the token, if it is in there, replaced. Everything that leaves this module as text goes through it. */
function scrub(text: string, secret: string): string {
  return secret !== "" && text.includes(secret) ? text.split(secret).join("<secret>") : text;
}

function messageOf(e: unknown, secret: string): string {
  return scrub(e instanceof Error ? e.message : String(e), secret);
}

/**
 * One request with a 10-second limit (the deliberate addition). The limit covers reading the
 * answer when `readBody` says to. Whatever the fetch does after the limit is ignored, so a fetch
 * that never looks at its signal still cannot hang a send.
 */
async function request(deps: NotifierDeps, url: string, init: RequestInit, readBody: (status: number) => boolean): Promise<{ code: number; text: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timed out after 10 seconds"));
    }, REQUEST_TIMEOUT_MS);
  });
  const work = (async () => {
    const resp = await deps.fetch(url, { ...init, signal: controller.signal });
    if (readBody(resp.status)) return { code: resp.status, text: await resp.text() };
    await resp.body?.cancel().catch(() => undefined); // not read: free the connection
    return { code: resp.status, text: "" };
  })();
  work.catch(() => undefined); // if the limit wins, a later failure of the request is not news
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** A JSON value's own property when it is an object, else undefined (what `x.p` gives in JavaScript for a primitive). */
const prop = (v: unknown, key: string): unknown => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined);

/**
 * The useful sentence out of a Meta error body: `error.message` and `error.error_data.details`
 * joined with " — " (the details name BOTH parameter counts of a template mismatch), at most 400
 * characters; or the raw body's first 400 when it is not that shape.
 */
function apiError(body: string): string {
  try {
    const e = prop(JSON.parse(body), "error") || {};
    const parts: string[] = [];
    const message = prop(e, "message");
    if (message) parts.push(String(message));
    const details = prop(prop(e, "error_data"), "details");
    if (details) parts.push(String(details));
    if (parts.length) return parts.join(" — ").slice(0, 400);
  } catch {
    // not JSON, or a shape we don't know: fall through
  }
  return String(body || "").slice(0, 400);
}

/**
 * A value for a template body PARAMETER: Meta rejects newlines, tabs and 4+ spaces inside one,
 * so collapse to a single line of plain spaces and strip *bold* and _italic_ markers.
 */
function flattenForTemplate(text: unknown): string {
  return String(text || "")
    .replace(/[*_]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** whatsapp_target_number may hold several numbers (comma, semicolon or space separated); one request goes to each. */
const recipients = (deps: NotifierDeps): string[] => deps.config.list("whatsapp_target_number");

/**
 * The shared send loop. `buildPayload(to)` is the Cloud API JSON body for one recipient; each is
 * POSTed in turn. Never throws for a send failure.
 */
/** https://graph.facebook.com/… and nothing else: the only place the WhatsApp token may be sent. */
export function isMetaUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "graph.facebook.com" && u.username === "" && u.password === "" && (u.port === "" || u.port === "443");
  } catch {
    return false;
  }
}

async function dispatch(deps: NotifierDeps, buildPayload: (to: string) => unknown): Promise<SendResult> {
  if (!isEnabled(deps)) return { sent: false, reason: "disabled" };
  const url = deps.config.value("whatsapp_api_url", "");
  const secret = token(deps);
  if (!url || !secret) return { sent: false, reason: "not_configured" };
  // DELIBERATE ADDITION (review of P3-08): the token is only ever sent to Meta. The old code
  // posted it to whatever whatsapp_api_url held, so anyone able to change that one setting could
  // have had the token delivered to a server of their own. Any other address counts as not set up.
  if (!isMetaUrl(url)) return { sent: false, reason: "not_configured" };
  const to = recipients(deps);
  if (to.length === 0) return { sent: false, reason: "not_configured" };

  let sentCount = 0;
  const results: SendRow[] = [];
  for (const recipient of to) {
    try {
      const resp = await request(
        deps,
        url,
        { method: "POST", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" }, body: JSON.stringify(buildPayload(recipient)) },
        (code) => !(code >= 200 && code < 300),
      );
      if (resp.code >= 200 && resp.code < 300) {
        sentCount++;
        results.push({ to: recipient, sent: true });
      } else {
        results.push({ to: recipient, sent: false, reason: "http_" + resp.code, detail: scrub(apiError(resp.text), secret) });
      }
    } catch (e) {
      results.push({ to: recipient, sent: false, reason: "exception", detail: messageOf(e, secret) });
    }
  }
  return { sent: sentCount > 0, sentCount, total: to.length, results };
}

/**
 * A free-form message. If `whatsapp_template_name` (the generic template) is set, the whole body
 * goes into {{1}} of it, flattened; otherwise plain text (which Meta delivers only inside the 24h
 * customer-service window).
 */
export async function sendWhatsApp(deps: NotifierDeps, body: string): Promise<SendResult> {
  const templateName = deps.config.value("whatsapp_template_name", "");
  const lang = deps.config.value("whatsapp_template_lang", "en") || "en";
  return dispatch(deps, (to) => {
    if (templateName) {
      return {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: { name: templateName, language: { code: lang }, components: [{ type: "body", parameters: [{ type: "text", text: flattenForTemplate(body) }] }] },
      };
    }
    return { messaging_product: "whatsapp", to, type: "text", text: { body: String(body || "") } };
  });
}

/**
 * An approved template with its ordered body parameters. The template's own text holds the layout;
 * each parameter is one value, flattened, and an empty one becomes "—" so Meta never rejects it for
 * being empty. HOW MANY parameters there are is the template's fact, fixed by whoever builds
 * `params` for it (ADR-0007): nothing here adds, drops or pads one.
 */
export async function sendTemplate(deps: NotifierDeps, templateName: string, params: readonly unknown[]): Promise<SendResult> {
  if (!templateName) return { sent: false, reason: "no_template" };
  const lang = deps.config.value("whatsapp_template_lang", "en") || "en";
  const parameters = (params || []).map((p) => {
    const t = flattenForTemplate(p);
    return { type: "text", text: t === "" ? "—" : t };
  });
  return dispatch(deps, (to) => ({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: { name: templateName, language: { code: lang }, components: parameters.length ? [{ type: "body", parameters }] : [] },
  }));
}

/**
 * The operation-aware send. Looks up `whatsapp_template_<opKey>`: if it is set, sends that template
 * with `params`; otherwise falls back to `sendWhatsApp(plain)` (the generic template, else plain text).
 *
 * A key outside OP_KEYS that is not the shopping list has no template setting here, which is what
 * an unset one gave in the old code: it falls back to plain text. `shopping_list` is refused: its
 * template setting is not read in the new app, so a send could not tell whether one is configured.
 */
export async function sendOp(deps: NotifierDeps, opKey: OpKey, params: readonly unknown[], plain: string): Promise<SendResult> {
  if ((opKey as string) === "shopping_list") throw new Error("Notifier.sendOp: shopping_list is not moved to the new app (the shopping list message is left out)");
  const name = isOpKey(opKey) ? deps.config.value(templateKey(opKey), "") : "";
  if (name) return sendTemplate(deps, name, params);
  return sendWhatsApp(deps, plain);
}

/**
 * What would stop a WhatsApp message arriving, checked in order, without sending one. The last
 * check asks Meta about the phone number with the configured token (a GET), so an expired or
 * revoked token, or a wrong phone number ID, is named in Meta's own words. Never returns the token.
 */
export async function diagnose(deps: NotifierDeps): Promise<Diagnosis> {
  const checks: Check[] = [];
  const add = (name: string, label: string, ok: boolean, detail: string, fix: string): void => {
    checks.push({ name, label, ok: !!ok, detail: detail || "", fix: ok ? "" : fix || "" });
  };

  const enabled = isEnabled(deps);
  add("enabled", "Notifications switched on", enabled, enabled ? "notifier_enabled is TRUE" : "notifier_enabled is not TRUE — nothing is sent", "Set notifier_enabled to TRUE in the config tab.");

  const url = String(deps.config.value("whatsapp_api_url", "") || "").trim();
  // This pattern is the one place the check knows Meta's host; the URL itself is always the setting's.
  const m = /^(https:\/\/graph\.facebook\.com\/v[\d.]+\/)(\d+)\/messages\/?$/.exec(url);
  add(
    "url",
    "API URL",
    !!m,
    m ? "phone number ID " + m[2] : url ? "not a …/<phone number ID>/messages URL" : "whatsapp_api_url is blank",
    "Set whatsapp_api_url to https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages (Meta → WhatsApp → API Setup).",
  );

  const secret = token(deps).trim();
  add("token", "Access token", !!secret, secret ? "set" : "whatsapp_api_token is blank", "Paste a permanent System User token into whatsapp_api_token.");

  const to = recipients(deps);
  add(
    "recipients",
    "Recipients",
    to.length > 0,
    to.length ? to.length + " number" + (to.length === 1 ? "" : "s") : "whatsapp_target_number is blank",
    "Put one or more numbers (E.164, no +) in whatsapp_target_number.",
  );

  // The old list also had shopping_list (see the header).
  const set = OP_KEYS.filter((op) => deps.config.value(templateKey(op), ""));
  const unset = OP_KEYS.filter((op) => !set.includes(op));
  add(
    "templates",
    "Templates",
    set.length > 0,
    (set.length ? "set: " + set.map((op) => op + "=" + deps.config.value(templateKey(op), "")).join(", ") : "none set") +
      (unset.length ? " · not set: " + unset.join(", ") + " (those send plain text, which Meta only delivers inside a 24h chat window)" : ""),
    "Set whatsapp_template_<op> to the approved template name for each message.",
  );

  if (m && secret) {
    const label = "Meta accepts the token and number";
    try {
      const resp = await request(
        deps,
        (m[1] ?? "") + (m[2] ?? "") + "?fields=verified_name,display_phone_number,quality_rating",
        { method: "GET", headers: { Authorization: "Bearer " + secret } },
        () => true,
      );
      if (resp.code >= 200 && resp.code < 300) {
        let info: unknown = {};
        try {
          info = JSON.parse(resp.text) || {};
        } catch {
          // an answer that is not JSON: no name to show
        }
        const rating = prop(info, "quality_rating");
        add(
          "meta",
          label,
          true,
          [prop(info, "verified_name"), prop(info, "display_phone_number"), rating && "quality " + String(rating)].filter(Boolean).map(String).join(" · ") || "HTTP " + resp.code,
          "",
        );
      } else {
        add(
          "meta",
          label,
          false,
          scrub("HTTP " + resp.code + " — " + apiError(resp.text), secret),
          resp.code === 401 || /token/i.test(resp.text)
            ? "The access token has expired or been revoked. Generate a permanent System User token in Meta Business Settings and paste it into whatsapp_api_token."
            : "Check the phone number ID in whatsapp_api_url and that the token has whatsapp_business_messaging permission.",
        );
      }
    } catch (e) {
      add("meta", label, false, "request failed: " + messageOf(e, secret), "Retry; if it persists, check the script has permission to make external requests.");
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// ── notify: internal events, written to the audit log only ────────────────

/** The fields the old callers put in an event's payload. All optional, as before. */
export interface NotifyPayload {
  actorId?: string;
  targetType?: string;
  targetId?: string;
  staffId?: string;
  staffName?: string;
  company?: string;
  openingFloat?: number | null;
  variance?: number | string | null;
  lottoReserveCounted?: number | null;
  lottoTopupFromTill?: number | null;
  cashInHand?: number | null;
  amount?: number;
  bonusesCreated?: number;
  totalAmount?: number;
}

/** A short human-readable summary of each event, as the old `summarize_` wrote it. */
export function summarize(event: string, payload: NotifyPayload = {}): string {
  payload = payload || {};
  switch (event) {
    case "shift.opened":
      return `🟢 ${payload.staffName || payload.staffId} opened ${payload.company} shift` + (payload.openingFloat != null ? ` (float $${payload.openingFloat})` : "");
    case "shift.closed": {
      const v = Number(payload.variance) || 0;
      const vstr = v === 0 ? "$0 variance" : v > 0 ? `+$${v.toFixed(2)} over` : `-$${Math.abs(v).toFixed(2)} short`;
      // Reserve only when the close actually carried one: a vape shift passes null, and "reserve $0" would read as an empty pot.
      let lottoStr = "";
      if (payload.lottoReserveCounted != null) {
        lottoStr = `, lotto reserve $${Number(payload.lottoReserveCounted).toFixed(2)}`;
        const moved = Number(payload.lottoTopupFromTill) || 0;
        if (moved > 0.01) lottoStr += ` (+$${moved.toFixed(2)} from till)`;
      }
      // The takings the cashier is now carrying; a close that took nothing out says nothing.
      let handStr = "";
      const inHand = Number(payload.cashInHand) || 0;
      if (payload.cashInHand != null && inHand > 0.01) handStr = `, $${inHand.toFixed(2)} in hand`;
      return `🔴 ${payload.staffName || payload.staffId} closed ${payload.company} shift, ${vstr}${lottoStr}${handStr}`;
    }
    case "payment.recorded":
      return `💰 Paid $${(payload.amount || 0).toFixed(2)} to ${payload.staffName || payload.staffId}`;
    case "commission.computed":
      return `🎯 Commission run: ${payload.bonusesCreated || 0} bonus(es), ` + `$${(payload.totalAmount || 0).toFixed(2)} total`;
    default:
      return `Event: ${event}`;
  }
}

/**
 * Dispatch an internal event. Always logs to the audit log; sends to no channel (the old code's
 * WhatsApp branch here was commented out and is not ported). Answers why nothing was dispatched.
 */
export async function notify(deps: NotifierDeps, event: string, payload: NotifyPayload = {}): Promise<{ dispatched: false; reason: "disabled" | "no_channel_configured" }> {
  payload = payload || {};
  await audit.write(
    deps.db,
    {
      actorId: payload.actorId || "SYSTEM",
      action: "notify." + event,
      targetType: payload.targetType || "notification",
      targetId: payload.targetId || "",
      details: summarize(event, payload),
    },
    { now: deps.now },
  );
  if (!isEnabled(deps)) return { dispatched: false, reason: "disabled" };
  return { dispatched: false, reason: "no_channel_configured" };
}
