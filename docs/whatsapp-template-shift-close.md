# WhatsApp templates — one close message per till

**`shift_close_v2` is superseded.** It served both tills, and they no longer take
the same shape of message:

- **cstore** moved to an ePOS. It reports **one card figure** and takes **no
  Clover payments**, so there is nothing to reconcile the cards against. Its
  message reports cards as information and checks cash only.
- **vape** is unchanged — Clover connected, credit and debit reported
  separately, and no lotto pot, so the reserve line it has always carried said
  *"not tracked on this till"* every single day.

So there are now two templates: **`shift_close_cstore`** (11 parameters) and
**`shift_close_vape`** (12). Both need submitting to Meta. Until each is approved
and its config key is set, **both tills keep using `shift_close_v2` exactly as
today** — the rollout is safe in any order, and safe half-done.

## Config

| Key | Value |
|---|---|
| `whatsapp_template_shift_close_cstore` | `shift_close_cstore` once approved |
| `whatsapp_template_shift_close_vape` | `shift_close_vape` once approved |
| `whatsapp_template_shift_close` | keep `shift_close_v2` — the fallback |

`Reconcile.sendNotifications_` sends one message per merchant group and picks the
op key per group, so a single-company group with its key set uses its own
template and anything else falls back. Nothing breaks while only one is live.

> **`card_variance_threshold` is `20` in production**, not the `$1` an earlier
> version of this document claimed. It now applies to **vape only** — cstore has
> no card comparison to threshold.

---

# `shift_close_cstore` — 11 parameters

| Field | Value |
|---|---|
| **Name** | `shift_close_cstore` |
| **Category** | Utility |
| **Language** | English (`en`) |
| **Header / Footer** | none |
| **Buttons** | one URL button — see below |

## Body

```
🧾 Shift Reconciliation
📅 {{1}}

🏪 {{2}}
⏰ {{3}}
👤 {{4}}

Σ Total sales
{{5}}

💵 Cash · recorded / counted
{{6}}
↳ {{7}}

🤝 Cash in hand
{{8}}

🎟 Lotto reserve
{{9}}

💳 Cards
{{10}}

Result: {{11}}

StoreOps · automated
```

## Sample values

| # | Sample | What it is |
|---|---|---|
| 1 | `Wed 9 Sep 2026` | Date |
| 2 | `cstore` | Till |
| 3 | `09:00–21:20` | First open to last close |
| 4 | `Blesson, Abijith` | Who worked |
| 5 | `$1842.00 — cash $602.00 · card $1240.00` | Revenue, split by tender |
| 6 | `$852.00 / $852.00 (var +$0.00) ✅` | Cash recorded vs counted |
| 7 | `float $250.00 back · reserve $300.00 · $302.00 in hand` | Where the cash went |
| 8 | `Blesson $1240.00 · Abijith $640.00` | Who is holding cash |
| 9 | `$500.00 (+$300.00 moved in)` | Lotto pot balance and movement |
| 10 | `$1240.00 — single total, not independently verified` | Cards, from the ePOS |
| 11 | `✅ Cash matched` | Overall result |

## Why `{{5}}` carries no variance

It used to compare what the cashier typed against `(cash counted − float) +
Clover card total`. Both sides carried a card term and they cancelled when the
cards agreed. **Remove Clover and only the reported side keeps its card term**, so
a perfectly clean day would report a variance equal to the whole card take —
roughly half of cstore revenue, on the line people read first.

Rebuilding it as a cash-only cross-check was rejected too: that just restates
`{{6}}`, which is now this till's only verdict, and two lines reporting one
variance is what made the old nine-parameter message unreadable. So `{{5}}` is
**descriptive** — full revenue, split by tender, no mark.

## Why `{{11}}` says "Cash matched"

*"All matched"* would claim a card check that no longer runs. The status is
derived from cash variance alone; `card_variance_threshold` is never read for
this till.

## What is no longer checked

The card figure is typed by a cashier and verified by nothing — roughly half of
cstore revenue moved from verified to asserted when Clover was switched off. That
is a consequence of the till migration, not of this template. The realistic
restorations are a plausibility check against the trailing median, a weekly
comparison against card settlement, or an ePOS export.

---

# `shift_close_vape` — 12 parameters

