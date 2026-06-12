#!/usr/bin/env python3
"""
import_product_master.py — pre-processor for the StoreOps ProductMaster
bulk import.

Reads two Excel files at the project root:
  * YV Vape Master Price List.xlsx — vape-only master, 18 cols, ~996 SKUs
  * Inventory-old.xlsx              — legacy 3-block sheet (Beer | Cigarettes | Vape)

Normalizes both into a single flat schema matching the product_master sheet
(22 columns; 5 are placeholders filled in by the import RPC), de-duplicates
in-memory (SKU first, else brand+name), and writes:

  scripts/product_master_staging.csv

WORKFLOW:
  1. python scripts/import_product_master.py
  2. In the spreadsheet, un-hide _pm_import_staging tab.
  3. Select cell A3, paste the CSV (Sheets auto-parses commas).
  4. Run "📦 Import Product Master (from staging)" from the StoreOps menu.
  5. Read the imported / skipped / errors summary alert.

DEPENDENCY: openpyxl  (pip install openpyxl)

This script is LOCAL-ONLY — not pushed by CLASP (see .claspignore).
"""

import csv
import os
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.stderr.write(
        "ERROR: openpyxl not installed.\n"
        "Install it:  pip install openpyxl\n"
    )
    sys.exit(1)

# ────────────────────────────────────────────────────────────
# Paths
# ────────────────────────────────────────────────────────────
HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent

VAPE_FILE = PROJECT_ROOT / "YV Vape Master Price List.xlsx"
INV_FILE = PROJECT_ROOT / "Inventory-old.xlsx"
OUT_FILE = HERE / "product_master_staging.csv"

# Header row order (22 cols) — must match Setup.js's setupPmImportStagingSheet_
HEADERS = [
    "product_id",            # 1  placeholder (filled by import RPC)
    "sku",                   # 2
    "barcode",               # 3
    "product_name",          # 4
    "brand",                 # 5
    "category",              # 6
    "subcategory",           # 7
    "pack_size",             # 8
    "unit",                  # 9
    "cost_price",            # 10
    "sell_price",            # 11
    "sell_price_credit",     # 12
    "min_sell_price",        # 13
    "margin_amount",         # 14 placeholder (computed)
    "margin_pct",            # 15 placeholder (computed)
    "supplier",              # 16
    "last_invoice_no",       # 17
    "source_file",           # 18
    "active",                # 19 placeholder (defaults TRUE)
    "notes",                 # 20
    "created_by",            # 21 placeholder (IMPORT or actorId)
    "created_at",            # 22 placeholder (now)
]

# ────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────
def empty_row():
    """Return a dict keyed by HEADERS with empty values."""
    return {h: "" for h in HEADERS}


def s(v):
    """Stringify a cell value, trimming whitespace; '' for None."""
    if v is None:
        return ""
    return str(v).strip()


def num(v):
    """Numeric coercion; returns 0.0 for blanks and unparseable values."""
    if v is None or v == "":
        return 0.0
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def cell(ws, row, col):
    """1-indexed sheet cell value."""
    return ws.cell(row=row, column=col).value


