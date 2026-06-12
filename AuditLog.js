// ============================================================
//  AuditLog.gs — append-only event log
// ============================================================
//  Best-effort: if the audit sheet doesn't exist yet (during setup),
//  this silently no-ops rather than blocking the operation.
//  Never edit log rows; only append.
// ============================================================

const AuditLog = (() => {

  const COL = {
    log_id: 1, timestamp: 2, actor_id: 3, action: 4,
    target_type: 5, target_id: 6, before: 7, after: 8, details: 9
  };
  const NUM_COLS = 9;

  function sheet_() {
    return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.AUDIT_LOG);
  }

  function write_(entry) {
    const sh = sheet_();
    if (!sh) return;

    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      Util.newId('LOG'),
      new Date(),
      entry.actorId || '',
      entry.action || '',
      entry.targetType || '',
      entry.targetId || '',
      entry.before ? JSON.stringify(entry.before) : '',
      entry.after  ? JSON.stringify(entry.after)  : '',
      entry.details || ''
    ]]);
  }

  function recent_(limit, filters) {
    const sh = sheet_();
    if (!sh) return [];
    const last = sh.getLastRow();
    if (last < 3) return [];
    limit = limit || 50;

    const rowsToRead = Math.min(limit * 4, last - 2);
    const startRow = last - rowsToRead + 1;
    const data = sh.getRange(startRow, 1, rowsToRead, NUM_COLS).getValues();
    const entries = data.reverse().map(r => ({
      logId: r[COL.log_id - 1],
      timestamp: r[COL.timestamp - 1] instanceof Date ? r[COL.timestamp - 1] : null,
      actorId: r[COL.actor_id - 1],
      action: r[COL.action - 1],
      targetType: r[COL.target_type - 1],
      targetId: r[COL.target_id - 1],
      before: r[COL.before - 1],
      after: r[COL.after - 1],
      details: r[COL.details - 1],
    }));

    let filtered = entries;
    if (filters) {
      if (filters.actorId)    filtered = filtered.filter(e => e.actorId === filters.actorId);
      if (filters.action)     filtered = filtered.filter(e => e.action === filters.action);
      if (filters.targetType) filtered = filtered.filter(e => e.targetType === filters.targetType);
      if (filters.targetId)   filtered = filtered.filter(e => e.targetId === filters.targetId);
    }
    return filtered.slice(0, limit);
  }

  return {
    write:  write_,
    recent: recent_,
  };
})();
