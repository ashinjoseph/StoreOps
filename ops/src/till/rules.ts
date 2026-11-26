/**
 * The till API contract's arithmetic rules, as pure functions.
 *
 * Every function returns a list of differences (path, expected, actual). Money
 * is compared in integer cents: a float such as 0.1 + 0.2 is never compared
 * with `===`. A rule whose inputs are missing or of the wrong type is skipped
 * (the schema check reports that), so these functions never throw on bad data.
 *
 * No function here prints or returns a person's name, display name or id.
 */

export type Severity = "error" | "warning";

export interface Difference {
  severity: Severity;
  path: string;
  expected: string;
  actual: string;
}

type Obj = Record<string, unknown>;

const METHODS = ["cash", "credit", "debit", "etransfer", "other"] as const;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Integer cents of a money figure, or null when it is not a finite number. */
export function cents(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : null;
}

/** Cents back to a two-decimal string (-50 -> "-0.50"). */
export function fmtCents(c: number): string {
  return (c / 100).toFixed(2);
}

const diff = (severity: Severity, path: string, expected: string, actual: string): Difference => ({
  severity,
  path,
  expected,
  actual,
});

/** `expected` and `actual` as money; null when either side is not a number. */
function moneyEquals(path: string, expected: number | null, actual: number | null): Difference[] {
  if (expected === null || actual === null || expected === actual) return [];
  return [diff("error", path, fmtCents(expected), fmtCents(actual))];
}

/** net = subtotal - discount; total = net + surcharge + hst + rounding. */
export function checkSalesSummary(summary: unknown, path: string): Difference[] {
  if (!isObj(summary)) return [];
  const out: Difference[] = [];
  const subtotal = cents(summary.subtotal);
  const discount = cents(summary.discount);
  const net = cents(summary.net);
  if (subtotal !== null && discount !== null) out.push(...moneyEquals(`${path}.net`, subtotal - discount, net));
  const surcharge = cents(summary.surcharge);
  const hst = cents(summary.hst);
  const rounding = cents(summary.rounding);
  const total = cents(summary.total);
  if (net !== null && surcharge !== null && hst !== null && rounding !== null) {
    out.push(...moneyEquals(`${path}.total`, net + surcharge + hst + rounding, total));
  }
  return out;
}

/** Per method: net_total = sales_total + refunds_total, sales >= 0, refunds <= 0. */
export function checkTakings(takings: unknown, path: string): Difference[] {
  if (!isObj(takings)) return [];
  const out: Difference[] = [];
  for (const method of METHODS) {
    const m = takings[method];
    if (!isObj(m)) continue;
    const p = `${path}.${method}`;
    const sales = cents(m.sales_total);
    const refunds = cents(m.refunds_total);
    const net = cents(m.net_total);
    if (sales !== null && refunds !== null) out.push(...moneyEquals(`${p}.net_total`, sales + refunds, net));
    if (sales !== null && sales < 0) out.push(diff("error", `${p}.sales_total`, ">= 0.00", fmtCents(sales)));
    if (refunds !== null && refunds > 0) out.push(diff("error", `${p}.refunds_total`, "<= 0.00", fmtCents(refunds)));
  }
  return out;
}

const CLOSING_FIELDS = ["expected", "counted", "variance", "closed_at", "closed_by", "z_number"] as const;

function describe(v: unknown): string {
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return "<array>";
  if (v === null) return "null";
  return `<${typeof v}>`;
}

/** One shift: variance, the open-shift nulls, and its own summary and takings. */
export function checkShift(shift: unknown, path: string): Difference[] {
  if (!isObj(shift)) return [];
  const out: Difference[] = [];
  const counted = cents(shift.counted);
  const expected = cents(shift.expected);
  const variance = cents(shift.variance);
  if (counted !== null && expected !== null && variance !== null) {
    out.push(...moneyEquals(`${path}.variance`, counted - expected, variance));
  }
  if (shift.status === "open") {
    for (const f of CLOSING_FIELDS) {
      const v = shift[f];
      if (v !== null && v !== undefined) out.push(diff("error", `${path}.${f}`, "null while the shift is open", describe(v)));
    }
  }
  out.push(...checkSalesSummary(shift.sales_summary, `${path}.sales_summary`));
  out.push(...checkTakings(shift.takings, `${path}.takings`));
  return out;
}

