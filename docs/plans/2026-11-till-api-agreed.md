# The till's API for Operations — what was agreed, and the review

> **Status: agreed, contract 1.1.0 (2026-11-22).** Every ask from
> Operations' review is done, and the contract lints clean. Part 1 is the
> till side's covering note, kept as sent apart from the heading and the
> link to the contract. Part 2 is Operations' review (card P0-02). The
> contract itself is
> [`ops/contracts/till-api.v1.yaml`](../../ops/contracts/till-api.v1.yaml),
> copied unchanged. The request it answers is
> [What Operations needs from the till](2026-11-till-api-for-operations.md).

## Part 1 — The till side's note

**To the Store Operations team, from the till side, 2026-11-21. Updated 2026-11-22 for your review: contract 1.1.0.**

This answers your draft "What Operations needs from the till, API v1". The contract is the OpenAPI file next to this note,
`till-api.v1.yaml`: save it as `ops/contracts/till-api.v1.yaml`. Most of your draft is
in it as you wrote it. This note lists only what changed, and why.

### Changed from your draft

| Your draft | Agreed | Why |
|---|---|---|
| `POST /ops/v1/pin/verify` | **Not provided.** Operations signs its people in itself. | Till PINs are checked on the till PC (so it works offline), and its lockout lives in that till alone, so there is no shared limit for an outside check to count against. An internet-facing PIN check with a 4 to 6 digit PIN could be guessed through. `GET /staff` still says `has_pin`. |
| Proposal kinds `cost_update` and `stock_receipt` | **One kind, `receipt`**: a supplier delivery with its invoice, stock and cost together. | The till already receives deliveries this way: stock in and supplier cost from the invoice in one step, approved by the owner. There is no cost change without a delivery. Use the till's purchase order (`PO-0003`) or supplier code, and the till's product codes (`YV-23649`). |
| Payload `{sku, vendor, unit_cost, effective_day}` | Per receipt: `order` or `vendor`, `invoice`, `invoiced_on`; per line: `sku`, `received` (pieces), and the invoice's `pieces` per carton, `carton_price`, `duty_per_carton` | The till keeps cost as the invoice states it; unit cost = (carton price + duty) / pieces. A line may leave out what the till already knows for that supplier and product. |
| `sales/daily` channels `till`, `online` | **Three: `till`, `online`, `delivery`** | The owner treats delivery as its own channel. `till` is the Office dashboard's "In store". `online` + `delivery` is its "Online" except for a pickup paid at the counter: its card surcharge and cash rounding, and a refund of it at the counter, are in `online` here and elsewhere on the dashboard. |
| Takings `{sales, refunds, net}` | `{sales_total, refunds_total, net_total}` | Takings are money taken, HST included, so by your own money rule their names say `total`. |
| Cash paid at the door "never in a till shift's cash" | **It goes into the drawer**: each shift has `door_cash {orders, total}`, and `expected` includes it | The owner's answer to your question 3. Door cash from deliveries recorded as delivered while a shift was open counts in that shift; one recorded while no shift was open counts in the next shift opened at the store; with two open at once, in the one opened first. The sale itself stays in the `delivery` channel. (Cash at the door is switched off in production today; this is how it counts once it is on.) |
| Keys | **90 days**, then a new key | Made by the owner in the Office with the 6-digit code; shown once, stored hashed, revocable. Make the next one before the old one expires: both work until then. An Operations key can call nothing but this API. |
| Errors | Your shape, with these codes: `bad_request`, `unauthorized`, `forbidden_store`, `not_found`, `conflict` (an idempotency key reused with another body), `rejected` (a proposal the till refuses, e.g. an unknown code or an invoice already received), `rate_limited`, `server_error`, `unavailable` | |
| `GET /proposals/{id}` | Statuses `pending`, `approved`, `rejected`, **`expired`** | A proposal nobody decides within 7 days expires. Any Operations key of the company can read it (1.1.0). |

### Your review (2026-11-21 and 22): what 1.1.0 does

Fields and endpoints are only added; nothing you build against 1.0.0 changes.