`shift_close_v2` with the lotto line removed. Everything else keeps its wording
and behaviour, including the genuine Clover cross-check and the
`⚠️ Clover unavailable` warning when the API is actually unreachable.

| Field | Value |
|---|---|
| **Name** | `shift_close_vape` |
| **Category** | Utility |
| **Language** | English (`en`) |
| **Header / Footer** | none |
| **Buttons** | one URL button — see below |

## Body

```
🧾 Shift Reconciliation
📅 {{1}}

🏪 {{2}}
⏰ {{3}}
👤 {{4}}

Σ Total sales
{{5}}

💵 Cash · recorded / counted
{{6}}
↳ {{7}}

🤝 Cash in hand
{{8}}

💳 Cards · cashier / Clover
Credit {{9}}
Debit {{10}}
Total {{11}}

Result: {{12}}

StoreOps · automated
```

## Sample values

| # | Sample |
|---|---|
| 1 | `Wed 9 Sep 2026` |
| 2 | `vape` |
| 3 | `09:00–21:20` |
| 4 | `Ashin` |
| 5 | `reported $651.00 / counted $651.00 (var +$0.00) ✅` |
| 6 | `$950.00 / $950.00 (var +$0.00) ✅` |
| 7 | `float $60.00 back · $890.00 in hand` |
| 8 | `Ashin $1240.00` |
| 9 | `$1.00 / $1.00 (var +$0.00) ✅` |
| 10 | `$50.00 / $50.00 (var +$0.00) ✅` |
| 11 | `$51.00 / $51.00 (var +$0.00) ✅` |
| 12 | `✅ All matched` |

## Why the lotto line went

Only cstore sells lotto. `{{9}}` printed *"not tracked on this till"* on every
vape message since the parameter existed — a whole line saying nothing, on a
message people skim. `reconParams_` appends the reserve parameter only where a
pot exists, so a third till that does sell lotto would get it back automatically.

---

# The button (both templates)

Add a single **Visit website** button:

| Field | Value |
|---|---|
| Type | URL (static) |
| Button text | `View sales dashboard` |
| URL | the deployed web app URL + `?v=sales` |

For the current primary deployment, paste this verbatim:

```
https://script.google.com/macros/s/AKfycbyaRT5Gi2aepnsrafOwn-bErrmDawFXvhsB-pSkgb5E2PPfoOLyNQIRL9zx8lgP1wIe/exec?v=sales
```

**The link points at sales, not the reconciliation.** The people on this thread
are owners and managers, and the message already carries the reconciliation
itself. The reconcile report still exists at `?v=recon`.

The sales view publishes **aggregates only** — totals, the daily chart split by
till, and the insight cards. No session rows, no cashier names. The reconcile
report names staff against cash amounts, which is reasonable to send to five
known numbers and unreasonable to leave on a forwardable URL.

**Static, not dynamic.** A static URL is baked into the approved template, so the
send carries no button component and the parameter count stays as documented. A
link sent as text would need an extra parameter and a second approval round.

Set `public_report_url` in `config` to the `/exec` URL — the code appends
`?v=sales` itself. Blank means no link is sent, rather than a dead one.

> The report needs the deployment set to **Execute as: Me** and **Who has
> access: Anyone**. That is a console setting, not code.

---

# Rollout

1. Submit both templates. Utility templates usually approve in minutes.
2. As each is approved, set its config key. Order does not matter; an unset key
   falls back to `shift_close_v2`.
3. Close one cstore shift and one vape shift and read both messages.

**A wrong parameter count fails silently.** Meta returns `http_400`,
`Notifier.dispatch_` uses `muteHttpExceptions`, and the reconciliation still runs
and still writes its row — you lose the message for that day, not the data, and
nothing throws. The `epos-recon` suite asserts the count per shape for exactly
this reason.

# Reference — how the figures are worked out

## How the total-sales, card-total and result figures are worked out

> Parameter numbers below refer to the retired 13-parameter `shift_close_v2`.
> The arithmetic is unchanged for vape; for cstore the total-sales line is now
> descriptive and the result covers cash only.

**{{5}} Total sales** compares what the cashier *said* against what can be
*measured*:

```
reported = cash sales + misc cash          (typed at close)
         + credit + debit + misc card      (typed at close)

counted  = (cash counted − opening float)  (the drawer, actually counted)
         + Clover card total               (the processor, not the cashier)

variance = counted − reported
```

