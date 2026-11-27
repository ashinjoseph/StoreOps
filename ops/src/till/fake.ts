// A fake till, built from the contract (ops/contracts/till-api.v1.yaml 1.1.0), so every later card that
// reads the till can be tested without the real one. It is for tests, the docs and local runs.
//
//   const till = createFakeTill();
//   const client = createTillClient({ baseUrl: till.baseUrl, key: till.key, fetch: till.fetch,
//                                     sleep: till.clock.sleep, now: till.clock.now });
//
// It serves the contract's GET endpoints from an in-memory, FICTIONAL data set (invented store, people
// from scripts/docs/fixtures.js plus one invented stranger, invented figures). It makes no network
// request and imports nothing from `node:`: it runs in Node and in the Worker.
//
// In its normal state every answer validates against the contract (test/till-fake.test.ts proves it) and
// passes the arithmetic rules of ./rules, apart from the one day the contract itself allows to break them
// (FAKE_DAYS.toCheck: takings that do not add up to the total, the till's "To check" case).
//
// Switches (each stays on until `reset()`): down, slow, rateLimit, serverError, garbage, redirect, echoKey.
// `requests` records every request: method, URL, whether an Authorization header was sent, and the
// `redirect` mode asked for. NEVER the header's value.
import { daysBetween, isRealDay, torontoDay } from "./days";
import type {
  DailyRow,
  DailySalesAnswer,
  MethodTakings,
  Money,
  Person,
  PurchaseOrder,
  Product,
  SalesSummary,
  Shift,
  StaffMember,
  Store,
  Supplier,
  Takings,
} from "./types";
import { NIL_STAFF_ID } from "./types";

/** Staging's address (invented data): the fake answers as if it were this host. */
export const FAKE_BASE_URL = "https://staging--scarbromart-office.netlify.app/ops/v1";
/** An obviously fake key. */
export const FAKE_KEY = "test-key-not-real-0000";
/** The instant the fake's clock starts at: Friday 2026-11-27, 10:00 in Toronto. */
export const FAKE_START = "2026-11-27T15:00:00Z";

export const FAKE_STORE_ID = "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e01";
/** A store the key may NOT see: asking about it answers 403 forbidden_store. */
export const FAKE_HIDDEN_STORE_ID = "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e09";
const COMPANY_ID = "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e02";

/** The till's people. The first three match people in `scripts/docs/fixtures.js` by name; the fourth does not. */
export const FAKE_PEOPLE = {
  priya: { staff_id: "11111111-aaaa-4aaa-8aaa-000000000001", name: "Priya Nair" },
  daniel: { staff_id: "11111111-aaaa-4aaa-8aaa-000000000002", name: "Daniel Okafor" },
  maya: { staff_id: "11111111-aaaa-4aaa-8aaa-000000000003", name: "Maya Chen" },
  /** In the till's staff list, and NOT in Operations: "listed, never created". */
  casey: { staff_id: "11111111-aaaa-4aaa-8aaa-000000000004", name: "Casey Lindqvist" },
} as const satisfies Record<string, Person>;
const NOT_KNOWN: Person = { staff_id: NIL_STAFF_ID, name: "Not known" };

/** The days that hold the interesting cases (the fake's "today" is 2026-11-27). */
export const FAKE_DAYS = {
  /** A till row whose takings are 4.00 short of its total: the till's "To check". */
  toCheck: "2026-11-22",
  /** No shifts and no sales. */
  empty: "2026-11-23",
  /** One closed shift; its staff_takings include the nil uuid ("Not known"). */
  closedWithNotKnown: "2026-11-24",
  /** All three channels in daily sales; a closed shift with door cash; an auto_closed shift with nothing counted. */
  allChannels: "2026-11-25",
  /** One shift still open. */
  open: "2026-11-26",
} as const;

// ── Figures ────────────────────────────────────────────────

