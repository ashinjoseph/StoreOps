# Bulk upload — products & categories

How to load many products at once into the catalog (the "EPOS" side of
StoreOps), which columns each product type needs, and how categories
behave during a bulk import.

Blank fill-in templates live in [`scripts/templates/`](../scripts/templates/).

---

## 1. Before you can import

Bulk import writes into the catalog tabs, so the schema has to exist first.

| Install state | What to run |
|---|---|
| Brand-new sheet | **🏪 StoreOps → ⚙️ First-time Setup** (see [quickstart.md](quickstart.md)) |
| Existing install still on the flat v1 catalog | **🏪 StoreOps → 🧱 Migrate Product Master → v2 (per-type)** once |

Setup/migration creates:

- `product_master` — the thin **core** tab (identity + *resolved* cost /
  sell / margin)
- `product_beer_detail`, `product_cigarettes_detail`, `product_vape_detail`
  — per-type **detail** tabs holding the inputs those numbers derive from
- `_pm_beer_staging`, `_pm_cig_staging`, `_pm_vape_staging`,
  `_pm_other_staging` — hidden **staging** tabs you paste into

Grocery/other has no detail tab — cost and sell are entered directly.

---

## 2. The upload flow

There is **no bulk upload button in the web app.** Import runs from the
spreadsheet menu (or the admin-only `rpcImportProductMasterFromStaging`
RPC). One import handles one type at a time.

1. Pick the template for your product type from `scripts/templates/` and
   fill in one row per product.
2. In Google Sheets, un-hide the matching `_pm_<type>_staging` tab.
3. Click cell **A3** and paste. (Row 1 is the title banner, row 2 is the
   column headers — data starts at row 3.)
4. **🏪 StoreOps → 📦 Import &lt;Type&gt; (from staging)**.
5. Read the summary: `Inserted` / `Updated` / `Skipped` / `Errors`.

Column order is tolerant — the importer matches on the row-2 header names,
so extra or reordered columns are fine as long as the names match. Blank
rows, and a row that repeats the literal header `product_name`, are skipped
silently, so pasting the header line by accident is harmless.

> **Don't use `scripts/product_master_template.csv`.** It is a leftover from
> the flat v1 catalog (it still has `product_id`, `case_size`,
> `last_invoice_no` in the core columns) and does not match any staging tab.
> Nothing references it. Use `scripts/templates/` instead.

To regenerate the blank templates after a schema change:

```bash
python3 scripts/import_product_master.py --templates
```

That reads the same column layouts the importer uses, so templates can't
drift from the staging tabs. (Plain `python3 scripts/import_product_master.py`
converts the master **.xlsx** sheets into filled staging CSVs instead, and
needs `openpyxl`; `--templates` does not.)

### Re-running an import is safe

Upsert is keyed on **SKU**, case-insensitive:

| Type | Key |
|---|---|
| beer | SKU **+ sell unit** (one SKU is listed once per sell unit — each is its own product) |
| cigarettes, vape, grocery/other | SKU |
| rows with no SKU | falls back to `brand` + `product_name` |

A matching row is **updated in place** and its pricing recomputed; a new
row is **inserted**. A SKU-less row whose brand+name already exists is
**skipped**, not duplicated. So re-pasting a corrected CSV is a price
update, not a second copy of the catalog.

---

## 3. Columns per type

Every template starts with the same 12 **core** columns, then appends that
type's own input columns.

**Core (all types):** `sku`, `barcode`, `product_name`, `brand`,
`category`, `subcategory`, `pack_size`, `unit`, `supplier`,
`min_sell_price`, `notes`, `source_file`

`product_name` and `category` are the only required ones.
`min_sell_price` is the discount floor — the UI flags any product whose
sell price falls below it.

Leave out `product_id`, `cost_price`/`sell_price` for derived types,
`margin_amount`, `margin_pct`, `active`, and the `created_*` / `updated_*`
columns. The import fills those in.

### Beer — `product_bulk_upload_beer.csv`

Also covers cooler/RTD, wine, cider and seltzer: they share beer's pricing
model, so `category` is `beer` and the real class goes in `subcategory`.

Extra columns: `sell_unit`, `lcbo_case_price`, `units_per_case`,
`packs_per_case`, `cost_input`, `deposit_per_unit`, `target_margin_pct`

```
Sell = Cost / (1 − Margin) + Deposit
```

Cost falls back to `lcbo_case_price ÷ units_per_case` when `cost_input` is
blank, so a row needs **either** `cost_input` **or** both of those. Margin
is reported excluding the deposit pass-through.

Example row:

| sku | product_name | category | subcategory | unit | sell_unit | lcbo_case_price | units_per_case | cost_input | deposit_per_unit | target_margin_pct |
|---|---|---|---|---|---|---|---|---|---|---|
| 17853 | Corona Extra 473Ml | beer | Beer | Single | Single | 73.68 | 24 | 3.07 | 0.10 | 0.2108 |

