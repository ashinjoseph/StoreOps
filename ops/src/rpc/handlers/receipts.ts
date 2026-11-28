// The RPCs of the Receipts and Businesses screens (card P5-12a), the Operations app's own (ADR-0023;
// listed in ops/contracts/rpc-ops.json). The router applies the contract's roles before these run, and
// each handler checks again, so a mistake in the contract file cannot open them. Identity and role are
// ctx.session's, never an argument: a `role`, `actorId`, `addedBy` or `staffId` in the input is ignored.
// Adding an original is not an RPC: it is PUT /files/receipt-original (receipts/routes.ts).
import { requireRole } from "../../auth/roles";
import { NOT_LOGGED_IN, type Session } from "../../auth/types";
import { archiveAfterDays } from "../../receipts/archive";
import * as businesses from "../../receipts/businesses";
import * as costs from "../../receipts/costs";
import * as drafts from "../../receipts/drafts";
import * as emails from "../../receipts/emails";
import * as legacy from "../../receipts/legacy";
import * as originals from "../../receipts/originals";
import * as review from "../../receipts/review";
import type { RpcContext, RpcHandler } from "../types";

function caller(ctx: RpcContext, roles: readonly string[] | null): Session {
  if (!ctx.session) throw new Error(NOT_LOGGED_IN);
  if (roles !== null) requireRole(ctx.session, roles);
  return ctx.session;
}
const fields = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});
const viewer = (s: Session): originals.Viewer => ({ staffId: s.staffId, role: s.role });

/** Anyone signed in. Admin, manager, payroll admin: a page of one status, with counts. An employee: their own of the last 7 days. */
export const rpcGetReceiptInbox: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, null);
  const o = fields(input);
  const config = await ctx.config();
  const inbox = await originals.inbox(ctx.db, viewer(s), { status: o["status"], before: o["before"], limit: o["limit"] }, ctx.now, archiveAfterDays(config));
  return { ...inbox, maxMb: originals.maxBytes(config) / originals.MB };
};

/** Admin, manager, payroll admin: the emails an assistant has dealt with (card P5-13), could_not_read first, then the email's date, newest first. `{ before, limit }` (limit 1 to 50, default 20); answers `{ items, counts, next }`. */
export const rpcGetReceiptEmails: RpcHandler = async (ctx, input) => {
  caller(ctx, originals.SEE_ALL);
  const o = fields(input);
  return emails.list(ctx.db, { before: o["before"], limit: o["limit"] });
};

/** Admin or manager: `{ id, aside, reason }`. */
export const rpcSetReceiptAside: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, originals.SET_ASIDE_ROLES);
  const o = fields(input);
  return originals.setAside(ctx.db, { id: o["id"], aside: o["aside"], reason: o["reason"] }, viewer(s), ctx.now, archiveAfterDays(await ctx.config()));
};

/** Admin or manager: `{ id, business }`, business cstore, vape or null, on a waiting original. */
export const rpcSetReceiptBusiness: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, originals.SET_ASIDE_ROLES);
  const o = fields(input);
  return originals.setBusiness(ctx.db, { id: o["id"], business: o["business"] }, viewer(s), ctx.now, archiveAfterDays(await ctx.config()));
};

/** Admin, manager, payroll admin: `{ id }` (an original's id). `{ draft }`: its live draft with lines, checks and business decision, or null (card P5-05a). */
export const rpcGetReceiptDraft: RpcHandler = async (ctx, input) => {
  caller(ctx, originals.SEE_ALL);
  return { draft: await drafts.getDraft(ctx.db, fields(input)["id"]) };
};

/**
 * Admin or manager: the figures typed by hand from an original (the same fields as the tool
 * receipt_propose; unknown fields such as a planted role or business are dropped). The same code path
 * as an assistant's proposal, with the person as the reader. `{ draft, replaced }`.
 */
export const rpcEnterReceiptDraft: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, originals.SET_ASIDE_ROLES);
  return drafts.propose(ctx.db, drafts.parsePageInput(input), { kind: "person", staffId: s.staffId }, await ctx.config(), ctx.now);
};

/** Admin, manager, payroll admin: both businesses and their live signs. Only an admin may change them. */
export const rpcGetBusinesses: RpcHandler = async (ctx) => {
  const s = caller(ctx, ["admin", "manager", "payroll_admin"]);
  return { canEdit: s.role === "admin", businesses: await businesses.list(ctx.db, await ctx.config()) };
};

