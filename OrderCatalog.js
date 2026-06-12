// ============================================================
//  OrderCatalog.gs — master list of orderable items
// ============================================================
//  The set of items employees pick from when building the shopping
//  list. Grows organically: adding a "new item" appends here so it's
//  findable next time (keeps naming consistent).
//
//  unit_price = estimated cost per unit (0 = unknown)
//  par_level  = target/"max" stock qty; pre-fills suggested order qty
// ============================================================

const OrderCatalog = (() => {

  const COL = {
    item_id: 1, name: 2, category: 3, unit: 4, unit_price: 5, par_level: 6,
    suggested_supplier: 7, active: 8, created_by: 9, created_at: 10, notes: 11
  };
  const NUM_COLS = 11;
  const DATA_START_ROW = 3;
  const CACHE_KEY = 'storeops:order_catalog';
  const CACHE_TTL = 600; // 10 min

  function bustCache_() {
    try { CacheService.getScriptCache().remove(CACHE_KEY); } catch (e) {}
  }
  function reviveRecord_(r) {
    if (r.createdAt && !(r.createdAt instanceof Date)) r.createdAt = new Date(r.createdAt);
    return r;
  }

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ORDER_CATALOG);
    if (!sh) throw new Error('order_catalog sheet not found — run First-time Setup');
    return sh;
  }

  function rowToRecord_(row, rowIndex) {
    return {
      itemId:            (row[COL.item_id - 1] || '').toString().trim(),
      name:              (row[COL.name - 1] || '').toString().trim(),
      category:          (row[COL.category - 1] || '').toString().trim(),
      unit:              (row[COL.unit - 1] || '').toString().trim(),
      unitPrice:         Number(row[COL.unit_price - 1]) || 0,
      parLevel:          Number(row[COL.par_level - 1]) || 0,
      suggestedSupplier: (row[COL.suggested_supplier - 1] || '').toString().trim(),
      active:            row[COL.active - 1] === true,
      createdBy:         (row[COL.created_by - 1] || '').toString().trim(),
      createdAt:         row[COL.created_at - 1] instanceof Date ? row[COL.created_at - 1] : null,
      notes:             (row[COL.notes - 1] || '').toString(),
      _rowIndex:         rowIndex,
    };
  }

  function getAll_(includeInactive) {
    let records;
    try {
      const raw = CacheService.getScriptCache().get(CACHE_KEY);
      if (raw) records = JSON.parse(raw).map(reviveRecord_);
    } catch (e) {}
    if (!records) {
      const sh = sheet_();
      const last = sh.getLastRow();
      records = last < DATA_START_ROW ? [] :
        sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS)
          .getValues()
          .map((row, i) => rowToRecord_(row, i + DATA_START_ROW))
          .filter(r => r.itemId);
      try { CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(records), CACHE_TTL); } catch (e) {}
    }
    return includeInactive ? records : records.filter(r => r.active);
  }

  function getById_(itemId) {
    return getAll_(true).find(i => i.itemId === itemId) || null;
  }

  /**
   * Append a new catalog item.
   * @param input { name, category, unit?, unitPrice?, parLevel?, suggestedSupplier?, notes?, actorId }
   */
  function create_(input) {
    if (!input.name) throw new Error('name is required');
    // Categories are free-text (users can add their own, e.g. "Beer").
    // ORDER_CATEGORIES is just the suggested starter set.
    const category = (input.category || 'Other').toString().trim() || 'Other';
    if (!input.actorId) throw new Error('actorId required');

    bustCache_();   // dedup check below must read fresh
    // De-dupe on (name, category) — return the existing item instead of a clone.
    const existing = getAll_(true).find(i =>
      i.name.toLowerCase() === input.name.toLowerCase().trim() && i.category === category
    );
    if (existing) return existing;

    const itemId = Util.newId('IT');
    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      itemId,
      input.name.toString().trim(),
      category,
      input.unit || '',
      Util.roundMoney(input.unitPrice || 0),
      Number(input.parLevel) || 0,
      input.suggestedSupplier || '',
      true,
      input.actorId,
      new Date(),
      input.notes || '',
    ]]);

    AuditLog.write({
      actorId: input.actorId,
      action: 'order_catalog.create',
      targetType: 'order_catalog',
      targetId: itemId,
      after: { name: input.name, category, unitPrice: input.unitPrice || 0, parLevel: Number(input.parLevel) || 0 },
    });

    bustCache_();
    return getById_(itemId);
  }

  function deactivate_(itemId, actorId) {
    const existing = getById_(itemId);
    if (!existing) throw new Error('Item not found: ' + itemId);
    const sh = sheet_();
    sh.getRange(existing._rowIndex, COL.active).setValue(false);
    AuditLog.write({
      actorId: actorId || 'SYSTEM',
      action: 'order_catalog.deactivate',
      targetType: 'order_catalog',
      targetId: itemId,
      before: { active: true },
      after: { active: false },
    });
    bustCache_();
    return getById_(itemId);
  }

  return {
    getAll:     () => getAll_(false),
    getById:    getById_,
    create:     create_,
    deactivate: deactivate_,
  };
})();