const cents = (n: number): Money => Math.round(n * 100) / 100;
const method = (sales: number, refunds = 0): MethodTakings => ({ sales_total: cents(sales), refunds_total: cents(refunds), net_total: cents(sales + refunds) });
const takings = (t: { cash?: [number, number?]; credit?: [number, number?]; debit?: [number, number?]; etransfer?: [number, number?]; other?: [number, number?] }): Takings => ({
  cash: method(...(t.cash ?? [0])),
  credit: method(...(t.credit ?? [0])),
  debit: method(...(t.debit ?? [0])),
  etransfer: method(...(t.etransfer ?? [0])),
  other: method(...(t.other ?? [0])),
});
const summary = (s: { count: number; refund_count?: number; subtotal: number; discount?: number; surcharge?: number; rounding?: number; hst: number }): SalesSummary => {
  const discount = s.discount ?? 0;
  const net = cents(s.subtotal - discount);
  const surcharge = s.surcharge ?? 0;
  const rounding = s.rounding ?? 0;
  return { count: s.count, refund_count: s.refund_count ?? 0, subtotal: cents(s.subtotal), discount: cents(discount), net, surcharge: cents(surcharge), rounding: cents(rounding), hst: cents(s.hst), total: cents(net + surcharge + s.hst + rounding) };
};
const NOTHING = summary({ count: 0, subtotal: 0, hst: 0 });

function shift(over: Partial<Shift> & Pick<Shift, "shift_id" | "register" | "device_name" | "business_day" | "opened_at" | "opened_by" | "status">): Shift {
  return {
    z_number: null,
    closed_at: null,
    closed_by: null,
    opening_float: 100,
    expected: null,
    counted: null,
    variance: null,
    close_note: null,
    cash_moves: { paid_in: 0, paid_out: 0, no_sale_count: 0 },
    door_cash: { orders: 0, total: 0 },
    takings: takings({}),
    sales_summary: NOTHING,
    staff_takings: [],
    last_corrected_at: null,
    ...over,
  };
}

function defaultShifts(): Record<string, Shift[]> {
  const A = summary({ count: 3, refund_count: 1, subtotal: 100, discount: 5, surcharge: 1, hst: 12.35 });
  const B = summary({ count: 2, subtotal: 60, hst: 7.8 });
  return {
    [FAKE_DAYS.closedWithNotKnown]: [
      shift({
        shift_id: "22222222-bbbb-4bbb-8bbb-000000000001",
        z_number: 41,
        register: "T1",
        device_name: "Counter one",
        business_day: FAKE_DAYS.closedWithNotKnown,
        opened_at: "2026-11-24T14:00:00Z",
        opened_by: { ...FAKE_PEOPLE.maya },
        closed_at: "2026-11-24T23:05:00Z",
        closed_by: { ...FAKE_PEOPLE.maya },
        status: "closed",
        opening_float: 100,
        expected: 158.35,
        counted: 158,
        variance: -0.35,
        cash_moves: { paid_in: 0, paid_out: 0, no_sale_count: 2 },
        takings: takings({ cash: [63.35, -5], credit: [50] }),
        sales_summary: A,
        staff_takings: [
          { ...FAKE_PEOPLE.maya, count: 2, net: 70 },
          { ...NOT_KNOWN, count: 1, net: 25 },
        ],
      }),
    ],
    [FAKE_DAYS.allChannels]: [
      shift({
        shift_id: "22222222-bbbb-4bbb-8bbb-000000000002",
        z_number: 42,
        register: "T1",
        device_name: "Counter one",
        business_day: FAKE_DAYS.allChannels,
        opened_at: "2026-11-25T14:00:00Z",
        opened_by: { ...FAKE_PEOPLE.daniel },
        closed_at: "2026-11-25T23:04:11Z",
        closed_by: { ...FAKE_PEOPLE.daniel },
        status: "closed",
        opening_float: 100,
        // float 100 + cash 20.00 + door cash 28.25
        expected: 148.25,
        counted: 148.25,
        variance: 0,
        door_cash: { orders: 1, total: 28.25 },
        takings: takings({ cash: [20], debit: [47.8] }),
        sales_summary: B,
        staff_takings: [{ ...FAKE_PEOPLE.daniel, count: 2, net: 60 }],
      }),
      // Closed by the till itself after 24 hours: nothing counted. `counted` is empty, never 0.
      shift({
        shift_id: "22222222-bbbb-4bbb-8bbb-000000000003",
        z_number: null,
        register: "T2",
        device_name: "Counter two",
        business_day: FAKE_DAYS.allChannels,
        opened_at: "2026-11-25T15:00:00Z",
        opened_by: { ...FAKE_PEOPLE.casey },
        closed_at: "2026-11-26T15:00:00Z",
        closed_by: null,
        status: "auto_closed",
        opening_float: 50,
        door_cash: { orders: 2, total: 56.5 },
      }),
    ],
    [FAKE_DAYS.open]: [
      shift({
        shift_id: "22222222-bbbb-4bbb-8bbb-000000000004",
        register: "T1",
        device_name: "Counter one",
        business_day: FAKE_DAYS.open,
        opened_at: "2026-11-26T14:00:00Z",
        opened_by: { ...FAKE_PEOPLE.maya },
        status: "open",
        opening_float: 100,
        takings: takings({ cash: [12] }),
        sales_summary: summary({ count: 1, subtotal: 10.62, hst: 1.38 }),
        staff_takings: [{ ...FAKE_PEOPLE.maya, count: 1, net: 10.62 }],
      }),
    ],
  };
}

