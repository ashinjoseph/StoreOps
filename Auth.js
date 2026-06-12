// ============================================================
//  Auth.gs — login, session tokens, role guards
// ============================================================
//  Sessions live in PropertiesService (script properties).
//  Token format: opaque 32-char hex (UUID minus hyphens).
//  Session value: { staffId, name, role, companiesAuthorized, expiresAt }
// ============================================================

const Auth = (() => {

  const SESSION_KEY_PREFIX = 'session:';
  const FAIL_KEY_PREFIX = 'loginFails:';

  function props_() {
    return PropertiesService.getScriptProperties();
  }

  function getConfigMap_() {
    const CACHE_KEY = 'storeops:config';
    try {
      const raw = CacheService.getScriptCache().get(CACHE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sh = ss.getSheetByName(SHEETS.CONFIG);
      if (!sh) return {};
      const data = sh.getRange(3, 1, sh.getLastRow() - 2, 2).getValues();
      const map = {};
      data.forEach(r => { if (r[0]) map[String(r[0])] = r[1]; });
      try { CacheService.getScriptCache().put(CACHE_KEY, JSON.stringify(map), 300); } catch (e) {}
      return map;
    } catch (e) {
      return {};
    }
  }

  function configValue_(key, defaultValue) {
    const map = getConfigMap_();
    const val = map[key];
    return (val !== undefined && val !== '') ? val : defaultValue;
  }

  // ── Login ───────────────────────────────────────────────
  function login_(name, code) {
    const trimmedName = (name || '').toString().trim();
    if (!trimmedName) return { success: false, error: 'Name is required' };

    // Rate limit check
    const lockoutCheck = checkLockout_(trimmedName);
    if (lockoutCheck.lockedOut) {
      AuditLog.write({
        actorId: 'SYSTEM',
        action: 'login.fail',
        targetType: 'staff',
        targetId: trimmedName,
        details: 'rate_limited: ' + lockoutCheck.minutesRemaining + 'min'
      });
      return {
        success: false,
        error: 'Too many failed attempts. Try again in ' +
               lockoutCheck.minutesRemaining + ' minutes.'
      };
    }

    const staff = Staff.getByName(trimmedName);
    if (!staff) {
      recordFailure_(trimmedName);
      AuditLog.write({
        actorId: 'SYSTEM', action: 'login.fail',
        targetType: 'staff', targetId: trimmedName,
        details: 'unknown_name'
      });
      return { success: false, error: 'Invalid name or code' };
    }
    if (!staff.active) {
      AuditLog.write({
        actorId: 'SYSTEM', action: 'login.fail',
        targetType: 'staff', targetId: staff.staffId,
        details: 'inactive'
      });
      return { success: false, error: 'Account is inactive' };
    }

    if (!Staff.verifyLoginCode(staff.staffId, code)) {
      recordFailure_(trimmedName);
      AuditLog.write({
        actorId: 'SYSTEM', action: 'login.fail',
        targetType: 'staff', targetId: staff.staffId,
        details: 'wrong_code'
      });
      return { success: false, error: 'Invalid name or code' };
    }

    // Success
    clearFailures_(trimmedName);
    const sessionHours = Number(configValue_('session_hours', 24)) || 24;
    const token = Util.newToken();
    const session = {
      staffId: staff.staffId,
      name: staff.name,
      role: staff.role,
      companiesAuthorized: staff.companiesAuthorized,
      expiresAt: Date.now() + sessionHours * 3600 * 1000
    };
    props_().setProperty(SESSION_KEY_PREFIX + token, JSON.stringify(session));

    AuditLog.write({
      actorId: staff.staffId,
      action: 'login.success',
      targetType: 'staff',
      targetId: staff.staffId,
      details: 'session created'
    });

    return {
      success: true,
      token: token,
      staffId: staff.staffId,
      name: staff.name,
      role: staff.role,
      companiesAuthorized: staff.companiesAuthorized,
    };
  }

  function logout_(token) {
    if (!token) return { success: true };
    const session = peek_(token);
    props_().deleteProperty(SESSION_KEY_PREFIX + token);
    if (session) {
      AuditLog.write({
        actorId: session.staffId,
        action: 'login.logout',
        targetType: 'session',
        targetId: token.substring(0, 8) + '...',
        details: ''
      });
    }
    return { success: true };
  }

  // ── Session validation ──────────────────────────────────
  function peek_(token) {
    if (!token) return null;
    const raw = props_().getProperty(SESSION_KEY_PREFIX + token);
    if (!raw) return null;
    let session;
    try { session = JSON.parse(raw); } catch (e) { return null; }
    if (!session || !session.expiresAt) return null;
    if (Date.now() > session.expiresAt) {
      props_().deleteProperty(SESSION_KEY_PREFIX + token);
      return null;
    }
    return session;
  }

  /**
   * Validate token + extend session lifetime (rolling).
   * Throws Error('NOT_LOGGED_IN') if invalid — let it propagate to the
   * client so the UI redirects to login.
   */
  function validate_(token) {
    const session = peek_(token);
    if (!session) throw new Error('NOT_LOGGED_IN');

    // Rolling expiry, but skip the PropertiesService WRITE on most calls:
    // only extend when less than half the window remains. This removes a
    // per-RPC write (a real latency cost) while still keeping sessions alive.
    const sessionHours = Number(configValue_('session_hours', 24)) || 24;
    const fullMs = sessionHours * 3600 * 1000;
    if ((session.expiresAt - Date.now()) < fullMs / 2) {
      session.expiresAt = Date.now() + fullMs;
      props_().setProperty(SESSION_KEY_PREFIX + token, JSON.stringify(session));
    }

    return session;
  }

  /**
   * Assert session has one of the allowed roles. Throws on failure.
   */
  function require_(session, allowedRoles) {
    if (!session) throw new Error('NOT_LOGGED_IN');
    if (!Array.isArray(allowedRoles)) allowedRoles = [allowedRoles];
    if (allowedRoles.indexOf(session.role) === -1) {
      throw new Error('FORBIDDEN: requires ' + allowedRoles.join(' or ') +
                      ', got ' + session.role);
    }
  }

  // ── Rate limiting ───────────────────────────────────────
  function recordFailure_(nameKey) {
    const key = FAIL_KEY_PREFIX + nameKey.toLowerCase();
    const raw = props_().getProperty(key);
    let info = raw ? JSON.parse(raw) : { count: 0, firstFailAt: Date.now() };
    const lockoutMins = Number(configValue_('login_lockout_mins', 60)) || 60;
    if (Date.now() - info.firstFailAt > lockoutMins * 60 * 1000) {
      info = { count: 0, firstFailAt: Date.now() };
    }
    info.count++;
    info.lastFailAt = Date.now();
    props_().setProperty(key, JSON.stringify(info));
  }

  function clearFailures_(nameKey) {
    props_().deleteProperty(FAIL_KEY_PREFIX + nameKey.toLowerCase());
  }

  function checkLockout_(nameKey) {
    const key = FAIL_KEY_PREFIX + nameKey.toLowerCase();
    const raw = props_().getProperty(key);
    if (!raw) return { lockedOut: false };
    const info = JSON.parse(raw);
    const maxFails = Number(configValue_('login_max_fails', 5)) || 5;
    const lockoutMins = Number(configValue_('login_lockout_mins', 60)) || 60;
    if (info.count < maxFails) return { lockedOut: false };
    const elapsed = Date.now() - info.firstFailAt;
    const lockoutMs = lockoutMins * 60 * 1000;
    if (elapsed >= lockoutMs) {
      props_().deleteProperty(key);
      return { lockedOut: false };
    }
    return {
      lockedOut: true,
      minutesRemaining: Math.ceil((lockoutMs - elapsed) / 60000)
    };
  }

  return {
    login:    login_,
    logout:   logout_,
    peek:     peek_,
    validate: validate_,
    require:  require_,
  };
})();
