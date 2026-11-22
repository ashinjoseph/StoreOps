# The till's API for Operations — what was agreed, and the review

> **Status: contract received 2026-11-21, revised 2026-11-22; review done.
> One of the five fixes asked is made; four and a question are open.**
> Part 1 is the till side's covering note, kept as sent apart from the
> heading and the link to the contract. Part 2 is Operations' review of
> the contract (card P0-02). The contract itself is
> [`ops/contracts/till-api.v1.yaml`](../../ops/contracts/till-api.v1.yaml),
> copied unchanged. The request it answers is
> [What Operations needs from the till](2026-11-till-api-for-operations.md).

## Part 1 — The till side's note

**To the Store Operations team, from the till side, 2026-11-21 (revised 2026-11-22).**

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
| `GET /proposals/{id}` | Statuses `pending`, `approved`, `rejected`, **`expired`** | A proposal nobody decides within 7 days expires. Only the key that made a proposal can read it. |

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

**Verdict: accepted for building against.** Every field in the request is
there with the meaning asked for, or changed for a stated reason (Part 1).
The changes are taken into the plan and cards (see the end). Five small
fixes are asked of the till side; none blocks phases 2–4.

### Linter

`redocly lint` (recommended rules): **5 errors, 7 warnings.**

The five errors are one YAML problem. Inside `{ … }`, an unquoted
description that contains a comma ends at the comma, and the rest becomes a
stray property. The machine-readable contract is unaffected, but these
descriptions are cut short for anyone generating docs or a client from the
file:

| Line | Field | Reads as |
|---:|---|---|
| 282 | `SalesSummary.net` | "After discounts" |
| 286 | `SalesSummary.total` | "What customers paid" |
| 312 | `Shift.variance` | "counted - expected. Null while open" |
| 409 | `ReceiptPayload.lines[].sku` | "The till's code" |
| 426 | `ProposalCreated.expires_at` | "Seven days after it was made" |

**Fix:** put those five descriptions in quotes.

The warnings are acceptable: errors are listed once as `default` rather than
per 4xx code, and there is no `license` in `info`.

### Asked of the till side

| # | What | Why it matters | Suggested fix | Nov 22 revision |
|---|---|---|---|---|
| 1 | Quote the five descriptions above | The contract should lint clean before it is frozen | Quotes | Open: the same five lint errors remain (now lines 284, 288, 316, 414, 431) |
| 2 | **A way to read the till's product codes, supplier codes and open purchase orders** | A `receipt` needs the till's `sku` per line and an `order` or `vendor`. Without a list, a person types each code by hand, which is where mistakes come from | Add `GET /products?store_id=` (sku, name, barcode, active, supplier code, pieces per carton), `GET /suppliers`, and `GET /orders?store_id=&status=open`. Adding endpoints is allowed within v1 | Open |
| 3 | `ProposalCreated.status` is only `pending`, but a repeat with the same key returns the earlier proposal, which may be approved, rejected or expired by then | A client generated from the file would reject a real answer | Allow all four statuses there, or say a repeat always answers with the current status | **Answered:** a repeat always answers `pending`; `GET /proposals/{id}` gives the current status. Operations reads that |
| 4 | Only the key that made a proposal can read it, and keys last 90 days | After a key change, Operations can't see what happened to proposals the old key made | Let any Operations key of the same environment read its proposals; otherwise Operations keeps the overlap of two keys to at least 8 days | Open. Until answered, Operations keeps two keys overlapping for at least 8 days |
| 5 | "Order or vendor" is in the description, not the schema | A payload with neither passes validation on Operations' side | `anyOf: [{required: [order]}, {required: [vendor]}]` on `ReceiptPayload` | Open. Operations checks it in its own code meanwhile |

And one question, still open on Nov 22: does "invoice already received"
(`422`) count only approved receipts, or pending and expired proposals too? Operations resends
an expired receipt under a new idempotency key with the same invoice, and
needs to know whether that is refused.

### Taken into the plan

- **PINs (D6):** Operations always checks its own PINs. The till link is for
  staff and figures, not sign-in. ADR-0021 updated.
- **Receipts (P5-05, P5-08):** vape receipt lines keep the invoice's shape
  (pieces per carton, carton price, duty per carton) and the till's product
  code; a vape delivery is sent as one `receipt` proposal, stock and cost
  together. Until item 2 above exists, the till code is typed once per
  supplier item and remembered.
- **The vape close (P1-03, P5-03):** the till's `expected` includes
  `door_cash`; takings fields are `*_total`; `etransfer` has its own column.
- **Keys (P5-02):** Operations records when its key expires and warns an
  admin 14 days before.
- **Daily sales:** three channels, `till`, `online` and `delivery`. A
  pickup paid at the counter puts its surcharge, rounding and any counter
  refund in `online`, so `online` + `delivery` differs from the dashboard's
  "Online" by those amounts.
- **Added Nov 22:** a sale or shift with no person recorded carries the nil
  uuid and the name "Not known". Operations never links that id to a person,
  and its sales count toward no one's commission; they are listed for a
  manager to see. A day whose takings don't add up to its total (a till sale
  the payments didn't cover) is shown with the till's flag, not rejected.
