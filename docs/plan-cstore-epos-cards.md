# Plan — cstore moves to ePOS: one card total, no Clover

**Status:** ready to implement. Written for handover.
**Base commit:** `ad165be`
**Scope owner decision still needed:** §6 (WhatsApp template). Everything else is settled.

---

## 1. What changed in the real world

Two separate facts, and they must not be conflated in the code:

1. **cstore's till is now ePOS.** The terminal reports **one card figure**, not a
   credit/debit split. A credit-vs-debit mismatch is now impossible *because the
   two numbers no longer exist separately*, not because they always agree.
2. **cstore no longer takes Clover payments at all.** There is nothing to
   reconcile the card total *against*. The card figure is the cashier's entry and
   that is the only source.

**vape is unchanged** — still Clover, still a credit/debit split. So every change
below is **per company**, never global.

### Facts established by reading the live config and code

| Fact | Where | Why it matters |
|---|---|---|
| cstore and vape already use **different Clover merchant IDs** (`G8NX2DSKT11X1` / `NVGHFSN32NK71`) | `config` tab | `reconcileDay_` groups by merchant ID (`Reconcile.gs:114`), so the two tills **already** produce two separate reconcile messages. Removing cstore's Clover does **not** change the message count. This was the main risk and it is not real. |
| `card_variance_threshold` is **20**, not the documented default of 1 | `config` tab | Any doc or test asserting `$1` is wrong against production. |
| `whatsapp_template_shift_close` = `storeops_shift_close` | `config` tab | **`shift_close_v2` was never submitted to Meta.** This is why §6 matters — the template can still be changed for free. |
| `getCardTotals_` returns `{ok:false, error:'not_configured'}` distinctly from network failures | `Clover.gs:72` | Lets us tell "this till doesn't use Clover" apart from "Clover is down" without a new flag on the API. |
| 262 historical sales rows carry real credit/debit values | prod backup | Nothing may destroy or reinterpret them. |

---

## 2. Design decisions, and why

These are the load-bearing choices. **Do not "simplify" past them** — each one is
here because the obvious alternative breaks something specific.

### D1. Add columns; never repurpose or drop them

`sales` gains two columns:

| Col | Name | Meaning |
|---|---|---|
| 17 | `card_total_sales` | Single card figure. Populated only for a no-split till. |
| 18 | `misc_card_sales` | Same, for the Misc block. |

`credit_card_sales`, `debit_card_sales`, `misc_credit_sales`, `misc_debit_sales`
**stay exactly as they are** and keep every historical value.

**Rejected — write the total into `credit_card_sales` and leave debit at 0.**
Every report would then show "Credit $1,240 · Debit $0" for cstore, which is a
statement about the world that is false. History and present would be
indistinguishable, so no report could ever separate them again.

**Rejected — drop the credit/debit columns.** 262 rows of real data, and the
`validation_results` sheet stores cashier-vs-Clover figures per day that would
lose their counterpart.

### D2. Blank is not zero on the card columns

A no-split row has **blank** credit/debit and a populated `card_total_sales`. A
split row is the reverse. They are mutually exclusive, so `total()` can sum all
of them without double counting.

Read them with a `numOrNull_`-style reader so a report can tell "this till
doesn't split" from "this till split and took $0 on credit". `TillSessions.gs:88`
already has exactly this helper and comment for the lotto columns — **copy that
pattern, do not invent a second one.**

`rowToRecord_` must therefore return `creditCardSales: null` (not `0`) for a
no-split row. Every consumer that sums must use `|| 0`; every consumer that
*displays* must check for `null`.

### D3. Splitting is config-driven, not a hardcoded `'cstore'`

New per-company config key, following the existing `clover_<company>_*` shape:

```
cstore_card_split = false
vape_card_split   = true
```

Default when the key is missing: **`true`** — so an install that hasn't been
touched keeps today's behaviour.

**Why not hardcode `cstore`:** vape will migrate eventually, and
`Sales.gs:529`-era comments already promise a third till needs no code change.
A constant named `EPOS_COMPANY` would be the lotto mistake repeated.

Add a single accessor — put it in `Sales.gs` next to the other config reads and
export it, so `TillSessions`, `Reconcile`, `WebApp` and the UI all ask the same
question one way:

```js
function cardSplitFor_(company) {
  return String(configValue_(company + '_card_split', 'true'))
    .toLowerCase() !== 'false';
}
```

### D4. "Not configured" is not "unavailable"

