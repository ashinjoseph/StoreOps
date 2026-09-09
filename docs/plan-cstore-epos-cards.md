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
| `shift_close_v2` **is live and approved** | owner, 2026-09-09 | An earlier draft of this plan said it had never been submitted. That came from the **2026-08-15 backup**, which is three weeks stale and still showed `storeops_shift_close`. The layout can no longer be changed for free — see §6. **Read config from the live sheet, never from the backup.** |
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

### D5. Card reconciliation is removed for cstore, not weakened

Owner's instruction: *"reconcile logic should not run for cards in cstore anymore
because it will always be correct and a single entity. Instead we are only
focusing on cash variance for cstore now."*

So for a no-split, no-Clover till there is no card check **at any level**:

- no `creditDiff`, no `debitDiff`, no `cardDiff` — not computed, not stored
- `cardsOff` is not evaluated; `card_variance_threshold` is never read
- `{{13}}`/status is derived from **cash variance alone**
- the Reconcile tab shows no claimed-vs-measured card row for these days

The card figure is still **revenue** — it belongs in the day's total and in the
sales dashboard. It is reported as information, never as a check. Do not leave a
disabled comparison behind "in case Clover comes back": if a till returns to
Clover, `<company>_card_split` and the merchant config turn it back on.

### D6. cstore's total-sales line stops being a variance line

Today `{{5}}` is a cross-check (`Reconcile.gs:408`):

```
reported = cash sales + misc cash + cashier card total
counted  = (cash counted − opening float) + Clover card total
variance = counted − reported
```

Both sides carry a card term, and they cancel when the cards agree. **Remove
Clover and only the reported side keeps its card term** — so a perfectly clean
day reports a variance equal to the entire card take, roughly **half of cstore
revenue**, on the line management reads first. This is the most expensive bug
available in this batch.

Per D5 the answer is not to rebuild the cross-check on cash alone — that would
duplicate `{{6}}`, which already compares cash recorded against cash counted and
is now the *only* check cstore has. Two lines reporting one variance is how the
old nine-parameter message became unreadable.

So for a `cloverNA` group, `{{5}}` becomes **descriptive, not comparative**:

```
$1,842.00 — cash $602.00 · card $1,240.00
```

Full revenue, split by tender, no variance and no ✅/⚠️ mark. The day's one
verdict lives in `{{6}}` and is summarised in the status param. vape's `{{5}}`
keeps the cross-check exactly as it is.

**Write the test for this before the code.**

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
- **Sales dashboard totals (~5201):** apply the parent/breakdown model in §7.6 —
  one `Card` tile always, equal to `credit + debit + card_total`; credit/debit as
  a breakdown beneath it when non-zero, carrying a coverage note when the range
  spans the migration. **Not** three peer tiles.
- **Session sub-line (~5277):** each row is one shape, so render `cr · db` or
  `card`. No coverage note needed at row level.

### 3.7 `src/PublicSales.html`

- Line ~235 hardcodes `[['Cash', t.cash], ['Credit', t.credit], ['Debit', t.debit], ['Misc', t.misc]]`.
  Apply the same parent/breakdown model as §3.6 — a `Card` entry always, the split
  beneath it only when it has something to say. This page is read by people who
  will not know a till migration happened, so the tiles must make sense without
  that context.
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
4. Submit `shift_close_cstore` to Meta (§6). Once approved, set
   `whatsapp_template_shift_close_cstore` = `shift_close_cstore` and
   `whatsapp_template_shift_close_vape` = `shift_close_v2`.
   Until both keys are set, **both tills keep using `shift_close_v2`** — safe, and
   identical to today.
5. Close one cstore shift and one vape shift and compare both messages.

Order matters: blanking Clover before the `cloverNA` handling ships gives a day
of false "Clover unavailable" warnings.

---

## 6. Two purpose-built templates

**Decided by the owner:** cstore and vape get **separate close templates**, and
**vape drops the lotto parameter** — only cstore sells lotto, so `{{9}}` has
always been dead weight there, printing *"not tracked on this till"* every single
day.

### Cost, stated plainly

`shift_close_v2` is live and approved. Dropping a parameter from vape means vape
needs a **new template too**, so this is **two Meta submissions, not one**. The
owner has asked for it knowing that; the upside is that `shift_close_v2` retires
entirely and neither surviving template carries a parameter that never says
anything.

