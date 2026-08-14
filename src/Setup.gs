// ============================================================
//  Setup.gs — first-time schema creation + menu + placeholders
// ============================================================
//  Run `firstTimeSetup` once on a fresh sheet. Creates all 14 tabs
//  with proper columns, validation, and a single placeholder row
//  per operational table so the user can eyeball the shape.
// ============================================================

const SHEETS = {
  STAFF:              'staff',
  ATTENDANCE:         'attendance',
  TILL_SESSIONS:      'till_sessions',
  SALES:              'sales',
  PAYMENTS:           'payments',
  PAYMENT_ITEMS:      'payment_items',
  BONUSES:            'bonuses',
  COMMISSION_RULES:   'commission_rules',
  COMMISSION_RUNS:    'commission_runs',
  AUDIT_LOG:          'audit_log',
  CONFIG:             'config',
  POS_EXTRACTED:      'pos_extracted',
  CLOVER_BATCHES:     'clover_batches',
  VALIDATION_RESULTS: 'validation_results',
  SUPPLIERS:          'suppliers',
  ORDER_CATALOG:      'order_catalog',
  SHOPPING_LIST:      'shopping_list',
  PRODUCT_MASTER:     'product_master',
  PM_IMPORT_STAGING:  '_pm_import_staging',          // legacy single-table staging (archived by v2 migration)
  PRODUCT_BEER_DETAIL:       'product_beer_detail',
  PRODUCT_CIGARETTES_DETAIL: 'product_cigarettes_detail',
  PRODUCT_VAPE_DETAIL:       'product_vape_detail',
  PM_BEER_STAGING:    '_pm_beer_staging',
  PM_CIG_STAGING:     '_pm_cig_staging',
  PM_VAPE_STAGING:    '_pm_vape_staging',
  PM_OTHER_STAGING:   '_pm_other_staging',
};

const COLORS = {
  HEADER:       '#1A237E',
  SUBHEADER:    '#283593',
  PLACEHOLDER:  '#FFF8E1',  // soft yellow — visually distinct
};

const ROLES = ['admin', 'manager', 'employee', 'payroll_admin'];
const COMPANIES = ['cstore', 'vape'];
const TILL_STATUSES = ['open', 'closed', 'validated'];
const ATT_STATUSES = ['scheduled', 'in_progress', 'worked', 'cancelled'];
const PAYMENT_METHODS = ['cash', 'bank', 'etransfer', 'other'];
const ITEM_TYPES = ['shift', 'bonus'];
const BONUS_TYPES = ['bonus', 'commission', 'incentive', 'deduction', 'tip', 'adjustment'];
const BONUS_STATUSES = ['proposed', 'pending', 'paid', 'cancelled'];
const VARIANCE_STATUSES = ['OK', 'minor', 'investigate', 'pending_validation'];
const RULE_APPLIES = ['all_staff', 'specific_staff'];
const ORDER_CATEGORIES = ['Grocery', 'Cigarettes', 'Vapes', 'Other'];
const SHOPPING_STATUSES = ['pending', 'bought', 'cleared', 'removed'];
// product_master uses its own lowercase/snake_case enum, distinct from
// ORDER_CATEGORIES (which is Title Case + user-mutable for ShoppingList UX).
const PRODUCT_CATEGORIES = ['vape', 'cigarettes', 'beer', 'grocery', 'other'];

// ============================================================
//  Menu (on sheet open)
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🏪 StoreOps')
    .addItem('⚙️ First-time Setup',                'firstTimeSetup')
    .addSeparator()
    .addItem('🔄 Run Commission Engine (last week)', 'menu_runCommissionEngine')
    .addItem('🗓️ Install Weekly Auto-Trigger',      'menu_installCommissionTrigger')
    .addItem('🛑 Remove Weekly Auto-Trigger',        'menu_removeCommissionTrigger')
    .addSeparator()
    .addItem('📦 Import Beer (from staging)',           'menu_importBeer')
    .addItem('📦 Import Cigarettes (from staging)',     'menu_importCigarettes')
    .addItem('📦 Import Vape (from staging)',           'menu_importVape')
    .addItem('📦 Import Grocery/Other (from staging)',  'menu_importOther')
    .addItem('🧱 Migrate Product Master → v2 (per-type)', 'menu_migrateProductMasterV2')
    .addItem('🛒 Add product_id to shopping_list', 'menu_migrateShoppingListProductId')
    .addSeparator()
    .addItem('⚠️ Reset Data (keeps schema)',         'resetDataTables')
    .addToUi();
}

// ── Per-type Product Master imports ─────────────────────────
// Each reads its own staging tab (_pm_<type>_staging) and upserts into
// the core product_master + that type's detail sheet. SKU is the primary
// key (beer keys on SKU + sell unit); SKU-less rows fall back to
// brand + name dedup. Pricing is derived in code from the staged inputs.
function menu_importBeer()       { menu_importProductType_('beer',       'Beer'); }
function menu_importCigarettes() { menu_importProductType_('cigarettes', 'Cigarettes'); }
function menu_importVape()       { menu_importProductType_('vape',       'Vape'); }
function menu_importOther()      { menu_importProductType_('other',      'Grocery/Other'); }