function defaultSales(): DailyRow[] {
  const till22 = summary({ count: 2, subtotal: 80, hst: 10.4 }); // total 90.40
  return [
    // The takings (86.40) fall 4.00 short of the total (90.40): the till keeps the sale and flags it.
    { business_day: FAKE_DAYS.toCheck, channel: "till", sales_summary: till22, takings: takings({ cash: [50.4], debit: [36] }) },
    { business_day: FAKE_DAYS.closedWithNotKnown, channel: "till", sales_summary: summary({ count: 3, refund_count: 1, subtotal: 100, discount: 5, surcharge: 1, hst: 12.35 }), takings: takings({ cash: [63.35, -5], credit: [50] }) },
    { business_day: FAKE_DAYS.allChannels, channel: "till", sales_summary: summary({ count: 2, subtotal: 60, hst: 7.8 }), takings: takings({ cash: [20], debit: [47.8] }) },
    { business_day: FAKE_DAYS.allChannels, channel: "online", sales_summary: summary({ count: 1, subtotal: 20, hst: 2.6 }), takings: takings({ etransfer: [22.6] }) },
    {
      business_day: FAKE_DAYS.allChannels,
      channel: "delivery",
      sales_summary: summary({ count: 1, subtotal: 25, hst: 3.25 }),
      takings: takings({ cash: [28.25] }),
      delivery: { orders: 1, fees: 5 },
    },
  ];
}

function defaultStores(): Store[] {
  return [{ store_id: FAKE_STORE_ID, code: "FIC1", name: "Fictional Corner Store", active: true, company_id: COMPANY_ID, company_code: "vape" }];
}

function defaultStaff(): StaffMember[] {
  return [
    { staff_id: FAKE_PEOPLE.priya.staff_id, display_name: FAKE_PEOPLE.priya.name, role: "owner", active: true, all_stores: true, store_ids: [], has_pin: true },
    { staff_id: FAKE_PEOPLE.daniel.staff_id, display_name: FAKE_PEOPLE.daniel.name, role: "store_manager", active: true, all_stores: false, store_ids: [FAKE_STORE_ID], has_pin: true },
    { staff_id: FAKE_PEOPLE.maya.staff_id, display_name: FAKE_PEOPLE.maya.name, role: "cashier", active: true, all_stores: false, store_ids: [FAKE_STORE_ID], has_pin: false },
    { staff_id: FAKE_PEOPLE.casey.staff_id, display_name: FAKE_PEOPLE.casey.name, role: "cashier", active: false, all_stores: false, store_ids: [FAKE_STORE_ID], has_pin: false },
  ];
}

function defaultProducts(): Product[] {
  return [
    {
      sku: "YV-10001",
      name: "Mango Ice 10ml",
      product: "Fictional Juice",
      barcode: "0123456789012",
      barcode_aliases: [],
      active: true,
      sku_pending: false,
      suppliers: [
        { vendor: "ACME", their_code: "AC-77", their_name: "Mango Ice", pieces: 10, preferred: true },
        { vendor: "BETA", their_code: "BT-5", their_name: "Mango Ice 10", pieces: 12, preferred: false },
      ],
    },
    { sku: "YV-10002", name: "Cool Mint 10ml", product: "Fictional Juice", barcode: "0123456789036", barcode_aliases: ["0123456789043"], active: true, sku_pending: false, suppliers: [{ vendor: "ACME", their_code: "AC-78", their_name: "Cool Mint", pieces: 10, preferred: true }] },
    { sku: "TMP-0001", name: "Berry Blast 10ml", product: "Fictional Juice", barcode: null, barcode_aliases: [], active: false, sku_pending: true, suppliers: [] },
  ];
}