/** Admin: `{ business, legalName, hstNumber, notes }`. */
export const rpcUpdateBusiness: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, ["admin"]);
  const o = fields(input);
  return businesses.update(ctx.db, { business: o["business"], legalName: o["legalName"], hstNumber: o["hstNumber"], notes: o["notes"] }, { staffId: s.staffId }, await ctx.config(), ctx.now);
};

/** Admin: `{ business, kind, value, supplier }`. */
export const rpcAddBusinessSign: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, ["admin"]);
  const o = fields(input);
  return businesses.addSign(ctx.db, { business: o["business"], kind: o["kind"], value: o["value"], supplier: o["supplier"] }, { staffId: s.staffId }, await ctx.config(), ctx.now);
};

/** Admin: `{ id }`. The sign is marked removed and kept. */
export const rpcRemoveBusinessSign: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, ["admin"]);
  return businesses.removeSign(ctx.db, { id: fields(input)["id"] }, { staffId: s.staffId }, await ctx.config(), ctx.now);
};

// ── Review, confirm, void, suppliers, the books (card P5-05b; ADR-0029) ──

const actor = (s: Session): review.Actor => ({ staffId: s.staffId, role: s.role });

/** Admin, manager, payroll admin: `{ id }` (an original's id). Everything the review sheet shows. */
export const rpcGetReceiptReview: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, review.READ_ROLES);
  return review.getReview(ctx.db, fields(input)["id"], actor(s), await ctx.config(), ctx.now);
};

/** Admin or manager: the draft's fields as corrected (as rpcEnterReceiptDraft), with `draft_id`, `business` and `supplier_id`. A new reading. `{ replaced, review }`. */
export const rpcSaveReceiptCorrection: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, review.REVIEW_ROLES);
  return review.saveCorrection(ctx.db, input, actor(s), await ctx.config(), ctx.now);
};

/** Admin or manager: `{ originalId, draftId, reason?, learnSigns, rememberSpelling }`. */
export const rpcConfirmReceipt: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, review.REVIEW_ROLES);
  const o = fields(input);
  return review.confirm(ctx.db, { originalId: o["originalId"], draftId: o["draftId"], reason: o["reason"], learnSigns: o["learnSigns"], rememberSpelling: o["rememberSpelling"] }, actor(s), await ctx.config(), ctx.now);
};

/** Admin or manager: `{ receiptId, reason }`. */
export const rpcVoidReceipt: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, review.REVIEW_ROLES);
  const o = fields(input);
  return review.voidReceipt(ctx.db, { receiptId: o["receiptId"], reason: o["reason"] }, actor(s), await ctx.config(), ctx.now);
};

/** Admin, manager, payroll admin: `{ q, after, limit, includeInactive }`. */
export const rpcGetReceiptSuppliers: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, review.READ_ROLES);
  const o = fields(input);
  return { ...(await review.listSuppliers(ctx.db, { q: o["q"], after: o["after"], limit: o["limit"], includeInactive: o["includeInactive"] })), canEdit: review.REVIEW_ROLES.includes(s.role) };
};

/** Admin or manager: `{ displayName, hstNumber, notes }`. */
export const rpcCreateReceiptSupplier: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, review.REVIEW_ROLES);
  const o = fields(input);
  return review.createSupplier(ctx.db, { displayName: o["displayName"], hstNumber: o["hstNumber"], notes: o["notes"] }, actor(s), ctx.now);
};

/** Admin or manager: `{ id, displayName?, hstNumber?, notes?, active? }`. */
export const rpcUpdateReceiptSupplier: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, review.REVIEW_ROLES);
  const o = fields(input);
  return review.updateSupplier(ctx.db, { id: o["id"], displayName: o["displayName"], hstNumber: o["hstNumber"], notes: o["notes"], active: o["active"] }, actor(s), ctx.now);
};

/** Admin or manager: `{ receiptId, totalCad }`. The Canadian amount paid, added once to a confirmed receipt in another currency (card P5-05c). */
export const rpcAddReceiptCanadianAmount: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, review.REVIEW_ROLES);
  const o = fields(input);
  return review.addCanadianAmount(ctx.db, { receiptId: o["receiptId"], totalCad: o["totalCad"] }, actor(s), await ctx.config(), ctx.now);
};

