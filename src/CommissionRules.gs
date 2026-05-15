// ============================================================
//  CommissionRules.gs — CRUD for commission_rules tab
// ============================================================
//  A rule says: "for staff S (or all staff) on company C, when weekly
//  sales > threshold, pay percentage of (sales - threshold) as commission".
//
//  Fields:
//    rule_id          CR_001, CR_002, ...
//    name             human label ("Cstore weekly base")
//    applies_to       'all_staff' | 'specific_staff'
//    staff_id         if applies_to='specific_staff'; else blank
//    company          'cstore' | 'vape'
//    threshold        dollars; sales below this earn 0 commission
//    percentage       e.g. 5 means 5% (not 0.05)
//    active           bool
//    effective_from   date
//    effective_to     optional end date; blank = open-ended
//    created_by, created_at, notes
// ============================================================

const CommissionRules = (() => {

  const COL = {
    rule_id: 1, name: 2, applies_to: 3, staff_id: 4, company: 5,
    threshold: 6, percentage: 7, active: 8,
    effective_from: 9, effective_to: 10,
    created_by: 11, created_at: 12, notes: 13
  };
  const NUM_COLS = 13;
  const DATA_START_ROW = 3;

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMMISSION_RULES);
    if (!sh) throw new Error('commission_rules sheet not found — run First-time Setup');
    return sh;
  }

  function rowToRecord_(row, rowIndex) {
    return {
      ruleId:        (row[COL.rule_id - 1] || '').toString().trim(),
      name:          (row[COL.name - 1] || '').toString(),
      appliesTo:     (row[COL.applies_to - 1] || '').toString().trim(),
      staffId:       (row[COL.staff_id - 1] || '').toString().trim(),
      company:       (row[COL.company - 1] || '').toString().trim(),
      threshold:     Number(row[COL.threshold - 1]) || 0,
      percentage:    Number(row[COL.percentage - 1]) || 0,
      active:        row[COL.active - 1] === true,
      effectiveFrom: row[COL.effective_from - 1] instanceof Date ? row[COL.effective_from - 1] : null,
      effectiveTo:   row[COL.effective_to - 1] instanceof Date ? row[COL.effective_to - 1] : null,
      createdBy:     (row[COL.created_by - 1] || '').toString(),
      createdAt:     row[COL.created_at - 1] instanceof Date ? row[COL.created_at - 1] : null,
      notes:         (row[COL.notes - 1] || '').toString(),
      _rowIndex:     rowIndex,
    };
  }

  function getAll_() {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    return data
      .map((row, i) => rowToRecord_(row, i + DATA_START_ROW))
      .filter(r => r.ruleId && !r.ruleId.startsWith('CR_PLACEHOLDER'));
  }

  function getById_(ruleId) {
    return getAll_().find(r => r.ruleId === ruleId) || null;
  }

  /**
   * Active rules that apply on `forDate` (effective_from ≤ forDate,
   * effective_to is null or ≥ forDate).
   */
  function getActiveOn_(forDate) {
    const date = forDate instanceof Date ? forDate : new Date();
    return getAll_().filter(r => {
      if (!r.active) return false;
      if (!r.effectiveFrom) return false;
      if (r.effectiveFrom > date) return false;
      if (r.effectiveTo && r.effectiveTo < date) return false;
      return true;
    });
  }

  /**
   * Which rules apply to a given (staff, company) on a given date?
   *   - rule.appliesTo='all_staff' applies to everyone
   *   - rule.appliesTo='specific_staff' requires staffId match
   *   - rule.company must match
   */
  function getRulesFor_(staffId, company, forDate) {
    return getActiveOn_(forDate).filter(r => {
      if (r.company !== company) return false;
      if (r.appliesTo === 'all_staff') return true;
      if (r.appliesTo === 'specific_staff') return r.staffId === staffId;
      return false;
    });
  }

  function nextRuleId_() {
    const all = getAll_();
    let max = 0;
    all.forEach(r => {
      const m = (r.ruleId || '').match(/^CR_(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'CR_' + String(max + 1).padStart(3, '0');
  }

  // ── Create ──────────────────────────────────────────────

  function create_(input) {
    if (!input.name) throw new Error('name required');
    if (!input.appliesTo) throw new Error('appliesTo required');
    if (RULE_APPLIES.indexOf(input.appliesTo) === -1) {
      throw new Error('Invalid appliesTo: ' + input.appliesTo);
    }
    if (input.appliesTo === 'specific_staff' && !input.staffId) {
      throw new Error('staffId required when appliesTo=specific_staff');
    }
    if (input.appliesTo === 'specific_staff') {
      const staff = Staff.getById(input.staffId);
      if (!staff) throw new Error('Staff not found: ' + input.staffId);
    }
    if (!input.company || COMPANIES.indexOf(input.company) === -1) {
      throw new Error('Invalid company: ' + input.company);
    }
    if (typeof input.threshold !== 'number' || input.threshold < 0) {
      throw new Error('threshold must be a non-negative number');
    }
    if (typeof input.percentage !== 'number' || input.percentage < 0 || input.percentage > 100) {
      throw new Error('percentage must be between 0 and 100');
    }
    if (!input.actorId) throw new Error('actorId required');

    const ruleId = nextRuleId_();
    const now = new Date();
    const effectiveFrom = input.effectiveFrom instanceof Date
      ? input.effectiveFrom
      : Util.parseDate(input.effectiveFrom);
    if (!effectiveFrom) throw new Error('effectiveFrom is required and must be a valid date');
    const effectiveTo = input.effectiveTo
      ? (input.effectiveTo instanceof Date ? input.effectiveTo : Util.parseDate(input.effectiveTo))
      : '';

    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      ruleId,
      input.name,
      input.appliesTo,
      input.appliesTo === 'specific_staff' ? input.staffId : '',
      input.company,
      Util.roundMoney(input.threshold),
      Number(input.percentage),
      input.active !== false,
      effectiveFrom,
      effectiveTo,
      input.actorId,
      now,
      input.notes || '',
    ]]);

    AuditLog.write({
      actorId: input.actorId,
      action: 'commission_rule.create',
      targetType: 'commission_rules',
      targetId: ruleId,
      after: {
        name: input.name,
        appliesTo: input.appliesTo,
        staffId: input.staffId,
        company: input.company,
        threshold: input.threshold,
        percentage: input.percentage,
      },
    });

    return getById_(ruleId);
  }

  // ── Update ──────────────────────────────────────────────

  /**
   * Patch a rule's mutable fields. Cannot change ruleId.
   *
   * @param input { ruleId, name?, threshold?, percentage?, active?,
   *               effectiveTo?, notes?, actorId }
   *
   * NOTE: changing applies_to / staff_id / company / effective_from on an
   * existing rule is discouraged — those changes alter the rule's identity.
   * For those cases, cancel the old rule (set effectiveTo) and create a new one.
   */
  function update_(input) {
    if (!input.ruleId) throw new Error('ruleId required');
    if (!input.actorId) throw new Error('actorId required');

    const existing = getById_(input.ruleId);
    if (!existing) throw new Error('Rule not found: ' + input.ruleId);

    const sh = sheet_();
    const row = existing._rowIndex;
    const before = {
      name: existing.name,
      threshold: existing.threshold,
      percentage: existing.percentage,
      active: existing.active,
      effectiveTo: existing.effectiveTo,
    };

    if (input.name !== undefined) sh.getRange(row, COL.name).setValue(input.name);
    if (input.threshold !== undefined) sh.getRange(row, COL.threshold).setValue(Util.roundMoney(input.threshold));
    if (input.percentage !== undefined) sh.getRange(row, COL.percentage).setValue(Number(input.percentage));
    if (input.active !== undefined) sh.getRange(row, COL.active).setValue(input.active === true);
    if (input.effectiveTo !== undefined) {
      const eto = input.effectiveTo
        ? (input.effectiveTo instanceof Date ? input.effectiveTo : Util.parseDate(input.effectiveTo))
        : '';
      sh.getRange(row, COL.effective_to).setValue(eto);
    }
    if (input.notes !== undefined) sh.getRange(row, COL.notes).setValue(input.notes);

    AuditLog.write({
      actorId: input.actorId,
      action: 'commission_rule.update',
      targetType: 'commission_rules',
      targetId: input.ruleId,
      before,
      after: {
        name: input.name,
        threshold: input.threshold,
        percentage: input.percentage,
        active: input.active,
        effectiveTo: input.effectiveTo,
      },
    });

    return getById_(input.ruleId);
  }

  /**
   * Convenience: deactivate a rule. Sets active=false; existing audit
   * trail preserved.
   */
  function deactivate_(ruleId, actorId) {
    return update_({ ruleId, active: false, actorId });
  }

  return {
    getAll:        getAll_,
    getById:       getById_,
    getActiveOn:   getActiveOn_,
    getRulesFor:   getRulesFor_,
    create:        create_,
    update:        update_,
    deactivate:    deactivate_,
  };
})();