`statusParam_` (`Reconcile.gs:376`) currently returns
`⚠️ Clover unavailable - cards not verified` whenever `cloverOk` is false. After
the migration that fires **every single day for cstore**, training everyone to
ignore the one line that flags real problems.

Introduce `cloverNA` on the merchant record: true when the *only* reason
`cloverOk` is false is `error === 'not_configured'`. Then:

- `cloverNA` → cards are **out of scope**, not broken. No warning, no
  `cardsOff` contribution, status falls through to the cash checks.
- `cloverOk === false` for any other reason (network, auth, 500) → keep the
  existing warning verbatim. That path is still live for vape.

**This distinction is the single most important behavioural change in the batch.**

### D5. Card validation for a no-split, no-Clover till reduces to nothing

For cstore there is no second source, so:

- no `creditDiff`, no `debitDiff`, no `cardDiff`
- `cardsOff` is always false
- `card_variance_threshold` is not consulted

The card figure still counts toward revenue and toward `{{5}}` reported — it is
simply unverified, and the message should **say so** rather than implying a check
that didn't happen.

### D6. `{{5}}` loses its measured card side for cstore

Today (`Reconcile.gs:408`):

```
counted = (cash counted − opening float) + Clover card total
```

With no Clover, `counted` can only be the drawer. Comparing a cash-only measured
figure against a reported figure that includes cards would manufacture a variance
equal to the day's card take — roughly **half of cstore revenue**.

So for a `cloverNA` group, `{{5}}` must compare **cash against cash**:

```
reported(cash) = cash sales + misc cash
counted(cash)  = cash counted − opening float
```

and say plainly that cards are excluded. Getting this wrong produces a
catastrophic-looking daily variance that is entirely fictional. **Write the test
for this before the code.**

---

## 3. File-by-file changes

Line numbers are from `ad165be` and will drift — anchor on the function names.

### 3.1 `src/Setup.gs`

1. **`setupSalesSheet_` (~595):** width `16` → `18`; append `card_total_sales`,
   `misc_card_sales` to `writeColumnHeaders_`.
2. **New one-shot migration `menu_migrateSalesCardTotal`**, modelled exactly on
   `menu_migrateTillSessionsLottoReserve` (~1178): guard on the header already
   being present, append the two columns, report what it did. Add the menu item
   next to the others (~84).
3. **`CONFIG_DEFAULTS` (~391):** add
   - `cstore_card_split` = `false` — *"cstore till reports one card total (ePOS)"*
   - `vape_card_split` = `true` — *"vape till reports credit and debit separately"*
   Leave `card_variance_threshold` alone; vape still uses it.

**Do not** blank the Clover cstore keys in `CONFIG_DEFAULTS` — defaults only seed
missing keys, they don't clear existing ones. That's an operator step (§5).

### 3.2 `src/Sales.gs`

- `COL` (~16): add `card_total_sales: 17, misc_card_sales: 18`; `NUM_COLS` 16 → 18.
- `rowToRecord_` (~30): add the two fields; switch the four credit/debit reads to
  the null-preserving reader (D2).
- `write_` `values` array (~108): append the two new values. Write `''` (not `0`)
  for whichever pair does not apply, so blank-is-not-zero survives the round trip.
- `total()` (~173): add `cardTotalSales` and `miscCardSales` to the sum.
- `aggregateByStaffCompany_` `cardTotal` (~203): add both new fields. **This feeds
  commissions** — miss it and every commission on a cstore card sale silently
  under-pays.
- `buildDaily_` / `getDashboard_` totals (~418, ~521, ~570): the `credit` and
  `debit` buckets stay (history needs them); add a `card` bucket. `total` must sum
  cash + credit + debit + card + misc.
- Bust `_salesCache` as usual — `write_` already does; don't regress it.

### 3.3 `src/TillSessions.gs`

- `close_` JSDoc (~320) and `salesInput` (~414): pass `cardTotalSales` and
  `miscCardSales` through from `input`.
- **Guard:** reject a close that sends *both* a split and a total for the same
  company — that means the client and the config disagree, and silently trusting
  either would corrupt the row. Throw with a message naming the company.

### 3.4 `src/WebApp.gs`

- `rpcCloseShift` input mapping (~422): forward the two new fields. This layer
  **drops anything not explicitly listed** — that is how `insights` went missing
  in PR #7. Adding the fields here is not optional plumbing, it is the bug.
- Wherever the shift card / bootstrap payload is built (~253), include
  `cardSplit: Sales.cardSplitFor(company)` per company so the client renders the
  right form without a second round trip.