Until both new templates are approved and configured, **both tills keep using
`shift_close_v2` unchanged** — so there is no window where anything breaks.

### `shift_close_cstore` — 11 parameters

Cards are **information**, never a check. The status speaks only to cash.

| # | Content | Example |
|---|---|---|
| 1 | Date | `Wed 9 Sep 2026` |
| 2 | Till | `cstore` |
| 3 | Hours | `09:00–21:20` |
| 4 | Staff | `Blesson, Abijith` |
| 5 | Total sales — descriptive, **no variance** | `$1,842.00 — cash $602.00 · card $1,240.00` |
| 6 | **Cash · recorded / counted** — the only check | `$852.00 / $852.00 (var +$0.00) ✅` |
| 7 | Cash destination | `float $250.00 back · reserve $300.00 · $302.00 in hand` |
| 8 | Cash in hand, by name | `Blesson $1,240.00 · Abijith $640.00` |
| 9 | Lotto reserve | `$500.00 (+$300.00 moved in)` |
| 10 | Cards (ePOS, informational) | `$1,240.00 — single total, not independently verified` |
| 11 | Result | `✅ Cash matched` / `⚠️ cash short $40.00` |

`{{11}}` must not say *"All matched"* — that would claim a card check that no
longer runs. *"Cash matched"* is the honest wording.

### `shift_close_vape` — 12 parameters

`shift_close_v2` minus the lotto line. Everything else keeps its current
behaviour and wording, including the genuine Clover cross-check.

| # | Content |
|---|---|
| 1–4 | Date · Till · Hours · Staff |
| 5 | Total sales — **keeps the cross-check**, Clover is still connected |
| 6 | Cash · recorded / counted |
| 7 | Cash destination |
| 8 | Cash in hand |
| 9 | Credit · cashier / Clover |
| 10 | Debit · cashier / Clover |
| 11 | Card total · cashier / Clover |
| 12 | Result — cash **and** cards |

`lottoParam_` stays in the codebase: `getLottoLog_`, the Cash Handling tab and
the `shift.closed` push notification all still use it. Only vape's *template*
loses the line. `Notifier.gs:51` already suppresses lotto on a vape close by
checking for `null` rather than zero — **that is the right pattern, follow it.**

### Config and routing

`Notifier.sendOp_` (`Notifier.gs:230`) reads `whatsapp_template_<opKey>`, and
`sendNotifications_` (`Reconcile.gs:292`) **already loops per merchant group**,
each of which knows its companies. So routing is small:

- New keys `whatsapp_template_shift_close_cstore` / `..._vape`.
- In `sendNotifications_`, pick the op key per group: a single-company group with
  its key set uses `shift_close_<company>`; anything else falls back to
  `shift_close`.
- **Resolve the fallback in `Reconcile`, not `Notifier`.** `sendOp_` falls back to
  plain text by design; teaching a generic helper one caller's key chain is the
  wrong place for the policy.
- `reconParams_` branches on the same condition and returns 11, 12 or 13 params.
  **A wrong count is a Meta `http_400` that `dispatch_` swallows** — the day
  reconciles, the row is written, and the message silently never arrives. Assert
  the count per shape in tests; nothing at runtime will tell you.
- `formatMessage_` (the plain-text fallback, `Reconcile.gs:497`) needs the same
  two shapes. It is what sends when no template is configured, which is exactly
  the state between deploy and approval.

### Docs

Split `docs/whatsapp-template-shift-close.md` into a cstore section and a vape
section, each with its own body, samples and the `?v=sales` button. Record that
`card_variance_threshold` is **20** in production — the doc currently claims `$1`
— and that it now applies to **vape only**.

## 7. Broader review — what this change exposes

Findings from a full sweep beyond the immediate edit. Ordered by what they cost.

### 7.1 CRITICAL — the public reconcile page will publish a fictional loss

`Public.html:298` renders `cell('Cards', r.cardClaimed, r.cardMeasured, r.cardVar)`
with **no unavailable branch at all** — unlike the in-app tab, which has one at
`Index.html:4840`. With Clover gone, `PublicReport.gs:160` sends
`cardMeasured: 0` and `cardVar: −cashierCard`, so every cstore day publishes:

> **Cards** $1,240.00 / $0.00 · **−$1,240.00**