function menu_importProductType_(type, label) {
  const ui = SpreadsheetApp.getUi();
  const stagingName = '_pm_' + (type === 'cigarettes' ? 'cig' : type) + '_staging';
  const resp = ui.alert(
    'Import ' + label,
    'Read all rows from "' + stagingName + '" and import to product_master + the ' +
    label.toLowerCase() + ' detail sheet?\n\n' +
    'SKU is the primary key — matching rows are UPDATED in place, new rows are inserted.\n' +
    'Pricing is recomputed from the staged inputs.\n\n' +
    'A summary is shown when done.',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  try {
    const result = ProductMaster.importFromStaging({ type: type, actorId: 'IMPORT' });
    const errs = result.errors || [];
    ui.alert(
      label + ' import done',
      'Inserted: ' + result.imported + '\n' +
      'Updated:  ' + (result.updated || 0) + '\n' +
      'Skipped (dup, no SKU): ' + (result.skipped || 0) + '\n' +
      'Errors: ' + errs.length +
      (errs.length
        ? '\n\nFirst ' + Math.min(errs.length, 3) + ':\n  • ' +
          errs.slice(0, 3).map(e => 'row ' + e.rowIndex + ': ' + e.message).join('\n  • ')
        : ''),
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Import failed', e.message, ui.ButtonSet.OK);
  }
}

// ── Migration: flat product_master → thin core + per-type detail ──
// Archives the old single-table product_master (and its legacy staging)
// by RENAME (never deletes — audit trail), then builds the new core +
// detail + per-type staging sheets. Re-import fresh from the master
// spreadsheets afterwards (import-only; master sheets are source of truth).
function menu_migrateProductMasterV2() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const resp = ui.alert(
    'Migrate Product Master → v2',
    'This will:\n' +
    '  1. RENAME the existing "product_master" (and "_pm_import_staging") to\n' +
    '     *__archived_<date> — nothing is deleted.\n' +
    '  2. Create the new thin core "product_master" + per-type detail sheets\n' +
    '     (beer / cigarettes / vape) + 4 per-type staging tabs.\n\n' +
    'Then run scripts/import_product_master.py and import each type from its\n' +
    'staging tab.\n\nContinue?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  const report = [];

  [SHEETS.PRODUCT_MASTER, SHEETS.PM_IMPORT_STAGING].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) { report.push(name + ': not present (skipped)'); return; }
    const archiveName = name + '__archived_' + stamp;
    if (ss.getSheetByName(archiveName)) { report.push(name + ': archive already exists (left as-is)'); return; }
    try { sh.setName(archiveName); report.push(name + ' → ' + archiveName); }
    catch (e) { report.push(name + ': RENAME FAILED — ' + e.message); }
  });

  const steps = [
    setupProductMasterSheet_,
    setupProductBeerDetailSheet_,
    setupProductCigDetailSheet_,
    setupProductVapeDetailSheet_,
    setupBeerStagingSheet_,
    setupCigStagingSheet_,
    setupVapeStagingSheet_,
    setupOtherStagingSheet_,
  ];
  steps.forEach(fn => { try { fn(); } catch (e) { report.push('setup ' + fn.name + ': FAILED — ' + e.message); } });

  try { ProductMaster._bustCache(); } catch (e) { /* ignore */ }

  ui.alert(
    'Migration done',
    report.join('\n') +
    '\n\nNext:\n' +
    '  1. python scripts/import_product_master.py\n' +
    '  2. Paste each CSV into its _pm_*_staging tab at A3\n' +
    '  3. Run the matching "Import …" menu item per type',
    ui.ButtonSet.OK);
}

// Run the commission engine manually for the previous calendar week.
function menu_runCommissionEngine() {
  const ui = SpreadsheetApp.getUi();
  const range = Util.getPreviousWeekRange(new Date());
  const existing = Commissions.findRunForWeek(range.start);
  let force = false;
  if (existing) {
    const resp = ui.alert(
      'Commission run already exists',
      'A commission run for the week of ' + Util.formatDate(range.start) +
      ' → ' + Util.formatDate(range.end) + ' already exists (' + existing.runId + ').\n\n' +
      'Run again? This will create DUPLICATE bonus rows for the same week.',
      ui.ButtonSet.YES_NO);
    if (resp !== ui.Button.YES) return;
    force = true;
  }
  try {
    const result = Commissions.runForWeek({
      weekStart: range.start,
      weekEnd: range.end,
      actorId: 'MANUAL_TRIGGER',
      force,
    });
    if (result.skipped) {
      ui.alert(result.reason);
      return;
    }
    ui.alert(
      'Commission run complete',
      'Week: ' + Util.formatDate(range.start) + ' → ' + Util.formatDate(range.end) + '\n' +
      'Staff with commission: ' + result.staffCount + '\n' +
      'Bonuses created: ' + result.bonusesProposed.length + '\n' +
      'Total: ' + Util.formatMoney(result.totalAmount) + '\n\n' +
      'Bonuses are in "proposed" status. Approve them in the Bonuses tab ' +
      'or via the web app (batch 4).',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Error', 'Commission run failed: ' + e.message, ui.ButtonSet.OK);
  }
}

function menu_installCommissionTrigger() {
  const ui = SpreadsheetApp.getUi();
  try {
    if (Commissions.isTriggerInstalled()) {
      const resp = ui.alert(
        'Trigger already installed',
        'A weekly commission trigger is already installed. Reinstall it (e.g. to pick up a new run hour)?',
        ui.ButtonSet.YES_NO);
      if (resp !== ui.Button.YES) return;
    }
    const result = Commissions.installWeeklyTrigger();
    ui.alert(
      'Trigger installed',
      'The commission engine will run every ' + result.dayOfWeek +
      ' at ' + result.hour + ':00.\n\n' +
      'To change the time, edit `commission_run_hour` in the config tab and reinstall.',
      ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Error', 'Trigger install failed: ' + e.message, ui.ButtonSet.OK);
  }
}

function menu_removeCommissionTrigger() {
  const ui = SpreadsheetApp.getUi();
  try {
    const result = Commissions.removeWeeklyTrigger();
    if (result.removed === 0) {
      ui.alert('No trigger to remove.');
    } else {
      ui.alert('Removed ' + result.removed + ' trigger(s).');
    }
  } catch (e) {
    ui.alert('Error', 'Trigger remove failed: ' + e.message, ui.ButtonSet.OK);
  }
}

// ============================================================
//  First-time setup
// ============================================================
function firstTimeSetup() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const existing = Object.values(SHEETS).filter(name => ss.getSheetByName(name));
  if (existing.length > 0) {
    const resp = ui.alert(
      'Sheets already exist',
      'These tabs already exist:\n' + existing.join(', ') +
      '\n\nContinue? Existing tabs will be left alone; only missing ones created.',
      ui.ButtonSet.YES_NO);
    if (resp !== ui.Button.YES) return;
  }

  // Run each setup call wrapped in try/catch so one failure doesn't
  // abort the rest. Report results at the end.
  const steps = [
    ['config',             setupConfigSheet_],
    ['staff',              setupStaffSheet_],
    ['attendance',         setupAttendanceSheet_],
    ['till_sessions',      setupTillSessionsSheet_],
    ['sales',              setupSalesSheet_],
    ['payments',           setupPaymentsSheet_],
    ['payment_items',      setupPaymentItemsSheet_],
    ['bonuses',            setupBonusesSheet_],
    ['commission_rules',   setupCommissionRulesSheet_],
    ['commission_runs',    setupCommissionRunsSheet_],
    ['audit_log',          setupAuditLogSheet_],
    ['pos_extracted',      setupPosExtractedSheet_],
    ['clover_batches',     setupCloverBatchesSheet_],
    ['validation_results', setupValidationResultsSheet_],
    ['suppliers',          setupSuppliersSheet_],
    ['order_catalog',      setupOrderCatalogSheet_],
    ['shopping_list',      setupShoppingListSheet_],
    ['product_master',          setupProductMasterSheet_],
    ['product_beer_detail',       setupProductBeerDetailSheet_],
    ['product_cigarettes_detail', setupProductCigDetailSheet_],
    ['product_vape_detail',       setupProductVapeDetailSheet_],
    ['_pm_beer_staging',   setupBeerStagingSheet_],
    ['_pm_cig_staging',    setupCigStagingSheet_],
    ['_pm_vape_staging',   setupVapeStagingSheet_],
    ['_pm_other_staging',  setupOtherStagingSheet_],
  ];

  const succeeded = [];
  const failed = [];
  steps.forEach(([name, fn]) => {
    try {
      fn();
      succeeded.push(name);
    } catch (e) {
      failed.push({ name: name, error: e.message + (e.stack ? '\n' + e.stack.split('\n').slice(0, 3).join('\n') : '') });
      console.error('Setup failed for ' + name + ': ' + e.message);
    }
  });

  // Remove the default "Sheet1" if it's still empty
  const sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() <= 1 && sheet1.getLastColumn() <= 1) {
    try { ss.deleteSheet(sheet1); } catch (e) { /* ignore */ }
  }

  // Build a clear report
  let msg;
  if (failed.length === 0) {
    msg = '✅  Setup complete\n\n' +
          'All ' + succeeded.length + ' sheets created with proper schema + ' +
          'placeholder rows (highlighted in yellow).\n\n' +
          'Next steps:\n' +
          '  1. Open the "staff" sheet\n' +
          '  2. Replace the placeholder row with your real admin info\n' +
          '  3. Delete other placeholder rows once you\'re happy with the shape\n' +
          '  4. Add more staff rows (one per person)\n' +
          '  5. Deploy the web app from Apps Script editor';
  } else {
    msg = '⚠️  Setup partially completed\n\n' +
          'Created (' + succeeded.length + '): ' + succeeded.join(', ') + '\n\n' +
          'FAILED (' + failed.length + '):\n' +
          failed.map(f => '  • ' + f.name + ' — ' + f.error).join('\n\n') +
          '\n\nFix the error(s) and re-run setup. Existing sheets will be skipped.';
  }
  ui.alert(msg);
}