### 3.5 `src/Reconcile.gs`

- `COL` (~22): leave the `validation_results` columns **exactly as they are**.
  For a `cloverNA` group write `''` into the four credit/debit cells rather than
  `0`, same blank-is-not-zero rule.
- Grouping (~137): accumulate `g.cashierCard` directly from
  `cardTotalSales + miscCardSales` when the company doesn't split; keep the
  existing credit/debit accumulation when it does. A group is `cloverNA` when
  every company in it has no merchant configured.
- Merchant record (~223): add `cloverNA`; leave the stored diff directions alone
  (the sheet's history must not change meaning mid-file — there's a comment at
  ~413 saying exactly this; keep it true).
- `statusParam_` (~376): apply D4.
- `buildParams_` (~401): apply D6, and produce card params per §6.
- Plain-text fallback (~522): mirror whatever §6 decides. It must not print
  `Credit / Debit` rows for a till that has neither.

### 3.6 `src/Index.html`

- **Close sheet (~2101):** when `!cardSplit`, render one **"Card sales ($)"**
  field in place of the credit and debit fields; in the Misc block (~2110) one
  **"Misc card ($)"** in place of misc credit and misc debit.
- **`wireMoneyInputs` specs (~2345):** register whichever fields actually exist.
  Registering a missing id is already safe (`if (!el) return`), but the submit
  path is not — read the fields conditionally.
- **Submit (~2428):** send `cardTotalSales` / `miscCardSales` **or** the split
  pair, never both (matches the §3.3 guard).
- **`recalcClose`:** the expected-cash preview must keep mirroring the server.
  Cards don't enter expected cash, so this should need no change — **verify, don't
  assume**, and add an assertion either way.
- **Reconcile tab (~4844):** emit the Credit and Debit rows only when the record
  has them; always emit the Total row. A `cloverNA` day should show the card total
  as *claimed, unverified* — not as a $0 Clover figure sitting next to it, which
  reads as a total loss.
- **Sales dashboard totals (~5201):** `Credit`/`Debit`/`Card` tiles render only
  when non-zero, so a cstore-filtered modern range shows `Card`, a historical
  range shows `Credit`/`Debit`, and a range spanning the migration shows all
  three — which is the truth.
- **Session sub-line (~5277):** same rule for the `cr · db` fragment.

### 3.7 `src/PublicSales.html`

- Line ~235 hardcodes `[['Cash', t.cash], ['Credit', t.credit], ['Debit', t.debit], ['Misc', t.misc]]`.
  Build that array conditionally on non-zero, same as §3.6.
- `PublicReport.gs:159` already publishes `cardClaimed` / `cardMeasured` as
  totals — for a `cloverNA` day, `cardMeasured` must be **omitted**, not sent as
  `0`. A public page showing "claimed $1,240 / measured $0" is the worst possible
  rendering of this change.

### 3.8 `src/Clover.gs`

**No code change.** `merchantFor_` already returns blanks for an unconfigured
company and `getCardTotals_` already reports `not_configured`. Resist tidying it.

---

## 4. What must NOT change

- Historical credit/debit values, in `sales` or `validation_results`.
- vape's entire path: split entry, Clover fetch, `card_variance_threshold`,
  credit/debit params, the genuine `Clover unavailable` warning.
- The stored sign convention on `card_variance` (`Reconcile.gs:413` comment).
- Cash reconciliation, the lotto reserve, `fed_from_reserve`, the sign toggle —
  all untouched by this batch.
- The merchant-group key shape. It already separates the two tills; leave it.

---

## 5. Operator steps (not code)

Run **after** the code is deployed, so the app is ready for the config:

1. Sheet menu → run **Migrate sales card total** (the new §3.1.2 item).
2. `config`: set `cstore_card_split` = `false`, `vape_card_split` = `true`.
3. `config`: **blank** `clover_cstore_merchant_id` and `clover_cstore_token`.
   Leave `clover_enabled` = `true` — vape still needs it.
4. Close one cstore shift and one vape shift and compare both messages.

Order matters: blanking Clover before the `cloverNA` handling ships gives a day
of false "Clover unavailable" warnings.

---

## 6. DECISION NEEDED — the WhatsApp template

The reconcile message is a **fixed 13-parameter Meta template**. Parameters
cannot be dropped without submitting and getting approval for a new template.
`{{10}}` credit, `{{11}}` debit and `{{12}}` card total are now meaningless for
cstore.

**The opportunity: `shift_close_v2` has never been submitted.** Live config still
points at `storeops_shift_close`. So the layout can still be changed for free —
but only until it is submitted.