flagged red, on the no-login URL that goes to owners and managers. `cell()` also
hardcodes a `$1` tolerance, ignoring `card_variance_threshold` entirely.

**Fix:** `PublicReport` omits `cardMeasured`/`cardVar` when cards were not
verified, and `cell()` gains a one-sided form showing the claimed figure with a
*"not verified"* note. **This must ship in the same batch** — it is worse than the
problem being solved.

### 7.2 HIGH — branch on blank, not on the status string

`Index.html:4817` derives `cloverUnavailable` from `r.status === 'clover_unavailable'`.
So the *stored status vocabulary* drives the UI. If a cards-not-applicable day
reports `OK`, the else-branch runs and renders `reconRow_('Credit', 0, 1240)` →
**"Credit $0.00 / $1,240.00 (+$1,240.00)"** in red. Fixing the message without
fixing this just moves the wrong number.

**Fix:** write **blank** into the four clover columns of `validation_results` for
an unverified day (already required by D2/§3.5), and have all three renderers —
in-app tab, public page, message — branch on `cloverCard == null` rather than on a
status string. One rule, three consumers, and it composes with the
genuinely-unavailable case instead of competing with it.

### 7.3 HIGH — a real control disappears, and nothing replaces it

`{{5}}`'s cross-check catches a **mistyped sales figure**, because it compares
what the cashier typed against what was independently measured. After this change
cstore has **no independent check on card revenue at all** — the ePOS total is
typed by a person and verified by nothing. That is roughly **half of cstore
revenue** moving from verified to asserted.

This is a consequence of the migration, not a reason to stop it, but it should be
a decision rather than a discovery. Options, cheapest first:

1. **Plausibility check.** Flag when card share of the day's revenue departs from
   its trailing median by more than a set margin. Catches a transposed digit
   (`$1,240` → `$12,400`), which is the realistic error. Cheap, no integration.
2. **Bank deposit reconciliation.** The card processor's settlement is the real
   measured figure; a weekly comparison restores the control properly.
3. **ePOS export.** See 7.4 — the workbook already has a sheet shaped for it.

I would ship (1) with this batch and treat (3) as the real answer.

### 7.4 MEDIUM — two dead sheets, one of them newly relevant

`pos_extracted` and `clover_batches` are **created by `Setup.gs` and never read or
written by any code** (`Setup.gs:296–297`, 796, 816 — the only references).

- `clover_batches` is now doubly dead for cstore. Either wire it or stop creating
  it; an empty tab in a workbook the owner reads is a standing question.
- **`pos_extracted` is exactly the shape ePOS integration needs.** Somebody
  already anticipated this. When 7.3(3) gets built, that is where it lands —
  worth a comment in the sheet saying so rather than leaving it looking abandoned.

### 7.5 MEDIUM — cash variance is now the whole of cstore's assurance

With cards unverified, `{{6}}` is the only number checking cstore. That raises
the stakes on two things already on record:

- Net cash variance annualises to **−$7,540** (analysis earlier in this session,
  over 85 days). Previously one control among several; now the only one.
- The lotto-payout netting shipped in `0f89c0a` feeds directly into that same
  figure. A payout entered wrong now has nothing else to catch it.

Worth revisiting `variance_ok_threshold` (currently 10) and
`variance_minor_threshold` (30) for cstore specifically, now that they gate the
only check.

### 7.6 MEDIUM — the history discontinuity, and how it is contained

**Where it does not exist.** At the **total** level there is no discontinuity at
all. D1 makes the columns mutually exclusive per row, so

```
total = cash + credit + debit + card_total + misc
```

is correct on both sides of the migration with **no date logic anywhere**. That
covers revenue, the daily chart, all four insight cards, the weekday and
part-of-month splits, commission thresholds, the public headline and every
reconcile figure — the great majority of the system, and none of it needs to know
the migration happened.

This is the whole reason D1 rejected writing the total into `credit_card_sales`.
Under that design the arithmetic would still work, but the split would be a lie,
and a lie is not something you can later separate back out.

**Where it does exist.** The tender split appears in exactly **three** places, and
a sweep confirms all three are scalar summaries over a range — **never a time
series**:

| Surface | Line |
|---|---|
| Sales dashboard tender tiles | `Index.html:5201` |
| Per-session sub-line (`cash · cr · db`) | `Index.html:5277` |
| Public sales tender tiles | `PublicSales.html:235` |