/** One daily row: summary, takings, the delivery rule, and the takings-add-up warning. */
export function checkDailyRow(row: unknown, path: string): Difference[] {
  if (!isObj(row)) return [];
  const out: Difference[] = [];
  out.push(...checkSalesSummary(row.sales_summary, `${path}.sales_summary`));
  out.push(...checkTakings(row.takings, `${path}.takings`));

  const total = isObj(row.sales_summary) ? cents(row.sales_summary.total) : null;
  if (total !== null && isObj(row.takings)) {
    let sum = 0;
    let complete = true;
    for (const method of METHODS) {
      const m = row.takings[method];
      const net = isObj(m) ? cents(m.net_total) : null;
      if (net === null) complete = false;
      else sum += net;
    }
    // The contract allows a gap for a till sale whose payments did not cover its total.
    if (complete && sum !== total) out.push(diff("warning", `${path}.takings`, fmtCents(total), fmtCents(sum)));
  }

  if (row.delivery !== undefined && row.channel !== "delivery") {
    out.push(
      diff("error", `${path}.delivery`, "absent unless channel is delivery", `present on ${describeChannel(row.channel)}`),
    );
  }
  return out;
}

function describeChannel(c: unknown): string {
  return typeof c === "string" && /^[a-z_]{1,20}$/.test(c) ? c : "another channel";
}

/** The rows as a set: one per business_day + channel, every day inside [from, to]. */
export function checkDailyRows(rows: unknown, from: string, to: string, path: string): Difference[] {
  if (!Array.isArray(rows)) return [];
  const out: Difference[] = [];
  const first = new Map<string, number>();
  rows.forEach((row, i) => {
    if (!isObj(row)) return;
    const day = row.business_day;
    const channel = row.channel;
    if (typeof day === "string" && typeof channel === "string") {
      const key = `${day}|${channel}`;
      const seen = first.get(key);
      if (seen === undefined) first.set(key, i);
      else {
        out.push(
          diff("error", `${path}[${i}]`, "one row per business_day and channel", `${day} ${channel} again (first at ${path}[${seen}])`),
        );
      }
    }
    if (typeof day === "string" && (day < from || day > to)) {
      out.push(diff("error", `${path}[${i}].business_day`, `${from} to ${to}`, day));
    }
  });
  return out;
}

/** Products: unique sku, every vendor listed by /suppliers, sku_pending iff sku starts TMP-. */
export function checkProducts(products: unknown, suppliers: unknown, path: string): Difference[] {
  if (!Array.isArray(products)) return [];
  const vendors = new Set<string>();
  if (Array.isArray(suppliers)) {
    for (const s of suppliers) if (isObj(s) && typeof s.vendor === "string") vendors.add(s.vendor);
  }
  const out: Difference[] = [];
  const first = new Map<string, number>();
  products.forEach((p, i) => {
    if (!isObj(p)) return;
    const at = `${path}[${i}]`;
    if (typeof p.sku === "string") {
      const seen = first.get(p.sku);
      if (seen === undefined) first.set(p.sku, i);
      else out.push(diff("error", `${at}.sku`, "unique", `same as ${path}[${seen}].sku`));
      if (typeof p.sku_pending === "boolean") {
        const pending = p.sku.startsWith("TMP-");
        if (pending !== p.sku_pending) out.push(diff("error", `${at}.sku_pending`, String(pending), String(p.sku_pending)));
      }
    }
    if (Array.isArray(p.suppliers)) {
      p.suppliers.forEach((link, j) => {
        if (isObj(link) && typeof link.vendor === "string" && !vendors.has(link.vendor)) {
          out.push(diff("error", `${at}.suppliers[${j}].vendor`, "a vendor listed by /suppliers", link.vendor));
        }
      });
    }
  });
  return out;
}
