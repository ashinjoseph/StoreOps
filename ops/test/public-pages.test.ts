// The public pages: ops/src/public/inline.ts and pages.ts, and their route in ops/src/index.ts.
// `/?v=recon` and `/?v=sales` are the only pages anyone on the internet can open with no sign-in.
//
// Ported here from the old suites (server side; src/WebApp.gs doGet, publicReconPage_,
// publicSalesPage_, inlineJson_):
//   - tests/suites/routing.js: each view serves its own page (sales → the sales template, recon →
//     the reconcile template, no v → the app); a mangled link lands somewhere useful (v is
//     case-sensitive, an unknown v falls through to the app, no parameters at all is the app);
//     the day window is clamped, not trusted (9999 → 365, 0 → 1, -5 → 1, junk → 60, absent → 60);
//     a failing report degrades to a message (served, not thrown; "unavailable" published; the
//     internal error not leaked); the sales page publishes aggregates only (no staffName, staffId,
//     sessionId, salesId, miscNotes; the aggregates are there).
//   - tests/suites/public-inline.js: for both pages, a note with </script> in it never reaches the
//     HTML as markup, the script is not cut short, the note arrives exactly as typed, and ordinary
//     markup in text survives. Here end to end, through the Worker's fetch handler and a database.
//   - tests/suites/public-render.js and public-chart.js: the pages' own scripts, unchanged, run
//     against the NEW side's payload (both render, the sales page does not "fail to render", one
//     chart column per day, the recon page escapes what it shows). The old suites' assertions over
//     invented payloads (tile wording, bar heights, compact()) test client code only, unchanged by
//     this card: they stay in tests/suites/, which reads the same src/*.html.
//   - tests/suites/template-guard.js (the build's half is in tests/suites/ops-ui-build.js): the
//     payload tag is the force-print form, it lands in parseable JavaScript.
// Plus this card's security rules: read-only (one read-only transaction; a write inside the build
// fails), the connection always closed, nothing read from the request but its method and URL, no
// other query parameter changes the payload, the headers and the content security policy (and the
// app page's policy unchanged), the fallback page and its status, the methods.
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, type Db } from "../src/db/client";
import { formatDate } from "../src/lib/dates";
import worker from "../src/index";
import { inlineJson } from "../src/public/inline";
import * as pages from "../src/public/pages";
import { PUBLIC_TEMPLATES } from "../src/public/templates.generated";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

const APP_PAGE = "<!doctype html><title>StoreOps</title><p>the app</p>";
const assets = {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response(request.method === "HEAD" ? null : APP_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
};
const envFor = (): Record<string, unknown> => ({ ASSETS: assets, OPS_DB_APP_URL: testDb.appUrl });
const get = (path: string, env: Record<string, unknown> = envFor(), method = "GET") => worker.fetch(new Request(`https://ops.test${path}`, { method }), env);

const EVIL = "</script><script>window.PWNED=1</script><!--";
const LONG = "x".repeat(20_000);
const HOSTILE = `${EVIL} <!-- ]]> \u2028 \u2029 </SCRIPT > ${LONG}`;
const HOSTILE_NAME = "Evil </script><script>alert(1)</script> Name";

/** Today and yesterday in Toronto, by the real clock (the Worker reads it). */
const today = (): string => formatDate(new Date());
const daysAgo = (n: number): string => formatDate(new Date(Date.now() - n * 86_400_000));

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});