`buildDaily_` does compute `d.credit` / `d.debit` per day (`Sales.gs:424`), but
**nothing renders them** — the chart plots `d.total` and `byCompany`. So no
plotted line collapses to zero on the migration date. Worth knowing, because that
is the failure everyone expects from a schema change like this and it is not
present here.

**How the three surfaces are handled.** An earlier draft of §3.6 said "render each
tile when non-zero". That is arithmetically fine and **presentationally wrong**: a
range spanning the migration would show `Credit`, `Debit` **and** `Card` as three
peer tiles, implying a third tender type appeared. The correct model is:

> **Card is the tender. Credit/debit is a breakdown of it that only some rows
> carry.**

So:

- **One `Card` tile, always** = `credit + debit + card_total`. Continuous across
  the boundary, never disappears, always comparable period to period.
- **Credit/debit render as a breakdown beneath it**, not beside it, and only when
  non-zero. When the range spans the migration the breakdown states its coverage —
  *"of which $58,000 split credit/debit"* — so a reader can see it explains part
  of the total rather than assuming it explains all of it.
- **The per-session sub-line needs no coverage note.** A session is entirely one
  shape, so each row renders either `cr · db` or `card`. The discontinuity exists
  between rows, never inside one.

That makes the *display* continuous, not just the arithmetic — which is what
"addressed" has to mean, or the numbers reconcile while the screen misleads.

**Provenance.** Add `cstore_epos_from` to `config` (the migration date), for three
reasons: a reader can explain the boundary without archaeology; the coverage note
above can name it; and any future analysis can split on it deliberately rather
than inferring from which columns happen to be blank.

**Analysis discipline.** This is the one part no code can enforce. The ad-hoc
analyses run earlier in this project read `credit_card_sales` and
`debit_card_sales` straight from the workbook — **those would silently undercount
every post-migration cstore row.** Any script must sum all three card columns.
Record it in `docs/data-model.md`, which currently documents the sales sheet at 16
columns and will be wrong the moment §3.1 lands.

**What remains genuinely lost.** For cstore days after the migration, the
credit-vs-debit mix is **not recoverable** — the ePOS reports one figure and no
record of the split exists. Any question of the form *"has debit's share grown?"*
can be answered up to the migration date and no further. That is a consequence of
the till change itself, not of this design, and there is no code that recovers it.
Worth stating so nobody goes looking for it later.

### 7.7 LOW — the status vocabulary needs one review pass

`status` is written to `validation_results`, read by the in-app tab, the public
page (`Public.html:289` maps `OK` / `investigate` / everything-else to three
pills) and the message. Adding a till whose cards are out of scope touches all
four. Enumerate the values and confirm each consumer handles the new one — do not
add a value and check only the message.

### 7.8 What is correctly out of scope

Verified during the sweep, no action needed:

- **Commissions** key off `sales.total` (`Commissions.gs:157`), not the tender
  split — so they are correct as long as `total()` gains the new columns (§3.2).
- **CashHandling** touches only `cash_removed_at_close`. Untouched.
- **`Notifier` `shift.closed`** already suppresses lotto on a null, not a zero
  (`Notifier.gs:51`). Correct as written.
- **`Clover.gs`** needs no change (§3.8).
- **`cashback_paid`** is unrelated legacy; leave it.

## 8. Tests

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
7. `cloverNA` group: `{{5}}` carries no variance and `{{6}}` compares cash against
   cash. **Assert the cash variance is $0 on a clean day** — the naive
   implementation yields a variance equal to the whole card take.
8. `cardsOff` never fires for a `cloverNA` group, at any threshold — including
   when `card_variance_threshold` is set to `0`.
9. `validation_results` credit/debit cells are blank, not `0`.

**Template routing (§6)**
9a. cstore group → op key `shift_close_cstore`, **11** params, `{{11}}` reads
    "Cash matched" — never "All matched".
9b. vape group → op key `shift_close_vape`, **12** params, **no lotto param**, and
    params 1–8 byte-identical to today's v2 output for the same fixture.
9c. With the new config keys unset, **both** groups fall back to `shift_close` and
    send **13** params — the safe pre-migration state, unchanged from today.
9d. Param count matches the template shape in all three cases. A mismatch is an
    `http_400` that `dispatch_` swallows, so this assertion is the only thing
    between a wrong count and a message that silently never arrives.
