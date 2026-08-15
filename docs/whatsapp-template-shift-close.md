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
| **Buttons** | none |

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

💳 Cards
Credit {{10}}
Debit {{11}}
Total {{12}}

Result: {{13}}

StoreOps · automated
```

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
| 5 | `reported $651.00 / expected $650.00 (+$1.00) ✅` | Total sales vs Clover |
| 6 | `$950.00 / $950.00 (var +$0.00) ✅` | Cash recorded vs counted |
| 7 | `float $350.00 back · reserve $300.00 · $300.00 in hand` | Where the counted cash went |
| 8 | `Ashin $300.00 · $1240.00 still out with 2 people` | Who carries it, what is still out |
| 9 | `$500.00 (+$300.00 moved in)` | Lotto pot balance and movement |
| 10 | `$1.00 / $1.00 (+$0.00) ✅` | Credit, Clover vs cashier |
| 11 | `$50.00 / $50.00 (+$0.00) ✅` | Debit, Clover vs cashier |
| 12 | `$51.00 / $51.00 (+$0.00) ✅` | Card total |
| 13 | `✅ All matched` | Overall result |

## What each parameter says on a bad day

The values change shape with the situation — the template does not.

| # | Good day | Something to look at |
|---|---|---|
| 5 | `reported $651.00 / expected $650.00 (+$1.00) ✅` | `reported $651.00 (no Clover)` |
| 6 | `$950.00 / $950.00 (var +$0.00) ✅` | `$950.00 / $910.00 (var -$40.00) ⚠️` |
| 7 | `float $250.00 back · $400.00 in hand` | `float $250.00 back · reserve $300.00 · $100.00 in hand` |
| 8 | `nothing taken out today · $0.00 still out` | `Ashin $650.00 · $2180.00 still out with 3 people · ⚠️ 1 held over the limit` |
| 9 | `$500.00` | `$200.00 - short $300.00 - 400 paid` |
| 13 | `✅ All matched` | `⚠️ Clover unavailable - cards not verified` |

Parameter 9 reads `not tracked on this till` for a vape-only day, or on a
spreadsheet that hasn't run the lotto migration. A fixed template can't drop
a section, so it says so rather than sending a bare dash.

## Structural rules this satisfies

Meta rejects a template body that breaks any of these. Worth re-checking if
you edit the layout:

- Does not begin or end with a variable — it opens on `🧾 Shift Reconciliation`
  and closes on `StoreOps · automated`.
- No two variables are adjacent. Every pair has static text between them,
  which is why `Result:` sits in front of `{{13}}` and `↳` in front of `{{7}}`
  — a blank line alone would not count as separation.
- Variables are numbered `1`–`13` with no gaps.
- Body is ~300 characters, well inside the 1024 limit.

The values themselves must contain no newline, no tab, and no run of four or
more spaces, or the send is rejected at call time rather than at approval.
`Notifier.flattenForTemplate_` strips all three as a backstop, and
`Reconcile.reconParams_` builds them clean so it never has to.

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