Every term on the `reported` side is somebody's typing; every term on the
`counted` side is measured. So this line catches a mistyped sales figure as
readily as a missing note — what it can't do is tell you which, because it
sums both sides of the day into one number. That is what `{{6}}` and `{{13}}`
are for.

**{{12}} Card total** is simply the two card figures against each other:

```
cashier total = credit + misc credit + debit + misc debit   (claimed)
Clover total  = Clover credit + Clover debit                (measured)
variance      = Clover − cashier
```

Displayed cashier-first, like every other line: what was claimed, then what is
actually there. The stored `card_variance` column keeps its original direction
(`cashier − Clover`) so the sheet doesn't change meaning halfway through its
history — only the message was realigned.

**{{13}} Result** is a roll-up over **both** cash and cards:

```
Clover unreachable                     → ⚠️ Clover unavailable - cards not verified
|cash variance| > variance_ok_threshold → ⚠️ cash short/over $X
|card difference| > card_variance_threshold → ⚠️ cards off $X
neither                                → ✅ All matched
```

Both thresholds live in the `config` tab and default to `$1`. Cash variance is
`counted − (opening float + cash sales)`, summed across the day's sessions —
the same number the close sheet shows.

> **This changed in this release.** The old status tested the card difference
> *only*. A drawer $40 short still reported **✅ All matched** as long as the
> card totals agreed — the line most people read, saying the one thing it
> hadn't checked. It now fails on either, and names which.

Note what is deliberately **not** in `{{13}}`: the `{{5}}` total-sales
difference. It is a derived cross-check that double-counts the cash variance
already reported, so folding it in would flag the same shortfall twice.

### One sign convention, everywhere

Every line reads **claimed / measured (var = measured − claimed)**, so the
sign always means the same thing:

- **negative → less is there than was claimed**
- **positive → more is there than was claimed**

| Line | claimed | measured |
|---|---|---|
| `{{5}}` total sales | what the cashier typed | drawer above float + Clover |
| `{{6}}` cash | opening float + cash sales | the drawer, counted |
| `{{10}}`–`{{12}}` cards | what the cashier typed | Clover |

```
Drawer $40 short, cards agree
  {{5}}  reported $451.00 / counted $411.00 (var -$40.00) ⚠️
  {{6}}  $650.00 / $610.00 (var -$40.00) ⚠️
  {{13}} ⚠️ cash short $40.00

Drawer $25 over
  {{5}}  reported $451.00 / counted $476.00 (var +$25.00) ⚠️
  {{6}}  $650.00 / $675.00 (var +$25.00) ⚠️
  {{13}} ⚠️ cash over $25.00
```

Each cause lands somewhere distinguishable, which is why all three are worth
carrying:

| What happened | {{5}} | {{6}} | {{12}} | {{13}} |
|---|---|---|---|---|
| Drawer $40 short | `-$40.00` ⚠️ | `-$40.00` ⚠️ | `+$0.00` ✅ | `cash short $40.00` |
| Cashier over-reported cards $12 | `-$12.00` ⚠️ | `+$0.00` ✅ | `-$12.00` ⚠️ | `cards off $12.00` |
| Cashier under-reported cards $12 | `+$12.00` ⚠️ | `+$0.00` ✅ | `+$12.00` ⚠️ | `cards off $12.00` |
| Both | `-$52.00` ⚠️ | `-$40.00` ⚠️ | `-$12.00` ⚠️ | `cash short $40.00 · cards off $12.00` |

`{{5}}` alone only sums the gap — the third row shows why that matters, since
a $12 under-report moves it *positive* while money is still misrecorded.
`{{6}}` and `{{12}}` isolate the two sides and `{{13}}` names the causes.

## Switching over

1. Submit `shift_close_v2` and wait for approval (usually minutes for Utility).
2. In the `config` tab set `whatsapp_template_shift_close` = `shift_close_v2`.
3. Send a test with **Reconcile now** from the app.

Order doesn't strictly matter. If the code is deployed while config still
points at the old nine-parameter template, Meta rejects the send for a
parameter-count mismatch — `Notifier.dispatch_` uses `muteHttpExceptions` and
returns `{sent:false, reason:'http_400'}`, so nothing throws and the
reconciliation itself still runs and still writes its row. You lose the
message for that day, not the data.