| # | Your ask | Done in 1.1.0 |
|---|---|---|
| 1 | Quote the five cut-off descriptions | Quoted. Our own check of every schema in the file now finds no stray keys, and it runs as a test, so a description cannot be cut off again unnoticed. Please re-run `redocly lint` on your side. |
| 2 | Product codes, supplier codes and open purchase orders | **`GET /products`**: every flavour with its till `sku`, name, barcode and other barcodes, whether it is on sale, whether its code is a placeholder (`TMP-…`), and per supplier their code, their name, pieces per carton and preferred. **`GET /suppliers`**: each supplier's code (what a receipt gives as `vendor`), name and active. **`GET /orders?status=open`**: purchase orders sent or arrived and not yet received (the only ones a receipt may name), with their lines: sku, cartons, pieces per carton, pieces ordered, the supplier's code. All take `store_id`. **No supplier prices or costs** in any of them: a receipt takes them from the invoice, and cost does not leave the till. |
| 4 | Reading proposals after a key change | Any Operations key of the company reads a proposal made by any of its Operations keys, so no overlap is needed for that. **Idempotency keys also hold across a key change**: a repeat sent with the new key returns the first proposal. Still make the next key before the old one expires, so no call fails. |
| 5 | "Order or vendor" in the schema | `ReceiptPayload` has `anyOf: [{required: [order]}, {required: [vendor]}]`. |
| Q | Does `422` "invoice already received" count pending and expired proposals? | It counts a delivery **received** and a proposal **still waiting** for the owner (same supplier, same invoice number, any case). A **rejected or expired** proposal does not count, so resending an expired delivery under a new idempotency key with the same invoice is accepted. This is now in the contract. |

### Your four questions

1. **e-Transfer at the till:** a real till payment method, kept as `etransfer`. The till also takes cards on a Clover
   terminal: those count under `credit` or `debit` by their card type, and under `other` when the type was not recorded.
2. **A shift past midnight:** it belongs to the day it **opened**, as you proposed. The Office daily report lists a shift on
   every day it was open, so the two differ only for such a shift (rare: the shop closes at 11 pm, and a shift left open
   is closed by itself after 24 hours).
3. **Cash at the door:** the driver puts it in the till; see `door_cash` above.
4. **Staff with no till login:** agreed, nothing from the till.

### Rules the till applies (stated so you never guess)

- `expected` is the till's own figure at close, plus `door_cash`. A void after close changes takings but not the till's
  part of `expected`; `last_corrected_at` tells you one happened.
- A website pickup paid at the counter is in that **shift's** takings and sales (its money is in the drawer), and in the
  **`online`** channel of `sales/daily` (it is a website order), never in the `till` channel.
- In every `sales/daily` row the takings add up to `sales_summary.total` (unless a till sale's payments did not cover its
  total: the till keeps it and flags it), and `total = net + surcharge + hst + rounding`.
- When the till recorded no person on a sale or shift, `staff_id` is the nil uuid and the name is "Not known".
- A repeated proposal request answers `pending` even if the owner has decided since: `GET /proposals/{id}` says where it stands.
- A delivery cancelled after a failed drop (the shop keeps the fee) is not in these figures in v1.

### Checking it before you rely on it

As you proposed: for one real closed day, every shift's `expected`, `counted`, `variance` and cash takings must match the
Office daily report exactly, and the takings by method must add up to the report's payment-method totals. The Office daily
report and the till's close screen count door cash into `expected` the same way, from this release.

You get a staging key first, on invented data, then a production key from the owner.

## Part 2 — Operations' review (card P0-02)

**Verdict: accepted, 1.1.0.** Every field in the request is there with the
meaning asked for, or changed for a reason Part 1 gives. Two rounds of
review (Nov 21 and 22) are closed.

### Checks on 1.1.0

| Check | Result |
|---|---|
| `redocly lint`, recommended rules | Valid: 0 errors. 10 warnings, all acceptable: errors are listed once under `default` instead of per 4xx code (9), and `info` has no `license` (1) |
| Additive only, against 1.0.0 | Every path, parameter, schema property, required list and enum of 1.0.0 is unchanged; 42 items added |

