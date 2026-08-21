# RetailPOS_DB analysis

A read of the Scarbro Mart point-of-sale backup (`RetailPOS_DB 08-19-2026_23-04-36.bak`),
covering 15 Apr – 19 Aug 2026.

The dashboard is `scarbro-pos-review.html` — a standalone page with the aggregate data
embedded, so it opens in any browser with no server or network access.

## What the backup actually is

Despite the `.bak` extension being described as MySQL, the file is a **Microsoft SQL Server**
full backup — MTF container, `TAPE` header, written by SQL Server 2008 (v10) at compatibility
level 100. MySQL tooling cannot read it. It restores cleanly on SQL Server 2022, which still
accepts compat level 100 (the oldest level it supports).

| | |
|---|---|
| Database | `RetailPOS_DB` |
| Source | `DESKTOP-VDRD582\SQLEXPRESS` |
| Taken | 2026-08-19 23:04:36 |
| Size | 251.8 MB (264,003,072 bytes on disk) |
| Recovery / collation | SIMPLE / `SQL_Latin1_General_CP1_CI_AS` |
| Data files | `RetailPOS_DB.mdf` 252.3 MB, `RetailPOS_DB_log.LDF` 109.8 MB |

## Headline findings

**Lottery is 40% of turnover and almost none of the income.** The POS books every lottery
ticket at face value as a sale. That money belongs to OLG; the store earns a commission on it.
Retail revenue is **$142,611**, not the **$237,720** the system reports — a 67% overstatement.
Lottery net of payouts is $95,109 (gross ticket sales $151,681, payouts $56,572).

**Three mis-keyed cash entries corrupt every payment report.** Invoices 13424, 6795 and 17
have absurd *cash tendered* values ($804,906,004,014 against a $20.00 sale, and two others),
pushing reported cash to $886.9 billion. The error is confined to the tender field —
`GrandTotal` is correct on all three, so sales figures were never affected.

**Cost price is missing on 94% of what is sold.** Only 102 of 842 sold products carry a
`PurchaseCost`, covering 6.8% of revenue. The POS `Margin` column therefore sums to $213,508
(~90% of sales), which is what the calculation returns when cost defaults to zero. No profit
analysis is possible from this data until costs are backfilled.

## Reproducing

Requires Docker. `restore.sh` starts SQL Server 2022, restores the backup, and `extract.sh`
writes the aggregates in `data/`.

```bash
./restore.sh /path/to/RetailPOS_DB.bak
./extract.sh
```

`data/*.psv` are pipe-delimited aggregates; `data/dash.json` is the same data bundled for the
dashboard. Re-embed it after regenerating:

```bash
python3 embed.py
```

## Schema notes

The tables that carry data:

| Table | Rows | What it is |
|---|---:|---|
| `InvoiceInfo` | 17,718 | Sale headers — `GrandTotal`, `InvoiceDate`, tender fields |
| `Invoice_Product` | 26,451 | Line items — `Qty`, `TotalAmount`, `PurchaseRate`, `Margin` |
| `Invoice_Payment` | 17,922 | Tender splits — `PaymentMode`, `Amount` |
| `Product` | 23,567 | Product master — `Category` holds the category *name*, not an ID |
| `LedgerBook` | 35,439 | Not used here |
| `Logs` | 28,308 | Not used here |

Gotchas worth knowing:

- `Invoice_Payment.Amount` is cash **tendered**, not applied. Revenue must come from
  `InvoiceInfo.GrandTotal` or the line items — summing payments overstates by the change given.
- `Product.Category` joins on name, not `Category.CAT_ID`.
- Lottery lives in category `LOTTERY`; payouts are negative rows
  (`LOTTO PAY OUT`, `INSTANT PAY OUT`) and must be netted, not filtered out.
- 7,492 of 17,718 invoices are lottery-only and contain no retail goods.

Three independent totals reconcile to within 0.1%: invoice headers $237,426, tender less
change $237,457, line items $237,660. The spread is invoice-level discounts and round-off.

## Privacy

`InvoiceInfo` contains cardholder fields (`CardNo`, `CardHolder`, `ApprovalCode`, `CardType`).
**None of it was extracted.** Everything in `data/` is aggregate: daily totals, hour/weekday
totals, category and product revenue, tender counts, basket buckets. No customer, card or
cardholder data leaves the database.

The backup itself is not in this repo and must not be committed — `.gitignore` excludes `*.bak`.