/** A store with a hostile name, a hostile lotto note and a hostile handover note, dated by the real clock. */
async function plantHostile(): Promise<void> {
  for (const t of ["audit_log", "validation_results", "cash_handover_items", "cash_handovers", "sales", "till_sessions", "attendance", "staff", "config"]) await owner.query(`delete from ops.${t}`);
  await owner.query("insert into ops.config (key, value) values ('cash_manager_staff_id', 'S_M')");
  await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role) values ('S_E', $1, 31.4159, true, 'employee'), ('S_M', 'Morgan Fictional', 29.99, true, 'manager')", [HOSTILE_NAME]);
  const d = daysAgo(1);
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ('A_E', 'S_E', $1, 'worked')", [d]);
  await owner.query(
    `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, cash_removed_at_close, lotto_reserve_counted, lotto_topup_from_till, lotto_reserve_note)
     values ('CST-E', 'A_E', 'S_E', 'cstore', $1, 'closed', now() - interval '30 hours', now() - interval '26 hours', 300, 450, 0, $2)`,
    [d, HOSTILE],
  );
  await owner.query("insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, card_total_sales, misc_notes) values ('SL_E', 'CST-E', 'S_E', 'cstore', $1, 600, 900, $2)", [d, HOSTILE]);
  await owner.query(
    `insert into ops.cash_handovers (handover_id, from_staff_id, to_staff_id, amount, handed_on, recorded_by, recorded_at, method, status, notes)
     values ('H_E', 'S_E', 'S_M', 100, $1, 'S_M', now(), 'cash', 'recorded', $2)`,
    [today(), HOSTILE],
  );
  await owner.query("insert into ops.cash_handover_items (item_id, handover_id, session_id, amount) values ('I_E', 'H_E', 'CST-E', 100)");
  await owner.query(
    `insert into ops.validation_results (validation_id, business_date, companies, cashier_card, clover_card, cash_counted, cash_variance, status, mode, validated_at, cash_sales)
     values ('VR_E', $1, 'cstore', 900, null, 600, 0, 'OK', 'auto', now(), 600)`,
    [d],
  );
}

/** The template's one inline script, as the HTML parser sees it: from <script> to the FIRST </script>. */
function scriptOf(html: string): string {
  const open = /<script\b[^>]*>/i.exec(html);
  if (!open) throw new Error("no script");
  const start = open.index + open[0].length;
  const end = html.slice(start).search(/<\/script/i);
  return html.slice(start, start + end);
}
function dataOf(html: string): any {
  const m = /var DATA = ([^\n]*);[ \t]*\n/.exec(scriptOf(html)); // [^\n], not ".": a planted U+2028 is a line terminator to "."
  if (!m) throw new Error("no DATA line");
  return JSON.parse(m[1]!);
}
/** Run the page's own script, unchanged, against a stub document; what it wrote into #app. */
function render(html: string): { html: string; threw: unknown } {
  const app = { innerHTML: "" };
  let threw: unknown = null;
  try {
    runInNewContext(scriptOf(html), {
      document: { getElementById: () => app, querySelector: () => ({ scrollLeft: 0, scrollWidth: 2000, clientWidth: 360 }) },
      console: { log() {}, error() {} },
    });
  } catch (e) {
    threw = e;
  }
  return { html: app.innerHTML, threw };
}

// ── inlineJson ────────────────────────────────────────────

describe("inlineJson (the port of inlineJson_)", () => {
  it("writes < as \\u003c and nothing else changes: it parses back to the same value", () => {
    const v = { note: EVIL, markup: "Paid a winner <b>$900</b> & topped up", ls: "a\u2028b\u2029c", n: [1, null, -2.5], long: LONG };
    const out = inlineJson(v);
    expect(out).not.toContain("<");
    expect(out).toContain("\\u003c/script>");
    expect(JSON.parse(out)).toEqual(v);
    expect(new Function(`return ${out};`)()).toEqual(v);
    expect(out).toBe(JSON.stringify(v).replace(/</g, "\\u003c"));
  });

  it("so no </script, <script or <!-- can appear in it, in any case", () => {
    const out = inlineJson({ a: "</SCRIPT>", b: "<Script>", c: "<!--", d: "< /script>" });
    expect(out).not.toMatch(/<\/?script|<!--/i);
  });

  it("U+2028 and U+2029 are left as they are (as the old function did): legal in a script since ES2019, and they cannot end one", () => {
    const out = inlineJson({ s: "\u2028\u2029" });
    expect(out).toContain("\u2028");
    expect(new Function(`return ${out};`)()).toEqual({ s: "\u2028\u2029" });
  });
});

// ── renderPublicPage ──────────────────────────────────────