### The asks, and how 1.1.0 answered them

| # | Ask | 1.1.0 |
|---|---|---|
| 1 | Quote five cut-off descriptions | Done; the till side now tests for it |
| 2 | Product codes, supplier codes, open purchase orders | Done: `GET /products`, `GET /suppliers`, `GET /orders?status=open`. No prices or costs in any of them |
| 3 | Status on a repeated proposal | A repeat always answers `pending`; `GET /proposals/{id}` gives the current status |
| 4 | Reading proposals after a key change | Done: any Operations key of the company reads them, and idempotency keys hold across a key change |
| 5 | "Order or vendor" in the schema | Done: `anyOf` on `ReceiptPayload` |
| Q | What `422` "invoice already received" counts | A received delivery or a proposal still waiting. A rejected or expired one doesn't, so it can be resent under a new idempotency key |

### Taken into the plan

- **PINs (D6):** Operations always checks its own PINs. ADR-0021.
- **Receipts (P5-05, P5-08):** vape lines keep the invoice's shape (pieces
  per carton, carton price, duty per carton) and are matched to till codes
  from `GET /products` (barcode, the supplier's own code, then name); the
  supplier and order are picked from `GET /suppliers` and `GET /orders`.
  The till gives no costs, so Operations' own `product_costs` is the cost
  history for both stores.
- **The vape close (P1-03, P5-03):** the till's `expected` includes
  `door_cash`; takings fields are `*_total`; `etransfer` has its own column.
- **Keys (P5-02):** Operations records each key's expiry and warns an admin
  14 days before. Proposals and idempotency keys survive a key change.
- **Daily sales:** three channels, `till`, `online` and `delivery`. A
  pickup paid at the counter puts its surcharge, rounding and any counter
  refund in `online`.
- **"Not known" (the nil uuid):** never linked to a person; its sales count
  toward no one's commission and are listed for a manager.
- **Takings short of the total** (a till sale its payments didn't cover):
  stored with the till's flag, never rejected.

### Staging retrieval check

**2026-11-23, contract 1.1.0, staging** (`staging--scarbromart-office.netlify.app/ops/v1`,
invented data). Card P1-04's checks run once by hand, with GETs only and no
`POST`: 10 requests, a little over one a second, with the key added by the session's
network proxy. Every answer was validated against the contract's schemas
(required fields, types, enums, nullability, uuid/date/date-time formats)
and against its arithmetic rules. The script itself (`ops/tools/till-check.ts`)
is still to be written. Raw answers were kept out of the repo. Below are
figures and field paths only.

| Endpoint | Asked | Status | Count | Schema differences |
|---|---|---|---|---|
| `GET /stores` | | 200 | 1 store | 0 |
| `GET /staff` | the store | 200 | 7 (1 owner, 6 store_manager; 3 active; 2 with a PIN) | 0 |
| `GET /shifts` | 2026-11-22, then back a day at a time | 200 ×4 | 22nd, 21st, 20th: 0 each. 19th: 3 (1 `closed`, 2 `auto_closed`) | 0 |
| `GET /sales/daily` | 2026-11-16 to 2026-11-22 | 200 | 6 rows over 3 days (17th to 19th): 3 `till`, 2 `online`, 1 `delivery` | 0 |
| `GET /products` | the store | 200 | 224 (218 active, 59 `sku_pending`, 59 with no barcode, 2 supplier links) | 0 |
| `GET /suppliers` | the store | 200 | 1 (active) | 0 |
| `GET /orders` | the store (default `open`) | 200 | 0 | 0 |

**Rules checked, all held:**

- `variance = counted − expected` on the one `closed` shift
  (50.00 − 50.00 = 0.00).
- `net = subtotal − discount` and `total = net + surcharge + hst + rounding`
  on all 3 shifts and all 6 daily rows, refunds and a −0.01 rounding included.
- Every method's `net_total = sales_total + refunds_total`, with `sales_total`
  ≥ 0 and `refunds_total` ≤ 0.
- In `sales/daily`, the takings' `net_total`s equal `sales_summary.total` on
  all 6 rows. No row needed the under-paid exception. They also matched on all
  3 shifts, where the contract doesn't promise it.
- `delivery` is on the `delivery` row only, and its fees (19.96 on 4 orders)
  are inside its subtotal. There is one row per day and channel, all inside
  the range asked.
- On each shift, `staff_takings[].net` sums to `sales_summary.net`.
- The `closed` shift's one sale (paid by e-transfer) is a website pickup paid
  at the counter. Its 16.10 is in that shift's takings, and in the day's
  `online` row (66.94 = 16.10 + 50.84), not in `till`, as Part 1 says.
- Every vendor on a product is in `GET /suppliers`. There are no duplicate
  SKUs, and `sku_pending` agrees with a `TMP-` code on every product.

**Differences from the contract: none.** Nothing missing, mistyped, outside
an enum or wrongly null. No fields beyond the contract.

**Not covered, because staging has no data for it:** a `PurchaseOrder` (no
open orders, so the `orders` schema was only checked on an empty list); an
under-paid sale; the nil uuid ("Not known"); `last_corrected_at` set; a
shift past midnight; and more than one supplier.

**To ask the till side:**

1. **What does `auto_closed` mean, and which fields may be null on it?** The
   contract only says the close fields are "null while open". On staging, one
   `auto_closed` shift has `z_number`, `expected`, `counted` and `variance` all
   null. Another has `z_number` and `expected` (50.00) but `counted` and
   `variance` null. Operations will read a null `counted` as *not counted*,
   never 0 (ADR-0004). Please confirm, and say whether `closed_by` can be null
   on a `closed` shift.
2. **Door cash on a shift closed without a count.** That first `auto_closed`
   shift has `door_cash` of 2 orders, 112.96, and `expected` null. Where does
   that cash go: into the next shift's `expected`, or nowhere?
3. **How Operations can see an under-paid sale.** `DailyRow` has no field for
   the "To check" flag, so a gap between takings and total can't be told apart
   from an error. Could a count or amount of flagged sales be added (additive
   in v1)?
4. **More staging data.** Please add an open purchase order with lines, a
   second supplier, more supplier links on products, a refund inside a
   shift, a sale with no person recorded, and a void after close. Then the
   untested shapes above get checked before the production key.

**Owner's answers (2026-11-23):**

1. **Accepted.** An empty `counted` means *not counted*, never 0, on any
   shift (`auto_closed` included). Operations shows it as not counted and
   leaves `variance` empty (ADR-0004).
2. **Door cash belongs to the shift that was open when the delivery was
   recorded,** even if that shift closes without a count. The driver, not
   the cashier, answers for it. **Agreed with the owner: a driver handover
   at the till**, asked of the till side below.
3. The owner is asking the till side for a field showing flagged
   under-paid sales.
4. The owner is asking the till side for more staging data.

**Asked of the till side (2026-11-23): door cash as a driver handover.**
When the driver brings door cash back, the till records a handover: the
driver, the deliveries it covers, and the amount counted at the till. The
drawer then answers for what was counted, and the driver for any gap
against what the deliveries collected. Additive in v1; nothing renamed:

| Field on `door_cash` | Meaning |
|---|---|
| `collected_total` | Cash the delivery records say was collected at the door |
| `handed_over_total` | Cash counted at the till when the driver handed it in; `null` until then |
| `driver` | `{staff_id, name}` of the driver who handed it in; `null` until then |
| `handed_over_at` | When it was handed in; `null` until then |

- `expected` includes `handed_over_total`, not `collected_total`. Until the
  handover, the amount is with the driver and in no drawer.
- The driver's gap is `handed_over_total − collected_total`. The cashier's
  `variance` stays `counted − expected`.
- It stays with the shift that was open when the delivery was recorded,
  even if that shift closes without a count.
- Today's `door_cash.total` is kept as it is (it equals `collected_total`).

