// ============================================================
//  notifier — the send path, and what it says when it fails
// ============================================================
//  dispatch_ uses muteHttpExceptions, so a rejected message returns
//  {sent:false} and nothing throws. Two silent failures ran for days as a
//  result. What makes them diagnosable is error_data.details — the only field
//  naming BOTH the count sent and the count the template expects — so it must
//  survive whole.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('notifier send path');

const CFG = {
  notifier_enabled: 'true',
  whatsapp_api_url: 'https://graph.facebook.com/v25.0/1/messages',
  whatsapp_api_token: 'TOKEN',
  whatsapp_target_number: '14165550100, 19055550101',
  whatsapp_template_lang: 'en',
  whatsapp_template_shift_close_cstore: 'shift_close_cstore',
};

let POSTED, RESPONSE;
function load(cfg) {
  POSTED = [];
  RESPONSE = { code: 200, body: '{}' };
  H.sheets({ config: Object.assign({}, CFG, cfg || {}) });
  return H.load(['Util.gs', 'Notifier.gs'], {
    UrlFetchApp: {
      fetch: (url, opt) => {
        POSTED.push({ url, method: (opt.method || 'get').toLowerCase(), headers: opt.headers || {},
                      payload: opt.payload ? JSON.parse(opt.payload) : null, muted: opt.muteHttpExceptions });
        return { getResponseCode: () => RESPONSE.code, getContentText: () => RESPONSE.body };
      },
    },
  }).Notifier;
}

const ELEVEN = ['a','b','c','d','e','f','g','h','i','j','k'];

t.section('The wire payload is what the template expects');
let N = load();
N.sendTemplate('shift_close_cstore', ELEVEN);
const body = POSTED[0].payload;
t.eq('template name', body.template.name, 'shift_close_cstore');
t.eq('language from config', body.template.language.code, 'en');
t.eq('one component', body.template.components.length, 1);
t.eq('of type body', body.template.components[0].type, 'body');
t.eq('carrying all eleven', body.template.components[0].parameters.length, 11);
t.eq('each a text param', body.template.components[0].parameters[0].type, 'text');
t.ok('no button component is invented', !body.template.components.some(c => c.type === 'button'));
t.eq('one POST per recipient', POSTED.length, 2);

t.section('Parameters are flattened so Meta accepts them');
N = load();
N.sendTemplate('x', ['line one\nline two', '  wide   gaps  ', '*bold*', '']);
const ps = POSTED[0].payload.template.components[0].parameters.map(p => p.text);
t.ok('newlines collapsed', ps[0].indexOf('\n') === -1);
t.ok('no run of four spaces', !/ {4}/.test(ps[1]));
t.ok('markdown stripped', ps[2].indexOf('*') === -1);
t.eq('an empty param becomes a dash, never empty', ps[3], '—');

t.section('A rejected send never throws, and reports the reason');
N = load();
RESPONSE = { code: 400, body: JSON.stringify({ error: {
  message: '(#132000) Number of parameters does not match the expected number of params',
  code: 132000, type: 'OAuthException',
  error_data: { messaging_product: 'whatsapp',
    details: 'body: number of localizable_params (11) does not match the expected number of params (13)' },
}}) };
let r;
t.ok('does not throw', (() => { try { r = N.sendTemplate('shift_close_cstore', ELEVEN); return true; }
                                catch (e) { return false; } })());
t.eq('and reports not sent', r.sent, false);
const detail = r.results[0].detail;
t.eq('with the http code', r.results[0].reason, 'http_400');
t.ok('the error code survives', /#132000/.test(detail));
t.ok('the count we SENT survives', /\(11\)/.test(detail));
t.ok('the count the template EXPECTS survives', /\(13\)/.test(detail));
t.ok('the sentence is whole, not cut mid-word', !/\bnu$/.test(detail));

t.section('Other Meta shapes degrade sensibly');
N = load();
RESPONSE = { code: 401, body: JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }) };
t.ok('message-only errors still report', /Invalid OAuth/.test(N.sendTemplate('x', ['a']).results[0].detail));
RESPONSE = { code: 404, body: JSON.stringify({ error: {
  message: '(#132001) Template name does not exist',
  error_data: { details: 'template name (shift_close_cstore) does not exist in en' } } }) };
t.ok('template-not-found surfaces its detail', /does not exist in en/.test(N.sendTemplate('x', ['a']).results[0].detail));
RESPONSE = { code: 502, body: '<html>502 Bad Gateway</html>' };
t.ok('a non-JSON body falls back to raw', /502 Bad Gateway/.test(N.sendTemplate('x', ['a']).results[0].detail));
RESPONSE = { code: 500, body: '' };
t.ok('an empty body does not throw', N.sendTemplate('x', ['a']).sent === false);

