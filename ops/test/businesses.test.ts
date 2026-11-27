// The two businesses and their signs (card P5-12a). NEW in the Operations app (ADR-0023): these tests
// are the specification. Against a real database, through the REAL router and the merged contract, and
// the assistant's `businesses` tool through the MCP SDK's own client. Invented people, shops and numbers.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/sessions";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { Config } from "../src/lib/config";
import * as businesses from "../src/receipts/businesses";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import { createTestDb, type TestDb } from "./helpers/db";
import { jsonOf, makeKey, makeWorld, sdkClient, setConfig, type McpWorld } from "./helpers/mcp";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

const STAFF: Array<[string, string, string]> = [
  ["S_001", "Ada Quill", "admin"],
  ["S_002", "Bram Hale", "manager"],
  ["S_003", "Cleo Marsh", "employee"],
  ["S_004", "Dara Vance", "payroll_admin"],
  ["S_008", "Hana Park", "admin"],
];
const tokens: Record<string, string> = {};

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
beforeEach(async () => {
  for (const t of ["audit_log", "business_signs", "sessions", "config", "staff"]) await owner.query(`delete from ops.${t}`);
  await owner.query("update ops.businesses set legal_name = null, hst_number = null, notes = null, modified_by = null, modified_at = null");
  for (const [id, name, role] of STAFF) await owner.query("insert into ops.staff (staff_id, name, active, role) values ($1, $2, true, $3)", [id, name, role]);
  for (const [id] of STAFF) tokens[id] = (await createSession(db, id, Config.fromRows([]), new Date())).token;
});

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);
async function call(name: string, args: unknown[]): Promise<{ ok: boolean; result?: any; error?: { message: string } }> {
  const router = createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: {}, log: () => undefined });
  const res = await router(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
  return (await res.json()) as { ok: boolean; result?: any; error?: { message: string } };
}
const add = (input: Record<string, unknown>, who = "S_001") => call("rpcAddBusinessSign", [tokens[who], input]);
const signRows = () => owner.query<any>("select sign_id, business, kind, value, value_key, supplier, learnt_from, added_by, removed_by, removed_at from ops.business_signs order by added_at, sign_id");
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after" from ops.audit_log order by seq`);

describe("the contract", () => {
  it("the seven RPCs of this card are listed with their roles, each needing a session", () => {
    const roles = Object.fromEntries(
      ["rpcGetReceiptInbox", "rpcSetReceiptAside", "rpcSetReceiptBusiness", "rpcGetBusinesses", "rpcUpdateBusiness", "rpcAddBusinessSign", "rpcRemoveBusinessSign"].map((n) => [n, contract.get(n) === undefined ? "missing" : contract.get(n)!.roles]),
    );
    expect(roles).toEqual({
      rpcGetReceiptInbox: null,
      rpcSetReceiptAside: ["admin", "manager"],
      rpcSetReceiptBusiness: ["admin", "manager"],
      rpcGetBusinesses: ["admin", "manager", "payroll_admin"],
      rpcUpdateBusiness: ["admin"],
      rpcAddBusinessSign: ["admin"],
      rpcRemoveBusinessSign: ["admin"],
    });
    for (const n of Object.keys(roles)) expect(contract.get(n)?.needs_session).toBe(true);
  });
});