function defaultSuppliers(): Supplier[] {
  return [
    { vendor: "ACME", name: "Acme Wholesale (fictional)", active: true },
    { vendor: "BETA", name: "Beta Imports (fictional)", active: true },
  ];
}

function defaultOrders(): PurchaseOrder[] {
  return [
    {
      order: "PO-0003",
      vendor: "ACME",
      status: "sent",
      created_at: "2026-11-20T15:00:00Z",
      sent_at: "2026-11-20T16:00:00Z",
      arrived_at: null,
      lines: [
        { sku: "YV-10001", name: "Mango Ice 10ml", cartons: 2, pieces: 10, ordered_pieces: 20, their_code: "AC-77" },
        { sku: "TMP-0001", name: "Berry Blast 10ml", cartons: 1, pieces: 10, ordered_pieces: 10, their_code: null },
      ],
    },
  ];
}

// ── A clock that never really waits ────────────────────────

export interface FakeClock {
  /** Pass as the client's `now`. */
  now(): Date;
  /** Pass as the client's `sleep`: resolves after `ms` of virtual time, or at once when `signal` aborts. Never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** The `ms` of every sleep asked for WITHOUT a signal: what the client waited for (a Retry-After). */
  readonly waits: number[];
  /** The `ms` of every sleep asked for WITH a signal: each request's deadline. */
  readonly deadlines: number[];
  /** As `sleep`, but recorded in neither list: what the fake till itself spends (`slow`). */
  delay(ms: number, signal?: AbortSignal): Promise<void>;
  /** Moves time on by hand and fires what falls due. */
  advance(ms: number): Promise<void>;
  /**
   * When true (the default), time jumps to the next timer by itself as soon as nothing else is running,
   * so an awaited `sleep` costs no real time. Set false to move time only with `advance`.
   */
  auto: boolean;
}

export function createFakeClock(start: string | Date = FAKE_START): FakeClock {
  let t = new Date(start).getTime();
  let seq = 0;
  const timers: Array<{ at: number; seq: number; fire: () => void }> = [];
  let scheduled = false;

  const next = (): void => {
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const due = timers.shift();
    if (due === undefined) return;
    t = Math.max(t, due.at);
    due.fire();
  };
  const schedule = (): void => {
    if (scheduled || !clock.auto || timers.length === 0) return;
    scheduled = true;
    // One real macrotask turn lets everything already in flight finish first.
    setTimeout(() => {
      scheduled = false;
      if (!clock.auto) return;
      next();
      schedule();
    }, 0);
  };

  const clock: FakeClock = {
    auto: true,
    waits: [],
    deadlines: [],
    now: () => new Date(t),
    sleep(ms, signal) {
      (signal === undefined ? clock.waits : clock.deadlines).push(ms);
      return clock.delay(ms, signal);
    },
    delay(ms, signal) {
      return new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const timer = { at: t + Math.max(0, ms), seq: seq++, fire: resolve };
        timers.push(timer);
        signal?.addEventListener(
          "abort",
          () => {
            const i = timers.indexOf(timer);
            if (i >= 0) timers.splice(i, 1);
            resolve();
          },
          { once: true },
        );
        schedule();
      });
    },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const first = timers[0];
        if (first === undefined || first.at > target) break;
        next();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      t = target;
    },
  };
  return clock;
}

// ── The fake till ──────────────────────────────────────────

export interface FakeRequest {
  method: string;
  url: string;
  /** Whether an Authorization header was sent. Its value is never kept. */
  hasAuthorization: boolean;
  /** The `redirect` mode the caller asked for (null when none). */
  redirect: string | null;
}

export interface FakeTillOptions {
  /** The key the fake accepts. Default FAKE_KEY. */
  key?: string;
  /** The address the fake answers as. Default FAKE_BASE_URL. */
  baseUrl?: string;
  /** The clock (for `slow` and for "today"). Default a new one starting at FAKE_START. */
  clock?: FakeClock;
}

