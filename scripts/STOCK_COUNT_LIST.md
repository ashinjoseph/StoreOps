# Stock Count List — what gets counted, and what doesn't

The POS exports every **button on the till**, not every **product**. Department
keys, services, lottery and unidentified scans all arrive as ordinary rows.
Counting those wastes a counter's time and puts meaningless entries into min/max
reporting, so they are filtered out before staff ever see the list.

## Building the list

```bash
python scripts/build_stock_count_list.py <ProductList*.csv> -o scripts/
```

Reads the semicolon-delimited POS export
(`Name;CategoryId;SalePriceExTax;SalePriceIncTax;Barcode;SalePriceTaxGroupId`)
and writes two files:

| File | Contents |
|---|---|
| `stock_count_list.csv` | the trackable products, grouped for shelf-by-shelf counting |
| `stock_count_excluded.csv` | every dropped row with the reason, so the call can be reviewed |

Re-running is safe — both files are rewritten from the exports each time.

## Current result

905 trackable products out of 931 exported rows; 26 excluded.

| Section | Products |
|---|---|
| Tobacco | 95 |
| Vape & Smoke Acc. | 22 |
| Beer & Coolers | 104 |
| Drinks | 170 |
| Chips & Snacks | 74 |
| Candy & Chocolate | 80 |
| Ice Cream & Frozen | 27 |
| Dairy | 8 |
| Grocery | 138 |
| Health & Beauty | 95 |
| Household & General | 36 |
| Electronics | 56 |

## What was excluded, and why

| Reason | Count | Examples |
|---|---|---|
| Department / open key — no barcode | 10 | `Grocery (Tax)`, `Miscellaneous`, `Cigars`, `Alcohol` |
| Lottery — sold from the terminal | 2 | `Lotto`, `Instant` |
| Service / fee PLU | 7 | `Key Cut`, `Photo`, `Fob`, `Bottle Deposit`, `Debit Card Fees` |
| Hot food, made to order | 2 | `Patty`, `Patty Combo` |
| Unidentified scan (name is the barcode, or a URL) | 6 | `06215718`, `http://pepsico.info/4yLCUx` |
| Duplicate barcode | 1 | `HEINEKEN 330UNIT` (same barcode as `Heineken Bottle 330ml`) |

Two judgement calls worth knowing about:

- **Kept** `Captain Black` (PLU `24333`/`24332`) and `RXBAR` (PLU `24435`).
  They sit on internal PLUs like the services do, but they are real goods on a
  shelf.
- **The Heineken duplicate** is a genuine POS data problem, not just an export
  artifact: `072890000224` and `72890000224` are the same barcode entered twice
  at two different prices ($3.01 and $3.60). The zero-padded row is kept. Worth
  fixing in the POS so the till stops ringing the same bottle at two prices.

## Columns

| Column | Filled by | Notes |
|---|---|---|
| `count_group` | import | the section a counter walks |
| `product_name`, `barcode`, `price` | import | `price` is tax-inclusive, to help identify the item on the shelf |
| `pos_category` | import | the POS's own category, kept for traceability |
| `priority` | import | `A` = tobacco, beer, electronics, or anything $15+; count these first |
| `stock` | **staff, on the shelf** | the only field the phone UI requires |
| `min`, `max` | later, in the sheet | far quicker to fill by dragging down a column |
| `counted_by`, `counted_at` | the app | who entered the number and when |
| `notes` | anyone | damaged stock, wrong barcode, and so on |

## Grouping

Sections are derived from `CategoryId`, which the POS spells inconsistently
(`GENERAL ITEMS` / `GENERAL ITMES`, `Ice cream` / `ICE CREAMS`,
`CHIPS` / `CHIPS & SNACKS`). `COUNT_GROUPS` in the script maps every spelling
onto one section. A category that appears in a future export without a mapping
lands in `Unsorted` rather than being dropped — check for that group after any
re-import.