# ────────────────────────────────────────────────────────────
# Parser 1: YV Vape Master Price List
# ────────────────────────────────────────────────────────────
def parse_vape_master(path):
    """Source columns (A..R, 18 total):
       SKU | Brand | Product Line | Category | Form Factor | Puffs | Pack Size
       | E-Liquid (mL) | Nicotine | Flavor | Purchase Price (Cash/Debit)
       | Sale Price (Cash/Debit) | Sale Price (Credit Card) | Margin $
       | Margin % | Supplier | Last Invoice # | Notes
    """
    if not path.exists():
        sys.stderr.write(f"WARN: {path.name} not found — skipping vape parser.\n")
        return []

    wb = openpyxl.load_workbook(path, data_only=True)
    if "Master Price List" not in wb.sheetnames:
        raise RuntimeError(
            f"{path.name}: 'Master Price List' tab not found "
            f"(found: {wb.sheetnames})"
        )
    ws = wb["Master Price List"]

    # Verify header row
    h1 = s(cell(ws, 1, 1)).lower()
    if "sku" not in h1:
        raise RuntimeError(
            f"{path.name}: expected SKU at A1, got {h1!r}. File layout shifted?"
        )

    out = []
    for r in range(2, ws.max_row + 1):
        sku           = s(cell(ws, r, 1))
        brand         = s(cell(ws, r, 2))
        product_line  = s(cell(ws, r, 3))
        # category    = s(cell(ws, r, 4))  # always "Disposable" etc — moved to subcategory
        form_factor   = s(cell(ws, r, 5))
        puffs_raw     = cell(ws, r, 6)
        pack_size     = s(cell(ws, r, 7))
        eliquid_ml    = cell(ws, r, 8)
        nicotine      = s(cell(ws, r, 9))
        flavor        = s(cell(ws, r, 10))
        cost_price    = num(cell(ws, r, 11))
        sell_price    = num(cell(ws, r, 12))
        sell_credit   = num(cell(ws, r, 13))
        # margin $ + margin % at cols 14, 15 — ignored (recomputed on write)
        supplier      = s(cell(ws, r, 16))
        invoice_raw   = cell(ws, r, 17)
        notes         = s(cell(ws, r, 18))

        # Bail at the first blank SKU row (signals end of data; the sheet has
        # 1000 rows of grid but only ~996 of data).
        if not sku and not brand and not product_line:
            continue

        # Compose product_name with attributes encoded inline so the schema
        # stays flat (vape-only fields don't get their own columns).
        name_parts = [p for p in [brand, product_line, flavor] if p]
        extras = []
        if puffs_raw:
            try:
                pn = int(float(puffs_raw))
                extras.append(f"{pn} puffs")
            except (TypeError, ValueError):
                extras.append(f"{puffs_raw} puffs")
        if eliquid_ml:
            try:
                ml = float(eliquid_ml)
                if ml == int(ml):
                    extras.append(f"{int(ml)} mL")
                else:
                    extras.append(f"{ml} mL")
            except (TypeError, ValueError):
                extras.append(f"{eliquid_ml} mL")
        if nicotine:
            extras.append(nicotine)
        product_name = " ".join(name_parts)
        if extras:
            product_name = (product_name + " " + " ".join(extras)).strip()
        if not product_name:
            product_name = sku  # fallback

        # Force-stringify invoice # to preserve any leading zeros
        last_invoice_no = ""
        if invoice_raw not in (None, ""):
            try:
                last_invoice_no = str(int(invoice_raw))
            except (TypeError, ValueError):
                last_invoice_no = str(invoice_raw).strip()

        row = empty_row()
        row["sku"]               = sku
        row["product_name"]      = product_name
        row["brand"]             = brand
        row["category"]          = "vape"
        row["subcategory"]       = form_factor
        row["pack_size"]         = pack_size
        row["unit"]              = "each"
        row["cost_price"]        = cost_price if cost_price else ""
        row["sell_price"]        = sell_price if sell_price else ""
        row["sell_price_credit"] = sell_credit if sell_credit else ""
        row["min_sell_price"]    = ""    # admin sets per product post-import
        row["supplier"]          = supplier
        row["last_invoice_no"]   = last_invoice_no
        row["source_file"]       = "YV Vape Master Price List.xlsx"
        row["notes"]             = notes
        out.append(row)

    return out


# ────────────────────────────────────────────────────────────
# Parser 2: Inventory-old (3-block layout)
# ────────────────────────────────────────────────────────────
# (category, name_col, size_col, price_col) — 1-indexed.
# Default assumption: Beer A:C, Cigarettes F:H, Vape L:N (cols D, E, I, J, K
# are empty separators). Will auto-detect actual column positions by scanning
# the row 3 headers for "Product Name" — assumption is only the fallback.
BLOCK_DEFAULT = [
    ("beer",        1,  2,  3),
    ("cigarettes",  6,  7,  8),
    ("vape",       12, 13, 14),
]


def detect_inv_old_blocks(ws):
    """Scan row 3 for cells whose value contains 'Product Name'. Return a
    list of (category, name_col, size_col, price_col) in left-to-right order.
    Categories are derived from row 2 above each block.
    """
    blocks = []
    cat_hints = {
        "beer": "beer",
        "cigarette": "cigarettes",
        "cigarettes": "cigarettes",
        "vape": "vape",
    }
    cat_order_seen = []
    for c in range(1, ws.max_column + 1):
        v = s(cell(ws, 3, c))
        if "product name" in v.lower():
            cat_from_row2 = s(cell(ws, 2, c)).lower()
            category = None
            for k, mapped in cat_hints.items():
                if k in cat_from_row2:
                    category = mapped
                    break
            if not category:
                # Fall back to default order
                idx = len(cat_order_seen)
                if idx < len(BLOCK_DEFAULT):
                    category = BLOCK_DEFAULT[idx][0]
                else:
                    category = "other"
            blocks.append((category, c, c + 1, c + 2))
            cat_order_seen.append(category)
    return blocks