export interface FakeSwitches {
  down: boolean;
  slowMs: number | null;
  /** How many more requests answer 429. */
  rateLimited: number;
  /** The Retry-After header of those answers; undefined sends none. */
  retryAfter: string | undefined;
  serverError: boolean;
  garbage: boolean;
  redirectTo: string | null;
  echoKey: boolean;
}

/** What the fake serves. Change it freely in a test (it is copied into every answer). */
export interface FakeData {
  stores: Store[];
  /** Stores the key may see. */
  visibleStoreIds: string[];
  staff: StaffMember[];
  /** Shifts by business day. */
  shifts: Record<string, Shift[]>;
  /** Daily rows, in day then channel order. */
  sales: DailyRow[];
  products: Product[];
  suppliers: Supplier[];
  orders: PurchaseOrder[];
}

export interface FakeTill {
  /** A `fetch`-shaped function that serves the contract's GETs. */
  fetch: typeof fetch;
  requests: FakeRequest[];
  state: { data: FakeData; switches: FakeSwitches };
  clock: FakeClock;
  baseUrl: string;
  key: string;
  /** Every request fails as if the network were down. */
  down(): void;
  /** Every answer takes `ms` of the clock's time (a caller's deadline may fall first). */
  slow(ms: number): void;
  /** The next `n` requests answer 429, with this Retry-After (seconds, or an HTTP date as text; undefined sends none). */
  rateLimit(n: number, retryAfter?: number | string): void;
  /** Every request answers 500. */
  serverError(): void;
  /** Every request answers 200 with text that is not JSON. */
  garbage(): void;
  /** Every request answers 302 to `to`. A caller that follows it makes a second, recorded request. */
  redirect(to: string): void;
  /** Every request answers 500 with a message that quotes the Authorization header it received, and the key. */
  echoKey(): void;
  /** Switches off everything above and puts the data back. Does not clear `requests`. */
  reset(): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const noSwitches = (): FakeSwitches => ({ down: false, slowMs: null, rateLimited: 0, retryAfter: undefined, serverError: false, garbage: false, redirectTo: null, echoKey: false });
const defaultData = (): FakeData => ({
  stores: defaultStores(),
  visibleStoreIds: [FAKE_STORE_ID],
  staff: defaultStaff(),
  shifts: defaultShifts(),
  sales: defaultSales(),
  products: defaultProducts(),
  suppliers: defaultSuppliers(),
  orders: defaultOrders(),
});

export function createFakeTill(options: FakeTillOptions = {}): FakeTill {
  const key = options.key ?? FAKE_KEY;
  const baseUrl = (options.baseUrl ?? FAKE_BASE_URL).replace(/\/+$/, "");
  const base = new URL(baseUrl);
  const clock = options.clock ?? createFakeClock();
  const requests: FakeRequest[] = [];
  const state = { data: defaultData(), switches: noSwitches() };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
  const error = (status: number, code: string, message: string, headers: Record<string, string> = {}): Response => json(status, { error: { code, message } }, headers);
  const copy = <T>(v: T): T => structuredClone(v);

  /** The store a request names, or the answer that refuses it. */
  function storeOf(q: URLSearchParams): string | Response {
    const id = q.get("store_id");
    if (id === null || !UUID.test(id)) return error(400, "bad_request", "store_id is missing or is not a uuid");
    if (!state.data.visibleStoreIds.includes(id.toLowerCase())) return error(403, "forbidden_store", "this key may not see that store");
    return id.toLowerCase();
  }

  function route(path: string, q: URLSearchParams): Response {
    const today = torontoDay(clock.now());
    if (path === "/stores") return json(200, copy({ stores: state.data.stores.filter((s) => state.data.visibleStoreIds.includes(s.store_id)) }));
    if (!["/staff", "/shifts", "/sales/daily", "/products", "/suppliers", "/orders"].includes(path)) return error(404, "not_found", "no such endpoint");
    const store = storeOf(q);
    if (typeof store !== "string") return store;
    switch (path) {
      case "/staff":
        return json(200, copy({ store_id: store, staff: state.data.staff }));
      case "/shifts": {
        const day = q.get("day");
        if (!isRealDay(day)) return error(400, "bad_request", "day is missing or is not a date (YYYY-MM-DD)");
        if (day > today) return error(400, "bad_request", "day is after today");
        return json(200, copy({ store_id: store, business_day: day, shifts: state.data.shifts[day] ?? [] }));
      }
      case "/sales/daily": {
        const from = q.get("from");
        const to = q.get("to");
        if (!isRealDay(from) || !isRealDay(to)) return error(400, "bad_request", "from and to are required dates (YYYY-MM-DD)");
        if (from > to) return error(400, "bad_request", "from is after to");
        if (to > today) return error(400, "bad_request", "to is after today");
        if (daysBetween(from, to) > 91) return error(400, "bad_request", "at most 92 days per request");
        const days = state.data.sales.filter((r) => r.business_day >= from && r.business_day <= to);
        const answer: DailySalesAnswer = { store_id: store, from, to, days };
        return json(200, copy(answer));
      }
      case "/products":
        return json(200, copy({ store_id: store, products: state.data.products }));
      case "/suppliers":
        return json(200, copy({ store_id: store, suppliers: state.data.suppliers }));
      default: {
        const status = q.get("status");
        if (status !== null && status !== "open") return error(400, "bad_request", "status can only be open");
        return json(200, copy({ store_id: store, orders: state.data.orders }));
      }
    }
  }

  async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
    const redirect = init?.redirect ?? null;
    requests.push({ method, url, hasAuthorization: headers.has("authorization"), redirect });
    const sw = state.switches;

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new TypeError("Invalid URL");
    }
    // Only the till's own host exists. Anything else is a host that does not answer.
    if (target.origin !== base.origin) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    if (sw.down) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    if (sw.slowMs !== null) {
      await clock.delay(sw.slowMs, init?.signal ?? undefined);
      if (init?.signal?.aborted) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    }
    if (sw.redirectTo !== null) {
      const mode = init?.redirect ?? "follow";
      if (mode === "error") throw new TypeError("fetch failed: redirect");
      if (mode === "manual") return new Response(null, { status: 302, headers: { location: sw.redirectTo } });
      // Followed: a second request goes out, and the key goes with it (the worst case a real fetch could produce).
      requests.push({ method: "GET", url: sw.redirectTo, hasAuthorization: headers.has("authorization"), redirect });
      return json(200, {});
    }
    if (sw.rateLimited > 0) {
      sw.rateLimited--;
      return error(429, "rate_limited", "60 requests a minute per key", sw.retryAfter === undefined ? {} : { "retry-after": sw.retryAfter });
    }
    if (sw.echoKey) return error(500, "server_error", `internal error handling Authorization: ${headers.get("authorization") ?? "(none)"} (expected Bearer ${key})`);
    if (sw.serverError) return error(500, "server_error", "the till failed");
    if (sw.garbage) return new Response("<html><body>Bad gateway</body></html>", { status: 200, headers: { "content-type": "text/html" } });

