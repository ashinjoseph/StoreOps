// The comparison: normalisation (explicit and minimal) and the difference walk.
//
// What may legitimately differ between the two sides, and nothing else by default:
//   1. Session tokens. Each side has its own: the harness's sign-ins, and any
//      token an rpcLogin answer carries. A token becomes <token:as S_002> (a
//      harness sign-in) or <token:N> (in order of first appearance), wherever it
//      appears in full, and the form the logout audit row stores
//      (token.substring(0, 8) + "...") becomes "<token:...>[:8]...".
//   2. Ids generated during the case: a value of the shape
//      PREFIX_yyyyMMdd_HHmmss_<random> (Util.newId on the old side, lib/ids newId
//      on the new, which may use more random characters) that did not exist on
//      that side when the case started. Prefix and stamp are kept, so they are
//      still compared; the random part becomes <id:N>, numbered per prefix in
//      order of first appearance, separately on each side. A result that uses
//      one id twice must therefore do so on both sides.
// Each case may add exemptions (a path and a REASON); the report lists them.
import { keyPath, type Outcome } from "./old-world";

/** Util.newId_ / lib/ids newId: prefix, Toronto stamp, then base-36 random characters. */
const ID_SHAPE = /\b([A-Za-z][A-Za-z0-9]*)_(\d{8})_(\d{6})_([a-z0-9]{1,10})\b/g;

/** Every id-shaped value in `text`. */
export function idsIn(text: string): string[] {
  return [...text.matchAll(ID_SHAPE)].map((m) => m[0]);
}

export class Normaliser {
  private readonly ids = new Map<string, string>();
  private readonly perPrefix = new Map<string, number>();
  private readonly tokens = new Map<string, string>();
  private readonly prefixes = new Map<string, string>();
  private tokenSeq = 0;

  /**
   * @param known ids that existed on this side before the case (never normalised)
   * @param harnessTokens the tokens the harness signed people in with, by staff id
   */
  constructor(
    private readonly known: ReadonlySet<string>,
    harnessTokens: ReadonlyMap<string, string>,
  ) {
    for (const [staffId, t] of [...harnessTokens].sort((a, b) => (a[0] < b[0] ? -1 : 1))) this.addToken(t, `as ${staffId}`);
  }

  private addToken(token: string, label: string): void {
    if (token === "" || this.tokens.has(token)) return;
    this.tokens.set(token, `<token:${label}>`);
    this.prefixes.set(token.substring(0, 8) + "...", `<token:${label}>[:8]...`);
  }

  /** Learn the tokens an answer hands out (any string under a key named `token`), in walk order. */
  learnTokens(value: unknown): void {
    walkSorted(value, (k, v) => {
      if (k === "token" && typeof v === "string" && !this.tokens.has(v)) this.addToken(v, String(++this.tokenSeq));
    });
  }

  /** Is `id` a generated id on this side? */
  isGenerated(id: string): boolean {
    return !this.known.has(id);
  }

  /** The placeholder `id` has, if it has been given one. */
  placeholderOf(id: string): string | undefined {
    return this.ids.get(id);
  }

  /**
   * Give `id` the placeholder the OTHER side gave its counterpart, when this
   * side has not numbered `id` yet and nothing here holds that placeholder.
   * Used for rows matched across the sides by content (writes.ts); a
   * placeholder already in use is never handed out twice.
   */
  adopt(id: string, placeholder: string): boolean {
    if (!this.isGenerated(id) || this.ids.has(id)) return false;
    const m = /^([A-Za-z][A-Za-z0-9]*)_(\d{8})_(\d{6})_<id:(\d+)>$/.exec(placeholder);
    if (!m || !id.startsWith(`${m[1]}_${m[2]}_${m[3]}_`)) return false;
    if ([...this.ids.values()].includes(placeholder)) return false;
    this.ids.set(id, placeholder);
    const pre = m[1] as string;
    this.perPrefix.set(pre, Math.max(this.perPrefix.get(pre) ?? 0, Number(m[4])));
    return true;
  }

  /** A string with tokens and generated ids replaced. Numbers new ids as it meets them. */
  str(s: string, assign = true): string {
    const prefix = this.prefixes.get(s);
    if (prefix !== undefined) return prefix;
    let out = s;
    for (const [t, p] of this.tokens) if (out.includes(t)) out = out.split(t).join(p);
    return out.replace(ID_SHAPE, (whole: string, pre: string, day: string, time: string) => {
      if (!this.isGenerated(whole)) return whole;
      let p = this.ids.get(whole);
      if (p === undefined) {
        if (!assign) return `${pre}_${day}_${time}_<id:?>`;
        const n = (this.perPrefix.get(pre) ?? 0) + 1;
        this.perPrefix.set(pre, n);
        p = `${pre}_${day}_${time}_<id:${n}>`;
        this.ids.set(whole, p);
      }
      return p;
    });
  }