/** Admin, manager, payroll admin: `{ business, from, to, supplierId, kind, before, limit }`, one business at a time; or `{ receiptId }` for one receipt. */
export const rpcGetReceiptBooks: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, review.READ_ROLES);
  return review.books(ctx.db, fields(input), actor(s), await ctx.config(), ctx.now);
};

// ── The old purchase list, as history (card P5-16) ──
// Never among the receipts: its own tables, its own answers. The session's role is the only identity used.

/** Admin, manager, payroll admin: `{ business: "cstore" | "vape" | "unsorted", from, to, spellingKey, text, before, limit }`: rows newest date first, with the totals of the filter. */
export const rpcGetLegacyPurchases: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, legacy.LEGACY_READ_ROLES);
  return legacy.getPurchases(ctx.db, fields(input), actor(s));
};

/** Admin, manager, payroll admin: every supplier spelling of the old list, most rows first. */
export const rpcGetLegacySpellings: RpcHandler = async (ctx) => {
  const s = caller(ctx, legacy.LEGACY_READ_ROLES);
  return legacy.getSpellings(ctx.db, actor(s));
};

/** Admin or manager: `{ rowId | spellingKey, business: "cstore" | "vape" | null }`: exactly one of the first two. */
export const rpcSetLegacyBusiness: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, legacy.LEGACY_EDIT_ROLES);
  const o = fields(input);
  return legacy.setBusiness(ctx.db, { rowId: o["rowId"], spellingKey: o["spellingKey"], business: o["business"] }, actor(s), ctx.now);
};

/** Admin or manager: `{ spellingKey, supplierId | null }`. */
export const rpcLinkLegacySupplier: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, legacy.LEGACY_EDIT_ROLES);
  const o = fields(input);
  return legacy.linkSupplier(ctx.db, { spellingKey: o["spellingKey"], supplierId: o["supplierId"] }, actor(s), ctx.now);
};

// ── The cost history and price-rise flags (card P5-15; ADR-0030) ──
// Costs are shown and acted on for ONE business at a time (a call with no business is refused). Admin and
// manager see and act; payroll admin reads; an employee sees nothing. Identity and role are the session's.

/** Admin, manager, payroll admin: `{ business, state?, before?, limit? }`. Flags newest rise first, with the counts per state. */
export const rpcGetPriceFlags: RpcHandler = async (ctx, input) => {
  caller(ctx, costs.READ_ROLES);
  const o = fields(input);
  return costs.getPriceFlags(ctx.db, { business: o["business"], state: o["state"], before: o["before"], limit: o["limit"] });
};

/** Admin or manager: `{ flagId, state: "seen" | "price_raised" | "new", note? }`. */
export const rpcSetPriceFlag: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, costs.ACT_ROLES);
  const o = fields(input);
  return costs.setFlagState(ctx.db, { flagId: o["flagId"], state: o["state"], note: o["note"] }, { staffId: s.staffId, role: s.role }, ctx.now);
};

/** Admin, manager, payroll admin: `{ itemId }`. The item, what is joined into it and its counted history in order. */
export const rpcGetItemCosts: RpcHandler = async (ctx, input) => {
  caller(ctx, costs.READ_ROLES);
  return costs.getItemCosts(ctx.db, { itemId: fields(input)["itemId"] });
};

/** Admin, manager, payroll admin: `{ business, supplierId?, text?, before?, limit? }`. */
export const rpcFindItems: RpcHandler = async (ctx, input) => {
  caller(ctx, costs.READ_ROLES);
  const o = fields(input);
  return costs.findItems(ctx.db, { business: o["business"], supplierId: o["supplierId"], text: o["text"], before: o["before"], limit: o["limit"] });
};

/** Admin or manager: `{ itemId, intoItemId | null, reason }`. null undoes a join. */
export const rpcJoinItems: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, costs.ACT_ROLES);
  const o = fields(input);
  return costs.joinItems(ctx.db, { itemId: o["itemId"], intoItemId: o["intoItemId"], reason: o["reason"] }, { staffId: s.staffId, role: s.role }, ctx.now);
};

/** Admin: observe every confirmed receipt that has not been (a batch at a time); safe to run twice. */
export const rpcObserveEarlierReceipts: RpcHandler = async (ctx) => {
  const s = caller(ctx, costs.CATCH_UP_ROLES);
  return costs.observeEarlierReceipts(ctx.db, { staffId: s.staffId, role: s.role }, await ctx.config(), ctx.now);
};