describe("renderPublicPage", () => {
  it("is the template with the inlined payload at its one tag, and the old title", () => {
    const t = PUBLIC_TEMPLATES.recon;
    const html = pages.renderPublicPage("recon", t, { days: 14, note: EVIL });
    expect(html).toContain('var DATA = {"days":14,"note":"\\u003c/script>');
    expect(html).toContain("<title>StoreOps · 14-day report</title>");
    expect(html).not.toContain("<?");
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(html.replace("<title>StoreOps · 14-day report</title>", "<title>StoreOps · 7-day report</title>")).toBe(t.before + inlineJson({ days: 14, note: EVIL }) + t.after);
  });

  it("the sales page keeps its own title", () => {
    const html = pages.renderPublicPage("sales", PUBLIC_TEMPLATES.sales, { days: 60 });
    expect(html).toContain("<title>StoreOps · sales</title>");
  });

  it("the payload lands in parseable JavaScript (template-guard)", () => {
    for (const view of ["recon", "sales"] as const) {
      const html = pages.renderPublicPage(view, PUBLIC_TEMPLATES[view], { days: 1, x: "</script>" });
      expect(() => new Function(scriptOf(html).replace(/\(function (render|main)\(\)[\s\S]*$/, ""))).not.toThrow();
      expect(dataOf(html)).toEqual({ days: 1, x: "</script>" });
    }
  });
});

// ── days ──────────────────────────────────────────────────

describe("the days parameter: coerced, then clamped (publicReconPage_ / publicSalesPage_)", () => {
  const cases: [string | null, number, number][] = [
    // raw, recon, sales
    [null, 7, 60],
    ["", 7, 60],
    ["7", 7, 7],
    ["14", 14, 14],
    ["9999", 31, 365],
    ["0", 1, 1],
    ["-5", 1, 1],
    ["abc", 7, 60],
    ["2.5", 3, 3],
    ["2.4", 2, 2],
    [" 12 ", 12, 12],
    ["1e9", 31, 365],
    ["Infinity", 31, 365],
    ["-Infinity", 1, 1],
    ["0x10", 16, 16],
    ["NaN", 7, 60],
    ["31", 31, 31],
    ["32", 31, 32],
    ["366", 31, 365],
  ];
  it.each(cases)("days=%j → recon %d, sales %d", (raw, recon, sales) => {
    expect(pages.parseDays("recon", raw)).toBe(recon);
    expect(pages.parseDays("sales", raw)).toBe(sales);
  });
});

// ── routing ───────────────────────────────────────────────

describe("which page a URL serves (doGet)", () => {
  it.each([
    ["/?v=recon", "recon"],
    ["/?v=sales", "sales"],
    ["/?v=recon&v=sales", "recon"], // the first value, as Apps Script's e.parameter
    ["/?days=3&v=sales", "sales"],
  ])("%s → the %s page", (path, view) => {
    expect(pages.publicView(new Request(`https://ops.test${path}`))).toBe(view);
  });

  it.each(["/", "/?v=", "/?v=Sales", "/?v=RECON", "/?v=nonsense", "/?v=recon%20", "/?V=recon", "/index.html?v=recon", "/rpc/x?v=recon", "/health?v=sales", "//?v=recon"])("%s → not a public page", (path) => {
    expect(pages.publicView(new Request(`https://ops.test${path}`))).toBeNull();
  });

  it("only GET and HEAD reach a public page", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) expect(pages.publicView(new Request("https://ops.test/?v=recon", { method }))).toBeNull();
    expect(pages.publicView(new Request("https://ops.test/?v=recon", { method: "HEAD" }))).toBe("recon");
  });
});

