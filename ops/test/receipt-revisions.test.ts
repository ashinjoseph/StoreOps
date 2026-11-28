// An updated invoice replaces the one it updates (card P5-18; the owner, Nov 28: "sometimes the wholesaler
// accepts the order and then later says some items are not in stock, so they send an updated invoice";
// "if no changes then nothing to change but if there is a delta, modify"). NEW in the Operations app
// (ADR-0023): these tests are its specification. A real database with the in-memory bucket; the RPCs
// through the REAL router and merged contract. Invented shops and figures only.
//
// The rule: a reading with the same supplier and invoice number as a receipt of the same business (on the
// books, or a draft not yet confirmed) is offered as its revision. Confirming it with `replaces` takes the
// old one off the books in the same step (voided with the reason, its original set aside; a draft's
// original is set aside) and puts the new one on. Same figures: a copy, not a revision; it is set aside.
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/sessions";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { TOOLS } from "../src/mcp/tools";
import { Config, loadConfig } from "../src/lib/config";
import * as businesses from "../src/receipts/businesses";
import * as drafts from "../src/receipts/drafts";
import * as originals from "../src/receipts/originals";
import * as review from "../src/receipts/review";
import { bucketStorage } from "../src/receipts/storage";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import { jsonOf, makeKey, makeWorld, sdkClient, setConfig, setDoor, textOf, type McpWorld } from "./helpers/mcp";

// 2026-11-27 10:00 in Toronto.
const NOW = new Date("2026-11-27T15:00:00.000Z");
let w: McpWorld;
const T: Record<string, string> = {};
const ADMIN = "S_001";
const MANAGER = "S_002";
const EMPLOYEE = "S_003";
const PAYROLL = "S_004";

beforeAll(async () => {
  w = await makeWorld(NOW);
});
afterAll(async () => {
  await w?.close();
});
beforeEach(async () => {
  w.clock.now = NOW;
  for (const t of ["price_flags", "item_costs", "receipt_observations", "supplier_items", "business_signs", "supplier_names", "purchase_receipt_lines", "purchase_receipts", "suppliers", "receipt_upload_tickets", "receipt_originals", "assistant_calls", "audit_log", "sessions", "config"]) {
    await w.owner.query(`delete from ops.${t}`);
  }
  await w.owner.query("update ops.staff set active = (staff_id <> 'S_005')");
  await setDoor(w, true);
  // Fictional display names for the two businesses (the settings cstore_business_name, vape_business_name).
  await setConfig(w, "cstore_business_name", "Fictional Corner Mart");
  await setConfig(w, "vape_business_name", "Fictional Vape Co");
  for (const id of [ADMIN, MANAGER, EMPLOYEE, PAYROLL]) T[id] = (await createSession(w.db, id, Config.fromRows([]), NOW)).token;
});

// ── Set-up helpers ────────────────────────────────────────