// ============================================================
//  Per-sheet setup functions
// ============================================================

function setupConfigSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.CONFIG)) return;
  const sh = ss.insertSheet(SHEETS.CONFIG);

  writeHeader_(sh, '⚙️  Configuration', 3);
  writeColumnHeaders_(sh, ['key', 'value', 'description']);

  const defaults = [
    ['cstore_default_opening_float', '250',            'Cstore opening float (dollars)'],
    ['vape_default_opening_float',   '100',            'Vape opening float (dollars)'],
    ['variance_ok_threshold',        '1',              'Variance under this = OK (green)'],
    ['variance_minor_threshold',     '30',             'Variance under this = Minor (yellow); over = investigate (red)'],
    ['cstore_business_name',         'Scarbro Mart',   'Display name for cstore'],
    ['vape_business_name',           'YV Vape Shop',   'Display name for vape'],
    ['session_hours',                '24',             'Login session lifetime (hours)'],
    ['login_max_fails',              '5',              'Failed login attempts before lockout'],
    ['login_lockout_mins',           '60',             'Minutes locked out after too many fails'],
    ['commission_run_day',           '1',              'Day of week for commission trigger (0=Sun..6=Sat)'],
    ['commission_run_hour',          '9',              'Hour of day for commission trigger (0-23)'],
    ['notifier_enabled',             'false',          'Toggle for WhatsApp / event notifications'],
    ['whatsapp_target_number',       '',               'Recipient phone(s), E.164 e.g. 14165551234. Comma-separate for several: 14165551234,14169998888'],
    ['whatsapp_api_url',             '',               'WhatsApp Cloud API endpoint: https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages'],
    ['whatsapp_api_token',           '',               'WhatsApp Cloud API access token (Bearer)'],
    ['whatsapp_template_name',       '',               'Generic fallback template (body as {{1}}, flattened). Blank = plain text'],
    ['whatsapp_template_lang',       'en',             'Template language code (applies to all whatsapp_template_* names)'],
    ['whatsapp_template_shift_open', '',               'Approved template for shift-open notice: {{1}} name, {{2}} company, {{3}} time'],
    ['whatsapp_template_shift_close','',               'Approved template for shift close/reconcile: {{1}} date {{2}} company {{3}} window {{4}} cash counted {{5}} cash variance {{6}} credit {{7}} debit {{8}} total {{9}} status'],
    ['whatsapp_template_shopping_list','',             'Approved template for shopping list: {{1}} date·by, {{2}} item lines, {{3}} summary'],
    ['clover_enabled',               'false',          'Toggle Clover card reconciliation at end of day'],
    ['clover_base_url',              'https://api.clover.com', 'Clover REST API base (sandbox: https://sandbox.dev.clover.com)'],
    ['clover_cstore_merchant_id',    '',               'Clover merchant ID for cstore'],
    ['clover_cstore_token',          '',               'Clover API token (Bearer) for cstore'],
    ['clover_vape_merchant_id',      '',               'Clover merchant ID for vape (same as cstore = one shared account)'],
    ['clover_vape_token',            '',               'Clover API token (Bearer) for vape'],
    ['card_variance_threshold',      '1',              'Card credit/debit/total mismatch under this = OK (dollars)'],
    ['timezone',                     Session.getScriptTimeZone(), 'Default timezone (script setting overrides)'],
  ];
  sh.getRange(3, 1, defaults.length, 3).setValues(defaults);

  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 220);
  sh.setColumnWidth(3, 420);
  sh.setFrozenRows(2);
}

function setupStaffSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.STAFF)) return;
  const sh = ss.insertSheet(SHEETS.STAFF);

  writeHeader_(sh, '👥  Staff', 11);
  writeColumnHeaders_(sh, [
    'staff_id', 'name', 'hourly_rate', 'active', 'role',
    'login_code', 'companies_authorized', 'email',
    'start_date', 'created_at', 'notes'
  ]);

  // Validation
  applyEnumValidation_(sh, 5, ROLES);
  applyBoolValidation_(sh, 4);
  sh.getRange(3, 3, 1000, 1).setNumberFormat('$#,##0.00');
  sh.getRange(3, 6, 1000, 1).setNumberFormat('@');  // login_code as text
  sh.getRange(3, 9, 1000, 1).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 10, 1000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');

  // Placeholder row (admin)
  sh.getRange(3, 1, 1, 11).setValues([[
    'S_001', 'Admin (replace me)', 0, true, 'admin',
    '0000', 'cstore,vape', '',
    '', new Date(), 'Placeholder — replace with your real info'
  ]]).setBackground(COLORS.PLACEHOLDER);

  // Column widths
  sh.setColumnWidth(1, 90);
  sh.setColumnWidth(2, 180);
  sh.setColumnWidth(3, 110);
  sh.setColumnWidth(4, 70);
  sh.setColumnWidth(5, 100);
  sh.setColumnWidth(6, 100);
  sh.setColumnWidth(7, 170);
  sh.setColumnWidth(8, 200);
  sh.setColumnWidth(9, 110);
  sh.setColumnWidth(10, 150);
  sh.setColumnWidth(11, 280);
  sh.setFrozenRows(2);
}

function setupAttendanceSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.ATTENDANCE)) return;
  const sh = ss.insertSheet(SHEETS.ATTENDANCE);

  writeHeader_(sh, '📅  Attendance — one row per workday', 16);
  writeColumnHeaders_(sh, [
    'attendance_id', 'staff_id', 'date',
    'scheduled_start', 'scheduled_end',
    'actual_start', 'actual_end',
    'hours_worked', 'rate_at_attendance', 'status',
    'notes', 'created_by', 'created_at', 'modified_by', 'modified_at', 'hours_basis'
  ]);

  applyEnumValidation_(sh, 10, ATT_STATUSES);
  sh.getRange(3, 3, 5000, 1).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 4, 5000, 2).setNumberFormat('@');  // scheduled times as HH:MM text
  sh.getRange(3, 6, 5000, 2).setNumberFormat('yyyy-MM-dd HH:mm:ss');  // actual datetimes
  sh.getRange(3, 8, 5000, 1).setNumberFormat('0.00');                 // hours_worked
  sh.getRange(3, 9, 5000, 1).setNumberFormat('$#,##0.00');             // rate
  sh.getRange(3, 13, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');
  sh.getRange(3, 15, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');

  // Placeholder
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);
  const ystart = new Date(yesterday); ystart.setHours(9, 0, 0, 0);
  const yend = new Date(yesterday); yend.setHours(17, 0, 0, 0);
  sh.getRange(3, 1, 1, 16).setValues([[
    Util.attendanceId(yesterday, 'S_001'),
    'S_001', yesterday,
    '09:00', '17:00',
    ystart, yend,
    8.0, 0, 'worked',
    'Placeholder', 'S_001', new Date(), '', '', ''
  ]]).setBackground(COLORS.PLACEHOLDER);

  setColWidths_(sh, [180, 80, 100, 100, 100, 150, 150, 90, 110, 110, 200, 90, 150, 90, 150, 100]);
  sh.setFrozenRows(2);
}

function setupTillSessionsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.TILL_SESSIONS)) return;
  const sh = ss.insertSheet(SHEETS.TILL_SESSIONS);

  writeHeader_(sh, '💵  Till Sessions — per-company cash reconciliation', 18);
  writeColumnHeaders_(sh, [
    'session_id', 'attendance_id', 'staff_id', 'company', 'date',
    'status', 'start_time', 'end_time',
    'expected_opening', 'opening_float', 'opening_note',
    'closing_cash_counted', 'cash_left_in_till', 'cash_removed_at_close',
    'expected_cash', 'closing_variance', 'variance_status', 'notes'
  ]);

  applyEnumValidation_(sh, 4, COMPANIES);
  applyEnumValidation_(sh, 6, TILL_STATUSES);
  applyEnumValidation_(sh, 17, VARIANCE_STATUSES);
  sh.getRange(3, 5, 5000, 1).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 7, 5000, 2).setNumberFormat('yyyy-MM-dd HH:mm:ss');
  for (const col of [9, 10, 12, 13, 14, 15, 16]) {
    sh.getRange(3, col, 5000, 1).setNumberFormat('$#,##0.00');
  }

  // Placeholder
  const y = new Date();
  y.setDate(y.getDate() - 1);
  y.setHours(0, 0, 0, 0);
  const ystart = new Date(y); ystart.setHours(8, 55, 0, 0);
  const yend = new Date(y); yend.setHours(17, 5, 0, 0);
  sh.getRange(3, 1, 1, 18).setValues([[
    Util.tillSessionId(y, 'S_001', 'cstore'),
    Util.attendanceId(y, 'S_001'),
    'S_001', 'cstore', y, 'closed', ystart, yend,
    250, 250, '',
    1030, 250, 780,
    1065.1, -35.1, 'investigate', 'Placeholder'
  ]]).setBackground(COLORS.PLACEHOLDER);

  setColWidths_(sh, [180, 180, 80, 80, 100, 90, 150, 150, 110, 100, 200, 130, 110, 130, 110, 110, 130, 200]);
  sh.setFrozenRows(2);
}

function setupSalesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.SALES)) return;
  const sh = ss.insertSheet(SHEETS.SALES);

  writeHeader_(sh, '🛒  Sales — by tender, per till session', 16);
  writeColumnHeaders_(sh, [
    'sales_id', 'session_id', 'staff_id', 'company', 'date',
    'cash_sales', 'credit_card_sales', 'debit_card_sales', 'cashback_paid',
    'hst_collected', 'bottle_deposit', 'round_off',
    'misc_cash_sales', 'misc_credit_sales', 'misc_debit_sales', 'misc_notes'
  ]);

  applyEnumValidation_(sh, 4, COMPANIES);
  sh.getRange(3, 5, 5000, 1).setNumberFormat('yyyy-MM-dd');
  for (const col of [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
    sh.getRange(3, col, 5000, 1).setNumberFormat('$#,##0.00');
  }

  // Placeholder
  const y = new Date();
  y.setDate(y.getDate() - 1);
  y.setHours(0, 0, 0, 0);
  const sessId = Util.tillSessionId(y, 'S_001', 'cstore');
  sh.getRange(3, 1, 1, 16).setValues([[
    sessId, sessId, 'S_001', 'cstore', y,
    910.10, 64.85, 968.35, 120.00,
    0, 0, 0,
    25.00, 0, 20.00, 'Placeholder — misc sales notes'
  ]]).setBackground(COLORS.PLACEHOLDER);

  setColWidths_(sh, [180, 180, 80, 80, 100, 110, 130, 130, 120, 120, 120, 110, 130, 130, 130, 220]);
  sh.setFrozenRows(2);
}

function setupPaymentsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.PAYMENTS)) return;
  const sh = ss.insertSheet(SHEETS.PAYMENTS);

  writeHeader_(sh, '💰  Payments — header rows', 7);
  writeColumnHeaders_(sh, [
    'payment_id', 'staff_id', 'paid_on', 'total_amount',
    'method', 'recorded_by', 'notes'
  ]);

  applyEnumValidation_(sh, 5, PAYMENT_METHODS);
  sh.getRange(3, 3, 5000, 1).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 4, 5000, 1).setNumberFormat('$#,##0.00');

  // Placeholder
  sh.getRange(3, 1, 1, 7).setValues([[
    'P_PLACEHOLDER_001', 'S_001', new Date(), 0,
    'cash', 'S_001', 'Placeholder — delete this row'
  ]]).setBackground(COLORS.PLACEHOLDER);

  setColWidths_(sh, [220, 80, 120, 120, 100, 100, 280]);
  sh.setFrozenRows(2);
}

function setupPaymentItemsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.PAYMENT_ITEMS)) return;
  const sh = ss.insertSheet(SHEETS.PAYMENT_ITEMS);

  writeHeader_(sh, '🔗  PaymentItems — allocations', 6);
  writeColumnHeaders_(sh, [
    'item_id', 'payment_id', 'item_type', 'ref_id', 'amount', 'notes'
  ]);

  applyEnumValidation_(sh, 3, ITEM_TYPES);
  sh.getRange(3, 5, 10000, 1).setNumberFormat('$#,##0.00');

  // Placeholder
  sh.getRange(3, 1, 1, 6).setValues([[
    'IT_PLACEHOLDER_001', 'P_PLACEHOLDER_001', 'shift',
    'A_PLACEHOLDER_001', 0, 'Placeholder'
  ]]).setBackground(COLORS.PLACEHOLDER);

  setColWidths_(sh, [220, 220, 110, 220, 110, 280]);
  sh.setFrozenRows(2);
}

function setupBonusesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.BONUSES)) return;
  const sh = ss.insertSheet(SHEETS.BONUSES);

  writeHeader_(sh, '🎁  Bonuses — bonuses, commissions, adjustments', 14);
  writeColumnHeaders_(sh, [
    'bonus_id', 'staff_id', 'date', 'type', 'amount', 'reason',
    'status', 'period_start', 'period_end', 'company', 'source_run_id',
    'created_by', 'created_at', 'notes'
  ]);

  applyEnumValidation_(sh, 4, BONUS_TYPES);
  applyEnumValidation_(sh, 7, BONUS_STATUSES);
  applyEnumValidation_(sh, 10, COMPANIES);  // company column allows blank too
  sh.getRange(3, 3, 5000, 1).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 5, 5000, 1).setNumberFormat('$#,##0.00');
  sh.getRange(3, 8, 5000, 2).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 13, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');

  // Placeholder
  sh.getRange(3, 1, 1, 14).setValues([[
    'B_PLACEHOLDER_001', 'S_001', new Date(), 'bonus', 0, 'Placeholder bonus reason',
    'cancelled', '', '', '', '',
    'S_001', new Date(), 'Placeholder — delete'
  ]]).setBackground(COLORS.PLACEHOLDER);

  setColWidths_(sh, [220, 80, 110, 110, 100, 240, 100, 110, 110, 90, 220, 100, 150, 240]);
  sh.setFrozenRows(2);
}

function setupCommissionRulesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.COMMISSION_RULES)) return;
  const sh = ss.insertSheet(SHEETS.COMMISSION_RULES);

  writeHeader_(sh, '🎯  Commission Rules', 13);
  writeColumnHeaders_(sh, [
    'rule_id', 'name', 'applies_to', 'staff_id', 'company',
    'threshold', 'percentage', 'active', 'effective_from', 'effective_to',
    'created_by', 'created_at', 'notes'
  ]);

  applyEnumValidation_(sh, 3, RULE_APPLIES);
  applyEnumValidation_(sh, 5, COMPANIES);
  applyBoolValidation_(sh, 8);
  sh.getRange(3, 6, 5000, 1).setNumberFormat('$#,##0.00');
  sh.getRange(3, 7, 5000, 1).setNumberFormat('0.00');
  sh.getRange(3, 9, 5000, 2).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 12, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');

  // Placeholder: cstore 5% over $1500 weekly
  sh.getRange(3, 1, 1, 13).setValues([[
    'CR_001', 'Cstore weekly base (placeholder)', 'all_staff', '', 'cstore',
    1500, 5, false, new Date(), '',
    'S_001', new Date(), 'Placeholder — enable when ready'
  ]]).setBackground(COLORS.PLACEHOLDER);

  setColWidths_(sh, [90, 220, 120, 80, 80, 110, 100, 70, 120, 120, 100, 150, 240]);
  sh.setFrozenRows(2);
}

function setupCommissionRunsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.COMMISSION_RUNS)) return;
  const sh = ss.insertSheet(SHEETS.COMMISSION_RUNS);

  writeHeader_(sh, '🎯  Commission Runs — execution log', 9);
  writeColumnHeaders_(sh, [
    'run_id', 'week_start', 'week_end', 'staff_count',
    'bonuses_created', 'total_commission_amount',
    'computed_at', 'computed_by', 'notes'
  ]);

  sh.getRange(3, 2, 5000, 2).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 6, 5000, 1).setNumberFormat('$#,##0.00');
  sh.getRange(3, 7, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');

  // Placeholder
  const lastMonday = Util.getMondayOf(new Date());
  const lastSunday = Util.endOfDay(Util.addDays(lastMonday, -1));
  const prevMonday = Util.addDays(lastMonday, -7);
  sh.getRange(3, 1, 1, 9).setValues([[
    'CRN_PLACEHOLDER_001', prevMonday, lastSunday,
    0, 0, 0, new Date(), 'SYSTEM_TRIGGER', 'Placeholder'
  ]]).setBackground(COLORS.PLACEHOLDER);

  setColWidths_(sh, [220, 120, 120, 100, 120, 160, 150, 120, 240]);
  sh.setFrozenRows(2);
}

function setupAuditLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.AUDIT_LOG)) return;
  const sh = ss.insertSheet(SHEETS.AUDIT_LOG);

  writeHeader_(sh, '🔍  Audit Log — append-only', 9);
  writeColumnHeaders_(sh, [
    'log_id', 'timestamp', 'actor_id', 'action',
    'target_type', 'target_id', 'before', 'after', 'details'
  ]);

  sh.getRange(3, 2, 50000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');

  // Placeholder
  sh.getRange(3, 1, 1, 9).setValues([[
    'LOG_PLACEHOLDER_001', new Date(), 'SYSTEM', 'setup.completed',
    'Spreadsheet', 'self', '', '', 'Initial setup placeholder'
  ]]).setBackground(COLORS.PLACEHOLDER);

  setColWidths_(sh, [220, 160, 100, 150, 110, 220, 280, 280, 240]);
  sh.setFrozenRows(2);
}