describe("through the Worker", () => {
  beforeEach(plantHostile);

  it("?v=recon and ?v=sales serve their templates with the payload inlined; anything else is the app, as before", async () => {
    const recon = await (await get("/?v=recon")).text();
    expect(recon).toContain("<title>StoreOps · 7-day report</title>");
    expect(recon).toContain("Daily reconciliation");
    expect(dataOf(recon).days).toBe(7);
    const sales = await (await get("/?v=sales")).text();
    expect(sales).toContain("<title>StoreOps · sales</title>");
    expect(dataOf(sales).days).toBe(60);
    for (const path of ["/", "/?v=Sales", "/?v=nonsense", "/?v=", "/?x=recon"]) {
      const res = await get(path);
      expect(await res.text(), path).toBe(APP_PAGE);
      expect(res.headers.get("content-security-policy"), path).toBe("frame-ancestors 'none'");
    }
  });

  it("the window is clamped (routing.js)", async () => {
    const days = async (q: string) => dataOf(await (await get(`/?v=sales${q}`)).text()).days;
    expect(await days("&days=9999")).toBe(365);
    expect(await days("&days=0")).toBe(1);
    expect(await days("&days=-5")).toBe(1);
    expect(await days("&days=abc")).toBe(60);
    expect(await days("")).toBe(60);
    expect(dataOf(await (await get("/?v=recon&days=9999")).text()).days).toBe(31);
    expect(await (await get("/?v=recon&days=14")).text()).toContain("<title>StoreOps · 14-day report</title>");
  });

  it("the hostile note: one </script> per script block, nothing breaks out, and the planted strings come back unchanged", async () => {
    const res = await get("/?v=recon");
    expect(res.status).toBe(200);
    const html = await res.text();
    const templateScripts = (PUBLIC_TEMPLATES.recon.before + PUBLIC_TEMPLATES.recon.after).match(/<\/script/gi)!.length;
    expect(templateScripts).toBe(1);
    expect(html.match(/<\/script/gi)).toHaveLength(templateScripts);
    expect(html.match(/<script\b/gi)).toHaveLength(1);
    const script = scriptOf(html);
    expect(script).not.toContain("<!--");
    expect(script).not.toMatch(/<script/i);
    expect(html).not.toContain(EVIL);
    expect(html.indexOf("</script>")).toBeGreaterThan(html.indexOf(LONG)); // the script ends after the payload, at the template's own tag
    const data = dataOf(html);
    expect(data.cash.moves[0].notes).toBe(HOSTILE);
    expect(data.cash.moves[0].from).toBe(HOSTILE_NAME);
    expect(data.cash.holders[0].name).toBe(HOSTILE_NAME);
    expect(data.reserve.rows.find((r: any) => r.note).note).toBe(HOSTILE);
    // The page's own script, run as a browser would, escapes what it shows.
    const out = render(html);
    expect(out.threw).toBeNull();
    expect(out.html).toContain("Cash in hands");
    expect(out.html).toContain("Evil &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; Name");
    expect(out.html).not.toContain("<script");
  });

  it("the hostile note cannot reach the sales page at all, and the page's script still renders", async () => {
    const html = await (await get("/?v=sales")).text();
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(html).not.toContain("PWNED");
    expect(html).not.toContain(LONG);
    const data = dataOf(html);
    for (const k of ["staffName", "staffId", "sessionId", "salesId", "miscNotes", "rows"]) expect(JSON.stringify(data)).not.toContain(k);
    expect(data.totals.total).toBe(1500);
    const out = render(html);
    expect(out.threw).toBeNull();
    expect(out.html.trim().length).toBeGreaterThan(0);
    expect(out.html).not.toContain("failed to render");
    expect(out.html.match(/class="col"/g)).toHaveLength(data.daily.length);
  });

  it("both pages render the fixture-free empty store too (public-render: never blank)", async () => {
    for (const t of ["cash_handover_items", "cash_handovers", "validation_results", "sales", "till_sessions"]) await owner.query(`delete from ops.${t}`);
    for (const path of ["/?v=recon", "/?v=sales"]) {
      const out = render(await (await get(path)).text());
      expect(out.threw, path).toBeNull();
      expect(out.html.trim().length, path).toBeGreaterThan(0);
      expect(out.html, path).not.toContain("failed to render");
    }
  });

  it("the headers: secure()'s, plus html, no-store, noindex, no-referrer, and a policy that allows exactly the page's one script", async () => {
    for (const view of ["recon", "sales"]) {
      const res = await get(`/?v=${view}`);
      const html = await res.text();
      const hash = createHash("sha256").update(scriptOf(html), "utf8").digest("base64");
      const headers = Object.fromEntries([...res.headers.entries()].filter(([k]) => k !== "content-length"));
      expect(headers).toEqual({
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "content-security-policy": `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
  });

  it("the policy's hash is of THIS response's script: a different payload, a different hash", async () => {
    const a = (await get("/?v=recon&days=7")).headers.get("content-security-policy");
    const b = (await get("/?v=recon&days=8")).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });

  it("HEAD: the same status and headers, no body; POST, PUT, DELETE: what a non-GET on / gets today (405)", async () => {
    const head = await get("/?v=recon", envFor(), "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(head.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const plain = await get("/", envFor(), "POST");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await get("/?v=recon", envFor(), method);
      expect(res.status, method).toBe(405);
      expect(await res.text(), method).toBe(await plain.clone().text());
      expect(res.headers.get("content-security-policy"), method).toBe("frame-ancestors 'none'");
    }
  });

  it("reads nothing from the request but its method and URL: no cookie, no token, no header, no body", async () => {
    const real = new Request("https://ops.test/?v=recon&days=5");
    const probe = new Proxy(real, {
      get(target, prop) {
        if (prop === "url" || prop === "method") return Reflect.get(target, prop);
        throw new Error(`the public route read request.${String(prop)}`);
      },
    });
    const res = await worker.fetch(probe as Request, envFor());
    expect(res.status).toBe(200);
    expect(dataOf(await res.text()).days).toBe(5);
  });

  it("no other query parameter changes the payload", async () => {
    const strip = (d: any) => ({ ...d, generatedAt: null });
    const plain = strip(dataOf(await (await get("/?v=recon&days=7")).text()));
    const noisy = strip(dataOf(await (await get("/?v=recon&days=7&staffId=S_E&token=abc&limit=1000&from=2020-01-01&company=vape&page=2")).text()));
    expect(noisy).toEqual(plain);
    const s1 = strip(dataOf(await (await get("/?v=sales")).text()));
    const s2 = strip(dataOf(await (await get("/?v=sales&staffId=S_E&company=vape&pageSize=500&startDate=2020-01-01")).text()));
    expect(s2).toEqual(s1);
  });

  it("an app-page request still opens no database connection", async () => {
    let touched = 0;
    const env = {
      ASSETS: assets,
      get OPS_DB_APP_URL() {
        touched++;
        return testDb.appUrl;
      },
    };
    await get("/", env);
    await get("/?v=nonsense", env);
    expect(touched).toBe(0);
    await get("/?v=recon", env);
    expect(touched).toBe(1);
  });
});

// ── handlePublic: the transaction, the connection, the fallback ─

describe("handlePublic", () => {
  beforeEach(plantHostile);
  const NOW = new Date("2026-11-20T15:30:00Z");

  /** A connection whose statements and close are recorded. */
  const recorded = async () => {
    const inner = await connect(testDb.appUrl);
    const sql: string[] = [];
    let closed = 0;
    const conn = {
      query: (t: string, p?: readonly unknown[]) => (sql.push(t), inner.query(t, p)),
      one: (t: string, p?: readonly unknown[]) => (sql.push(t), inner.one(t, p)),
      maybeOne: (t: string, p?: readonly unknown[]) => (sql.push(t), inner.maybeOne(t, p)),
      close: async () => {
        closed++;
        await inner.close();
      },
    } as Db & { close(): Promise<void> };
    return { conn, sql, closed: () => closed };
  };

  const call = async (path: string, over: Partial<pages.PublicDeps> = {}) => {
    const logs: Record<string, unknown>[] = [];
    const rec = await recorded();
    const out = await pages.handlePublic(new Request(`https://ops.test${path}`), {}, { openDb: async () => rec.conn, now: () => NOW, log: (e) => logs.push(e), ...over });
    return { ...out, logs, rec, html: await out.response.text() };
  };

  it("one connection, one read-only transaction around the whole build, then the connection closed", async () => {
    for (const [path, queries] of [["/?v=recon", 11], ["/?v=sales", 3]] as const) {
      const r = await call(path);
      expect(r.response.status).toBe(200);
      expect(r.rec.sql[0]).toBe("begin transaction read only");
      expect(r.rec.sql[r.rec.sql.length - 1]).toBe("commit");
      // config + the build's own queries (public-report.test.ts pins those): none per row.
      expect(r.rec.sql.length - 2, path).toBe(queries);
      expect(r.rec.closed()).toBe(1);
      expect(r.logs).toEqual([]);
    }
  });

  it("a write attempted inside the public build fails, nothing is written, and the page is the fallback", async () => {
    const before = await owner.one<{ n: number }>("select count(*)::int as n from ops.audit_log");
    const writer: pages.Builder = async (tx) => {
      await tx.query("insert into ops.audit_log (log_id, action) values ('L_PUBLIC_WRITE', 'public.write')");
      return { days: 7 };
    };
    const r = await call("/?v=recon", { build: { recon: writer } });
    expect(r.response.status).toBe(503);
    expect(r.html).toContain("Report temporarily unavailable.");
    expect(await owner.one<{ n: number }>("select count(*)::int as n from ops.audit_log")).toEqual(before);
    expect(r.rec.sql).toContain("rollback");
    expect(r.rec.closed()).toBe(1);
    expect(r.logs).toEqual([{ event: "public_page.failed", view: "recon", errorClass: "DbError", message: "database error (25006)" }]);
  });

  it("withReadOnlyTransaction: a write is refused by the database (SQLSTATE 25006, read-only transaction)", async () => {
    await expect(pages.withReadOnlyTransaction(db, (tx) => tx.query("update ops.staff set name = 'x'"))).rejects.toMatchObject({ code: "25006" });
    expect((await db.query<{ name: string }>("select name from ops.staff where staff_id = 'S_M'"))[0]!.name).toBe("Morgan Fictional");
    // and the connection is usable afterwards (the transaction was ended)
    expect(await db.one<{ one: number }>("select 1 as one")).toEqual({ one: 1 });
  });

  it("the build throws: the old fallback page (503), one log line, and no message, stack, table or value in the response", async () => {
    const boom: pages.Builder = async () => {
      throw new Error('relation "ops.staff_secret" at value 14165550123 SECRET-STACK');
    };
    for (const view of ["recon", "sales"] as const) {
      const r = await call(`/?v=${view}&days=9`, { build: { [view]: boom } });
      expect(r.response.status).toBe(503);
      // The response is exactly the template around the old fallback payload: nothing else in it.
      expect(r.html).toBe(pages.renderPublicPage(view, PUBLIC_TEMPLATES[view], pages.fallbackPayload(view, 9)));
      expect(r.html).not.toMatch(/staff_secret|14165550123|SECRET|relation|at value/);
      expect(r.logs).toEqual([{ event: "public_page.failed", view, errorClass: "Error", message: 'relation "ops.staff_secret" at value 14165550123 SECRET-STACK' }]);
      expect(r.rec.closed()).toBe(1);
      const data = dataOf(r.html);
      expect(data).toEqual(
        view === "recon"
          ? {
              days: 9,
              fromStr: "",
              toStr: "",
              generatedAt: "",
              reserve: { unavailable: "Report temporarily unavailable." },
              cash: { unavailable: "Report temporarily unavailable." },
              reconcile: { unavailable: "Report temporarily unavailable." },
            }
          : { days: 9, unavailable: "Report temporarily unavailable." },
      );
      const out = render(r.html);
      expect(out.threw).toBeNull();
      expect(out.html).toContain("Report temporarily unavailable.");
      expect(r.response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("no database (none configured, or it is down): the fallback, and nothing about the connection", async () => {
    const logs: Record<string, unknown>[] = [];
    const out = await pages.handlePublic(new Request("https://ops.test/?v=sales"), {}, {
      openDb: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432 postgres://ops_app:pw@db");
      },
      now: () => NOW,
      log: (e) => logs.push(e),
    });
    expect(out.response.status).toBe(503);
    const html = await out.response.text();
    expect(html).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|ops_app|postgres/);
    expect(dataOf(html)).toEqual({ days: 60, unavailable: "Report temporarily unavailable." });
    expect(logs).toHaveLength(1);
    // Through the Worker with nothing configured: the same.
    const res = await get("/?v=recon", { ASSETS: assets });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("Report temporarily unavailable.");
  });

  it("the connection is closed even when the build fails", async () => {
    const r = await call("/?v=sales", {
      build: {
        sales: async () => {
          throw new Error("x");
        },
      },
    });
    expect(r.rec.closed()).toBe(1);
  });
});
