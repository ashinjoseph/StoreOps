#!/usr/bin/env python3
"""
import_scarbro_inventory.py — stage the Scarbro Mart scanned inventory
for the Grocery/Other bulk import.

Reads:
  references/scarbro_mart_inventory.xlsx   (sheet "master-inventory")

Writes:
  scripts/scarbro_inventory_other_staging.csv

matching the column order of the `_pm_other_staging` tab
(ProductMaster.stagingLayout_ / Setup.gs setupOtherStagingSheet_).

WORKFLOW:
  1. python scripts/import_scarbro_inventory.py
  2. Un-hide _pm_other_staging in the spreadsheet.
  3. Select A3, paste the CSV (Sheets auto-parses commas).
  4. Run "📦 Import Grocery/Other (from staging)" from the StoreOps menu.

WHY THE SOURCE IS NOT IMPORTED AS-IS
------------------------------------
The file carries four columns — UPC, name, a free-text CATEGORIE, and a
retail price. Three consequences drive everything below.

* There is no cost anywhere in it. cost_price is left blank rather than
  guessed, so margin reads 100% until costs are filled in. A fabricated
  cost would look like data.

* `category` on the core row is a closed set (ProductMaster.gs VALID_
  CATEGORIES). The 32 free-text CATEGORIE values cannot go there, so they
  are preserved verbatim in `subcategory` and the row is bucketed into
  grocery / other.

* Alcohol is deliberately NOT filed as category 'beer'. The beer type
  derives its price from a product_beer_detail row (LCBO case price,
  units per case, deposit, target margin) and ProductMaster.update
  re-derives from that detail on every save. A 'beer' row with no detail
  row would have its price zeroed the first time someone edited it, so
  these land as grocery with 'Beer' in subcategory — promotable later,
  once cost data exists.

DEPENDENCY: openpyxl  (pip install openpyxl)
LOCAL-ONLY — clasp pushes rootDir 'src', so nothing here is uploaded.
"""

import csv
import re
import sys
from collections import Counter
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.stderr.write("ERROR: openpyxl not installed.  pip install openpyxl\n")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "references" / "scarbro_mart_inventory.xlsx"
OUT = ROOT / "scripts" / "scarbro_inventory_other_staging.csv"
SOURCE_FILE_TAG = "Scarbro Mart Inventory"

# Column order of _pm_other_staging. Must stay in step with
# ProductMaster.stagingLayout_('other').
COLUMNS = [
    "sku", "barcode", "product_name", "brand", "category", "subcategory",
    "pack_size", "unit", "supplier", "min_sell_price", "notes", "source_file",
    "cost_price", "sell_price", "sell_price_credit",
]

# Non-consumables → 'other'; everything else is 'grocery'. subcategory keeps
# the original CATEGORIE either way, so a wrong call here costs nothing but a
# filter and can be re-bucketed without re-importing.
NON_CONSUMABLE = {
    "Batteries", "Easy Heat", "Intimacy", "Oral Health",
    "Paper & Plastic", "Shaving", "Camping", "Cat Food",
}

# Already in product_master as a beer row with real derived pricing. Dedup is
# exact-lowercase brand+name for SKU-less rows, and the two spellings differ in
# punctuation — so the importer would not catch it and we would end up with two
# Muskoka rows, one priced properly and one bare. Excluded by name.
ALREADY_IN_CATALOG = {"muskoka mad tom ipa (473 ml)"}


def digits(value):
    """UPCs arrive pipe-wrapped: |00005880750090| → 00005880750090."""
    return re.sub(r"\D", "", str(value or ""))


def main():
    if not SOURCE.exists():
        sys.stderr.write("ERROR: %s not found\n" % SOURCE)
        sys.exit(1)

    wb = openpyxl.load_workbook(SOURCE, data_only=True)
    ws = wb["master-inventory"]
    rows = [r for r in ws.iter_rows(values_only=True)
            if any(c not in (None, "") for c in r)]
    wb.close()

    header, data = rows[0], rows[1:]
    if [str(c).strip() for c in header[:4]] != [
            "UPC", "ITEM NAME & SIZE", "CATEGORIE", "Store Price"]:
        sys.stderr.write("ERROR: unexpected header %r\n" % (header,))
        sys.exit(1)

    staged, skipped_unpriced, skipped_dupe, nameless = [], 0, 0, []
    for upc, name, categorie, price in (r[:4] for r in data):
        name = str(name or "").strip()
        if not name:
            # Scanned but never named. product_name is the dedup key for
            # SKU-less rows, so importing it blank would be unmatchable and
            # invisible in the picker. Reported, not swallowed.
            nameless.append((digits(upc), str(categorie or "").strip(), price))
            continue
        if price in (None, ""):
            skipped_unpriced += 1          # nothing to sell it at
            continue
        if name.lower() in ALREADY_IN_CATALOG:
            skipped_dupe += 1
            continue

        cat = str(categorie or "").strip()
        staged.append({
            "sku": "",
            "barcode": digits(upc),
            "product_name": name,
            "brand": "",
            "category": "other" if cat in NON_CONSUMABLE else "grocery",
            "subcategory": cat,
            "pack_size": "",
            "unit": "",
            "supplier": "",
            "min_sell_price": "",
            "notes": "",
            "source_file": SOURCE_FILE_TAG,
            "cost_price": "",              # absent from source — never guessed
            "sell_price": price,
            "sell_price_credit": "",
        })

    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(staged)

    buckets = Counter(r["category"] for r in staged)
    with_barcode = sum(1 for r in staged if r["barcode"])

    print("wrote %s" % OUT.relative_to(ROOT))
    print("  staged rows        : %d  (of %d in source)" % (len(staged), len(data)))
    print("    grocery          : %d" % buckets["grocery"])
    print("    other            : %d" % buckets["other"])
    print("  held back unpriced : %d" % skipped_unpriced)
    print("  excluded duplicate : %d" % skipped_dupe)
    if nameless:
        print("  scanned but unnamed: %d  — needs a name before it can import"
              % len(nameless))
        for upc, cat, price in nameless:
            print("      UPC %s  %s  %s" % (upc, cat, price))
    print("  carrying a barcode : %d  (%d without)"
          % (with_barcode, len(staged) - with_barcode))

    # SKU-less, brand-less rows dedup on name alone, so two different items
    # sharing a name would collapse into one on import. Name them now.
    dupes = [n for n, c in Counter(r["product_name"].lower()
                                   for r in staged).items() if c > 1]
    if dupes:
        print("\n  WARNING: %d duplicate name(s) — these collapse on import:" % len(dupes))
        for n in dupes:
            print("    %s" % n)
    else:
        print("  no duplicate names — import is safely repeatable")


if __name__ == "__main__":
    main()