def parse_inventory_old(path):
    """Source layout — 3 side-by-side blocks of (Product Name | Size | Unit Price):
       Block A: Beer            (cols A..C by default)
       Block B: Cigarettes      (cols F..H by default)
       Block C: Vape            (cols L..N by default)
       Row 1: title 'RBH/JTI/ITCO'
       Row 2: block category banner
       Row 3: column headers (Product Name | Size | Unit Price) ×3
       Row 4+: data
    """
    if not path.exists():
        sys.stderr.write(f"WARN: {path.name} not found — skipping inv-old parser.\n")
        return []

    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.worksheets[0]   # sheet name varies, take the first

    # Detect blocks; fall back to default layout if detection produces 0.
    blocks = detect_inv_old_blocks(ws)
    if not blocks:
        sys.stderr.write(
            f"WARN: {path.name}: could not detect 'Product Name' headers in row 3. "
            f"Falling back to default block layout.\n"
        )
        blocks = list(BLOCK_DEFAULT)

    out = []
    for r in range(4, ws.max_row + 1):
        for (category, name_col, size_col, price_col) in blocks:
            name = s(cell(ws, r, name_col))
            size = s(cell(ws, r, size_col))
            price = num(cell(ws, r, price_col))

            if not name:
                continue
            # Defensive: skip any "Total"/"Subtotal" rows
            nl = name.lower()
            if nl.startswith("total") or nl.startswith("subtotal"):
                continue

            product_name = (name + " " + size).strip() if size else name

            row = empty_row()
            row["sku"]               = ""
            row["product_name"]      = product_name
            row["brand"]             = ""
            row["category"]          = category
            row["subcategory"]       = size
            row["pack_size"]         = size
            row["unit"]              = "each"
            row["cost_price"]        = ""    # not in this file
            row["sell_price"]        = price if price else ""
            row["sell_price_credit"] = ""
            row["min_sell_price"]    = ""
            row["supplier"]          = ""
            row["last_invoice_no"]   = ""
            row["source_file"]       = "Inventory-old.xlsx"
            row["notes"]             = ""
            out.append(row)

    return out


# ────────────────────────────────────────────────────────────
# Merge + dedup
# ────────────────────────────────────────────────────────────
def dedup_rows(rows):
    """SKU first (case-insensitive); else brand|product_name (case-insensitive).
    Mirrors ProductMaster.findDuplicate_ on the server.
    """
    seen_sku = set()
    seen_bn = set()
    final = []
    skipped = 0
    for r in rows:
        sku_key = (r.get("sku") or "").strip().lower()
        if sku_key:
            if sku_key in seen_sku:
                skipped += 1
                continue
            seen_sku.add(sku_key)
        else:
            bn = (
                (r.get("brand") or "").strip().lower()
                + "|"
                + (r.get("product_name") or "").strip().lower()
            )
            if bn in seen_bn:
                skipped += 1
                continue
            seen_bn.add(bn)
        final.append(r)
    return final, skipped


# ────────────────────────────────────────────────────────────
# CSV writer
# ────────────────────────────────────────────────────────────
def write_csv(rows, path):
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=HEADERS)
        w.writeheader()
        for r in rows:
            w.writerow(r)


# ────────────────────────────────────────────────────────────
# Main
# ────────────────────────────────────────────────────────────
def main():
    vape_rows = parse_vape_master(VAPE_FILE)
    print(f"  YV Vape Master:   {len(vape_rows):>4} rows parsed")

    inv_rows = parse_inventory_old(INV_FILE)
    print(f"  Inventory-old:    {len(inv_rows):>4} rows parsed")

    all_rows = vape_rows + inv_rows
    final, dup_count = dedup_rows(all_rows)
    print(f"  Pre-dedup total:  {len(all_rows):>4}")
    print(f"  Duplicates:       {dup_count:>4}  (kept the first occurrence)")
    print(f"  Final rows:       {len(final):>4}")

    # Quick category breakdown so wildly off counts get noticed.
    cat_counts = {}
    for r in final:
        cat_counts[r["category"]] = cat_counts.get(r["category"], 0) + 1
    print("  By category:")
    for c, n in sorted(cat_counts.items(), key=lambda x: -x[1]):
        print(f"    {c:<12} {n}")

    write_csv(final, OUT_FILE)
    print(f"\n✅  Wrote {len(final)} rows to {OUT_FILE.relative_to(PROJECT_ROOT)}")
    print("\nNext: un-hide the _pm_import_staging tab, paste the CSV at A3,")
    print('      then run "📦 Import Product Master (from staging)" from the menu.')


if __name__ == "__main__":
    main()