### Cigarettes — `product_bulk_upload_cigarettes.csv`

Extra columns: `cost_per_carton`, `packs_per_carton`, `target_margin_pct`,
`review_sold`

```
Cost/Pack = Cost/Carton ÷ Packs/Carton
Sell/Pack = Cost/Pack / (1 − Margin)
```

Both `cost_per_carton` and `packs_per_carton` must be > 0. Pack size
(20s / 25s) goes in the core `pack_size` column. Tobacco tax is already
baked into the carton cost; there's no deposit.

Example row:

| product_name | category | pack_size | unit | supplier | cost_per_carton | packs_per_carton | target_margin_pct |
|---|---|---|---|---|---|---|---|
| John Player Bold KS 10x20 | cigarettes | 20s | pack | ITC | 150.73 | 10 | 0.10 |

### Vape — `product_bulk_upload_vape.csv`

Extra columns: `product_line`, `form_factor`, `puffs`, `eliquid_ml`,
`nicotine`, `flavor`, `purchase_price`, `sale_price`, `sale_price_credit`,
`last_invoice_no`

Prices are **given**, not derived — `sale_price` must be > 0.
`sale_price_credit` defaults to `sale_price` when blank. Attributes get
real columns instead of being crammed into the product name.

Example row:

| sku | product_name | brand | category | subcategory | unit | form_factor | puffs | nicotine | flavor | purchase_price | sale_price |
|---|---|---|---|---|---|---|---|---|---|---|---|
| YV-0142 | Geek Bar Pulse Blue Razz | Geek Bar | vape | Disposable | each | Disposable | 15000 | 2% | Blue Razz Ice | 11.50 | 24.99 |

### Grocery / other — `product_bulk_upload_grocery_other.csv`

Extra columns: `cost_price`, `sell_price`, `sell_price_credit`

No detail tab and no derivation — the prices you type are the prices used.

Example row:

| sku | barcode | product_name | brand | category | subcategory | unit | cost_price | sell_price |
|---|---|---|---|---|---|---|---|---|
| GRO-0001 | 0640522123456 | Lay's Classic 66g | Lay's | grocery | Chips | each | 0.95 | 2.29 |

`target_margin_pct` is a **fraction, not a percentage** — `0.21`, not `21`.
The staging tab formats the column as a percent, so typing `21%` also works;
typing `21` gives you a 2100% margin.

---

## 4. Categories

### There is no bulk category upload, and none is needed

`category` is a **fixed enum of five values**, hard-coded in
`ProductMaster.VALID_CATEGORIES` (`src/ProductMaster.gs`) and mirrored as a
dropdown by `PRODUCT_CATEGORIES` in `src/Setup.gs`:

```
vape | cigarettes | beer | grocery | other
```

`vapes` is accepted as an alias for `vape`. Anything else is rejected.

These aren't labels — each one selects a **pricing engine and a detail
table**. `beer` means "LCBO case-price + deposit maths", `cigarettes` means
"carton-to-pack maths". So adding a sixth category isn't data entry; it's a
code change: a new entry in the `ProductTypes` registry (detail columns,
`derivePricing`, `validate`, `fieldSchema`), a detail tab and a staging tab
in `Setup.gs`, a menu item, and the new name added to both constants above.
Until then, put the finer classification in `subcategory`.

### Does a product bulk upload create categories automatically?

**`category` — no.** An unrecognised value doesn't create anything. It
throws per row, is counted in the import's `Errors` total, and *that row is
not imported* — the rest of the paste still goes through. The error reads:

```
invalid category: "snacks" (expected one of: vape, cigarettes, beer, grocery, other)
```

If you leave `category` blank, the importer defaults it to the type you're
importing (`other` for the grocery/other tab), so blanks are safe.

**`subcategory` — yes, effectively.** It is free text with no enum, no
validation and no dropdown. Whatever you type is stored as-is on first use
and immediately shows up wherever subcategories are read. That's the
supported way to bulk-add your own groupings: `Chips`, `Lager`, `Cooler/RTD`,
`Disposable` — just put them in the column and import.

The core `category` column also carries a dropdown, so pasting an invalid
value leaves the cell flagged in the sheet as well as erroring on import.

### The other "category" in the codebase

`order_catalog` (the shopping-list picker) has its own **free-text**
category, seeded from `ORDER_CATEGORIES` — `Grocery`, `Cigarettes`,
`Vapes`, `Other`, Title Case. `OrderCatalog.create` accepts any string, so
those categories *do* auto-create when an item uses a new one.

It is a **separate table with a separate list** and the product import never
touches it. Importing products does not add order-catalog categories, and
vice versa. Note the two lists disagree on purpose: product categories are
lowercase and closed, order categories are Title Case and open.