describe("reading", () => {
  it("the two seeded businesses, blank until typed, with the setting's display name", async () => {
    await owner.query("insert into ops.config (key, value) values ('cstore_business_name', 'Fictional Corner')");
    const r = await call("rpcGetBusinesses", [tokens["S_004"]]);
    expect(r.ok).toBe(true);
    expect(r.result.canEdit).toBe(false);
    expect(r.result.businesses).toEqual([
      { key: "cstore", displayName: "Fictional Corner", legalName: null, hstNumber: null, notes: null, modifiedBy: null, modifiedAt: null, signs: [] },
      { key: "vape", displayName: "YV Vape Shop", legalName: null, hstNumber: null, notes: null, modifiedBy: null, modifiedAt: null, signs: [] },
    ]);
    expect((await call("rpcGetBusinesses", [tokens["S_001"]])).result.canEdit).toBe(true);
    expect((await call("rpcGetBusinesses", [tokens["S_002"]])).result.canEdit).toBe(false);
  });

  it("who may: admin, manager, payroll admin; not an employee; not without a session", async () => {
    expect((await call("rpcGetBusinesses", [tokens["S_003"]])).error?.message).toMatch(/^FORBIDDEN/);
    expect((await call("rpcGetBusinesses", [""])).error?.message).toBe("NOT_LOGGED_IN");
  });

  it("the database holds exactly the two, and the app role cannot add or remove one", async () => {
    expect((await db.query<{ business: string }>("select business from ops.businesses order by 1")).map((r) => r.business)).toEqual(["cstore", "vape"]);
    await expect(db.query("insert into ops.businesses (business) values ('cstore')")).rejects.toMatchObject({ kind: "permission" });
    await expect(db.query("delete from ops.businesses where business = 'vape'")).rejects.toMatchObject({ kind: "permission" });
    await expect(db.query("delete from ops.business_signs")).rejects.toMatchObject({ kind: "permission" });
  });
});

describe("changing a business", () => {
  it("an admin sets the legal name, HST number (normalised) and notes; audited with before and after", async () => {
    const r = await call("rpcUpdateBusiness", [tokens["S_001"], { business: "vape", legalName: "  Fictional  Vapour Ltd. ", hstNumber: "123456789 rt 0001", notes: "Books with the\nfictional bookkeeper", actorId: "S_008" }]);
    expect(r.ok).toBe(true);
    expect(r.result.changed).toBe(true);
    expect(r.result.business).toMatchObject({ key: "vape", legalName: "Fictional Vapour Ltd.", hstNumber: "123456789RT0001", notes: "Books with the\nfictional bookkeeper", modifiedBy: "Ada Quill" });
    const [a] = await audits();
    expect(a).toMatchObject({ actor_id: "S_001", action: "business.update", target_type: "businesses", target_id: "vape" });
    expect(JSON.parse(a.before)).toEqual({ legalName: null, hstNumber: null, notes: null });
    expect(JSON.parse(a.after)).toEqual({ legalName: "Fictional Vapour Ltd.", hstNumber: "123456789RT0001", notes: "Books with the\nfictional bookkeeper" });
    // The same again: nothing changes, nothing audited.
    expect((await call("rpcUpdateBusiness", [tokens["S_001"], { business: "vape", legalName: "Fictional Vapour Ltd.", hstNumber: "123456789RT0001", notes: "Books with the\nfictional bookkeeper" }])).result.changed).toBe(false);
    expect(await audits()).toHaveLength(1);
    // Blank goes back to NULL.
    const cleared = await call("rpcUpdateBusiness", [tokens["S_001"], { business: "vape", legalName: "", hstNumber: " ", notes: "" }]);
    expect(cleared.result.business).toMatchObject({ legalName: null, hstNumber: null, notes: null });
  });

  it("every field rule", async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ business: "both" }, /cstore or vape/],
      [{ business: "cstore", legalName: "x" }, /at least 2/],
      [{ business: "cstore", legalName: "y".repeat(121) }, /at most 120/],
      [{ business: "cstore", legalName: "Two\nlines" }, /control/],
      [{ business: "cstore", legalName: 42 }, /must be text/],
      [{ business: "cstore", hstNumber: "12345678RT0001" }, /nine digits, RT, then four digits/],
      [{ business: "cstore", hstNumber: "123456789RP0001" }, /nine digits, RT/],
      [{ business: "cstore", hstNumber: "123456789RT001" }, /nine digits, RT/],
      [{ business: "cstore", hstNumber: "abcdefghiRT0001" }, /nine digits, RT/],
      [{ business: "cstore", notes: "z".repeat(501) }, /at most 500/],
      [{ business: "cstore", notes: "bell\u0007" }, /control/],
    ];
    for (const [input, message] of bad) {
      const r = await call("rpcUpdateBusiness", [tokens["S_001"], input]);
      expect(r.error?.message, JSON.stringify(input)).toMatch(message);
    }
    expect(await audits()).toEqual([]);
  });

  it("the two businesses cannot share an HST number", async () => {
    await call("rpcUpdateBusiness", [tokens["S_001"], { business: "cstore", hstNumber: "111222333RT0001" }]);
    const r = await call("rpcUpdateBusiness", [tokens["S_001"], { business: "vape", hstNumber: "111 222 333 RT 0001" }]);
    expect(r.error?.message).toMatch(/already belongs to cstore \(Scarbro Mart\)/);
    const sign = await add({ business: "vape", kind: "hst_number", value: "111222333-RT-0001" });
    expect(sign.error?.message).toMatch(/already belongs to cstore/);
  });

  it("who may: an admin only", async () => {
    for (const who of ["S_002", "S_003", "S_004"]) {
      expect((await call("rpcUpdateBusiness", [tokens[who], { business: "cstore", legalName: "Fictional" }])).error?.message, who).toMatch(/^FORBIDDEN/);
      expect((await add({ business: "cstore", kind: "card_last4", value: "1234" }, who)).error?.message, who).toMatch(/^FORBIDDEN/);
      expect((await call("rpcRemoveBusinessSign", [tokens[who], { id: "bs" + "0".repeat(20) }])).error?.message, who).toMatch(/^FORBIDDEN/);
    }
    expect(await signRows()).toEqual([]);
  });
});

