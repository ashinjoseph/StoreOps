// ============================================================
//  Notifier.gs — event broadcast hook
// ============================================================
//  Centralized event dispatcher. Currently a no-op that just logs to
//  AuditLog. Future: wire to WhatsApp Cloud API, email, etc.
//
//  Call from anywhere:
//    Notifier.notify('shift.opened', { staffId, sessionId, openingFloat });
//    Notifier.notify('shift.closed', { staffId, sessionId, variance });
//    Notifier.notify('payment.recorded', { staffId, amount });
//
//  Event payloads should be small (a few fields). Don't include sensitive
//  data like full payment items.
// ============================================================

const Notifier = (() => {

  function configValue_(key, defaultValue) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sh = ss.getSheetByName(SHEETS.CONFIG);
      if (!sh) return defaultValue;
      const data = sh.getRange(3, 1, sh.getLastRow() - 2, 2).getValues();
      const row = data.find(r => r[0] === key);
      return row && row[1] !== '' ? row[1] : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  }

  function isEnabled_() {
    const raw = configValue_('notifier_enabled', 'false');
    return raw === true || String(raw).toLowerCase() === 'true';
  }

  /**
   * Format a short human-readable summary for each event type.
   * Keep it under 200 chars so it fits in any messaging medium.
   */
  function summarize_(event, payload) {
    payload = payload || {};
    switch (event) {
      case 'shift.opened':
        return `🟢 ${payload.staffName || payload.staffId} opened ${payload.company} shift` +
               (payload.openingFloat != null ? ` (float $${payload.openingFloat})` : '');
      case 'shift.closed':
        const v = Number(payload.variance) || 0;
        const vstr = v === 0 ? '$0 variance' :
                     v > 0 ? `+$${v.toFixed(2)} over` :
                     `-$${Math.abs(v).toFixed(2)} short`;
        return `🔴 ${payload.staffName || payload.staffId} closed ${payload.company} shift, ${vstr}`;
      case 'payment.recorded':
        return `💰 Paid $${(payload.amount || 0).toFixed(2)} to ${payload.staffName || payload.staffId}`;
      case 'commission.computed':
        return `🎯 Commission run: ${payload.bonusesCreated || 0} bonus(es), ` +
               `$${(payload.totalAmount || 0).toFixed(2)} total`;
      default:
        return `Event: ${event}`;
    }
  }

  /**
   * Dispatch an event. Always logs to audit_log; sends to external
   * channels only if notifier_enabled=true.
   */
  function notify_(event, payload) {
    payload = payload || {};

    // Always log to audit
    AuditLog.write({
      actorId: payload.actorId || 'SYSTEM',
      action: 'notify.' + event,
      targetType: payload.targetType || 'notification',
      targetId: payload.targetId || '',
      details: summarize_(event, payload),
    });

    if (!isEnabled_()) return { dispatched: false, reason: 'disabled' };

    // Future: route to WhatsApp Cloud API
    // const url = configValue_('whatsapp_api_url', '');
    // const token = configValue_('whatsapp_api_token', '');
    // const target = configValue_('whatsapp_target_number', '');
    // if (url && token && target) {
    //   try {
    //     UrlFetchApp.fetch(url, {
    //       method: 'post',
    //       headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    //       payload: JSON.stringify({
    //         messaging_product: 'whatsapp',
    //         to: target,
    //         type: 'text',
    //         text: { body: summarize_(event, payload) }
    //       }),
    //       muteHttpExceptions: true,
    //     });
    //     return { dispatched: true, channel: 'whatsapp' };
    //   } catch (e) {
    //     console.log('Notifier WhatsApp failed: ' + e.message);
    //     return { dispatched: false, error: e.message };
    //   }
    // }

    return { dispatched: false, reason: 'no_channel_configured' };
  }

  return {
    notify: notify_,
  };
})();