// Phase 2 placeholder tabs — schemas only, no behavior

function setupPosExtractedSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.POS_EXTRACTED)) return;
  const sh = ss.insertSheet(SHEETS.POS_EXTRACTED);

  writeHeader_(sh, '📄  POS Extracted (Phase 2 placeholder)', 12);
  writeColumnHeaders_(sh, [
    'pos_id', 'company', 'business_date', 'extracted_at',
    'cash_total', 'credit_total', 'debit_total', 'cashback_total',
    'hst', 'lottery_sales', 'bottle_deposit', 'source_filename'
  ]);
  sh.getRange(3, 3, 5000, 1).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 4, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');
  for (const col of [5, 6, 7, 8, 9, 10, 11]) {
    sh.getRange(3, col, 5000, 1).setNumberFormat('$#,##0.00');
  }
  setColWidths_(sh, [180, 80, 120, 150, 110, 110, 110, 110, 100, 110, 110, 220]);
  sh.setFrozenRows(2);
}

function setupCloverBatchesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.CLOVER_BATCHES)) return;
  const sh = ss.insertSheet(SHEETS.CLOVER_BATCHES);

  writeHeader_(sh, '🏦  Clover Batches (Phase 2 placeholder)', 11);
  writeColumnHeaders_(sh, [
    'batch_id', 'batch_date', 'company', 'gross_amount', 'fees',
    'net_expected', 'deposit_date', 'bank_amount', 'variance',
    'status', 'notes'
  ]);
  sh.getRange(3, 2, 5000, 1).setNumberFormat('yyyy-MM-dd');
  sh.getRange(3, 7, 5000, 1).setNumberFormat('yyyy-MM-dd');
  for (const col of [4, 5, 6, 8, 9]) {
    sh.getRange(3, col, 5000, 1).setNumberFormat('$#,##0.00');
  }
  setColWidths_(sh, [180, 120, 80, 120, 100, 130, 120, 130, 110, 110, 240]);
  sh.setFrozenRows(2);
}

function setupValidationResultsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.VALIDATION_RESULTS)) return;
  const sh = ss.insertSheet(SHEETS.VALIDATION_RESULTS);

  writeHeader_(sh, '✅  Validation Results (cashier vs Clover, per shift)', 21);
  writeColumnHeaders_(sh, [
    'validation_id', 'business_date', 'window_start', 'window_end', 'merchant', 'companies',
    'cashier_credit', 'clover_credit', 'cashier_debit', 'clover_debit',
    'cashier_card', 'clover_card', 'card_variance',
    'cash_counted', 'cash_variance', 'status', 'mode', 'session_ids', 'validated_at', 'validated_by', 'cash_sales'
  ]);
  sh.getRange(3, 2, 5000, 1).setNumberFormat('yyyy-MM-dd');            // business_date
  sh.getRange(3, 3, 5000, 2).setNumberFormat('yyyy-MM-dd HH:mm:ss');   // window_start, window_end
  for (let col = 7; col <= 15; col++) {                                // money columns
    sh.getRange(3, col, 5000, 1).setNumberFormat('$#,##0.00');
  }
  sh.getRange(3, 19, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');  // validated_at
  sh.getRange(3, 21, 5000, 1).setNumberFormat('$#,##0.00');            // cash_sales
  setColWidths_(sh, [170, 100, 140, 140, 110, 120, 105, 105, 105, 105, 105, 105, 105, 105, 105, 100, 70, 200, 150, 100, 105]);
  sh.setFrozenRows(2);
}

function setupSuppliersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.SUPPLIERS)) return;
  const sh = ss.insertSheet(SHEETS.SUPPLIERS);

  writeHeader_(sh, '🚚  Suppliers (reference)', 7);
  writeColumnHeaders_(sh, [
    'supplier_id', 'name', 'category', 'products', 'contact', 'notes', 'active'
  ]);
  applyEnumValidation_(sh, 3, ORDER_CATEGORIES);
  applyBoolValidation_(sh, 7);

  // Seed from "Convenience Store Suppliers" reference (normalized; edit freely).
  const seed = [
    ['SUP_001', 'Cosco Business Center', 'Grocery', 'Bread, Eggs, 2% Milk 1L, Chocolate Milk 500ml, Toilet Paper, Paper Towel, Gum, Candy, Small cans of chips, Water, Perrier glass bottles, Kinder eggs, Kinder chocolate bars, Microwave popcorn, Sesame cake, Other cakes', '', '', true],
    ['SUP_002', 'S & S Cash and Carry', 'Grocery', 'Mild Beef Patty ($11.99/box)', '', '', true],
    ['SUP_003', 'Murry Cash and Carry', 'Grocery', 'Arizona drinks, Garbage bags, Bounty dryer sheets (15pcs), Grander, Disposable plates/cups, Margarine, Dish detergent (S/L), Raw, Lighters', '', '', true],
    ['SUP_004', 'No Frills', 'Grocery', 'On-sale 2L pops, Big bags of chips', '', '', true],
    ['SUP_005', 'Walmart', 'Grocery', 'Ensure (Vanilla/Chocolate), Cat food (can pate/grill)', '', '', true],
    ['SUP_006', 'Freshco', 'Grocery', 'Big bags of chips', '', '', true],
    ['SUP_007', 'Shoppers Drugmart', 'Grocery', 'Laundry detergent (Tide/Gain), Laundry softener, Pops 710ml (Coca Cola, Pepsi, Canada Dry, Crush Orange, Diet Coke, Coke Zero)', '', '', true],
    ['SUP_008', 'Dollar Store', 'Grocery', 'Chocolate bars, Tide (yellow — check the weight)', '', '', true],
    ['SUP_009', 'Kenedy Milk (Steve)', 'Grocery', 'Honey, Pills, Raw, Lighters, Bongs, Cigarettes (LD)', 'Store: 416-757-6458, Cell: 647-989-8816', '', true],
    ['SUP_010', 'RBH', 'Cigarettes', 'Benson & Hedges Prime, Belmont, Next, Tobacco pouch (Next, Drum), Pipe tobacco, Cigar (Sail Classic), IQOS Iluma Terea sticks & devices', '', 'Company program; minimum order 10 cartons', true],
    ['SUP_011', 'JTI', 'Cigarettes', "LD, Macdonald's, Export A Fine LR, Export A rolling paper", '', 'Company program; minimum order 4 cartons', true],
    ['SUP_012', 'ITCO Products', 'Cigarettes', 'Dumaurier (from Petro-Canada, 2-pack deals), Pall Mall & others (from May)', 'May: 416-277-7819', 'No company program', true],
    ['SUP_013', 'Costco Cigarettes', 'Cigarettes', 'Match cigarettes, Windproof lighters', '', '', true],
    ['SUP_014', 'Amy', 'Cigarettes', 'All brands', 'Cell: 437-974-6789', 'No delivery fee; minimum order $1000', true],
    ['SUP_015', 'Christina', 'Cigarettes', 'Fox and ZYN (Real)', 'Cell: 437-345-1688', '', true],
    ['SUP_016', 'Pacific Smoke', 'Vapes', 'Flavour Beast disposable vapes, Pods, E-juice, Vape devices, Allo 3-pack pods', 'www.pacificsmoke.com', 'No delivery fee; minimum order $1000', true],
    ['SUP_017', 'Genuine Vapes', 'Vapes', 'Elf Bar, AL FAKHER (Crown Bar shisha flavour), Ovns 3K, Z Pods', 'https://genuinevapes.ca', '', true],
    ['SUP_018', 'Valor Distributions', 'Vapes', 'STLTH pods & STLTH disposable vapes', 'www.valordistributions.com', '', true],
  ];
  sh.getRange(3, 1, seed.length, 7).setValues(seed);

  setColWidths_(sh, [90, 180, 110, 420, 200, 240, 70]);
  sh.setFrozenRows(2);
}

function setupOrderCatalogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.ORDER_CATALOG)) return;
  const sh = ss.insertSheet(SHEETS.ORDER_CATALOG);

  writeHeader_(sh, '📒  Order Catalog', 11);
  writeColumnHeaders_(sh, [
    'item_id', 'name', 'category', 'unit', 'unit_price', 'par_level',
    'suggested_supplier', 'active', 'created_by', 'created_at', 'notes'
  ]);
  applyEnumValidation_(sh, 3, ORDER_CATEGORIES);
  applyBoolValidation_(sh, 8);
  sh.getRange(3, 5, 5000, 1).setNumberFormat('$#,##0.00');   // unit_price
  sh.getRange(3, 6, 5000, 1).setNumberFormat('0.##');         // par_level
  sh.getRange(3, 10, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');

  setColWidths_(sh, [90, 200, 110, 90, 100, 90, 160, 70, 100, 150, 220]);
  sh.setFrozenRows(2);
}

// Thin CORE catalog — identity + RESOLVED per-unit cost/sell/margin. The
// type-specific INPUTS that derive those numbers live in the per-type
// detail sheets (product_<type>_detail). See ProductTypes.gs.
function setupProductMasterSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.PRODUCT_MASTER)) return;
  const sh = ss.insertSheet(SHEETS.PRODUCT_MASTER);

  writeHeader_(sh, '📦  Product Master (core)', 23);
  writeColumnHeaders_(sh, [
    'product_id', 'sku', 'barcode', 'product_name', 'brand',
    'category', 'subcategory', 'pack_size', 'unit', 'supplier',
    'cost_price', 'sell_price', 'sell_price_credit', 'min_sell_price',
    'margin_amount', 'margin_pct',
    'active', 'notes', 'source_file',
    'created_by', 'created_at', 'updated_by', 'updated_at'
  ]);

  applyEnumValidation_(sh, 6, PRODUCT_CATEGORIES);   // category
  applyBoolValidation_(sh, 17);                       // active

  // Money formats: cost, sell, sell_credit, min_sell, margin_amount
  for (const col of [11, 12, 13, 14, 15]) {
    sh.getRange(3, col, 5000, 1).setNumberFormat('$#,##0.00');
  }
  sh.getRange(3, 16, 5000, 1).setNumberFormat('0.0%');                 // margin_pct (0..1)
  sh.getRange(3, 21, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');  // created_at
  sh.getRange(3, 23, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');  // updated_at
  sh.getRange(3, 2, 5000, 2).setNumberFormat('@');                     // SKU + barcode as text

  setColWidths_(sh, [
    180,  90, 110, 280, 110,
    100, 130, 90,  90,  140,
    90, 90, 90, 90,
    90, 70,
    60, 240, 180,
    100, 150, 100, 150
  ]);
  sh.setFrozenRows(2);
}

// ── Per-type detail sheets (1:1 with core by product_id) ────
// Generic builder driven by ProductTypes.gs so the column lists never
// drift. Money / percent / timestamp formats inferred from the schema.
const _PM_MONEY_RE = /(price|cost|deposit)/i;

function setupProductDetailSheet_(category, sheetName, title) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(sheetName)) return;
  const sh = ss.insertSheet(sheetName);

  const cols = ProductTypes.detailColumns(category);
  const schema = ProductTypes.schemaFor(category).detailFields;
  const typeOf = {};
  schema.forEach(f => { typeOf[f.key] = f.type; });

  writeHeader_(sh, title, cols.length);
  writeColumnHeaders_(sh, cols);

  cols.forEach((c, idx) => {
    const col = idx + 1;
    if (c === 'created_at' || c === 'updated_at') {
      sh.getRange(3, col, 10000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');
    } else if (c === 'sku' || c === 'product_id') {
      sh.getRange(3, col, 10000, 1).setNumberFormat('@');
    } else if (typeOf[c] === 'percent') {
      sh.getRange(3, col, 10000, 1).setNumberFormat('0.0%');
    } else if (typeOf[c] === 'number' && _PM_MONEY_RE.test(c)) {
      sh.getRange(3, col, 10000, 1).setNumberFormat('$#,##0.00');
    }
  });

  sh.setFrozenRows(2);
}

function setupProductBeerDetailSheet_() {
  setupProductDetailSheet_('beer', SHEETS.PRODUCT_BEER_DETAIL, '🍺  Beer detail (LCBO case pricing)');
}
function setupProductCigDetailSheet_() {
  setupProductDetailSheet_('cigarettes', SHEETS.PRODUCT_CIGARETTES_DETAIL, '🚬  Cigarettes detail (carton → pack pricing)');
}
function setupProductVapeDetailSheet_() {
  setupProductDetailSheet_('vape', SHEETS.PRODUCT_VAPE_DETAIL, '💨  Vape detail (attributes + prices)');
}

