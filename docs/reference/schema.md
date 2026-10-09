# Schema reference

> **Generated** by `npm run docs:schema` from what `firstTimeSetup` and the
> migrations in `src/Setup.gs` actually build. Do not edit by hand — change
> the code and regenerate. The docs-guard suite fails when this file is stale.

Row 1 of every tab is a title banner, row 2 is the header, data starts at row 3.
Tabs starting with `_` are import staging areas, not data.
For what the tables mean and how they relate, see
[architecture/data-model.md](../architecture/data-model.md).

| Tab | Columns | Purpose |
|---|---:|---|
| [`config`](#config) | 3 | Configuration |
| [`staff`](#staff) | 11 | Staff |
| [`attendance`](#attendance) | 16 | Attendance — one row per workday |
| [`till_sessions`](#till_sessions) | 21 | Till Sessions — per-company cash reconciliation |
| [`sales`](#sales) | 18 | Sales — by tender, per till session |
| [`payments`](#payments) | 7 | Payments — header rows |
| [`payment_items`](#payment_items) | 6 | PaymentItems — allocations |
| [`bonuses`](#bonuses) | 15 | Bonuses — bonuses, commissions, adjustments |
| [`commission_rules`](#commission_rules) | 15 | Commission Rules |
| [`commission_runs`](#commission_runs) | 9 | Commission Runs — execution log |
| [`audit_log`](#audit_log) | 9 | Audit Log — append-only |
| [`pos_extracted`](#pos_extracted) | 12 | POS Extracted (Phase 2 placeholder) |
| [`clover_batches`](#clover_batches) | 11 | Clover Batches (Phase 2 placeholder) |
| [`validation_results`](#validation_results) | 21 | Validation Results (cashier vs Clover, per shift) |
| [`suppliers`](#suppliers) | 7 | Suppliers (reference) |
| [`order_catalog`](#order_catalog) | 11 | Order Catalog |
| [`shopping_list`](#shopping_list) | 15 | Shopping List |
| [`product_master`](#product_master) | 24 | Product Master (core) |
| [`product_beer_detail`](#product_beer_detail) | 11 | Beer detail (LCBO case pricing) |
| [`product_cigarettes_detail`](#product_cigarettes_detail) | 8 | Cigarettes detail (carton → pack pricing) |
| [`product_vape_detail`](#product_vape_detail) | 14 | Vape detail (attributes + prices) |
| [`_pm_beer_staging`](#_pm_beer_staging) | 20 | Beer — Import Staging (paste CSV at A3; SKU + sell unit is the key) |
| [`_pm_cig_staging`](#_pm_cig_staging) | 17 | Cigarettes — Import Staging (paste CSV at A3; SKU is the key) |
| [`_pm_vape_staging`](#_pm_vape_staging) | 23 | Vape — Import Staging (paste CSV at A3; SKU is the key) |
| [`_pm_other_staging`](#_pm_other_staging) | 16 | Grocery/Other — Import Staging (paste CSV at A3; cost/sell entered directly) |
| [`cash_handovers`](#cash_handovers) | 12 | Cash Handovers |
| [`cash_handover_items`](#cash_handover_items) | 5 | Cash Handover Items |

## staff

_Staff_

| # | Column |
|---:|---|
| 1 | `staff_id` |
| 2 | `name` |
| 3 | `hourly_rate` |
| 4 | `active` |
| 5 | `role` |
| 6 | `login_code` |
| 7 | `companies_authorized` |
| 8 | `email` |
| 9 | `start_date` |
| 10 | `created_at` |
| 11 | `notes` |

## attendance

_Attendance — one row per workday_

| # | Column |
|---:|---|
| 1 | `attendance_id` |
| 2 | `staff_id` |
| 3 | `date` |
| 4 | `scheduled_start` |
| 5 | `scheduled_end` |
| 6 | `actual_start` |
| 7 | `actual_end` |
| 8 | `hours_worked` |
| 9 | `rate_at_attendance` |
| 10 | `status` |
| 11 | `notes` |
| 12 | `created_by` |
| 13 | `created_at` |
| 14 | `modified_by` |
| 15 | `modified_at` |
| 16 | `hours_basis` |

## till_sessions

_Till Sessions — per-company cash reconciliation_

| # | Column |
|---:|---|
| 1 | `session_id` |
| 2 | `attendance_id` |
| 3 | `staff_id` |
| 4 | `company` |
| 5 | `date` |
| 6 | `status` |
| 7 | `start_time` |
| 8 | `end_time` |
| 9 | `expected_opening` |
| 10 | `opening_float` |
| 11 | `opening_note` |
| 12 | `closing_cash_counted` |
| 13 | `cash_left_in_till` |
| 14 | `cash_removed_at_close` |
| 15 | `expected_cash` |
| 16 | `closing_variance` |
| 17 | `variance_status` |
| 18 | `notes` |
| 19 | `lotto_reserve_counted` |
| 20 | `lotto_topup_from_till` |
| 21 | `lotto_reserve_note` |

## sales

_Sales — by tender, per till session_

| # | Column |
|---:|---|
| 1 | `sales_id` |
| 2 | `session_id` |
| 3 | `staff_id` |
| 4 | `company` |
| 5 | `date` |
| 6 | `cash_sales` |
| 7 | `credit_card_sales` |
| 8 | `debit_card_sales` |
| 9 | `cashback_paid` |
| 10 | `hst_collected` |
| 11 | `bottle_deposit` |
| 12 | `round_off` |
| 13 | `misc_cash_sales` |
| 14 | `misc_credit_sales` |
| 15 | `misc_debit_sales` |
| 16 | `misc_notes` |
| 17 | `card_total_sales` |
| 18 | `misc_card_sales` |

## payments

_Payments — header rows_

| # | Column |
|---:|---|
| 1 | `payment_id` |
| 2 | `staff_id` |
| 3 | `paid_on` |
| 4 | `total_amount` |
| 5 | `method` |
| 6 | `recorded_by` |
| 7 | `notes` |

## payment_items

_PaymentItems — allocations_

| # | Column |
|---:|---|
| 1 | `item_id` |
| 2 | `payment_id` |
| 3 | `item_type` |
| 4 | `ref_id` |
| 5 | `amount` |
| 6 | `notes` |

## bonuses

_Bonuses — bonuses, commissions, adjustments_

| # | Column |
|---:|---|
| 1 | `bonus_id` |
| 2 | `staff_id` |
| 3 | `date` |
| 4 | `type` |
| 5 | `amount` |
| 6 | `reason` |
| 7 | `status` |
| 8 | `period_start` |
| 9 | `period_end` |
| 10 | `company` |
| 11 | `source_run_id` |
| 12 | `created_by` |
| 13 | `created_at` |
| 14 | `notes` |
| 15 | `source_rule_id` |

## commission_rules

_Commission Rules_

| # | Column |
|---:|---|
| 1 | `rule_id` |
| 2 | `name` |
| 3 | `applies_to` |
| 4 | `staff_id` |
| 5 | `company` |
| 6 | `threshold` |
| 7 | `percentage` |
| 8 | `active` |
| 9 | `effective_from` |
| 10 | `effective_to` |
| 11 | `created_by` |
| 12 | `created_at` |
| 13 | `notes` |
| 14 | `rule_type` |
| 15 | `fixed_amount` |

## commission_runs

_Commission Runs — execution log_

| # | Column |
|---:|---|
| 1 | `run_id` |
| 2 | `week_start` |
| 3 | `week_end` |
| 4 | `staff_count` |
| 5 | `bonuses_created` |
| 6 | `total_commission_amount` |
| 7 | `computed_at` |
| 8 | `computed_by` |
| 9 | `notes` |

## audit_log

_Audit Log — append-only_

| # | Column |
|---:|---|
| 1 | `log_id` |
| 2 | `timestamp` |
| 3 | `actor_id` |
| 4 | `action` |
| 5 | `target_type` |
| 6 | `target_id` |
| 7 | `before` |
| 8 | `after` |
| 9 | `details` |

## pos_extracted

_POS Extracted (Phase 2 placeholder)_

| # | Column |
|---:|---|
| 1 | `pos_id` |
| 2 | `company` |
| 3 | `business_date` |
| 4 | `extracted_at` |
| 5 | `cash_total` |
| 6 | `credit_total` |
| 7 | `debit_total` |
| 8 | `cashback_total` |
| 9 | `hst` |
| 10 | `lottery_sales` |
| 11 | `bottle_deposit` |
| 12 | `source_filename` |

## clover_batches

_Clover Batches (Phase 2 placeholder)_

| # | Column |
|---:|---|
| 1 | `batch_id` |
| 2 | `batch_date` |
| 3 | `company` |
| 4 | `gross_amount` |
| 5 | `fees` |
| 6 | `net_expected` |
| 7 | `deposit_date` |
| 8 | `bank_amount` |
| 9 | `variance` |
| 10 | `status` |
| 11 | `notes` |

## validation_results

_Validation Results (cashier vs Clover, per shift)_

| # | Column |
|---:|---|
| 1 | `validation_id` |
| 2 | `business_date` |
| 3 | `window_start` |
| 4 | `window_end` |
| 5 | `merchant` |
| 6 | `companies` |
| 7 | `cashier_credit` |
| 8 | `clover_credit` |
| 9 | `cashier_debit` |
| 10 | `clover_debit` |
| 11 | `cashier_card` |
| 12 | `clover_card` |
| 13 | `card_variance` |
| 14 | `cash_counted` |
| 15 | `cash_variance` |
| 16 | `status` |
| 17 | `mode` |
| 18 | `session_ids` |
| 19 | `validated_at` |
| 20 | `validated_by` |
| 21 | `cash_sales` |

## suppliers

_Suppliers (reference)_

| # | Column |
|---:|---|
| 1 | `supplier_id` |
| 2 | `name` |
| 3 | `category` |
| 4 | `products` |
| 5 | `contact` |
| 6 | `notes` |
| 7 | `active` |

## order_catalog

_Order Catalog_

| # | Column |
|---:|---|
| 1 | `item_id` |
| 2 | `name` |
| 3 | `category` |
| 4 | `unit` |
| 5 | `unit_price` |
| 6 | `par_level` |
| 7 | `suggested_supplier` |
| 8 | `active` |
| 9 | `created_by` |
| 10 | `created_at` |
| 11 | `notes` |

## shopping_list

_Shopping List_

| # | Column |
|---:|---|
| 1 | `entry_id` |
| 2 | `item_id` |
| 3 | `item_name` |
| 4 | `category` |
| 5 | `quantity` |
| 6 | `unit` |
| 7 | `unit_price` |
| 8 | `note` |
| 9 | `status` |
| 10 | `added_by` |
| 11 | `added_at` |
| 12 | `batch_id` |
| 13 | `generated_by` |
| 14 | `generated_at` |
| 15 | `product_id` |

## product_master

_Product Master (core)_

| # | Column |
|---:|---|
| 1 | `product_id` |
| 2 | `sku` |
| 3 | `barcode` |
| 4 | `product_name` |
| 5 | `brand` |
| 6 | `category` |
| 7 | `subcategory` |
| 8 | `pack_size` |
| 9 | `unit` |
| 10 | `supplier` |
| 11 | `cost_price` |
| 12 | `sell_price` |
| 13 | `sell_price_credit` |
| 14 | `min_sell_price` |
| 15 | `margin_amount` |
| 16 | `margin_pct` |
| 17 | `active` |
| 18 | `notes` |
| 19 | `source_file` |
| 20 | `created_by` |
| 21 | `created_at` |
| 22 | `updated_by` |
| 23 | `updated_at` |
| 24 | `needs_detail` |

## product_beer_detail

_Beer detail (LCBO case pricing)_

| # | Column |
|---:|---|
| 1 | `product_id` |
| 2 | `sku` |
| 3 | `sell_unit` |
| 4 | `lcbo_case_price` |
| 5 | `units_per_case` |
| 6 | `packs_per_case` |
| 7 | `cost_input` |
| 8 | `deposit_per_unit` |
| 9 | `target_margin_pct` |
| 10 | `created_at` |
| 11 | `updated_at` |

## product_cigarettes_detail

_Cigarettes detail (carton → pack pricing)_

| # | Column |
|---:|---|
| 1 | `product_id` |
| 2 | `sku` |
| 3 | `cost_per_carton` |
| 4 | `packs_per_carton` |
| 5 | `target_margin_pct` |
| 6 | `review_sold` |
| 7 | `created_at` |
| 8 | `updated_at` |

## product_vape_detail

_Vape detail (attributes + prices)_

| # | Column |
|---:|---|
| 1 | `product_id` |
| 2 | `sku` |
| 3 | `product_line` |
| 4 | `form_factor` |
| 5 | `puffs` |
| 6 | `eliquid_ml` |
| 7 | `nicotine` |
| 8 | `flavor` |
| 9 | `purchase_price` |
| 10 | `sale_price` |
| 11 | `sale_price_credit` |
| 12 | `last_invoice_no` |
| 13 | `created_at` |
| 14 | `updated_at` |

## _pm_beer_staging

_Beer — Import Staging (paste CSV at A3; SKU + sell unit is the key)_

| # | Column |
|---:|---|
| 1 | `sku` |
| 2 | `barcode` |
| 3 | `product_name` |
| 4 | `brand` |
| 5 | `category` |
| 6 | `subcategory` |
| 7 | `pack_size` |
| 8 | `unit` |
| 9 | `supplier` |
| 10 | `min_sell_price` |
| 11 | `notes` |
| 12 | `source_file` |
| 13 | `needs_detail` |
| 14 | `sell_unit` |
| 15 | `lcbo_case_price` |
| 16 | `units_per_case` |
| 17 | `packs_per_case` |
| 18 | `cost_input` |
| 19 | `deposit_per_unit` |
| 20 | `target_margin_pct` |

## _pm_cig_staging

_Cigarettes — Import Staging (paste CSV at A3; SKU is the key)_

| # | Column |
|---:|---|
| 1 | `sku` |
| 2 | `barcode` |
| 3 | `product_name` |
| 4 | `brand` |
| 5 | `category` |
| 6 | `subcategory` |
| 7 | `pack_size` |
| 8 | `unit` |
| 9 | `supplier` |
| 10 | `min_sell_price` |
| 11 | `notes` |
| 12 | `source_file` |
| 13 | `needs_detail` |
| 14 | `cost_per_carton` |
| 15 | `packs_per_carton` |
| 16 | `target_margin_pct` |
| 17 | `review_sold` |

## _pm_vape_staging

_Vape — Import Staging (paste CSV at A3; SKU is the key)_

| # | Column |
|---:|---|
| 1 | `sku` |
| 2 | `barcode` |
| 3 | `product_name` |
| 4 | `brand` |
| 5 | `category` |
| 6 | `subcategory` |
| 7 | `pack_size` |
| 8 | `unit` |
| 9 | `supplier` |
| 10 | `min_sell_price` |
| 11 | `notes` |
| 12 | `source_file` |
| 13 | `needs_detail` |
| 14 | `product_line` |
| 15 | `form_factor` |
| 16 | `puffs` |
| 17 | `eliquid_ml` |
| 18 | `nicotine` |
| 19 | `flavor` |
| 20 | `purchase_price` |
| 21 | `sale_price` |
| 22 | `sale_price_credit` |
| 23 | `last_invoice_no` |

## _pm_other_staging

_Grocery/Other — Import Staging (paste CSV at A3; cost/sell entered directly)_

| # | Column |
|---:|---|
| 1 | `sku` |
| 2 | `barcode` |
| 3 | `product_name` |
| 4 | `brand` |
| 5 | `category` |
| 6 | `subcategory` |
| 7 | `pack_size` |
| 8 | `unit` |
| 9 | `supplier` |
| 10 | `min_sell_price` |
| 11 | `notes` |
| 12 | `source_file` |
| 13 | `needs_detail` |
| 14 | `cost_price` |
| 15 | `sell_price` |
| 16 | `sell_price_credit` |

## cash_handovers

_Cash Handovers_

| # | Column |
|---:|---|
| 1 | `handover_id` |
| 2 | `from_staff_id` |
| 3 | `to_staff_id` |
| 4 | `amount` |
| 5 | `handed_on` |
| 6 | `recorded_by` |
| 7 | `recorded_at` |
| 8 | `method` |
| 9 | `status` |
| 10 | `notes` |
| 11 | `voided_by` |
| 12 | `voided_at` |

## cash_handover_items

_Cash Handover Items_

| # | Column |
|---:|---|
| 1 | `item_id` |
| 2 | `handover_id` |
| 3 | `session_id` |
| 4 | `amount` |
| 5 | `notes` |

## config

Key/value tab read by every module (cached for 5 minutes). Values are
deliberately not listed — they are per-install and some are secrets.

| Key | What it controls |
|---|---|
| `card_variance_threshold` | Card mismatch under this = OK (dollars). Only tills with card_split AND Clover are checked |
| `cash_handover_stale_days` | Flag cash still out with a cashier after this many days |
| `cash_manager_staff_id` | Staff who holds the business cash; shift takings are handed over to them. Blank = cash handling not configured |
| `clover_base_url` | Clover REST API base (sandbox: https://sandbox.dev.clover.com) |
| `clover_cstore_merchant_id` | Clover merchant ID for cstore |
| `clover_cstore_token` | Clover API token (Bearer) for cstore |
| `clover_enabled` | Toggle Clover card reconciliation at end of day |
| `clover_vape_merchant_id` | Clover merchant ID for vape (same as cstore = one shared account) |
| `clover_vape_token` | Clover API token (Bearer) for vape |
| `commission_run_day` | Day of week for commission trigger (0=Sun..6=Sat) |
| `commission_run_hour` | Hour of day for commission trigger (0-23) |
| `cstore_business_name` | Display name for cstore |
| `cstore_card_split` | cstore till reports ONE card total (ePOS) — no credit/debit split |
| `cstore_default_opening_float` | Cstore opening float (dollars) |
| `cstore_epos_from` | Date cstore moved to ePOS (yyyy-MM-dd). Marks where the credit/debit split stops — reporting only |
| `login_lockout_mins` | Minutes locked out after too many fails |
| `login_max_fails` | Failed login attempts before lockout |
| `lotto_reserve_default` | Expected lotto reserve balance at cstore close (dollars) |
| `notifier_enabled` | Toggle for WhatsApp / event notifications |
| `public_report_url` | Deployed web app /exec URL. The reconcile message links to <url>?v=recon (7-day read-only report, no login). Blank = no link sent |
| `session_hours` | Login session lifetime (hours) |
| `timezone` | Default timezone (script setting overrides) |
| `vape_business_name` | Display name for vape |
| `vape_card_split` | vape till reports credit and debit separately |
| `vape_default_opening_float` | Vape opening float (dollars) |
| `variance_minor_threshold` | Variance under this = Minor (yellow); over = investigate (red) |
| `variance_ok_threshold` | Variance under this = OK (green) |
| `whatsapp_api_token` | WhatsApp Cloud API access token (Bearer) |
| `whatsapp_api_url` | WhatsApp Cloud API endpoint: https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages |
| `whatsapp_target_number` | Recipient phone(s), E.164 e.g. 14165551234. Comma-separate for several: 14165551234,14169998888 |
| `whatsapp_template_lang` | Template language code (applies to all whatsapp_template_* names) |
| `whatsapp_template_name` | Generic fallback template (body as {{1}}, flattened). Blank = plain text |
| `whatsapp_template_shift_close` | Approved template for shift close/reconcile, 13 params: {{1}} date {{2}} company {{3}} window {{4}} staff {{5}} total sales {{6}} cash recorded/counted {{7}} where the cash went {{8}} cash in hand {{9}} lotto reserve {{10}} credit {{11}} debit {{12}} card total {{13}} status |
| `whatsapp_template_shift_close_cstore` | Close template for cstore. Blank = fall back to whatsapp_template_shift_close |
| `whatsapp_template_shift_close_vape` | Close template for vape. Blank = fall back to whatsapp_template_shift_close |
| `whatsapp_template_shift_open` | Approved template for shift-open notice: {{1}} name, {{2}} company, {{3}} time |
| `whatsapp_template_shopping_list` | Approved template for shopping list: {{1}} date·by, {{2}} item lines, {{3}} summary |