  /** A JSON value with every string normalised, walking object keys in sorted order. */
  value(v: unknown, assign = true): unknown {
    if (typeof v === "string") return this.str(v, assign);
    if (Array.isArray(v)) return v.map((x) => this.value(x, assign));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[this.str(k, assign)] = this.value((v as Record<string, unknown>)[k], assign);
      return out;
    }
    return v;
  }

  outcome(o: Outcome): Outcome {
    if (o.kind === "ok") return { kind: "ok", value: this.value(o.value) };
    if (o.kind === "error") return { kind: "error", message: this.str(o.message) };
    return o;
  }
}

function walkSorted(v: unknown, visit: (key: string | null, value: unknown) => void, key: string | null = null): void {
  visit(key, v);
  if (Array.isArray(v)) v.forEach((x) => walkSorted(x, visit, null));
  else if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v).sort()) walkSorted((v as Record<string, unknown>)[k], visit, k);
  }
}

// ── Differences ────────────────────────────────────────────

export interface Diff {
  /** "call 2 rpcLogin", "table audit_log", ... */
  where: string;
  /** A JSON path ($.holders[0].total) or, for a table, [primary key].column. */
  path: string;
  old: string;
  new: string;
}

/** The most differences listed per call or per table; the rest are counted. */
export const MAX_DIFFS = 20;

const MISSING = Symbol("missing");

export function render(v: unknown): string {
  if (v === MISSING) return "(missing)";
  const s = JSON.stringify(v);
  const text = s === undefined ? String(v) : s;
  return text.length > 160 ? text.slice(0, 157) + "..." : text;
}

function tag(v: unknown): string {
  if (v === MISSING) return "missing";
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** A path pattern ($.a[*].b, $.*.c) as a test on concrete paths. */
export function pathMatcher(pattern: string): (path: string) => boolean {
  if (!pattern.startsWith("$")) throw new Error(`an exemption path starts with $: ${pattern}`);
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\[\\\*\\\]/g, "\\[\\d+\\]")
        .replace(/\\\.\\\*/g, "\\.[^.\\[]+") +
      "$",
  );
  return (path) => re.test(path);
}

/**
 * Every difference between two JSON values. Exact: numbers by ===, so a cent
 * is a difference; null, '', 0, false and a missing key are all different
 * from each other; object key order is ignored; array order is not.
 * `exempt(path)` true: that value is not compared, but it must exist on both sides.
 */
export function diffValues(a: unknown, b: unknown, path: string, out: { path: string; old: string; new: string }[], exempt: (p: string) => boolean = () => false): void {
  if (exempt(path) && a !== MISSING && b !== MISSING) return;
  const ta = tag(a);
  const tb = tag(b);
  if (ta !== tb) {
    out.push({ path, old: render(a), new: render(b) });
    return;
  }
  if (ta === "array") {
    const x = a as unknown[];
    const y = b as unknown[];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      diffValues(i < x.length ? x[i] : MISSING, i < y.length ? y[i] : MISSING, `${path}[${i}]`, out, exempt);
    }
    return;
  }
  if (ta === "object") {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
    for (const k of keys) diffValues(Object.hasOwn(x, k) ? x[k] : MISSING, Object.hasOwn(y, k) ? y[k] : MISSING, `${path}${keyPath(k)}`, out, exempt);
    return;
  }
  if (a !== b) out.push({ path, old: render(a), new: render(b) });
}

/** Two outcomes of one call. An error on both sides with the same message agrees. */
export function diffOutcomes(o: Outcome, n: Outcome, exempt: (p: string) => boolean): { path: string; old: string; new: string }[] {
  const out: { path: string; old: string; new: string }[] = [];
  const show = (x: Outcome): string => (x.kind === "ok" ? render(x.value) : x.kind === "error" ? `(error) ${JSON.stringify(x.message)}` : "(not ported)");
  if (o.kind === "ok" && n.kind === "ok") diffValues(o.value, n.value, "$", out, exempt);
  else if (o.kind === "error" && n.kind === "error") {
    if (o.message !== n.message) out.push({ path: "$", old: show(o), new: show(n) });
  } else out.push({ path: "$", old: show(o), new: show(n) });
  return out;
}

export { MISSING };