**Recommended — fold this into v2 before submitting, as 12 parameters:**

| Param | cstore (ePOS) | vape (Clover) |
|---|---|---|
| `{{10}}` Cards | `$1,240.00 (ePOS, not independently verified)` | `$51.00 / $51.00 (var +$0.00) ✅` |
| `{{11}}` Breakdown | `single card total — no credit/debit split` | `Credit $1.00 · Debit $50.00` |

`{{12}}` becomes the status (was `{{13}}`). One submission serves both tills and
survives vape migrating later.

**Alternative — keep 13 params**, fill `{{10}}`/`{{11}}` with `n/a — single card
total`. Zero design work, but bakes a dead parameter into an approved template
for as long as it lives.

`docs/whatsapp-template-shift-close.md` must be rewritten either way — it
currently documents the 13-param body, the samples, and the `?v=sales` button
URL. **Do not submit anything to Meta until this is decided.**

---

## 7. Tests

New suite `epos-cards`, run against real module code via the existing harnesses.
**Every assertion must be confirmed to fail against `ad165be` before the fix
lands** — that is the house rule and it has caught wrong tests twice.

**Arithmetic**
1. cstore close with `cardTotalSales: 1240` → sales row total includes it; credit
   and debit read back **blank, not 0**.
2. vape close with credit `1` + debit `50` → unchanged from today, byte for byte.
3. A range spanning the migration totals **cash + credit + debit + card + misc**
   once, with no double count.
4. `aggregateByStaffCompany` includes the card total in `cardTotal` — the
   commission feed.

**Reconcile**
5. `cloverNA` cstore group → status contains **no** "Clover unavailable".
6. Real Clover failure on vape → status **does** contain it. (5 and 6 together are
   the point; either alone passes a broken implementation.)
7. `cloverNA` group: `{{5}}` compares cash against cash. **Assert the variance is
   $0 on a clean day** — the naive implementation yields a variance equal to the
   whole card take.
8. `cardsOff` never fires for a `cloverNA` group, at any threshold.
9. `validation_results` credit/debit cells are blank, not `0`.

**Guards**
10. A close sending both split and total for one company throws, naming it.
11. `cardSplitFor_` defaults to `true` for an unknown company and a missing key.

**UI / payload**
12. `rpcCloseShift` forwards both new fields (extend `wiring`, which derives
    required fields from `Index.html` — confirm it fails first).
13. cstore close sheet renders one card field, no credit/debit ids.
14. vape close sheet still renders both.
15. Dashboard tiles: card-only range → no Credit/Debit tiles; historical range →
    no Card tile; spanning range → all three.
16. `PublicReport` omits `cardMeasured` on a `cloverNA` day rather than sending 0.

**Regression:** the full existing suite — **459 assertions across 22 suites** —
must stay green. `lotto-payout`, `sign-toggle` and `parity` are the ones most
likely to be disturbed; `parity` in particular pins the dashboard and the message
together and will catch a one-sided change.

---

## 8. Suggested order

1. Setup.gs schema + migration + config defaults, with the migration tested.
2. Sales.gs columns, null reader, totals, aggregate. Tests 1–4.
3. TillSessions + WebApp plumbing and the both-shapes guard. Tests 10, 12.
4. Reconcile: `cloverNA`, status, `{{5}}`. Tests 5–9 — **the risky part, do it
   with the tests already written.**
5. Index.html close sheet, then the read-side renderers. Tests 13–15.
6. PublicSales + PublicReport. Test 16.
7. §6 template decision → rewrite `docs/whatsapp-template-shift-close.md`.
8. Full suite, syntax gate over every file in `src/`, CHANGELOG, push to the
   working branch for test-script verification before any merge.

---

## 9. Traps

- **`{{5}}` is the expensive one.** Leaving Clover's card total in the measured
  side for a till with no Clover produces a daily variance roughly half of cstore
  revenue, on the line management reads first.
- **`aggregateByStaffCompany` is easy to miss** — it's the commission feed, not a
  display path, so no screen goes visibly wrong when it's incomplete.
- **`rpcCloseShift` drops unlisted fields silently.** Known prior incident.
- **Blank vs zero** decides whether history stays readable. `Number(x) || 0` on
  the display path erases the distinction.
- **Two migrations exist in this area** (lotto columns, cash handling). Follow
  their guard-on-header pattern; a migration that runs twice must be harmless.
- **Don't blank cstore's Clover config before the code ships** (§5 order).
