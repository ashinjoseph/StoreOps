# Product Master — Per-Type Bulk Import & Upsert

The catalog is split into a thin **core** tab (`product_master`) plus one
**detail** tab per type. The core holds identity + the *resolved* per-unit
`cost_price` / `sell_price` / `margin_*`; the detail tabs hold the type-specific
INPUTS those numbers are derived from (in code, on the server):

| Type | Detail tab | Pricing model |
|---|---|---|
| beer (+ cooler/RTD, wine, cider) | `product_beer_detail` | `Sell = Cost/(1−Margin) + Deposit`; Cost falls back to `LCBO case price / units per case` |
| cigarettes | `product_cigarettes_detail` | `Cost/Pack = Cost/Carton ÷ Packs/Carton`; `Sell = Cost/Pack / (1−Margin)` |
| vape | `product_vape_detail` | prices given; attributes (puffs, mL, nicotine, flavor) are real columns |
| grocery / other | — (core only) | plain `cost` / `sell` entered directly |

Field definitions, pricing math and the per-type form schema all live in
`ProductTypes.gs` (the single source of truth). Don't hand-maintain column lists.

## Files

- **`import_product_master.py`** — reads the master spreadsheets and writes one
  staging CSV per type:
  - `references/master_beer_sheet.xlsx` → `product_master_beer_staging.csv`
  - `references/master_cigarette_sheet.xlsx` → `product_master_cig_staging.csv`
  - `YV Vape Master Price List.xlsx` → `product_master_vape_staging.csv`
  - (grocery/other) → `product_master_other_staging.csv` (header-only template)

  Resolved cost/sell/margin are left **blank** — the server derives them.

## Primary key

Upsert keyed by **SKU** (case-insensitive). **Beer** keys on **SKU + sell unit**
because the same SKU is listed once per sell unit (Single, 6-Pack, …) and each
listing is its own product. SKU-less rows (e.g. cigarettes) fall back to
`brand + product_name`. Re-pasting the same CSV updates prices and inserts new
products without duplicating.

## One-time migration (existing installs)

Run **🧱 Migrate Product Master → v2 (per-type)** from the 🏪 StoreOps menu once.
It RENAMES the old `product_master` (and `_pm_import_staging`) to
`*__archived_<date>` — nothing is deleted — and creates the new core + detail +
per-type staging tabs. Then re-import fresh from the masters (below); the master
spreadsheets are the source of truth, so no data is parsed out of the archive.

## Workflow (per type)

1. `python scripts/import_product_master.py`
2. In Google Sheets, un-hide the `_pm_<type>_staging` tab (`_pm_beer_staging`,
   `_pm_cig_staging`, `_pm_vape_staging`, `_pm_other_staging`).
3. Click cell **A3**, paste the matching CSV. Sheets auto-parses commas.
4. From the **🏪 StoreOps** menu, run **📦 Import &lt;Type&gt; (from staging)**.
5. Read the summary alert: `Inserted` / `Updated` / `Skipped` / `Errors`.

## Column reference

Every staging tab starts with the same **core** columns, then appends that
type's input columns (order is `ProductMaster.stagingLayout(type)`):

**Core (all types):** `sku`, `barcode`, `product_name`, `brand`, `category`,
`subcategory`, `pack_size`, `unit`, `supplier`, `min_sell_price`, `notes`,
`source_file`.

**Beer detail:** `sell_unit`, `lcbo_case_price`, `units_per_case`,
`packs_per_case`, `cost_input`, `deposit_per_unit`, `target_margin_pct` (0..1).

**Cigarettes detail:** `cost_per_carton`, `packs_per_carton`,
`target_margin_pct` (0..1), `review_sold`.

**Vape detail:** `product_line`, `form_factor`, `puffs`, `eliquid_ml`,
`nicotine`, `flavor`, `purchase_price`, `sale_price`, `sale_price_credit`,
`last_invoice_no`.

**Grocery/Other:** `cost_price`, `sell_price`, `sell_price_credit` (entered
directly — no derivation).

`product_id`, `margin_amount`, `margin_pct`, `active`, `created_*`, `updated_*`,
and the resolved `cost_price`/`sell_price` for derived types are filled by the
import — leave them out of the staged inputs.