    if (method !== "GET") return error(404, "not_found", "no such endpoint");
    const auth = headers.get("authorization");
    if (auth === null) return error(401, "unauthorized", "no key was sent");
    if (auth !== `Bearer ${key}`) return error(401, "unauthorized", "unknown, expired or revoked key");
    const prefix = base.pathname.replace(/\/+$/, "");
    if (target.pathname !== prefix && !target.pathname.startsWith(prefix + "/")) return error(404, "not_found", "no such endpoint");
    return route(target.pathname.slice(prefix.length) || "/", target.searchParams);
  }

  const till: FakeTill = {
    fetch: serve as typeof fetch,
    requests,
    state,
    clock,
    baseUrl,
    key,
    down: () => void (state.switches.down = true),
    slow: (ms) => void (state.switches.slowMs = ms),
    rateLimit: (n, retryAfter) => {
      state.switches.rateLimited = n;
      state.switches.retryAfter = retryAfter === undefined ? undefined : String(retryAfter);
    },
    serverError: () => void (state.switches.serverError = true),
    garbage: () => void (state.switches.garbage = true),
    redirect: (to) => void (state.switches.redirectTo = to),
    echoKey: () => void (state.switches.echoKey = true),
    reset: () => {
      state.switches = noSwitches();
      state.data = defaultData();
    },
  };
  return till;
}