t.section('The detail is bounded, so a toast stays usable');
N = load();
RESPONSE = { code: 400, body: JSON.stringify({ error: { message: 'x'.repeat(900) } }) };
t.ok('capped', N.sendTemplate('x', ['a']).results[0].detail.length <= 400);
RESPONSE = { code: 400, body: 'y'.repeat(900) };
t.ok('raw fallback capped too', N.sendTemplate('x', ['a']).results[0].detail.length <= 400);

t.section('Guards before any request is made');
N = load({ notifier_enabled: 'false' });
t.eq('disabled sends nothing', N.sendTemplate('x', ['a']).reason, 'disabled');
t.eq('and posts nothing', POSTED.length, 0);
N = load({ whatsapp_api_token: '' });
t.eq('no token is not_configured', N.sendTemplate('x', ['a']).reason, 'not_configured');
N = load({ whatsapp_target_number: '' });
t.eq('no recipients is not_configured', N.sendTemplate('x', ['a']).reason, 'not_configured');
N = load();
t.eq('no template name is refused', N.sendTemplate('', ['a']).reason, 'no_template');

t.section('sendOp picks the template named in config');
N = load();
N.sendOp('shift_close_cstore', ELEVEN, 'plain text');
t.eq('resolved from whatsapp_template_<opKey>', POSTED[0].payload.template.name, 'shift_close_cstore');
N = load();
N.sendOp('shift_close_nosuch', ELEVEN, 'plain text');
t.ok('an unset key falls back to plain text, not a template',
     POSTED.length === 0 || POSTED[0].payload.type !== 'template');

// ── Diagnose: what's wrong, without sending anything ────────
// "WhatsApp isn't working" had no first step: a send that fails says why only
// to whoever was looking at the toast, a disabled switch says nothing at all,
// and an expired token is only discovered by a message not arriving. diagnose
// checks each piece in order and asks Meta about the token and the number —
// a read, never a message.
const check = (d, name) => (d.checks || []).find(c => c.name === name) || {};

t.section('Diagnose: a healthy setup asks Meta, sends nothing');
N = load({ whatsapp_template_shift_open: 'shift_open' });
RESPONSE = { code: 200, body: JSON.stringify({ verified_name: 'Fictional Mart', display_phone_number: '+1 416-555-0199', quality_rating: 'GREEN' }) };
let D = N.diagnose();
t.eq('one request', POSTED.length, 1);
t.eq('a GET, not a send', POSTED[0] && POSTED[0].method, 'get');
t.ok('to the phone number, not /messages', POSTED[0] && /\/1\?fields=/.test(POSTED[0].url));
t.ok('with the token as a bearer header', POSTED[0] && /^Bearer TOKEN$/.test(POSTED[0].headers.Authorization || ''));
t.eq('all good', D.ok, true);
t.ok('names the WhatsApp number it would send from', /Fictional Mart/.test(check(D, 'meta').detail || ''));
t.ok('counts the recipients', /2/.test(check(D, 'recipients').detail || ''));
t.ok('the token never appears in the report', JSON.stringify(D).indexOf('TOKEN') === -1);

t.section('Diagnose: an expired token is named, in Meta\'s words');
N = load();
RESPONSE = { code: 401, body: JSON.stringify({ error: { message: 'Error validating access token: Session has expired on Sunday, 19-Oct-26.', code: 190 } }) };
D = N.diagnose();
t.eq('not ok', D.ok, false);
t.eq('the Meta check fails', check(D, 'meta').ok, false);
t.ok('with Meta\'s own sentence', /Session has expired/.test(check(D, 'meta').detail || ''));
t.ok('and what to do about it', /token/i.test(check(D, 'meta').fix || ''));

t.section('Diagnose: a switched-off notifier is the first thing reported');
N = load({ notifier_enabled: 'false' });
D = N.diagnose();
t.eq('not ok', D.ok, false);
t.eq('the switch is flagged', check(D, 'enabled').ok, false);
t.ok('naming the config key to change', /notifier_enabled/.test(check(D, 'enabled').fix || ''));

t.section('Diagnose: missing settings are named, and Meta is not asked');
N = load({ whatsapp_api_token: '', whatsapp_target_number: '' });
D = N.diagnose();
t.eq('no request made without a token', POSTED.length, 0);
t.eq('token flagged', check(D, 'token').ok, false);
t.eq('recipients flagged', check(D, 'recipients').ok, false);
t.ok('the URL itself is fine', check(D, 'url').ok === true);

t.section('Diagnose: a URL that isn\'t a /messages endpoint is caught');
N = load({ whatsapp_api_url: 'https://graph.facebook.com/v21.0/' });
D = N.diagnose();
t.eq('url flagged', check(D, 'url').ok, false);

t.section('Diagnose: lists which templates are set');
N = load({ whatsapp_template_shift_open: '' });
RESPONSE = { code: 200, body: '{}' };
D = N.diagnose();
t.ok('a configured close template is listed', /shift_close_cstore/.test(check(D, 'templates').detail || ''));
t.ok('an unset one is called out', /shift_open/.test(check(D, 'templates').detail || ''));

t.done();
