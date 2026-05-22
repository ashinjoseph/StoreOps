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

  /**
   * Collapse a multi-line message into a single line for a WhatsApp
   * template body parameter ({{1}} can't contain newlines, tabs, or
   * 4+ consecutive spaces — Meta rejects those at send time).
   */
  // Meta rejects literal newlines / tabs / 4+ spaces inside a template
  // PARAMETER, but accepts other Unicode whitespace. So we keep the layout
  // using U+2028 (line separator → renders as a line break) and U+00A0
  // (non-breaking space → keeps indentation without a run of plain spaces).
  function flattenForTemplate_(text) {
    const LS = '\u2028';    // U+2028 line separator → WhatsApp renders a line break
    const NBSP = '\u00A0';  // U+00A0 non-breaking space → spacing without a 4+ space run
    return String(text || '')
      .replace(/[*_]/g, '')                  // strip *bold*/_italic_ (shows literally in a param)
      .replace(/\r/g, '')
      .replace(/\t/g, ' ')
      .replace(/\n/g, LS)                    // line breaks survive validation as U+2028
      .replace(/ {2,}/g, m => NBSP.repeat(m.length))  // 2+ spaces → NBSP (avoids the 4-space rule)
      .trim();
  }

  // whatsapp_target_number may hold several numbers (comma / semicolon /
  // space separated). The Cloud API sends to one recipient per request.
  function recipients_() {
    const raw = configValue_('whatsapp_target_number', '');
    return String(raw || '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }

  // Shared send loop. buildPayload(to) returns the Cloud API JSON body for
  // one recipient; we POST to each. Never throws — returns
  // { sent, sentCount, total, results } (or a { sent:false, reason } guard).
  function dispatch_(buildPayload) {
    if (!isEnabled_()) return { sent: false, reason: 'disabled' };
    const url = configValue_('whatsapp_api_url', '');
    const token = configValue_('whatsapp_api_token', '');
    if (!url || !token) return { sent: false, reason: 'not_configured' };
    const recipients = recipients_();
    if (recipients.length === 0) return { sent: false, reason: 'not_configured' };

    let sentCount = 0;
    const results = [];
    recipients.forEach(to => {
      try {
        const resp = UrlFetchApp.fetch(url, {
          method: 'post',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          payload: JSON.stringify(buildPayload(to)),
          muteHttpExceptions: true,
        });
        const code = resp.getResponseCode();
        if (code >= 200 && code < 300) { sentCount++; results.push({ to: to, sent: true }); }
        else results.push({ to: to, sent: false, reason: 'http_' + code, detail: resp.getContentText().slice(0, 200) });
      } catch (e) {
        results.push({ to: to, sent: false, reason: 'exception', detail: e.message });
      }
    });

    return { sent: sentCount > 0, sentCount: sentCount, total: recipients.length, results: results };
  }

  /**
   * Send a free-form message. If whatsapp_template_name (generic) is set,
   * wraps the whole body into {{1}} of that template (flattened so it
   * survives Meta's param validation); otherwise sends plain text (works
   * inside the 24h customer-service window). Best-effort, never throws.
   */
  function sendWhatsApp_(body) {
    const templateName = configValue_('whatsapp_template_name', '');
    const lang = configValue_('whatsapp_template_lang', 'en') || 'en';
    return dispatch_(to => {
      if (templateName) {
        return {
          messaging_product: 'whatsapp', to: to, type: 'template',
          template: {
            name: templateName, language: { code: lang },
            components: [{ type: 'body', parameters: [{ type: 'text', text: flattenForTemplate_(body) }] }],
          },
        };
      }
      return { messaging_product: 'whatsapp', to: to, type: 'text', text: { body: String(body || '') } };
    });
  }

  /**
   * Send an approved template with an ordered list of body parameters. The
   * template's STATIC text holds the layout / line breaks; each param is a
   * single value. Params are sanitized (markdown stripped, line breaks →
   * U+2028, runs of spaces → U+00A0) so Meta accepts them; an empty param
   * becomes '—' so the API never rejects the message. Best-effort.
   */
  function sendTemplate_(templateName, params) {
    if (!templateName) return { sent: false, reason: 'no_template' };
    const lang = configValue_('whatsapp_template_lang', 'en') || 'en';
    const parameters = (params || []).map(p => {
      const t = flattenForTemplate_(p);
      return { type: 'text', text: t === '' ? '—' : t };
    });
    return dispatch_(to => ({
      messaging_product: 'whatsapp', to: to, type: 'template',
      template: {
        name: templateName, language: { code: lang },
        components: parameters.length ? [{ type: 'body', parameters: parameters }] : [],
      },
    }));
  }

  /**
   * Operation-aware send. Looks up whatsapp_template_<opKey>; if that's set,
   * sends the per-operation template with `params`. Otherwise falls back to
   * sendWhatsApp_(plain) — which uses the generic template if configured,
   * else plain text. Lets each event have its own well-formatted template
   * while degrading gracefully when templates aren't configured.
   */
  function sendOp_(opKey, params, plain) {
    const name = configValue_('whatsapp_template_' + opKey, '');
    if (name) return sendTemplate_(name, params);
    return sendWhatsApp_(plain);
  }

  return {
    notify: notify_,
    sendWhatsApp: sendWhatsApp_,
    sendTemplate: sendTemplate_,
    sendOp: sendOp_,
  };
})();
