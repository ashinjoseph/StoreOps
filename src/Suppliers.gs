// ============================================================
//  Suppliers.gs — supplier reference (read-only in app)
// ============================================================
//  Loose reference of WHERE to buy WHAT. Seeded once by Setup and
//  edited directly in the sheet. The app only reads it (a reference
//  screen); there is no create/update RPC.
// ============================================================

const Suppliers = (() => {

  const COL = {
    supplier_id: 1, name: 2, category: 3, products: 4, contact: 5, notes: 6, active: 7
  };
  const NUM_COLS = 7;
  const DATA_START_ROW = 3;
  const CACHE_KEY = 'storeops:suppliers';
  const CACHE_TTL = 600; // 10 min — reference data, edited in-sheet

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SUPPLIERS);
    if (!sh) throw new Error('suppliers sheet not found — run First-time Setup');
    return sh;
  }

  function rowToRecord_(row) {
    return {
      supplierId: (row[COL.supplier_id - 1] || '').toString().trim(),
      name:       (row[COL.name - 1] || '').toString().trim(),
      category:   (row[COL.category - 1] || '').toString().trim(),
      products:   (row[COL.products - 1] || '').toString(),
      contact:    (row[COL.contact - 1] || '').toString(),
      notes:      (row[COL.notes - 1] || '').toString(),
      active:     row[COL.active - 1] === true,
    };
  }

  function getAll_(includeInactive) {
    let records;
    try {
      const raw = CacheService.getScriptCache().get(CACHE_KEY);
      if (raw) records = JSON.parse(raw);
    } catch (e) {}
    if (!records) {
      const sh = sheet_();
      const last = sh.getLastRow();
      records = last < DATA_START_ROW ? [] :
        sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS)
          .getValues()
          .map(rowToRecord_)
          .filter(r => r.supplierId);
      try { CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(records), CACHE_TTL); } catch (e) {}
    }
    return includeInactive ? records : records.filter(r => r.active);
  }

  function getById_(supplierId) {
    return getAll_(true).find(s => s.supplierId === supplierId) || null;
  }

  return {
    getAll:  () => getAll_(false),
    getById: getById_,
  };
})();
