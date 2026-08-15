// ============================================================
//  CashHandling.gs — cash in a cashier's hands, until it isn't
// ============================================================
//  Every close computes `cash_removed_at_close` — the drawer count, less
//  the float that stays for tomorrow, less anything moved into the lotto
//  reserve. That is the cash the cashier physically walks out with, and
//  until now nothing tracked it past that moment.
//
//  This module holds that amount against whoever took it, shift by shift,
//  and discharges it with a HANDOVER: a row saying who moved cash to whom,
//  how much, and — the field that settles an argument — who recorded it.
//
//  Deliberately NOT a two-party confirmation flow. Either the cashier or
//  the cash manager records the handover and it takes effect immediately;
//  what makes it trustworthy is that `recorded_by` is permanent and shown
//  on screen, never collapsed behind a tap.
//
//  Allocation is oldest-first against unsettled sessions, so "which shift's
//  cash is still out" has an answer, not just a running total.
//
//  A handover is never deleted. `voidHandover_` flips the status and leaves the row
//  — a deleted row reviews nothing, which defeats the purpose of the ledger.
// ============================================================

const CashHandling = (() => {

  // cash_handovers
  const H_COL = {
    handover_id: 1, from_staff_id: 2, to_staff_id: 3, amount: 4, handed_on: 5,
    recorded_by: 6, recorded_at: 7, method: 8, status: 9, notes: 10,
    voided_by: 11, voided_at: 12
  };
  const H_NUM_COLS = 12;
  const H_DATA_START = 3;

  // cash_handover_items
  const I_COL = { item_id: 1, handover_id: 2, session_id: 3, amount: 4, notes: 5 };
  const I_NUM_COLS = 5;
  const I_DATA_START = 3;

  let _handoversCache = null;
  let _itemsCache = null;

  function bustCaches_() {
    _handoversCache = null;
    _itemsCache = null;
  }

  // ── Cell parsing ────────────────────────────────────────
  // Same defensive reads as TillSessions: a column formatted as text hands
  // back "$520.00" or "2026-08-14", and a strict instanceof/Number check
  // silently drops the row.
  function toDate_(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v !== 'string' || !v.trim()) return null;
    const s = v.trim();
    const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function num_(v) {
    if (typeof v === 'number') return isNaN(v) ? 0 : v;
    if (v == null) return 0;
    const s = v.toString().trim();
    if (!s) return 0;
    const n = Number(s.replace(/[$,\s]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function configValue_(key, defaultValue) {
    try {
      const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CONFIG);
      if (!sh) return defaultValue;
      const data = sh.getRange(3, 1, sh.getLastRow() - 2, 2).getValues();
      const row = data.find(r => r[0] === key);
      return row && row[1] !== '' ? row[1] : defaultValue;
    } catch (e) { return defaultValue; }
  }

  // ── Feature flag ────────────────────────────────────────
  /**
   * Both tables must exist. Until the migration runs this is false and every
   * public read returns { enabled:false } rather than throwing, so the code
   * deploys safely ahead of the one menu click that turns it on.
   */
  function sheetsExist_() {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    return !!(ss.getSheetByName(SHEETS.CASH_HANDOVERS) &&
              ss.getSheetByName(SHEETS.CASH_HANDOVER_ITEMS));
  }

  function handoversSheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CASH_HANDOVERS);
    if (!sh) throw new Error('cash_handovers sheet not found — run StoreOps → Add cash handling tables');
    return sh;
  }
  function itemsSheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CASH_HANDOVER_ITEMS);
    if (!sh) throw new Error('cash_handover_items sheet not found — run StoreOps → Add cash handling tables');
    return sh;
  }

  /**
   * The person who holds the business cash, from config. Returns null when
   * unset or pointing at a staff row that no longer exists — callers say so
   * plainly rather than writing a handover to a blank recipient.
   */
  function cashManager_() {
    const id = (configValue_('cash_manager_staff_id', '') || '').toString().trim();
    if (!id) return null;
    return Staff.getById(id) || null;
  }

  function staleDays_() {
    const n = Number(configValue_('cash_handover_stale_days', 7));
    return isNaN(n) || n <= 0 ? 7 : n;
  }

  // ── Row decoders ────────────────────────────────────────
  function hRowToRecord_(row, rowIndex) {
    return {
      handoverId:  (row[H_COL.handover_id - 1] || '').toString().trim(),
      fromStaffId: (row[H_COL.from_staff_id - 1] || '').toString().trim(),
      toStaffId:   (row[H_COL.to_staff_id - 1] || '').toString().trim(),
      amount:      num_(row[H_COL.amount - 1]),
      handedOn:    toDate_(row[H_COL.handed_on - 1]),
      recordedBy:  (row[H_COL.recorded_by - 1] || '').toString().trim(),
      recordedAt:  toDate_(row[H_COL.recorded_at - 1]),
      method:      (row[H_COL.method - 1] || 'cash').toString().trim(),
      status:      (row[H_COL.status - 1] || 'recorded').toString().trim().toLowerCase(),
      notes:       (row[H_COL.notes - 1] || '').toString(),
      voidedBy:    (row[H_COL.voided_by - 1] || '').toString().trim(),
      voidedAt:    toDate_(row[H_COL.voided_at - 1]),
      _rowIndex:   rowIndex,
    };
  }

  function iRowToRecord_(row, rowIndex) {
    return {
      itemId:     (row[I_COL.item_id - 1] || '').toString().trim(),
      handoverId: (row[I_COL.handover_id - 1] || '').toString().trim(),
      sessionId:  (row[I_COL.session_id - 1] || '').toString().trim(),
      amount:     num_(row[I_COL.amount - 1]),
      notes:      (row[I_COL.notes - 1] || '').toString(),
      _rowIndex:  rowIndex,
    };
  }

  function getAllHandovers_() {
    if (_handoversCache) return _handoversCache;
    const sh = handoversSheet_();
    const last = sh.getLastRow();
    _handoversCache = last < H_DATA_START ? [] :
      sh.getRange(H_DATA_START, 1, last - H_DATA_START + 1, H_NUM_COLS)
        .getValues()
        .map((row, i) => hRowToRecord_(row, i + H_DATA_START))
        .filter(r => r.handoverId);
    return _handoversCache;
  }

  function getAllItems_() {
    if (_itemsCache) return _itemsCache;
    const sh = itemsSheet_();
    const last = sh.getLastRow();
    _itemsCache = last < I_DATA_START ? [] :
      sh.getRange(I_DATA_START, 1, last - I_DATA_START + 1, I_NUM_COLS)
        .getValues()
        .map((row, i) => iRowToRecord_(row, i + I_DATA_START))
        .filter(r => r.itemId);
    return _itemsCache;
  }

  function isVoided_(h) { return h.status === 'voided'; }

  /**
   * How much has already been handed over against each session. Voided
   * handovers are excluded, which is what makes a void reverse the
   * allocation without touching a single item row.
   */
  function settledBySession_() {
    const live = {};
    getAllHandovers_().forEach(h => { if (!isVoided_(h)) live[h.handoverId] = true; });
    const map = {};
    getAllItems_().forEach(it => {
      if (!live[it.handoverId]) return;
      map[it.sessionId] = Util.roundMoney((map[it.sessionId] || 0) + it.amount);
    });
    return map;
  }

  function isClosed_(s) {
    const st = (s.status || '').toLowerCase();
    return st === 'closed' || st === 'validated';
  }

  function daysBetween_(from, to) {
    if (!from) return 0;
    return Math.max(0, Math.floor((to - from) / 86400000));
  }

  // ── Balances ────────────────────────────────────────────
  /**
   * What `staffId` is still carrying, and which shifts it came from.
   *
   * Sessions whose cash_removed_at_close is zero or negative are skipped.
   * Negative means the drawer came up short of its own float — a variance
   * matter that variance_status already handles. Counting it here would let
   * a till shortfall quietly REDUCE what the cashier owes, turning a loss
   * into a discount.
   */
  function getOutstandingForStaff_(staffId) {
    if (!staffId) throw new Error('staffId required');
    const settled = settledBySession_();
    const now = new Date();

    const unsettledSessions = [];
    let totalOutstanding = 0;

    TillSessions.getAll()
      .filter(s => s.staffId === staffId && isClosed_(s))
      .forEach(s => {
        const cashTaken = Util.roundMoney(s.cashRemovedAtClose || 0);
        if (cashTaken <= 0.005) return;
        const done = settled[s.sessionId] || 0;
        const remaining = Util.roundMoney(cashTaken - done);
        if (remaining <= 0.005) return;
        unsettledSessions.push({
          sessionId: s.sessionId,
          company:   s.company,
          date:      s.date ? s.date.toISOString() : null,
          dateStr:   s.date ? Util.formatDate(s.date) : '',
          cashTaken: cashTaken,
          settled:   done,
          remaining: remaining,
          ageDays:   daysBetween_(s.date, now),
        });
        totalOutstanding = Util.roundMoney(totalOutstanding + remaining);
      });

    // Oldest first — the order the allocation walks, so the UI preview and
    // the write agree.
    unsettledSessions.sort((a, b) => {
      const ad = a.date ? new Date(a.date).getTime() : 0;
      const bd = b.date ? new Date(b.date).getTime() : 0;
      return ad - bd;
    });

    return { staffId: staffId, totalOutstanding: totalOutstanding, unsettledSessions: unsettledSessions };
  }

  /**
   * Every staff member currently holding cash, largest first, plus the
   * sessions that have been out longer than cash_handover_stale_days.
   */
  function getAllOutstanding_() {
    const limit = staleDays_();
    const holders = [];
    const stale = [];
    let grandTotal = 0;

    Staff.getAll().forEach(st => {
      const o = getOutstandingForStaff_(st.staffId);
      if (o.totalOutstanding <= 0.005) return;
      holders.push({
        staffId:  st.staffId,
        name:     st.name,
        total:    o.totalOutstanding,
        shifts:   o.unsettledSessions.length,
        oldest:   o.unsettledSessions.length ? o.unsettledSessions[0].dateStr : '',
        oldestAge: o.unsettledSessions.length ? o.unsettledSessions[0].ageDays : 0,
      });
      grandTotal = Util.roundMoney(grandTotal + o.totalOutstanding);
      o.unsettledSessions.forEach(s => {
        if (s.ageDays >= limit) {
          stale.push({
            staffId: st.staffId, name: st.name, sessionId: s.sessionId,
            company: s.company, dateStr: s.dateStr,
            remaining: s.remaining, ageDays: s.ageDays,
          });
        }
      });
    });

    holders.sort((a, b) => b.total - a.total);
    stale.sort((a, b) => b.ageDays - a.ageDays);
    return { holders: holders, grandTotal: grandTotal, stale: stale, staleDays: limit };
  }

  // ── Handover history ────────────────────────────────────
  function enrich_(h, names) {
    const items = getAllItems_()
      .filter(it => it.handoverId === h.handoverId)
      .map(it => ({ sessionId: it.sessionId, amount: it.amount, notes: it.notes }));
    return {
      handoverId:   h.handoverId,
      fromStaffId:  h.fromStaffId,
      fromName:     names[h.fromStaffId] || h.fromStaffId,
      toStaffId:    h.toStaffId,
      toName:       names[h.toStaffId] || h.toStaffId,
      amount:       h.amount,
      handedOn:     h.handedOn ? h.handedOn.toISOString() : null,
      handedOnStr:  h.handedOn ? Util.formatDate(h.handedOn) : '',
      recordedBy:   h.recordedBy,
      recordedByName: names[h.recordedBy] || h.recordedBy,
      recordedAt:   h.recordedAt ? h.recordedAt.toISOString() : null,
      method:       h.method,
      status:       h.status,
      notes:        h.notes,
      voidedBy:     h.voidedBy,
      voidedByName: h.voidedBy ? (names[h.voidedBy] || h.voidedBy) : '',
      items:        items,
    };
  }

  function getHistory_(limit, staffId) {
    const names = {};
    Staff.getAll().forEach(s => { names[s.staffId] = s.name; });
    let rows = getAllHandovers_();
    if (staffId) {
      rows = rows.filter(h => h.fromStaffId === staffId || h.toStaffId === staffId);
    }
    return rows
      .slice()
      .sort((a, b) => {
        const at = a.recordedAt ? a.recordedAt.getTime() : 0;
        const bt = b.recordedAt ? b.recordedAt.getTime() : 0;
        if (bt !== at) return bt - at;
        return b._rowIndex - a._rowIndex;   // same second → sheet order
      })
      .slice(0, limit || 25)
      .map(h => enrich_(h, names));
  }

  // ── Record ──────────────────────────────────────────────
  /**
   * Record cash moving from a cashier to the cash manager.
   *
   * @param input {
   *   fromStaffId, amount, actorId,
   *   handedOn?  (Date or yyyy-MM-dd; defaults to today)
   *   toStaffId? (defaults to the configured cash manager)
   *   method?    (defaults to 'cash')
   *   notes?     (REQUIRED when the amount is short of the balance)
   * }
   *
   * Returns { handoverId, amount, itemsCreated:[...], outstandingBefore,
   *           outstandingAfter }
   */
  function record_(input) {
    input = input || {};
    if (!input.fromStaffId) throw new Error('fromStaffId required');
    if (!input.actorId) throw new Error('actorId required');
    const amount = Util.roundMoney(Number(input.amount) || 0);
    if (amount <= 0) throw new Error('amount must be a positive number');

    const from = Staff.getById(input.fromStaffId);
    if (!from) throw new Error('Staff not found: ' + input.fromStaffId);

    const manager = cashManager_();
    const toStaffId = (input.toStaffId || (manager && manager.staffId) || '').toString().trim();
    if (!toStaffId) {
      throw new Error(
        'No cash manager configured — set cash_manager_staff_id in the config tab ' +
        'to the staff_id of whoever holds the business cash.'
      );
    }
    if (!Staff.getById(toStaffId)) throw new Error('Recipient not found: ' + toStaffId);

    // Either party may record it; an admin can record on anyone's behalf.
    const actor = Staff.getById(input.actorId);
    const actorIsParty = input.actorId === input.fromStaffId || input.actorId === toStaffId;
    if (!actorIsParty && (!actor || actor.role !== 'admin')) {
      throw new Error('Only ' + from.name + ', the cash manager, or an admin can record this handover');
    }

    const before = getOutstandingForStaff_(input.fromStaffId);
    if (amount > before.totalOutstanding + 0.005) {
      throw new Error(
        from.name + ' is holding ' + Util.formatMoney(before.totalOutstanding) +
        ', so ' + Util.formatMoney(amount) + ' cannot be handed over.'
      );
    }

    const notes = (input.notes || '').toString().trim();
    const leftover = Util.roundMoney(before.totalOutstanding - amount);
    if (leftover > 0.005 && !notes) {
      throw new Error(
        Util.formatMoney(leftover) + ' would stay in ' + from.name +
        "'s hands. Please give a reason."
      );
    }

    const handedOn = toDate_(input.handedOn) || new Date();
    const now = new Date();
    const handoverId = Util.newId('H');

    // Allocate oldest first, filling each session before moving on — the
    // same walk payShifts uses against unpaid attendance.
    const itemsCreated = [];
    const itemRows = [];
    let remaining = amount;
    for (let i = 0; i < before.unsettledSessions.length && remaining > 0.005; i++) {
      const s = before.unsettledSessions[i];
      const take = Util.roundMoney(Math.min(remaining, s.remaining));
      if (take <= 0.005) continue;
      const itemId = Util.newId('CI');
      itemRows.push([itemId, handoverId, s.sessionId, take, '']);
      itemsCreated.push({
        itemId: itemId, sessionId: s.sessionId, dateStr: s.dateStr,
        company: s.company, amount: take,
        isPartial: take < s.remaining - 0.005,
      });
      remaining = Util.roundMoney(remaining - take);
    }

    if (remaining > 0.005) {
      // Should be unreachable — the overpayment guard above covers it — but a
      // silent unallocated remainder is exactly the bug worth shouting about.
      throw new Error('Could not allocate ' + Util.formatMoney(remaining) + ' — nothing to apply it to');
    }

    const hSheet = handoversSheet_();
    hSheet.getRange(hSheet.getLastRow() + 1, 1, 1, H_NUM_COLS).setValues([[
      handoverId, input.fromStaffId, toStaffId, amount, handedOn,
      input.actorId, now, (input.method || 'cash'), 'recorded', notes, '', ''
    ]]);

    if (itemRows.length) {
      const iSheet = itemsSheet_();
      iSheet.getRange(iSheet.getLastRow() + 1, 1, itemRows.length, I_NUM_COLS)
        .setValues(itemRows);
    }

    bustCaches_();

    AuditLog.write({
      actorId: input.actorId,
      action: 'cash.handover',
      targetType: SHEETS.CASH_HANDOVERS,
      targetId: handoverId,
      after: {
        from: input.fromStaffId, to: toStaffId, amount: amount,
        sessions: itemsCreated.length, stillOut: leftover, notes: notes,
      },
      details: from.name + ' → ' + (Staff.getById(toStaffId) || {}).name + ' ' +
               Util.formatMoney(amount) + ', recorded by ' +
               ((actor && actor.name) || input.actorId) +
               (leftover > 0.005 ? ', ' + Util.formatMoney(leftover) + ' still out' : ''),
    });

    return {
      handoverId: handoverId,
      amount: amount,
      itemsCreated: itemsCreated,
      outstandingBefore: before.totalOutstanding,
      outstandingAfter: leftover,
    };
  }

  // ── Void ────────────────────────────────────────────────
  /**
   * Reverse a handover without erasing it. The row stays, status flips, and
   * settledBySession_ stops counting its items — so the balance returns to
   * exactly what it was, with the mistake still legible.
   */
  function voidHandover_(handoverId, actorId) {
    if (!handoverId) throw new Error('handoverId required');
    if (!actorId) throw new Error('actorId required');

    const h = getAllHandovers_().find(x => x.handoverId === handoverId);
    if (!h) throw new Error('Handover not found: ' + handoverId);
    if (isVoided_(h)) throw new Error('Handover is already voided');

    const sh = handoversSheet_();
    sh.getRange(h._rowIndex, H_COL.status).setValue('voided');
    sh.getRange(h._rowIndex, H_COL.voided_by).setValue(actorId);
    sh.getRange(h._rowIndex, H_COL.voided_at).setValue(new Date());
    bustCaches_();

    AuditLog.write({
      actorId: actorId,
      action: 'cash.handover.void',
      targetType: SHEETS.CASH_HANDOVERS,
      targetId: handoverId,
      before: { amount: h.amount, from: h.fromStaffId, to: h.toStaffId, recordedBy: h.recordedBy },
      details: 'Voided ' + Util.formatMoney(h.amount) + ' handover recorded by ' + h.recordedBy,
    });

    return { handoverId: handoverId, status: 'voided', amount: h.amount };
  }

  // ── UI payload ──────────────────────────────────────────
  /**
   * Everything the Cash Handling tab needs in one round-trip.
   * `privileged` decides whether the all-staff roster comes back — the
   * caller (WebApp) resolves that from the session, never from the client.
   */
  function getPosition_(staffId, privileged) {
    if (!sheetsExist_()) return { enabled: false };

    const manager = cashManager_();
    const mine = getOutstandingForStaff_(staffId);
    const out = {
      enabled: true,
      cashManager: manager ? { staffId: manager.staffId, name: manager.name } : null,
      isCashManager: !!(manager && manager.staffId === staffId),
      mine: mine,
      recent: getHistory_(10, staffId),
    };
    if (privileged) {
      const all = getAllOutstanding_();
      out.holders   = all.holders;
      out.grandTotal = all.grandTotal;
      out.stale     = all.stale;
      out.staleDays = all.staleDays;
      out.allRecent = getHistory_(25, null);
    }
    return out;
  }

  return {
    sheetsExist:            sheetsExist_,
    cashManager:            cashManager_,
    getOutstandingForStaff: getOutstandingForStaff_,
    getAllOutstanding:      getAllOutstanding_,
    getHistory:             getHistory_,
    getPosition:            getPosition_,
    record:                 record_,
    voidHandover:           voidHandover_,
  };
})();