describe("signs", () => {
  it("each kind is added, normalised for comparison, and audited", async () => {
    const a = await add({ business: "cstore", kind: "name", value: "  Fictional   Corner-Store  " });
    expect(a.ok).toBe(true);
    expect(a.result.sign).toMatchObject({ kind: "name", value: "Fictional Corner-Store", supplier: null, learntFrom: "typed", addedBy: "Ada Quill" });
    await add({ business: "cstore", kind: "hst_number", value: "987654321 rt 0002" });
    await add({ business: "vape", kind: "supplier_account", value: "AC-1029 33", supplier: "Fictional Wholesale Co" });
    await add({ business: "vape", kind: "card_last4", value: " 4821 " });
    const rows = await signRows();
    expect(rows.map((r) => [r.business, r.kind, r.value, r.value_key, r.supplier])).toEqual([
      ["cstore", "name", "Fictional Corner-Store", "fictionalcornerstore", null],
      ["cstore", "hst_number", "987654321RT0002", "987654321rt0002", null],
      ["vape", "supplier_account", "AC-1029 33", "fictionalwholesaleco|ac102933", "Fictional Wholesale Co"],
      ["vape", "card_last4", "4821", "4821", null],
    ]);
    const list = await call("rpcGetBusinesses", [tokens["S_002"]]);
    expect(list.result.businesses[1].signs.map((s: any) => [s.kind, s.value, s.supplier])).toEqual([
      ["supplier_account", "AC-1029 33", "Fictional Wholesale Co"],
      ["card_last4", "4821", null],
    ]);
    const adds = (await audits()).filter((x) => x.action === "business_sign.add");
    expect(adds).toHaveLength(4);
    expect(JSON.parse(adds[3].after)).toEqual({ business: "vape", kind: "card_last4", value: "4821", supplier: null });
  });

  it("every field rule", async () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ business: "cstore", kind: "logo", value: "x" }, /kind of sign/],
      [{ business: "nope", kind: "name", value: "Fictional" }, /cstore or vape/],
      [{ business: "cstore", kind: "name", value: "" }, /required/],
      [{ business: "cstore", kind: "name", value: "x" }, /at least 2/],
      [{ business: "cstore", kind: "name", value: "n".repeat(121) }, /at most 120/],
      [{ business: "cstore", kind: "name", value: "tab\there" }, /control/],
      [{ business: "cstore", kind: "card_last4", value: "123" }, /exactly four digits/],
      [{ business: "cstore", kind: "card_last4", value: "12345" }, /exactly four digits/],
      [{ business: "cstore", kind: "card_last4", value: "4111 1111 1111 1111" }, /exactly four digits/],
      [{ business: "cstore", kind: "card_last4", value: "12a4" }, /exactly four digits/],
      [{ business: "cstore", kind: "hst_number", value: "12345" }, /nine digits, RT/],
      [{ business: "cstore", kind: "supplier_account", value: "A1" }, /supplier's name is required/],
      [{ business: "cstore", kind: "supplier_account", value: "", supplier: "Fictional Co" }, /account number is required/],
      [{ business: "cstore", kind: "supplier_account", value: "a".repeat(61), supplier: "Fictional Co" }, /at most 60/],
      [{ business: "cstore", kind: "supplier_account", value: "A1", supplier: "s".repeat(81) }, /at most 80/],
      [{ business: "cstore", kind: "name", value: "- -" }, /nothing in it to compare/],
    ];
    for (const [input, message] of bad) expect((await add(input)).error?.message, JSON.stringify(input)).toMatch(message);
    expect(await signRows()).toEqual([]);
  });

  it("a sign cannot point at both businesses, however it is spaced, dashed or cased", async () => {
    await add({ business: "vape", kind: "card_last4", value: "4821" });
    await add({ business: "vape", kind: "name", value: "Fictional Vapour Ltd" });
    await add({ business: "vape", kind: "supplier_account", value: "AC-1029", supplier: "Fictional Wholesale" });
    const tries: Array<[Record<string, unknown>, RegExp]> = [
      [{ business: "cstore", kind: "card_last4", value: "4821" }, /^The card ending 4821 already belongs to vape \(YV Vape Shop\)\. A sign can belong to one business only: remove it there first\.$/],
      [{ business: "cstore", kind: "name", value: "FICTIONAL  vapour-LTD" }, /already belongs to vape/],
      [{ business: "cstore", kind: "name", value: "Fictional—Vapour Ltd" }, /already belongs to vape/], // an em dash
      [{ business: "cstore", kind: "supplier_account", value: "ac 1029", supplier: "fictional  WHOLESALE" }, /^Account ac 1029 at fictional WHOLESALE already belongs to vape/],
      [{ business: "vape", kind: "card_last4", value: "4821" }, /already listed for vape/],
    ];
    for (const [input, message] of tries) expect((await add(input)).error?.message, JSON.stringify(input)).toMatch(message);
    // The same account number at another supplier is another sign.
    expect((await add({ business: "cstore", kind: "supplier_account", value: "AC-1029", supplier: "Other Fictional Supply" })).ok).toBe(true);
    expect((await signRows()).filter((r) => r.business === "cstore").map((r) => r.kind)).toEqual(["supplier_account"]);
  });

  it("the database refuses the same live sign twice even past the code (partial unique index)", async () => {
    await add({ business: "vape", kind: "card_last4", value: "4821" });
    await expect(
      owner.query("insert into ops.business_signs (sign_id, business, kind, value, value_key, added_by, added_at) values ('bs00000000000000000001', 'cstore', 'card_last4', '4821', '4821', 'S_001', now())"),
    ).rejects.toMatchObject({ kind: "unique" });
  });

  it("two admins adding the same card to the two businesses at once: one wins, the other is told", async () => {
    const [a, b] = await Promise.all([add({ business: "cstore", kind: "card_last4", value: "7310" }, "S_001"), add({ business: "vape", kind: "card_last4", value: "7310" }, "S_008")]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((a.ok ? b : a).error?.message).toMatch(/already belongs to/);
    expect(await signRows()).toHaveLength(1);
  });

  it("removal keeps the row, is audited once, and frees the sign for the other business", async () => {
    const s = (await add({ business: "vape", kind: "card_last4", value: "4821" })).result.sign;
    const r = await call("rpcRemoveBusinessSign", [tokens["S_008"], { id: s.id }]);
    expect(r.result.removed).toBe(true);
    expect(r.result.business.signs).toEqual([]);
    expect((await call("rpcRemoveBusinessSign", [tokens["S_001"], { id: s.id }])).result.removed).toBe(false);
    const [row] = await signRows();
    expect(row).toMatchObject({ sign_id: s.id, business: "vape", value: "4821", removed_by: "S_008" });
    expect(row.removed_at).toBeInstanceOf(Date);
    expect((await audits()).filter((x) => x.action === "business_sign.remove")).toHaveLength(1);
    expect((await add({ business: "cstore", kind: "card_last4", value: "4821" })).ok).toBe(true);
    expect(await signRows()).toHaveLength(2);
    expect((await call("rpcRemoveBusinessSign", [tokens["S_001"], { id: "bs" + "f".repeat(20) }])).error?.message).toBe("No such sign.");
  });

  it("the app role may only mark a sign removed, never change what it says", async () => {
    const s = (await add({ business: "vape", kind: "card_last4", value: "4821" })).result.sign;
    await expect(db.query("update ops.business_signs set business = 'cstore' where sign_id = $1", [s.id])).rejects.toMatchObject({ kind: "permission" });
    await expect(db.query("update ops.business_signs set value = '0000' where sign_id = $1", [s.id])).rejects.toMatchObject({ kind: "permission" });
  });

  it("normalise and checkHst on their own", () => {
    expect(businesses.normalise("Ｆｉｃ  ti-onal–Co")).toBe("fictionalco");
    expect(businesses.signKey("supplier_account", "12-34", "Fictional Co")).toBe("fictionalco|1234");
    expect(businesses.checkHst("123456789 RT 0001")).toBe("123456789RT0001");
    expect(businesses.checkHst("")).toBeNull();
    expect(() => businesses.checkHst("123456789RT00011")).toThrow(/nine digits/);
  });

  it("a module call outside the router still takes the actor from its argument only", async () => {
    const out = await withTransaction(db, async (tx) => businesses.addSign(tx, { business: "cstore", kind: "name", value: "Fictional Corner", addedBy: "S_004" } as never, { staffId: "S_001" }, Config.fromRows([]), new Date()));
    expect(out.sign.addedBy).toBe("Ada Quill");
  });
});

