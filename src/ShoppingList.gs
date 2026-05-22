// ============================================================
//  ShoppingList.gs — shared "to order" list + generation
// ============================================================
//  Anyone can add items (item + approx qty). The pending list is
//  visible to everyone. A manager/payroll_admin/admin "generates" it:
//  the pending rows are formatted into copyable text, optionally sent
//  over WhatsApp, and stamped status='ordered' with a shared batch_id
//  (soft-clear — history preserved for audit).
//
//  Statuses: pending → ordered (on generate) | removed (manual delete)
// ============================================================

const ShoppingList = (() => {

  const COL = {
    entry_id: 1, item_id: 2, item_name: 3, category: 4, quantity: 5, unit: 6,
    unit_price: 7, note: 8, status: 9, added_by: 10, added_at: 11,
    batch_id: 12, generated_by: 13, generated_at: 14
  };
  const NUM_COLS = 14;
  const DATA_START_ROW = 3;

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SHOPPING_LIST);
    if (!sh) throw new Error('shopping_list sheet not found — run First-time Setup');
    return sh;
  }

  function rowToRecord_(row, rowIndex) {
    return {
      entryId:     (row[COL.entry_id - 1] || '').toString().trim(),
      itemId:      (row[COL.item_id - 1] || '').toString().trim(),
      itemName:    (row[COL.item_name - 1] || '').toString().trim(),
      category:    (row[COL.category - 1] || '').toString().trim(),
      quantity:    Number(row[COL.quantity - 1]) || 0,
      unit:        (row[COL.unit - 1] || '').toString().trim(),
      unitPrice:   Number(row[COL.unit_price - 1]) || 0,
      note:        (row[COL.note - 1] || '').toString(),
      status:      (row[COL.status - 1] || '').toString().trim(),
      addedBy:     (row[COL.added_by - 1] || '').toString().trim(),
      addedAt:     row[COL.added_at - 1] instanceof Date ? row[COL.added_at - 1] : null,
      batchId:     (row[COL.batch_id - 1] || '').toString().trim(),
      generatedBy: (row[COL.generated_by - 1] || '').toString().trim(),
      generatedAt: row[COL.generated_at - 1] instanceof Date ? row[COL.generated_at - 1] : null,
      _rowIndex:   rowIndex,
    };
  }

  function getAll_() {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    return data
      .map((row, i) => rowToRecord_(row, i + DATA_START_ROW))
      .filter(r => r.entryId);
  }

  function getById_(entryId) {
    return getAll_().find(e => e.entryId === entryId) || null;
  }

  function getPending_() {
    return getAll_()
      .filter(e => e.status === 'pending')
      .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  }

  // The live checklist: items still to buy (pending) + already-checked
  // (bought), sorted pending-first then oldest-first. Excludes removed/cleared.
  function getActive_() {
    return getAll_()
      .filter(e => e.status === 'pending' || e.status === 'bought')
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
        return (a.addedAt || 0) - (b.addedAt || 0);
      });
  }

  /** Toggle an item's bought (checked) state. Any authenticated user. */
  function setBought_(entryId, bought, actorId) {
    const existing = getById_(entryId);
    if (!existing) throw new Error('Entry not found: ' + entryId);
    if (existing.status !== 'pending' && existing.status !== 'bought') {
      throw new Error('Entry is not on the active list');
    }
    const newStatus = bought ? 'bought' : 'pending';
    const sh = sheet_();
    sh.getRange(existing._rowIndex, COL.status).setValue(newStatus);
    AuditLog.write({
      actorId: actorId || 'SYSTEM',
      action: 'shopping_list.' + (bought ? 'check' : 'uncheck'),
      targetType: 'shopping_list',
      targetId: entryId,
      after: { status: newStatus, itemName: existing.itemName },
    });
    return getById_(entryId);
  }

  /**
   * Clear the whole active list (start fresh). Soft-clear: pending + bought
   * rows become 'cleared' with a shared batch stamp (for those rows the
   * batch_id/generated_by/generated_at columns record the clear event).
   */
  function clearAll_(actorId) {
    if (!actorId) throw new Error('actorId required');
    const active = getActive_();
    if (active.length === 0) return { cleared: 0 };
    const batchId = Util.newId('CLR');
    const now = new Date();
    const sh = sheet_();
    active.forEach(e => {
      sh.getRange(e._rowIndex, COL.status).setValue('cleared');
      sh.getRange(e._rowIndex, COL.batch_id).setValue(batchId);
      sh.getRange(e._rowIndex, COL.generated_by).setValue(actorId);
      sh.getRange(e._rowIndex, COL.generated_at).setValue(now);
    });
    AuditLog.write({
      actorId: actorId,
      action: 'shopping_list.clear',
      targetType: 'shopping_list',
      targetId: batchId,
      after: { cleared: active.length },
    });
    return { cleared: active.length, batchId };
  }

  /**
   * Add an item to the pending list.
   * @param input {
   *   itemId?, itemName, category, quantity, unit?, unitPrice?, note?,
   *   newItem?, parLevel?, suggestedSupplier?, addedBy
   * }
   * If newItem=true, a catalog item is created first and linked.
   */
  function add_(input) {
    if (!input.addedBy) throw new Error('addedBy required');
    const name = (input.itemName || '').toString().trim();
    if (!name) throw new Error('itemName required');
    // Free-text category (users can add their own); default to 'Other'.
    const category = (input.category || 'Other').toString().trim() || 'Other';
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('quantity must be a positive number');

    let itemId = (input.itemId || '').toString().trim();
    let unit = input.unit || '';
    let unitPrice = Number(input.unitPrice) || 0;

    if (input.newItem) {
      // Persist to the catalog so it's pickable next time.
      const item = OrderCatalog.create({
        name: name,
        category: category,
        unit: unit,
        unitPrice: unitPrice,
        parLevel: Number(input.parLevel) || 0,
        suggestedSupplier: input.suggestedSupplier || '',
        actorId: input.addedBy,
      });
      itemId = item.itemId;
      unit = item.unit;
      if (!input.unitPrice) unitPrice = item.unitPrice;
    } else if (itemId) {
      // Snapshot unit/price from the catalog if not overridden.
      const item = OrderCatalog.getById(itemId);
      if (item) {
        if (!unit) unit = item.unit;
        if (!input.unitPrice) unitPrice = item.unitPrice;
      }
    }

    const entryId = Util.newId('SL');
    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      entryId, itemId, name, category, quantity, unit,
      Util.roundMoney(unitPrice), input.note || '', 'pending', input.addedBy, new Date(),
      '', '', '',
    ]]);

    AuditLog.write({
      actorId: input.addedBy,
      action: 'shopping_list.add',
      targetType: 'shopping_list',
      targetId: entryId,
      after: { itemName: name, category, quantity, unit },
    });

    return getById_(entryId);
  }

  function removeEntry_(entryId, actorId) {
    const existing = getById_(entryId);
    if (!existing) throw new Error('Entry not found: ' + entryId);
    if (existing.status !== 'pending') throw new Error('Can only remove pending entries');
    const sh = sheet_();
    sh.getRange(existing._rowIndex, COL.status).setValue('removed');
    AuditLog.write({
      actorId: actorId || 'SYSTEM',
      action: 'shopping_list.remove',
      targetType: 'shopping_list',
      targetId: entryId,
      before: { status: 'pending', itemName: existing.itemName },
      after: { status: 'removed' },
    });
    return { success: true, entryId };
  }

  /**
   * Generate the shopping list: format the still-to-buy (pending) items
   * into text and send via WhatsApp (best-effort). READ-ONLY — does NOT
   * clear or change the list. Items leave the list only when checked off
   * (bought) or via Clear list.
   */
  function generate_(actorId) {
    if (!actorId) throw new Error('actorId required');
    const pending = getPending_();
    if (pending.length === 0) return { empty: true };

    const staff = Staff.getById(actorId);
    const byName = staff ? staff.name : actorId;
    const text = formatList_(pending, byName);

    // Best-effort WhatsApp send (no row mutation)
    let whatsapp = { sent: false, reason: 'not_attempted' };
    try { whatsapp = Notifier.sendWhatsApp(text); } catch (e) { whatsapp = { sent: false, reason: 'exception', detail: e.message }; }

    AuditLog.write({
      actorId: actorId,
      action: 'shopping_list.generate',
      targetType: 'shopping_list',
      targetId: 'generate',
      after: { itemCount: pending.length, whatsappSent: !!whatsapp.sent },
    });

    return { text, itemCount: pending.length, whatsapp };
  }

  function formatList_(entries, byName) {
    const friendly = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEE d MMM yyyy');
    const lines = ['🛒 *Shopping List*', '📅 ' + friendly + (byName ? '   ·   by ' + byName : ''), ''];

    // Category order: known categories first, then any stragglers.
    const cats = ORDER_CATEGORIES.slice();
    entries.forEach(e => {
      const c = e.category || 'Other';
      if (cats.indexOf(c) === -1) cats.push(c);
    });

    let total = 0;
    let anyPrice = false;
    let count = 0;
    cats.forEach(cat => {
      const inCat = entries.filter(e => (e.category || 'Other') === cat);
      if (inCat.length === 0) return;
      lines.push('*' + cat + '*');
      inCat.forEach(e => {
        const unit = e.unit ? ' ' + e.unit : '';
        let line = '•  ' + e.itemName + '   ×' + e.quantity + unit;
        if (e.unitPrice > 0) {
          const lineCost = Util.roundMoney(e.quantity * e.unitPrice);
          line += '   —   ' + Util.formatMoney(lineCost);
          total += lineCost;
          anyPrice = true;
        }
        if (e.note) line += '   _(' + e.note + ')_';
        lines.push(line);
        count++;
      });
      lines.push('');
    });

    lines.push('────────');
    if (anyPrice) lines.push('*Estimated total:  ' + Util.formatMoney(Util.roundMoney(total)) + '*');
    lines.push('_' + count + ' item' + (count === 1 ? '' : 's') + '_');
    return lines.join('\n').trim();
  }

  return {
    getPending:  getPending_,
    getActive:   getActive_,
    getById:     getById_,
    add:         add_,
    removeEntry: removeEntry_,
    setBought:   setBought_,
    clearAll:    clearAll_,
    generate:    generate_,
  };
})();
