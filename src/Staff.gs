// ============================================================
//  Staff.gs — staff roster operations
// ============================================================
//  Reads/writes the `staff` tab. Identity = staff_id (immutable).
//  Names can be edited; cascades elsewhere are advisory.
// ============================================================

const Staff = (() => {

  const COL = {
    staff_id: 1, name: 2, hourly_rate: 3, active: 4, role: 5,
    login_code: 6, companies_authorized: 7, email: 8,
    start_date: 9, created_at: 10, notes: 11
  };
  const NUM_COLS = 11;
  const DATA_START_ROW = 3;

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.STAFF);
    if (!sh) throw new Error('staff sheet not found — run First-time Setup');
    return sh;
  }

  function rowToRecord_(row, rowIndex) {
    const companiesRaw = (row[COL.companies_authorized - 1] || '').toString().trim();
    return {
      staffId:    (row[COL.staff_id - 1] || '').toString().trim(),
      name:       (row[COL.name - 1] || '').toString().trim(),
      hourlyRate: Number(row[COL.hourly_rate - 1]) || 0,
      active:     row[COL.active - 1] === true,
      role:       (row[COL.role - 1] || 'employee').toString().trim(),
      loginCode:  (row[COL.login_code - 1] || '').toString().trim(),
      companiesAuthorized: companiesRaw
        ? companiesRaw.split(',').map(s => s.trim()).filter(Boolean)
        : [],
      email:      (row[COL.email - 1] || '').toString().trim(),
      startDate:  row[COL.start_date - 1] instanceof Date ? row[COL.start_date - 1] : null,
      createdAt:  row[COL.created_at - 1] instanceof Date ? row[COL.created_at - 1] : null,
      notes:      (row[COL.notes - 1] || '').toString(),
      _rowIndex:  rowIndex,
    };
  }

  function getAll_(includeInactive) {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    return data
      .map((row, i) => rowToRecord_(row, i + DATA_START_ROW))
      .filter(r => r.staffId && (includeInactive || r.active));
  }

  function getById_(staffId) {
    return getAll_(true).find(s => s.staffId === staffId) || null;
  }

  function getByName_(name) {
    const target = (name || '').toString().trim();
    if (!target) return null;
    return getAll_(true).find(s => s.name === target) || null;
  }

  function getActive_() {
    return getAll_(false);
  }

  /**
   * Constant-time login code comparison.
   * Returns true iff the staff exists, is active, and the code matches.
   */
  function verifyLoginCode_(staffId, submittedCode) {
    const s = getById_(staffId);
    if (!s || !s.active || !s.loginCode) return false;
    const a = s.loginCode;
    const b = (submittedCode || '').toString().trim();
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Create a new staff row.
   * Returns the created record.
   */
  function create_(input) {
    if (!input.name) throw new Error('name is required');
    if (typeof input.hourlyRate !== 'number') throw new Error('hourlyRate must be a number');

    const all = getAll_(true);
    const nameClash = all.find(s => s.name.toLowerCase() === input.name.toLowerCase());
    if (nameClash) throw new Error('Staff name already exists: ' + input.name);

    const staffId = nextStaffId_(all);
    const loginCode = input.loginCode || Util.newLoginCode(4);
    if (all.find(s => s.loginCode === loginCode)) {
      // Collision unlikely on 4 digits but possible; retry with 6
      input.loginCode = Util.newLoginCode(6);
      return create_(input);
    }
    const role = input.role || 'employee';
    if (ROLES.indexOf(role) === -1) throw new Error('Invalid role: ' + role);

    const companiesAuth = input.companiesAuthorized || ['cstore', 'vape'];
    const companiesStr = Array.isArray(companiesAuth)
      ? companiesAuth.join(',')
      : String(companiesAuth);

    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      staffId,
      input.name,
      input.hourlyRate,
      input.active !== false,
      role,
      loginCode,
      companiesStr,
      input.email || '',
      input.startDate || '',
      new Date(),
      input.notes || ''
    ]]);

    return getById_(staffId);
  }

  function nextStaffId_(allRecords) {
    let max = 0;
    allRecords.forEach(s => {
      const m = (s.staffId || '').match(/^S_(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    return 'S_' + String(max + 1).padStart(3, '0');
  }

  return {
    getAll:           () => getAll_(true),
    getActive:        getActive_,
    getById:          getById_,
    getByName:        getByName_,
    verifyLoginCode:  verifyLoginCode_,
    create:           create_,
  };
})();