describe("the assistant's businesses tool", () => {
  let w: McpWorld;
  beforeAll(async () => {
    w = await makeWorld(new Date("2026-11-27T15:00:00Z"));
  });
  afterAll(async () => {
    await w?.close();
  });

  it("each business with its key, display name, legal name, HST number and live signs, and nothing else", async () => {
    await setConfig(w, "assistants_enabled", "true");
    await setConfig(w, "vape_business_name", "Fictional Vapes");
    const now = w.clock.now;
    await withTransaction(w.db, async (tx) => {
      const config = Config.fromRows([]);
      await businesses.update(tx, { business: "vape", legalName: "Fictional Vapour Ltd.", hstNumber: "123456789RT0001" }, { staffId: "S_001" }, config, now);
      await businesses.addSign(tx, { business: "vape", kind: "card_last4", value: "4821" }, { staffId: "S_001" }, config, now);
      await businesses.addSign(tx, { business: "vape", kind: "supplier_account", value: "AC-1029", supplier: "Fictional Wholesale" }, { staffId: "S_001" }, config, now);
      const gone = await businesses.addSign(tx, { business: "cstore", kind: "name", value: "Removed Fictional Name" }, { staffId: "S_001" }, config, now);
      await businesses.removeSign(tx, { id: gone.sign.id }, { staffId: "S_001" }, config, now);
      await businesses.addSign(tx, { business: "cstore", kind: "name", value: "Fictional\u202e Corner" }, { staffId: "S_001" }, config, now).catch(() => undefined);
    });
    const client = await sdkClient(w, (await makeKey(w)).key);
    const data = jsonOf(await client.callTool({ name: "businesses", arguments: {} }));
    expect(Object.keys(data)).toEqual(["businesses"]);
    // Signs added in one instant come in no set order.
    for (const b of data["businesses"] as Array<{ signs: Array<{ kind: string }> }>) b.signs.sort((x, y) => x.kind.localeCompare(y.kind));
    expect(data["businesses"]).toEqual([
      { key: "cstore", name: "Scarbro Mart", legalName: null, hstNumber: null, signs: [] }, // the removed name is not shown; a name with a direction override was refused
      {
        key: "vape",
        name: "Fictional Vapes",
        legalName: "Fictional Vapour Ltd.",
        hstNumber: "123456789RT0001",
        signs: [
          { kind: "card_last4", value: "4821", supplier: null },
          { kind: "supplier_account", value: "AC-1029", supplier: "Fictional Wholesale" },
        ],
      },
    ]);
    const text = JSON.stringify(data);
    expect(text).not.toMatch(/S_00|Ada Quill|addedBy|added_at|sign_id|bs[0-9a-f]{20}|Removed Fictional/);
    await client.close();
  });
});
