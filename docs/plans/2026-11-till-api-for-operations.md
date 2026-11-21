# What Operations needs from the till — API v1

> **Status: draft for the owner, who builds the till side.** This is the
> request: what Operations will ask, what it needs back, and the rules the
> answers must follow. The till team turns it into the till's own contract
> (an OpenAPI file) and shares it back; that file becomes
> `ops/contracts/till-api.v1.yaml` and is frozen for the Operations work.
> See [ADR-0021](../adr/0021-till-figures-come-through-an-api.md) for why it
> is an API and not database access.

The table names below come from the till's **staging** database, read for
column names only. They are hints about where each figure lives, not a
requirement on how the till computes it. Where the till already has a rule,
such as what a void does to a shift total, the till's rule wins and the API
says which rule it applied.

## Ground rules

| Rule | Detail |
|---|---|
| **Caller** | One key per Operations environment (staging, production). Sent as `Authorization: Bearer <key>`, stored hashed by the till (as `pos_devices.token_hash` already is). Revocable. |
| **Reach** | Read-only, apart from `POST /proposals`. The key can't see customers, online orders, loyalty, card numbers or anything outside the endpoints below. |
| **Logging** | Every call recorded by the till, as `mcp_calls` already records AI calls: key, endpoint, parameters, status, time. |
| **Rate** | 60 requests a minute per key is plenty. Operations calls at close and in a nightly job. |
| **Scope** | Every request names a store (`store_id`). The till checks the key may see that store. |
| **Money** | JSON numbers rounded to cents. **Before HST** unless the field name says `total` or `hst`. Refunds are negative amounts in the same fields, never a separate sign flag. |
| **Time** | Moments in UTC ISO 8601. Each shift and day also carries `business_day` (`YYYY-MM-DD`, America/Toronto), so Operations never converts. |
| **Corrections** | Figures are **after** voids and payment-method fixes. Each shift carries `last_corrected_at`, so Operations can see that a figure changed after it took its copy. |
| **Errors** | `{"error": {"code": "...", "message": "..."}}` with a proper HTTP status. A store or day with no data is `200` with an empty list, not an error. |
| **Versioning** | Everything under `/ops/v1/`. Adding a field is allowed; renaming or removing one needs `/ops/v2/`. |

## Endpoints

### 1. `GET /ops/v1/stores`
The stores the key may see.

| Field | Notes |
|---|---|
| `store_id`, `code`, `name`, `active` | from `stores` |
| `company_id`, `company_code` | from `companies`; lets Operations map the till's company to its own `vape` |

### 2. `GET /ops/v1/staff?store_id=`
Everyone who can work a till at that store.

| Field | Notes |
|---|---|
| `staff_id` | the id that appears on sales and shifts (`pos_sales.staff_id`, `pos_shifts.opened_by`) |
| `display_name`, `role`, `active` | from `memberships` |
| `all_stores`, `store_ids[]` | from `memberships.all_stores` and `membership_stores` |
| `has_pin` | whether a PIN is set; **never the PIN or its hash** |

### 3. `POST /ops/v1/pin/verify`
Body: `{ "staff_id": "...", "pin": "1234" }`.
Answer: `{ "ok": true }` or `{ "ok": false, "locked_until": "<time or null>" }`.

- The till applies its **own** lockout (`pos_pin_attempts` already exists),
  so failed attempts through Operations count against the same limit as at
  the till.
- The same answer for an unknown `staff_id` and a wrong PIN.
- Never logs the PIN.

### 4. `GET /ops/v1/shifts?store_id=&day=YYYY-MM-DD`
Every shift whose `business_day` is that day, **open ones included**. This is
the one that replaces typing at the vape close.

| Field | Notes |
|---|---|
| `shift_id`, `z_number`, `register`, `device_name` | `pos_shifts`, `pos_devices` |
| `business_day` | Toronto date of `opened_at` |
| `opened_at`, `opened_by` `{staff_id, name}` | |
| `closed_at`, `closed_by` `{staff_id, name}` | `null` while open |
| `status` | `open`, `closed` or `auto_closed` |
| `opening_float`, `expected`, `counted`, `variance` | `variance = counted − expected`; `null` while open, never 0 |
| `close_note` | |
| `cash_moves` | `{ paid_in, paid_out, no_sale_count }` from `pos_cash_moves` |
| `takings` | per payment method, after voids and method fixes: `{ cash, credit, debit, etransfer, other }`. Each is `{ sales, refunds, net }`, so a refund is visible, not hidden in a net figure. |
| `sales_summary` | `{ count, subtotal, discount, surcharge, rounding, net, hst, total }` |
| `staff_takings[]` | per staff on the shift: `{ staff_id, name, count, net }` (feeds commissions) |
| `last_corrected_at` | newest void or method fix touching this shift, or `null` |

### 5. `GET /ops/v1/sales/daily?store_id=&from=&to=`
One row per `business_day` per channel (`till`, `online`), at most 92 days per request.
Same `takings` and `sales_summary` shapes as a shift. These are the
figures the Office dashboard shows, so the two can't disagree.

### 6. `POST /ops/v1/proposals`
For changes Operations suggests and a person approves in the Office. The
till already does this for AI suggestions (`mcp_proposals`); reuse it.

Body: `{ "kind": "...", "store_id": "...", "idempotency_key": "...", "payload": {...}, "proposed_by": {"staff_id","name"} }`.
Answer: `{ "proposal_id", "status": "pending" }`. A repeated `idempotency_key`
returns the first proposal, not a second one.

First kinds needed, in phase 5:

| `kind` | Payload |
|---|---|
| `cost_update` | lines of `{ sku, vendor, unit_cost, effective_day }` from a confirmed purchase receipt |
| `stock_receipt` | lines of `{ sku, quantity }` received, with the receipt id |

### 7. `GET /ops/v1/proposals/{proposal_id}`
Answer: `{ status: pending | approved | rejected, decided_at, decided_by, note }`.

## Things to decide on the till side

1. **e-Transfer at the till.** Staging has `etransfer` payments. StoreOps has
   nowhere to put them today. They are kept as their own method in the API;
   Operations will add the matching column when it ports the close.
2. **Which day a shift belongs to** when it runs past midnight. Proposed: the
   day it opened. Say if the till's daily report does it differently, and
   the API should follow the report.
3. **Online orders paid at the door** (cash at delivery) show in
   `sales_daily`. Proposed: they appear under channel `online` and never in a
   till shift's cash, because they don't go through the drawer. Correct this
   if drivers put that cash into the till.
4. **Staff with no till login** (a driver, a bookkeeper) are Operations-only.
   Nothing is needed from the till for them.

## How to check it before Operations uses it

For one real closed day, the till team compares the shifts endpoint against
the Office daily report for that day: every shift's `expected`, `counted`,
`variance` and cash takings must match the report exactly, and the takings
by method must add up to the report's payment-method totals.
