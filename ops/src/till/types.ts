// What the till's API answers, written by hand from ops/contracts/till-api.v1.yaml (1.1.0).
//
// A hand copy can drift, so test/till-client.test.ts checks every answer of the fake till (whose
// data is typed with these) against the contract itself. A field the contract adds later arrives
// in the data (the client hands over what the till sent) but is not typed until it is added here.
//
// Money is a JSON number rounded to the cent, as the till sends it: `12.5` is 12.50. Refunds are
// negative. Before HST unless the name says `total` or `hst`. A later card that adds money up does it
// in whole cents (`Math.round(x * 100)`), never by adding the numbers.
// Moments are UTC ISO 8601 strings; days are `YYYY-MM-DD` (America/Toronto). Nothing is a Date here:
// the answers are plain JSON.

export type Uuid = string;
/** `YYYY-MM-DD`. */
export type Day = string;
/** ISO 8601, UTC, e.g. `2026-11-25T23:04:11Z`. */
export type Moment = string;
/** A JSON number, to the cent. */
export type Money = number;

/** The till's "no one recorded" person. Never linked to anyone. */
export const NIL_STAFF_ID = "00000000-0000-0000-0000-000000000000";

export interface Store {
  store_id: Uuid;
  code: string;
  name: string;
  active: boolean;
  company_id: Uuid;
  /** Map this to Operations' own company (e.g. `vape`). */
  company_code: string;
}

export interface Person {
  staff_id: Uuid;
  name: string;
}

export type StaffRole = "owner" | "area_manager" | "store_manager" | "cashier";

export interface StaffMember {
  staff_id: Uuid;
  display_name: string;
  role: StaffRole;
  active: boolean;
  all_stores: boolean;
  /** Empty when `all_stores`. */
  store_ids: Uuid[];
  has_pin: boolean;
}

export interface MethodTakings {
  sales_total: Money;
  /** Zero or negative. */
  refunds_total: Money;
  net_total: Money;
}

export interface Takings {
  cash: MethodTakings;
  credit: MethodTakings;
  debit: MethodTakings;
  etransfer: MethodTakings;
  other: MethodTakings;
}

export interface SalesSummary {
  count: number;
  refund_count: number;
  subtotal: Money;
  discount: Money;
  /** After discounts, before HST: subtotal - discount. */
  net: Money;
  surcharge: Money;
  rounding: Money;
  hst: Money;
  /** net + surcharge + hst + rounding. */
  total: Money;
}

export type ShiftStatus = "open" | "closed" | "auto_closed";

export interface Shift {
  shift_id: Uuid;
  /** Null while open (and on some auto-closed shifts). */
  z_number: number | null;
  register: string;
  device_name: string;
  /** The Toronto day it was opened. */
  business_day: Day;
  opened_at: Moment;
  /** The nil uuid and "Not known" when the till recorded no one. */
  opened_by: Person;
  closed_at: Moment | null;
  closed_by: Person | null;
  status: ShiftStatus;
  opening_float: Money;
  /** The till's own figure plus door cash. Null while open, and on an auto-closed shift it may be. */
  expected: Money | null;
  /** Null means NOT COUNTED, never zero (ADR-0004). */
  counted: Money | null;
  /** counted - expected; null when either is. */
  variance: Money | null;
  close_note: string | null;
  cash_moves: { paid_in: Money; paid_out: Money; no_sale_count: number };
  door_cash: { orders: number; total: Money };
  takings: Takings;
  sales_summary: SalesSummary;
  staff_takings: Array<{ staff_id: Uuid; name: string; count: number; net: Money }>;
  /** The newest void or method fix of a sale in this shift. */
  last_corrected_at: Moment | null;
}

export type Channel = "till" | "online" | "delivery";

export interface DailyRow {
  business_day: Day;
  channel: Channel;
  sales_summary: SalesSummary;
  takings: Takings;
  /** The `delivery` channel only. */
  delivery?: { orders: number; fees: Money };
}

export interface ProductSupplierLink {
  vendor: string;
  their_code: string | null;
  their_name: string | null;
  pieces: number;
  preferred: boolean;
}

export interface Product {
  sku: string;
  name: string;
  product: string;
  barcode: string | null;
  barcode_aliases: string[];
  active: boolean;
  /** A placeholder code (`TMP-…`) for a flavour not yet given its `YV-` code. */
  sku_pending: boolean;
  suppliers: ProductSupplierLink[];
}

export interface Supplier {
  vendor: string;
  name: string;
  active: boolean;
}

export interface PurchaseOrder {
  order: string;
  vendor: string;
  status: "sent" | "arrived";
  created_at: Moment;
  sent_at: Moment | null;
  arrived_at: Moment | null;
  lines: Array<{ sku: string; name: string; cartons: number; pieces: number; ordered_pieces: number; their_code: string | null }>;
}

// The 200 answers, one per call.
export interface StoresAnswer {
  stores: Store[];
}
export interface StaffAnswer {
  store_id: Uuid;
  staff: StaffMember[];
}
export interface ShiftsAnswer {
  store_id: Uuid;
  business_day: Day;
  shifts: Shift[];
}
export interface DailySalesAnswer {
  store_id: Uuid;
  from: Day;
  to: Day;
  days: DailyRow[];
}
export interface ProductsAnswer {
  store_id: Uuid;
  products: Product[];
}
export interface SuppliersAnswer {
  store_id: Uuid;
  suppliers: Supplier[];
}
export interface OrdersAnswer {
  store_id: Uuid;
  orders: PurchaseOrder[];
}

/** The till's own error codes (the contract's `Error.error.code` enum). */
export const TILL_ERROR_CODES = ["bad_request", "unauthorized", "forbidden_store", "not_found", "conflict", "rejected", "rate_limited", "server_error", "unavailable"] as const;
export type TillErrorCode = (typeof TILL_ERROR_CODES)[number];

/** Why a call did not give data. See the component page `docs/components/till-link.md`. */
export type TillErrorKind =
  | "not_configured"
  | "bad_address"
  | "bad_input"
  | "timeout"
  | "network"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "server"
  | "bad_answer"
  | "rejected";

export interface TillError {
  kind: TillErrorKind;
  /** The HTTP status, when the till answered. */
  status?: number;
  /** The till's own error code, when it sent one of the contract's. */
  code?: TillErrorCode;
  /** For a person to read. Never holds the key, and never a value from the till's answer except its own error message. */
  message: string;
  /** `rate_limited`: how long the till asked us to wait, in seconds. */
  retryAfterSeconds?: number;
}

export type TillResult<T> = { ok: true; data: T } | { ok: false; error: TillError };
