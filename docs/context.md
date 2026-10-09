# Context

## The business

One building with two counters, run as two companies:

- **cstore**: a convenience store. Groceries, tobacco, beer and lottery. It has
  a lottery **reserve pot** that pays winners, and since its move to an **ePOS**
  till it reports one card total with no Clover terminal.
- **vape**: a vape shop at a separate till, on **Clover**, which reports
  credit and debit separately and can be queried for the day's card payments.

A small team works shifts across both counters, sometimes both on the same day.
One person, the cash manager, holds the business cash; takings move to them
from whoever closed the till.

## What it replaced

StoreOps merged two earlier projects into one app over one Sheet: a
schedule-and-payroll tool that was never deployed, and a reconciliation app
that handled the cashier's close. Both approaches were kept; the data started
fresh.

The questions it exists to answer, on a phone, from the same data, with a
record of who did what:

- *Did tonight's drawer balance, and if not, by how much?*
- *Who is holding the cash from Tuesday?*
- *What do we owe Jordan, and for which shifts?*
- *Did the card machine agree with what the cashier wrote down?*
- *Was that $900 lottery payout from the pot or the drawer?*
- *What do we need to order this week?*

## Goals

1. **Close a till in under two minutes**, on a phone, with the arithmetic done
   for the cashier.
2. **Every dollar accounted for**: from the drawer, to a cashier's hands, to
   the cash manager, with nothing silently lost between steps.
3. **Pay that staff can check for themselves**: hours × rate per shift, and
   which payment settled which shift.
4. **Commissions without spreadsheets**: rules computed weekly and approved by
   a person.
5. **Owners informed without logging in**: an evening WhatsApp message and two
   read-only pages.
6. **Free to run**: no servers, no subscription, data in a Sheet the owner
   already understands.

## Non-goals

- Replacing the POS. Sales come from the till's own end-of-day report, entered
  at close.
- Inventory counts. The product master holds prices and margins, not stock
  levels.
- Accounting. Figures go to the accountant; StoreOps is not a ledger.
- Multi-tenant use. One store, one Sheet.

## Constraints that shaped the design

| Constraint | Consequence |
|---|---|
| No budget for hosting | Google Apps Script + Sheets ([ADR-0001](adr/0001-apps-script-and-sheets-as-the-platform.md)) |
| Staff use their own phones, often with poor reception | One page, phone-first, few round trips, optimistic writes on the shopping list |
| Staff don't have Google accounts for work | PIN login with server-side sessions ([ADR-0002](adr/0002-pin-login-with-server-side-sessions.md)) |
| Owners want to look without a login | Public pages with data inlined, aggregates only ([ADR-0003](adr/0003-public-pages-inline-their-data.md)) |
| Hardware changes under the software (ePOS, Clover) | Per-till config and additive schema ([ADR-0005](adr/0005-card-shapes-are-mutually-exclusive-columns.md)) |
| WhatsApp business messages must use pre-approved templates | Message shape is bound to the template ([ADR-0007](adr/0007-message-shape-follows-the-template.md)) |
| The owner edits the Sheet directly at times | Header-driven reads, blank-safe parsing, an audit log |

## Glossary

| Term | Meaning |
|---|---|
| **Till session** | One counter (cstore or vape) opened and closed by one person on one day |
| **Float** | Cash left in the drawer to make change: $250 cstore, $100 vape by default |
| **Expected cash** | What the drawer should hold at close: float + cash sales + misc cash − cashback + reserve fed |
| **Variance** | Counted minus expected. Positive means over, negative means short. |
| **Lotto reserve / pot** | A separate cash box at cstore that pays lottery winners. Counted at every close. |
| **Reserve fed** | How much the pot paid into the drawer this shift: last count + top-up − this count |
| **Top-up** | Cash moved from the drawer into the pot at close |
| **Card split** | Whether a till reports credit and debit separately (vape) or one card total (cstore on ePOS) |
| **Reconcile** | Comparing what the cashier entered against an independent measure: the cash count, and Clover for cards |
| **Not verified** | No independent measure exists. Not the same as "matched", and never shown as $0. |
| **Handover** | Cash a cashier gives the cash manager, settling their oldest shifts first |
| **Cash in hand** | Takings a cashier removed at close and hasn't handed over yet |
| **Attendance** | One person's workday, the unit payroll pays against |
| **Proposed bonus** | A commission the weekly engine computed and nobody has approved yet |
| **Management fee** | A fixed weekly amount paid as a rule, with no sales threshold |
| **Product master** | The product catalogue: core fields plus a per-type detail table |
| **Needs detail** | A product missing a name or variant. It shows in the picker but must be completed before it can go on the list. |
| **Staging tab** | A `_pm_<type>_staging` tab where a CSV is pasted before import |