// ── Per-type import staging tabs ────────────────────────────
// Hidden tab per type. Admin un-hides, pastes the matching CSV from the
// Python pre-processor at A3, runs the matching "Import …" menu item,
// then re-hides. Column order comes from ProductMaster.stagingLayout(type)
// so the sheet headers and the CSV always agree.
function setupTypeStagingSheet_(type, sheetName, title) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(sheetName)) return;
  const sh = ss.insertSheet(sheetName);

  const layout = ProductMaster.stagingLayout(type);   // snake_case headers, canonical order
  writeHeader_(sh, title, layout.length);
  writeColumnHeaders_(sh, layout);

  layout.forEach((c, idx) => {
    const col = idx + 1;
    if (c === 'category') {
      applyEnumValidation_(sh, col, PRODUCT_CATEGORIES);
    } else if (c === 'sku' || c === 'barcode') {
      sh.getRange(3, col, 10000, 1).setNumberFormat('@');
    } else if (/_pct$/.test(c) || c === 'target_margin_pct') {
      sh.getRange(3, col, 10000, 1).setNumberFormat('0.0%');
    } else if (_PM_MONEY_RE.test(c)) {
      sh.getRange(3, col, 10000, 1).setNumberFormat('$#,##0.00');
    }
  });

  sh.setFrozenRows(2);
  try { sh.hideSheet(); } catch (e) { /* ignore — admin can hide manually */ }
}

function setupBeerStagingSheet_() {
  setupTypeStagingSheet_('beer', SHEETS.PM_BEER_STAGING,
    '🍺  Beer — Import Staging (paste CSV at A3; SKU + sell unit is the key)');
}
function setupCigStagingSheet_() {
  setupTypeStagingSheet_('cigarettes', SHEETS.PM_CIG_STAGING,
    '🚬  Cigarettes — Import Staging (paste CSV at A3; SKU is the key)');
}
function setupVapeStagingSheet_() {
  setupTypeStagingSheet_('vape', SHEETS.PM_VAPE_STAGING,
    '💨  Vape — Import Staging (paste CSV at A3; SKU is the key)');
}
function setupOtherStagingSheet_() {
  setupTypeStagingSheet_('other', SHEETS.PM_OTHER_STAGING,
    '🧺  Grocery/Other — Import Staging (paste CSV at A3; cost/sell entered directly)');
}

function setupShoppingListSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEETS.SHOPPING_LIST)) return;
  const sh = ss.insertSheet(SHEETS.SHOPPING_LIST);

  writeHeader_(sh, '🛒  Shopping List', 15);
  writeColumnHeaders_(sh, [
    'entry_id', 'item_id', 'item_name', 'category', 'quantity', 'unit',
    'unit_price', 'note', 'status', 'added_by', 'added_at',
    'batch_id', 'generated_by', 'generated_at', 'product_id'
  ]);
  // category now holds the product-master category (lowercase enum).
  applyEnumValidation_(sh, 4, PRODUCT_CATEGORIES);
  applyEnumValidation_(sh, 9, SHOPPING_STATUSES);
  sh.getRange(3, 5, 5000, 1).setNumberFormat('0.##');         // quantity
  sh.getRange(3, 7, 5000, 1).setNumberFormat('$#,##0.00');   // unit_price
  sh.getRange(3, 11, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');
  sh.getRange(3, 14, 5000, 1).setNumberFormat('yyyy-MM-dd HH:mm:ss');

  setColWidths_(sh, [90, 90, 200, 110, 80, 80, 100, 220, 90, 100, 150, 100, 110, 150, 180]);
  sh.setFrozenRows(2);
}

// One-shot migration: append the product_id column (col 15) to an EXISTING
// shopping_list tab. Idempotent — no-op once the header is present. Fresh
// installs already include it via setupShoppingListSheet_.
function menu_migrateShoppingListProductId() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SHOPPING_LIST);
  if (!sh) { ui.alert('shopping_list not found — run First-time Setup first.'); return; }
  const headers = sh.getRange(2, 1, 1, Math.max(sh.getLastColumn(), 15)).getValues()[0];
  if (headers.indexOf('product_id') !== -1) { ui.alert('Already migrated — product_id column present.'); return; }
  sh.getRange(2, 15).setValue('product_id')
    .setFontWeight('bold').setFontColor('#FFFFFF')
    .setBackground(COLORS.SUBHEADER).setHorizontalAlignment('center');
  sh.setColumnWidth(15, 180);
  ui.alert('Added product_id at column 15. Existing rows are unchanged.');
}

// ============================================================
//  Helpers
// ============================================================
function writeHeader_(sh, title, cols) {
  sh.getRange(1, 1, 1, cols).merge()
    .setValue(title)
    .setFontSize(13).setFontWeight('bold')
    .setFontColor('#FFFFFF').setHorizontalAlignment('center')
    .setBackground(COLORS.HEADER);
  sh.setRowHeight(1, 34);
}

function writeColumnHeaders_(sh, names) {
  sh.getRange(2, 1, 1, names.length).setValues([names])
    .setFontWeight('bold').setFontColor('#FFFFFF')
    .setBackground(COLORS.SUBHEADER).setHorizontalAlignment('center');
  sh.setRowHeight(2, 28);
}

function applyEnumValidation_(sh, col, options) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(options, true)
    .setAllowInvalid(true)
    .build();
  sh.getRange(3, col, 5000, 1).setDataValidation(rule);
}

function applyBoolValidation_(sh, col) {
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList([true, false], true)
    .build();
  sh.getRange(3, col, 5000, 1).setDataValidation(rule);
}

function setColWidths_(sh, widths) {
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

// ============================================================
//  Reset (development helper)
// ============================================================
function resetDataTables() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert(
    '⚠️ Reset data tables',
    'This DELETES all rows from operational tables:\n\n' +
    '  • attendance, till_sessions, sales\n' +
    '  • payments, payment_items\n' +
    '  • bonuses, commission_runs\n' +
    '  • audit_log\n\n' +
    'Staff, config, and commission_rules are LEFT ALONE.\n\n' +
    'Cannot be undone. Continue?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const toClear = [
    SHEETS.ATTENDANCE, SHEETS.TILL_SESSIONS, SHEETS.SALES,
    SHEETS.PAYMENTS, SHEETS.PAYMENT_ITEMS,
    SHEETS.BONUSES, SHEETS.COMMISSION_RUNS, SHEETS.AUDIT_LOG
  ];
  toClear.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    const lastRow = sh.getLastRow();
    if (lastRow > 2) {
      sh.getRange(3, 1, lastRow - 2, sh.getLastColumn())
        .clearContent().setBackground(null);
    }
  });
  ui.alert('✅  Data tables reset. Staff, config, commission_rules preserved.');
}
