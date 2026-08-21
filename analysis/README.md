# RetailPOS_DB — sales intelligence

Analysis of `RetailPOS_DB`, the point-of-sale database behind Scarbro Mart
(1744 Lawrence Ave E, Scarborough). Covers 15 Apr – 19 Aug 2026: 17,718
transactions, $237,720 of sales.

The dashboard is **`dashboard.html`** — one self-contained file, no server
needed. Open it in any browser.

---

## Headline findings

**Sales are flat, and that flat line is hiding two real movements.** Total sales
trend +1.1% across the window at p = 0.91 — no trend at all. But underneath,
customer visits rose **+14.6%** (p = 0.015) while the average basket fell
**−11.5%** (p = 0.045). Both clear significance; the total does not, because they
almost exactly cancel. More people are coming in and each is spending less.
Traffic is not the constraint — what happens at the counter is.

**Lottery is 40% of the sales line and about 5% of what the business earns.**
$151,681 of tickets, $56,572 paid out in prizes, $95,109 held — nearly all of
which is remitted to OLG. At a 5% retailer commission that is roughly $7,584 of
actual income, against $142,611 of retail. Lottery is reported inside sales here
because that is how the store books it, and given its own section so the
distinction never gets lost.

**Only 15.7% of lottery customers buy anything else.** 7,491 visits — 42% of every
transaction in four months — bought a ticket and left. The ones who do add goods
spend $16.11, *more* than the $13.60 of a customer who never touches lottery. So
this is not a low-value crowd, it is an unserved one. Converting one in twenty
would add roughly $5,100 over a comparable period.

**Category momentum is real but partly seasonal.** Drinks +49.5%, ready-to-drink
+246%, grocery-no-tax +33.7% all clear significance. All three are also exactly
what a mid-April-to-mid-August window inflates. Four months cannot separate trend
from summer — treat them as seasonal until a full year says otherwise. Tobacco is
flat in dollars and has given up 2.35 points of retail share, which is the more
reliable signal.

**Profit cannot be calculated.** Purchase cost is present on 102 of 842 products
sold, covering 6.8% of revenue. The POS margin column sums to ~90% of sales,
which is what that calculation returns when cost defaults to zero. Nothing here
uses it.

---

## Repairs applied to the database

Three invoices carried mis-keyed *cash tendered* amounts — the worst being
**$804,906,004,014.00 against a $20.00 sale** — which pushed reported cash to
$886.9 billion and made every payment report meaningless.

`fix_miskeyed_tender.sql` repairs them: tendered is set equal to the
sale amount and change to zero. It selects rows **by rule, not by hardcoded ID**
(tender above $10,000 *and* more than $500 over its own sale), runs in a
transaction with a post-check that rolls back if a repaired invoice stops
balancing, and is safe to re-run — once fixed, rows no longer match.

`GrandTotal` was never affected by the mis-keying, so sales figures were correct
throughout. Only cash/tender reporting was wrong.

---

## Rebuilding from the backup

Requires Docker. The `.bak` is a **SQL Server 2008 full backup** (MTF container,
compat level 100) — not MySQL, despite the extension. It restores on SQL Server
2022, which still accepts that compatibility level.

```bash
./restore.sh /path/to/RetailPOS_DB.bak   # SQL Server 2022 in Docker, restore
sqlcmd -S localhost -U sa -i fix_miskeyed_tender.sql   # repair tender rows
./extract.sh                              # aggregate extracts -> analysis/data/*.psv
python3 analyse.py                        # statistics      -> analysis/data/insights.json
python3 build.py                          # embed data      -> dashboard.html
```

`analyse.py` needs `numpy`, `pandas` and `scipy`.

---

## Method

Trend figures are ordinary least squares on **whole Sun–Sat weeks only** — the
extract starts on a Wednesday and ends on a Wednesday, and including those stubs
would read as a collapse at both ends. 17 whole weeks qualify. Every trend is
reported with R² and a two-sided p-value; "significant" means p < 0.05.

17 weeks is enough to detect a strong trend and not enough to detect a weak one,
so **"not significant" here means *not proven*, not *proven flat*.**

Category momentum compares the first half of that window against the second.
Product movers compare the first 42 days against the last 42.

---

## Layout

| Path | What it is |
|---|---|
| `dashboard.html` | The dashboard — self-contained, data embedded |
| `restore.sh` | Restores the `.bak` into SQL Server 2022 in Docker |
| `fix_miskeyed_tender.sql` | Rule-based repair for the mis-keyed tender rows |
| `extract.sh` | Aggregate extracts from the restored database |
| `analyse.py` | Regressions, momentum, attach rates → `insights.json` |
| `build.py` | Embeds `insights.json` into the dashboard |
| `data/*.psv` | Pipe-delimited aggregate extracts |
| `data/insights.json` | Everything the dashboard reads |

### Schema notes

- `Invoice_Payment.Amount` is cash **tendered**, not applied. Revenue must come
  from `InvoiceInfo.GrandTotal` or the line items — summing payments overstates
  by the change given.
- `Product.Category` joins on category **name**, not `Category.CAT_ID`.
- Lottery lives in category `LOTTERY`; payouts are negative rows
  (`LOTTO PAY OUT`, `INSTANT PAY OUT`) and must be netted, not filtered out.
- 7,491 of 17,718 invoices are lottery-only and contain no retail goods.

---

## Privacy

`InvoiceInfo` carries cardholder fields (`CardNo`, `CardHolder`, `ApprovalCode`,
`CardType`). **None were read.** Everything in `data/` is aggregate —
daily and weekly totals, category and product revenue, tender counts, basket
buckets. No customer or card data leaves the database.

The backup itself is **not in this repository** and must not be committed;
`.gitignore` excludes `*.bak`. This repository is private and the dashboard is
not published to GitHub Pages, because these are real trading figures.