9e. `formatMessage_` plain-text fallback emits no Credit/Debit lines for cstore
    and no lotto line for vape. This is what sends between deploy and approval.

**Public and in-app rendering (§7.1, §7.2)**
9f. `PublicReport` **omits** `cardMeasured`/`cardVar` on an unverified day rather
    than sending `0`. Assert the keys are absent, not zero.
9g. `Public.html` renders the one-sided card cell — claimed figure plus a "not
    verified" note, **no red variance**. Assert the string `-$1,240` cannot
    appear for a clean cstore day.
9h. In-app reconcile tab: an unverified day shows no `reconRow_('Credit', 0, X)`.
    Branch on `cloverCard == null`, not on the status string.
9i. A genuine Clover failure on **vape** still renders the existing unavailable
    treatment in all three surfaces. (9f–9i together are the point; each alone
    passes a broken implementation.)

**Guards**
10. A close sending both split and total for one company throws, naming it.
11. `cardSplitFor_` defaults to `true` for an unknown company and a missing key.

**UI / payload**
12. `rpcCloseShift` forwards both new fields (extend `wiring`, which derives
    required fields from `Index.html` — confirm it fails first).
13. cstore close sheet renders one card field, no credit/debit ids.
14. vape close sheet still renders both.
15. Dashboard tiles, the continuity assertions:
    - post-migration range → a `Card` tile, no credit/debit breakdown
    - historical range → a `Card` tile **still present** and equal to
      credit + debit, with the breakdown beneath it
    - spanning range → one `Card` tile equal to all three summed, breakdown
      present with a coverage note. **Assert `Card` is never absent** — a tile
      that vanishes mid-range is the discontinuity leaking into the UI.
15a. `total` is identical whether a range sits before, after or across the
    migration boundary for the same underlying money. This is the assertion that
    proves D1's mutual exclusivity holds end to end.
15b. Same for `PublicSales.html` tiles.
16. `PublicReport` omits `cardMeasured` on a `cloverNA` day rather than sending 0.

**Plausibility check (§7.3, if shipped in this batch)**
17. A card figure an order of magnitude off its trailing median is flagged; one
    inside normal daily variation is not. Use the real 85-day distribution for the
    fixture, not invented numbers.

**Regression:** the full existing suite — **459 assertions across 22 suites** —
must stay green. `lotto-payout`, `sign-toggle` and `parity` are the ones most
likely to be disturbed; `parity` in particular pins the dashboard and the message
together and will catch a one-sided change.

---

## 9. Suggested order

1. Setup.gs schema + migration + config defaults, with the migration tested.
2. Sales.gs columns, null reader, totals, aggregate. Tests 1–4.
3. TillSessions + WebApp plumbing and the both-shapes guard. Tests 10, 12.
4. Reconcile: `cloverNA`, status, `{{5}}`. Tests 5–9 — **the risky part, do it
   with the tests already written.**
5. Index.html close sheet, then the read-side renderers. Tests 13–15.
6. PublicSales + PublicReport. Test 16.
7. Template routing per group + `reconParams_` branching for three shapes, and
   the `formatMessage_` fallback. Tests 9a–9e.
7b. **§7.1 and §7.2 — the public page and the null-branching rule. Do not defer
   these past this batch:** publishing "Cards −$1,240.00" to stakeholders every
   day is worse than the problem being fixed.
8. Split `docs/whatsapp-template-shift-close.md` into cstore (11 params) and vape
   (12, no lotto). Owner submits **both** to Meta and sets the two config keys as
   each is approved — they can go live independently.
9. Full suite, syntax gate over every file in `src/`, CHANGELOG, push to the
   working branch for test-script verification before any merge.

---

## 10. Traps

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
- **A wrong template param count fails silently.** `dispatch_` uses
  `muteHttpExceptions`, so Meta's 400 returns `{sent:false}` and nothing throws:
  the day reconciles, the row is written, and no message arrives. Only a test
  catches it.
- **The public page has no unavailable branch** (§7.1). The in-app tab does, which
  makes it easy to check one, see a guard, and assume both are covered.
- **`cloverUnavailable` keys off a status string** (§7.2), so fixing the message
  without fixing the renderers just relocates the wrong number.
- **Don't verify config against the 2026-08-15 backup.** It is stale — it is what
  produced the wrong "v2 was never submitted" claim in the first draft.