let serial = 0;
const tick = () => {
  w.clock.now = new Date(w.clock.now.getTime() + 1000);
};
async function original(opts: { business?: "cstore" | "vape" | null; by?: string } = {}): Promise<string> {
  tick();
  const bytes = new TextEncoder().encode(`%PDF-1.4\n% fictional receipt for review ${++serial} ${Math.random()}\n%%EOF\n`);
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const r = await withTransaction(w.db, (tx) =>
    originals.add(tx, bucketStorage(w.bucket), { bytes, sha256, contentType: "application/pdf", business: opts.business ?? null, source: "upload", fileName: `r${serial}.pdf`, note: null }, { staffId: opts.by ?? EMPLOYEE, role: "employee" }, w.clock.now),
  );
  return (r.record as { id: string }).id;
}
async function sign(business: string, kind: string, value: string, supplier?: string): Promise<string> {
  const r = await withTransaction(w.db, async (tx) => businesses.addSign(tx, { business, kind, value, supplier }, { staffId: ADMIN }, await loadConfig(tx), NOW));
  return r.sign.id;
}
const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);
type Answer = { ok: boolean; result?: any; error?: { message: string } };
async function rpc(name: string, args: unknown[]): Promise<Answer> {
  tick();
  const router = createRpcRouter({ contract, handlers, openDb: () => connect(w.testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: {}, now: () => w.clock.now, log: () => undefined });
  const res = await router(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
  return (await res.json()) as Answer;
}
/** The result, or a thrown error with the server's message. */
async function ok(name: string, args: unknown[]): Promise<any> {
  const r = await rpc(name, args);
  if (!r.ok) throw new Error(`${name}: ${r.error?.message}`);
  return r.result;
}
async function refused(name: string, args: unknown[]): Promise<string> {
  const r = await rpc(name, args);
  expect(r.ok, `${name} should be refused`).toBe(false);
  return r.error?.message ?? "";
}

const ASSISTANT = async (staffId = ADMIN): Promise<drafts.Reader> => ({ kind: "assistant", keyId: (await makeKey(w, { right: "propose", staffId })).keyId, staffId });
async function propose(input: Record<string, unknown>, reader: drafts.Reader, db: Db = w.db): Promise<drafts.ProposeResult> {
  tick();
  const now = w.clock.now;
  return withTransaction(db, async (tx) => drafts.propose(tx, input, reader, await loadConfig(tx), now));
}
async function newSupplier(name: string, by = MANAGER, extra: Record<string, unknown> = {}): Promise<string> {
  return (await ok("rpcCreateReceiptSupplier", [T[by], { displayName: name, ...extra }])).supplier.id;
}
const reviewOf = (id: string, by = MANAGER) => ok("rpcGetReceiptReview", [T[by], { id }]);
/** A correction: the draft's fields as the page sends them, the business (null: the signs), the supplier. */
async function correct(id: string, fields: Record<string, unknown>, opts: { business?: string | null; supplierId?: string | null; by?: string; draftId?: string | null } = {}): Promise<any> {
  const r = await reviewOf(id, opts.by ?? MANAGER);
  return ok("rpcSaveReceiptCorrection", [T[opts.by ?? MANAGER], { original_id: id, draft_id: opts.draftId === undefined ? r.draft.id : opts.draftId, business: opts.business ?? null, supplier_id: opts.supplierId ?? null, ...fields }]);
}
async function confirmIt(id: string, opts: { by?: string; reason?: string; learnSigns?: string[]; rememberSpelling?: boolean } = {}): Promise<Answer> {
  const r = await reviewOf(id, opts.by ?? MANAGER);
  return rpc("rpcConfirmReceipt", [T[opts.by ?? MANAGER], { originalId: id, draftId: r.draft?.id, reason: opts.reason, learnSigns: opts.learnSigns ?? [], rememberSpelling: opts.rememberSpelling ?? false }]);
}
const books = (business: string | null, more: Record<string, unknown> = {}, by = MANAGER) => rpc("rpcGetReceiptBooks", [T[by], { business, ...more }]);
const rows = () => w.owner.query<any>("select * from ops.purchase_receipts order by read_at, purchase_id");
const count = async (t: string) => (await w.owner.one<{ n: number }>(`select count(*)::int as n from ops.${t}`)).n;
const audits = (like: string) => w.owner.query<any>(`select actor_id, action, target_type, target_id, "before", "after" from ops.audit_log where action like $1 order by seq`, [like]);

/** A full receipt the person settles: every confirm requirement met. */
const FULL = (extra: Record<string, unknown> = {}) => ({
  supplier: { name: "Fictional Grocer" },
  invoice_number: "FG-1001",
  date: "2026-11-20",
  paid: { how: "card", card_last4: "4821" },
  amounts: { subtotal: "10.00", hst: "1.30", total: "11.30" },
  kind: "supplies",
  ...extra,
});
/** An original with a confirmed receipt of `business`, through the RPCs. */
async function onTheBooks(business: "cstore" | "vape", supplierId: string, extra: Record<string, unknown> = {}, by = MANAGER): Promise<{ originalId: string; receipt: any }> {
  const id = await original();
  await ok("rpcEnterReceiptDraft", [T[by], { original_id: id, ...FULL({ paid: { how: "cash" }, ...extra }) }]);
  await correct(id, FULL({ paid: { how: "cash" }, ...extra }), { business, supplierId, by });
  const c = await confirmIt(id, { by, reason: (extra["reason"] as string | undefined) ?? undefined });
  if (!c.ok) throw new Error(c.error?.message);
  return { originalId: id, receipt: c.result.receipt };
}

// ── Revisions ─────────────────────────────────────────────

const ORDER = (amounts: Record<string, string>, extra: Record<string, unknown> = {}) => ({ invoice_number: "FW-2001", supplier: { name: "Fictional Wholesale" }, amounts, kind: "stock", ...extra });
const FIRST = { subtotal: "100.00", hst: "13.00", total: "113.00" };
const UPDATED = { subtotal: "80.00", hst: "10.40", total: "90.40" };

/** An original read and corrected (business and supplier settled), not confirmed: its review. */
async function readOnly(amounts: Record<string, string>, supplierId: string, business: "cstore" | "vape" = "cstore", extra: Record<string, unknown> = {}): Promise<{ id: string; review: any }> {
  const id = await original();
  await ok("rpcEnterReceiptDraft", [T[MANAGER], { original_id: id, ...FULL({ paid: { how: "cash" }, ...ORDER(amounts, extra) }) }]);
  await correct(id, FULL({ paid: { how: "cash" }, ...ORDER(amounts, extra) }), { business, supplierId });
  return { id, review: await reviewOf(id) };
}
async function confirmReplacing(id: string, replaces: unknown, opts: { by?: string; reason?: string } = {}): Promise<Answer> {
  const r = await reviewOf(id, opts.by ?? MANAGER);
  return rpc("rpcConfirmReceipt", [T[opts.by ?? MANAGER], { originalId: id, draftId: r.draft?.id, reason: opts.reason, learnSigns: [], rememberSpelling: false, replaces }]);
}

describe("an updated invoice replaces the one it updates (card P5-18)", () => {
  it("one on the books: the review offers the revision; a manager confirms it replacing the old, which is voided with the reason and its original set aside; the books count only the new one", async () => {
    const ws = await newSupplier("Fictional Wholesale");
    const old = await onTheBooks("cstore", ws, ORDER(FIRST));
    const neu = await readOnly(UPDATED, ws);
    const rv = neu.review.confirm.revision;
    expect(rv).toMatchObject({ purchaseId: old.receipt.id, originalId: old.originalId, status: "confirmed", invoiceNumber: "FW-2001", total: "113.00", sameFigures: false, allowed: true, reasonNeeded: false });
    expect(rv.words).toMatch(/updated invoice/);
    // The duplicate check names a receipt on the books as one, not as a draft.
    expect(neu.review.confirm.failed.find((c: any) => c.check === "duplicate").words).toContain(`(on the books as receipt ${old.receipt.id}, cstore,`);
    // Without replacing, a manager still may not confirm a duplicate of a receipt on the books (as before).
    expect(neu.review.confirm.allowed).toBe(false);
    const c = await confirmReplacing(neu.id, old.receipt.id);
    expect(c.ok, c.error?.message).toBe(true);
    expect(c.result.message).toMatch(/replaces invoice FW-2001/);
    const all = await rows();
    const o = all.find((r: any) => r.purchase_id === old.receipt.id);
    const n = all.find((r: any) => r.purchase_id === c.result.receipt.id);
    expect(o).toMatchObject({ status: "voided", voided_by: MANAGER });
    expect(o.void_reason).toBe(`Replaced by an updated invoice (receipt ${n.purchase_id}).`);
    expect(n).toMatchObject({ status: "confirmed", replaces: old.receipt.id, confirm_reason: null });
    const origs = await w.owner.query<any>("select receipt_id, status, set_aside_reason, set_aside_by from ops.receipt_originals order by added_at");
    expect(origs.find((x: any) => x.receipt_id === old.originalId)).toMatchObject({ status: "set_aside", set_aside_reason: "Replaced by an updated invoice", set_aside_by: MANAGER });
    expect(origs.find((x: any) => x.receipt_id === neu.id)).toMatchObject({ status: "confirmed" });
    // No redo draft is made for the replaced one: nothing of it goes back to review.
    expect(all.filter((r: any) => r.original_id === old.originalId && r.status === "draft")).toHaveLength(0);
    const b = (await books("cstore")).result;
    expect(b.totals).toMatchObject({ count: 1, total: "90.40", voided: 1 });
    expect(b.items.find((x: any) => x.id === n.purchase_id)).toMatchObject({ replaces: old.receipt.id });
    const a = await audits("receipt.%");
    expect(a.map((x: any) => x.action)).toContain("receipt.replaced");
    const replaced = a.find((x: any) => x.action === "receipt.replaced");
    expect(replaced).toMatchObject({ actor_id: MANAGER, target_id: old.receipt.id });
    expect(JSON.parse(replaced.after)).toMatchObject({ status: "voided", replacedBy: n.purchase_id, total: "113.00" });
    expect(JSON.parse(a.filter((x: any) => x.action === "receipt.confirm").pop().after)).toMatchObject({ replaces: old.receipt.id });
  });

  it("one still a draft: confirming the update replacing it sets the first original aside; nothing is voided", async () => {
    const ws = await newSupplier("Fictional Wholesale");
    const first = await readOnly(FIRST, ws);
    const neu = await readOnly(UPDATED, ws);
    expect(neu.review.confirm.revision).toMatchObject({ purchaseId: first.review.draft.id, status: "draft", sameFigures: false, allowed: true });
    const c = await confirmReplacing(neu.id, first.review.draft.id);
    expect(c.ok, c.error?.message).toBe(true);
    const origs = await w.owner.query<any>("select receipt_id, status, set_aside_reason from ops.receipt_originals");
    expect(origs.find((x: any) => x.receipt_id === first.id)).toMatchObject({ status: "set_aside", set_aside_reason: "Replaced by an updated invoice" });
    expect((await rows()).filter((r: any) => r.status === "voided")).toHaveLength(0);
    expect((await books("cstore")).result.totals).toMatchObject({ count: 1, total: "90.40" });
  });

  it("the same figures: a copy, not an update; the review says set it aside, and replacing is refused", async () => {
    const ws = await newSupplier("Fictional Wholesale");
    const old = await onTheBooks("cstore", ws, ORDER(FIRST));
    const copy = await readOnly(FIRST, ws);
    expect(copy.review.confirm.revision).toMatchObject({ purchaseId: old.receipt.id, sameFigures: true, allowed: false });
    expect(copy.review.confirm.revision.words).toMatch(/copy.*Set it aside/);
    const r = await confirmReplacing(copy.id, old.receipt.id);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/same figures.*copy.*Set it aside instead/);
    expect((await rows()).find((x: any) => x.purchase_id === old.receipt.id).status).toBe("confirmed");
  });

  it("replacing only what is offered: another receipt, another business's, nothing, or not a string is refused, and nothing changes", async () => {
    const ws = await newSupplier("Fictional Wholesale");
    const other = await newSupplier("Fictional Bakery");
    const old = await onTheBooks("cstore", ws, ORDER(FIRST));
    const unrelated = await onTheBooks("cstore", other, ORDER(FIRST, { invoice_number: "FB-9", supplier: { name: "Fictional Bakery" } }));
    const neu = await readOnly(UPDATED, ws);
    for (const bad of [unrelated.receipt.id, "pr" + "0".repeat(24), 42, { id: old.receipt.id }]) {
      const r = await confirmReplacing(neu.id, bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.error?.message).toMatch(/not one this invoice can replace/);
    }
    // The same invoice number on the other business's books is not offered as a revision.
    const vapeOld = await onTheBooks("vape", ws, ORDER(FIRST, { invoice_number: "FW-3001" }));
    const vapeNew = await readOnly(UPDATED, ws, "cstore", { invoice_number: "FW-3001" });
    expect(vapeNew.review.confirm.revision).toBeNull();
    expect((await confirmReplacing(vapeNew.id, vapeOld.receipt.id)).error?.message).toMatch(/not one this invoice can replace/);
    // A reading that duplicates nothing offers nothing.
    const fresh = await readOnly(UPDATED, ws, "cstore", { invoice_number: "FW-4001" });
    expect(fresh.review.confirm.revision).toBeNull();
    expect((await rows()).filter((r: any) => r.status === "voided")).toHaveLength(0);
  });

  it("who may: an admin or a manager; a payroll admin and an employee may not confirm at all (as before)", async () => {
    const ws = await newSupplier("Fictional Wholesale");
    const old = await onTheBooks("cstore", ws, ORDER(FIRST));
    const neu = await readOnly(UPDATED, ws);
    for (const who of [PAYROLL, EMPLOYEE]) {
      const r = await rpc("rpcConfirmReceipt", [T[who], { originalId: neu.id, draftId: neu.review.draft.id, replaces: old.receipt.id }]);
      expect(r.ok, who).toBe(false);
      expect(r.error?.message).toMatch(/FORBIDDEN/);
    }
    expect((await confirmReplacing(neu.id, old.receipt.id, { by: ADMIN })).ok).toBe(true);
  });

  it("another failed check still needs a reason when replacing; the duplicate the update resolves does not", async () => {
    const ws = await newSupplier("Fictional Wholesale");
    const old = await onTheBooks("cstore", ws, ORDER(FIRST));
    // Parts that do not add up: 80 + 10.40 is not 95.00.
    const neu = await readOnly({ subtotal: "80.00", hst: "10.40", total: "95.00" }, ws);
    expect(neu.review.confirm.revision).toMatchObject({ allowed: true, reasonNeeded: true });
    expect((await confirmReplacing(neu.id, old.receipt.id)).error?.message).toMatch(/A check failed/);
    const c = await confirmReplacing(neu.id, old.receipt.id, { reason: "the supplier rounded the total" });
    expect(c.ok, c.error?.message).toBe(true);
  });

  it("an update of an update: the second replaces the first replacement; each old one is voided once", async () => {
    const ws = await newSupplier("Fictional Wholesale");
    const old = await onTheBooks("cstore", ws, ORDER(FIRST));
    const second = await readOnly(UPDATED, ws);
    const c2 = await confirmReplacing(second.id, old.receipt.id);
    expect(c2.ok).toBe(true);
    const third = await readOnly({ subtotal: "70.00", hst: "9.10", total: "79.10" }, ws);
    expect(third.review.confirm.revision).toMatchObject({ purchaseId: c2.result.receipt.id });
    const c3 = await confirmReplacing(third.id, c2.result.receipt.id);
    expect(c3.ok, c3.error?.message).toBe(true);
    expect((await books("cstore")).result.totals).toMatchObject({ count: 1, total: "79.10", voided: 2 });
  });

  it("the database: one receipt is replaced at most once; replaces names a receipt; the app role may set it", async () => {
    const ws = await newSupplier("Fictional Wholesale");
    const old = await onTheBooks("cstore", ws, ORDER(FIRST));
    const neu = await readOnly(UPDATED, ws);
    expect((await confirmReplacing(neu.id, old.receipt.id)).ok).toBe(true);
    const n = (await rows()).find((r: any) => r.replaces === old.receipt.id);
    const other = await readOnly(UPDATED, ws, "cstore", { invoice_number: "FW-5001" });
    await expect(w.owner.query("update ops.purchase_receipts set replaces = $1 where purchase_id = $2", [old.receipt.id, other.review.draft.id])).rejects.toThrow(/purchase_receipts_replaces/);
    await expect(w.owner.query("update ops.purchase_receipts set replaces = 'pr' || repeat('9', 24) where purchase_id = $1", [other.review.draft.id])).rejects.toThrow(/foreign key/);
    // On the books, it is final like every other column.
    await expect(w.owner.query("update ops.purchase_receipts set replaces = null where purchase_id = $1", [n.purchase_id])).rejects.toThrow(/final/);
  });
});
