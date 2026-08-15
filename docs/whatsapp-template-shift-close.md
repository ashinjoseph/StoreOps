# WhatsApp template — `shift_close_v2`

The reconcile message the app sends at end of day. Submit this at Meta
(WhatsApp Manager → Message templates → Create), then put the approved
**name** into the `whatsapp_template_shift_close` row of the `config` tab.

Replaces the previous nine-parameter template. Those nine crammed the cash
destination, the reserve and the variance into a single parameter, because
there was no room for more — which produced the one line nobody could read.
Thirteen parameters now carry one fact each, and the template owns the layout.

---

## Submission fields

| Field | Value |
|---|---|
| **Name** | `shift_close_v2` |
| **Category** | Utility |
| **Language** | English (`en`) |
| **Header** | none |
| **Footer** | none |
| **Buttons** | one **URL** button — see below |

Create it as a **new template** rather than editing the live nine-parameter
one. A new name means the old template keeps sending until the new one is
approved, and the switch is one config edit with no window where neither works.

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

💳 Cards · cashier / Clover
Credit {{10}}
Debit {{11}}
Total {{12}}

Result: {{13}}

StoreOps · automated
```

## Button

Add a single **Visit website** button:

| Field | Value |
|---|---|
| Type | URL (static) |
| Button text | `View 7-day report` |
| URL | the deployed web app URL + `?v=recon` |

For the current primary deployment (`AKfycbyaRT5Gi…`), paste this verbatim:

```
https://script.google.com/macros/s/AKfycbyaRT5Gi2aepnsrafOwn-bErrmDawFXvhsB-pSkgb5E2PPfoOLyNQIRL9zx8lgP1wIe/exec?v=recon
```

**Check this is still the live deployment before submitting.** The URL is baked
into the approved template, and a web app deployed to a different script project
gets a different URL — which is exactly what happened at the cutover, when the
primary moved to a copy of the original prod workbook. Submitting a stale URL
costs a second approval round.

It opens the read-only report: who is holding cash, how the lotto pot moved,
and whether each day added up — no login.

**Static, not dynamic — this matters.** A static URL is baked into the approved
template, so the send carries no button component and the body stays at 13
parameters. Had the link gone in as text it would have needed a 14th parameter
and a second approval round. Nothing in `Notifier.sendTemplate_` changes.

The plain-text fallback (when no template is configured) appends the same URL
as a line instead, since plain messages have no buttons.

Set `public_report_url` in the `config` tab to the `/exec` URL — the code adds
`?v=recon` itself. Leave it blank and no link is sent at all, rather than a dead
one.

> The report needs the deployment set to **Execute as: Me** and **Who has
> access: Anyone**. That is a console setting, not code, and the link 404s
> until it is set.

## Sample values

Meta requires one sample per variable before it will accept the template.
These are real outputs from the reconcile harness, so what you paste in is
what the message actually looks like.

| # | Sample | What it is |
|---|---|---|
| 1 | `Sat 15 Aug 2026` | Date |
| 2 | `cstore + vape` | Tills in this Clover merchant group |
| 3 | `09:00–21:20` | First open to last close |
| 4 | `Ashin, Meera` | Who worked |
| 5 | `reported $651.00 / counted $651.00 (var +$0.00) ✅` | Sales claimed vs drawer + Clover |
| 6 | `$950.00 / $950.00 (var +$0.00) ✅` | Cash recorded vs counted |
| 7 | `float $350.00 back · reserve $300.00 · $300.00 in hand` | Where the counted cash went |
| 8 | `Ashin $1240.00 · Meera $640.00` | Who is holding cash, by name |
| 9 | `$500.00 (+$300.00 moved in)` | Lotto pot balance and movement |
| 10 | `$1.00 / $1.00 (var +$0.00) ✅` | Credit, cashier vs Clover |
| 11 | `$50.00 / $50.00 (var +$0.00) ✅` | Debit, cashier vs Clover |
| 12 | `$51.00 / $51.00 (var +$0.00) ✅` | Card total |
| 13 | `✅ All matched` | Overall result |

## What each parameter says on a bad day

The values change shape with the situation — the template does not.

| # | Good day | Something to look at |
|---|---|---|
| 5 | `reported $651.00 / counted $651.00 (var +$0.00) ✅` | `reported $651.00 (no Clover)` |
| 6 | `$950.00 / $950.00 (var +$0.00) ✅` | `$950.00 / $910.00 (var -$40.00) ⚠️` |
| 7 | `float $250.00 back · $400.00 in hand` | `float $250.00 back · reserve $300.00 · $100.00 in hand` |
| 8 | `nobody is holding cash` | `Ashin $1240.00 · Meera $640.00 · ⚠️ 1 shift held over the limit` |
| 9 | `$500.00` | `$200.00 - short $300.00 - 400 paid` |
| 13 | `✅ All matched` | `⚠️ cash short $40.00 · cards off $12.00` |

Parameter 9 reads `not tracked on this till` for a vape-only day, or on a
spreadsheet that hasn't run the lotto migration. A fixed template can't drop
a section, so it says so rather than sending a bare dash.

Parameter 8 always names people. A total with a headcount — *"$1240 out with
2 people"* — says there is something to chase without saying who to chase,
which is the half that makes it actionable. Where the cash handling tables
aren't set up yet it falls back to today's takings, marked `(today)`.

## How {{5}}, {{12}} and {{13}} are worked out

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
