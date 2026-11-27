// ============================================================
//  ui-backups — the nightly copy's line and "Make a copy now" on the
//  Settings screen (Operations app only; admin only)
// ============================================================
//  Card P4-06a; ADR-0023, ADR-0028. These assertions run the page's own
//  functions, lifted from both copies of the page (src/Index.html and the
//  Worker's built ops/public/index.html):
//   - the line is the server's sentence, at the top of the screen, above
//     the first group; each state of `lastBackup` (never, ok, stale,
//     failed) renders its words; a warning is visibly a warning (amber,
//     role alert, a marker attribute) and a good copy is not;
//   - the control is there for an admin and only when the server sent the
//     line (a manager, or no `lastBackup`, gets neither);
//   - pressing it calls rpcRunBackupNow with the session token only, shows
//     the result in words (a toast and a line under the control), then
//     reloads the screen; a refusal is shown as written; a lost session
//     goes to the sign-in handling;
//   - everything the server sent is escaped; no var, no storage, no
//     template tag; the built page carries it.
// ============================================================
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const t = H.suite('Nightly copy — the line and the button on Settings, Operations app');

const GOOD = { state: 'ok', warn: false, message: 'Last copy: 2026-11-27 03:00:12, 24 tables, 2268 rows', lastGood: { at: '2026-11-27T08:00:12.000Z', folder: 'nightly/2026-11-27', tables: 24, rows: 2268 }, lastFailure: null };
const NEVER = { state: 'never', warn: true, message: 'Last copy: no copy yet. The first one is made at 3 in the morning, or press "Make a copy now".', lastGood: null, lastFailure: null };
const STALE = { state: 'stale', warn: true, message: 'The newest good copy is more than 36 hours old (2026-11-25 03:00:12, 24 tables, 2268 rows). A night was missed: press "Make a copy now".', lastGood: GOOD.lastGood, lastFailure: null };
const FAILED = { state: 'failed', warn: true, message: 'The last copy failed on 2026-11-27 03:00:05: the bucket refused nightly/2026-11-27/sales.0001.ndjson: Error (10001). The newest good copy is from 2026-11-26 03:00:12 (24 tables, 2250 rows). Press "Make a copy now" to try again.', lastGood: GOOD.lastGood, lastFailure: { at: '2026-11-27T08:00:05.000Z', reason: 'x' } };
const SETTINGS = [
  { key: 'cash_manager_staff_id', value: null, default: '', blankReads: '', read: 'text', description: 'Cash manager', isDefault: true, group: 'Tills and cash' },
  { key: 'till_enabled', value: 'true', default: 'false', blankReads: 'false', read: 'boolean', description: 'Switch for the link to the till', isDefault: false, group: 'Till' },
];

const tick = () => new Promise(r => setImmediate(r)).then(() => new Promise(r => setImmediate(r)));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const unescapeHtml = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

(async () => {
  for (const [label, js] of H.uiScripts()) {
    t.section('Against ' + label);

    const own = ['backupLineHTML_', 'runBackupNow_'].map(n => H.fnSource(js, n)).join('\n');
    const noteDecl = /^  let backupNote_ = null;$/m.exec(js);
    t.ok(label + ': the note variable is declared with let', !!noteDecl);
    const count = (s, n) => s.split(n).length - 1;
    t.eq(label + ': rpcRunBackupNow is named only inside the button\'s own function', [count(js, 'rpcRunBackupNow') > 0, count(js, 'rpcRunBackupNow') === count(own, 'rpcRunBackupNow')], [true, true]);
    t.ok(label + ': no var, no storage and no template tag in the section', !/\bvar\b/.test(own) && !/localStorage|sessionStorage/.test(own) && own.indexOf('<?') === -1);
    t.ok(label + ': the line is drawn above the groups, from the server\'s sentence', /html \+= backupLineHTML_\(data && data\.lastBackup, !!\(state\.me && state\.me\.role === 'admin'\)\);/.test(H.fnSource(js, 'renderSettingsTab')));

    const lifted = [noteDecl[0], ...['esc', 'settingShown_', 'tillWarnHTML_', 'backupLineHTML_', 'runBackupNow_', 'renderSettingsTab'].map(n => (n === 'runBackupNow_' ? 'async ' : '') + H.fnSource(js, n))].join('\n');

    const world = role => {
      const w = { sent: [], toasts: [], reloads: [], rpcErrors: [], reply: { message: 'Copy made: 24 tables, 2268 rows, in the folder nightly/2026-11-27.' }, fail: null, html: '', btn: null, nextData: null };
      w.moreBack = () => '';
      w.haptic = () => {};
      w.state = { token: 'tok', me: role ? { role } : null };
      w.call = async (method, ...args) => { w.sent.push([method, args]); if (w.fail) throw new Error(w.fail); return w.reply; };
      w.toast = (m, k) => w.toasts.push([m, k]);
      w.handleRpcError = e => w.rpcErrors.push(e.message);
      w.loadSettingsTab = async force => { w.reloads.push(force); w.run('renderSettingsTab')(w.nextData); };
      w.$ = () => ({
        get innerHTML() { return w.html; },
        set innerHTML(h) { w.html = h; w.btn = h.indexOf('data-backup-now') !== -1 ? { textContent: 'Make a copy now', disabled: false, onclick: null } : null; },
        querySelectorAll: sel => (sel === '[data-backup-now]' && w.btn ? [w.btn] : []),
      });
      Object.assign(w, { document: {}, Date, Math, Number, String, JSON, console, Promise, Error });
      vm.createContext(w);
      vm.runInContext(lifted, w);
      w.run = name => vm.runInContext(name, w);
      w.render = data => { w.nextData = data; w.run('renderSettingsTab')(data); return w.html; };
      return w;
    };
    const data = lastBackup => ({ settings: SETTINGS, other: [], secrets: [], lastBackup });

    // ── each state renders its words, and a warning looks like one ──
    for (const [name, d] of [['never run', NEVER], ['a good copy', GOOD], ['stale', STALE], ['failed', FAILED]]) {
      const html = world('admin').render(data(d));
      const line = new RegExp('<div data-backup-line="' + d.state + '"([^>]*)>([^<]*)</div>').exec(html);
      t.ok(label + ': ' + name + ': the line is there with its state', !!line);
      const text = unescapeHtml(line ? line[2] : '');
      t.ok(label + ': ' + name + ': it says the server\'s words', text.replace(/^⚠️ /, '') === d.message);
      const attrs = line ? line[1] : '';
      if (d.warn) {
        t.ok(label + ': ' + name + ': it is visibly a warning (amber, an alert, marked, with the sign)', /data-backup-warning="1"/.test(attrs) && /role="alert"/.test(attrs) && /#fef3c7/.test(attrs) && /#92400e/.test(attrs) && /^⚠️ /.test(line[2]));
      } else {
        t.ok(label + ': ' + name + ': it is not a warning (green, no alert, no marker)', !/data-backup-warning/.test(attrs) && !/role="alert"/.test(attrs) && /#166534/.test(attrs) && !/⚠️/.test(line[2]));
      }
      const at = html.indexOf('data-backup-line');
      t.ok(label + ': ' + name + ': it is at the top: after the Settings heading, above every group and every setting', at > html.indexOf('>Settings</div>') && at < html.indexOf('>Tills and cash</div>') && at < html.indexOf('data-setting-key='));
    }
    t.ok(label + ': the good copy says its tables and rows', world('admin').render(data(GOOD)).indexOf('Last copy: 2026-11-27 03:00:12, 24 tables, 2268 rows') !== -1);

    // ── who gets the control ──
    const adminHtml = world('admin').render(data(GOOD));
    t.eq(label + ': an admin gets one "Make a copy now" control', [count(adminHtml, 'data-backup-now'), adminHtml.indexOf('>Make a copy now</button>') !== -1], [1, true]);
    const managerHtml = world('manager').render(data(GOOD));
    t.ok(label + ': a manager gets no control', managerHtml.indexOf('data-backup-now') === -1 && managerHtml.indexOf('Make a copy now') === -1);
    t.ok(label + ': nobody signed in gets no control', world(null).render(data(GOOD)).indexOf('data-backup-now') === -1);
    for (const none of [undefined, null, {}, { message: '' }]) {
      const h = world('admin').render(data(none));
      t.ok(label + ': with no usable lastBackup there is no line and no control (' + JSON.stringify(none) + ')', h.indexOf('data-backup-line') === -1 && h.indexOf('data-backup-now') === -1);
    }
    t.ok(label + ': the settings are still listed', adminHtml.indexOf('data-setting-key="till_enabled"') !== -1);

    // ── everything the server sent is escaped ──
    const nasty = world('admin').render(data({ state: 'fa"il<b>', warn: true, message: '<script>alert(1)</script> & "quotes"' }));
    t.ok(label + ': the message and the state are escaped', nasty.indexOf('<script>alert(1)') === -1 && nasty.indexOf('&lt;script&gt;') !== -1 && nasty.indexOf('data-backup-line="fa"il') === -1);

    // ── pressing the control ──
    {
      const w = world('admin');
      w.render(data(GOOD));
      t.ok(label + ': the button has a click handler', typeof w.btn.onclick === 'function');
      const pressed = w.btn.onclick();
      t.eq(label + ': while it runs the button says so and is off', [w.btn.textContent, w.btn.disabled], ['Making a copy…', true]);
      await pressed; await settle();
      t.eq(label + ': it called rpcRunBackupNow with the session token and nothing else', w.sent, [['rpcRunBackupNow', ['tok']]]);
      t.eq(label + ': the result is a toast in words', w.toasts, [['✓ Copy made: 24 tables, 2268 rows, in the folder nightly/2026-11-27.', 'success']]);
      t.eq(label + ': the screen was reloaded, forced', w.reloads, [true]);
      t.ok(label + ': the result is shown in words under the control, once', /<div data-backup-result="ok"[^>]*>Copy made: 24 tables, 2268 rows, in the folder nightly\/2026-11-27\.<\/div>/.test(w.html));
      w.render(data(GOOD));
      t.ok(label + ': and gone the next time', w.html.indexOf('data-backup-result') === -1);
    }
    {
      const w = world('admin');
      w.render(data(GOOD));
      w.fail = 'A copy is already being made. Wait a few minutes, then look at the line at the top of this screen.';
      await w.btn.onclick(); await settle();
      t.eq(label + ': a refusal is shown as written, as an error', w.toasts, [[w.fail, 'error']]);
      t.ok(label + ': and under the control, as a failure', w.html.indexOf('data-backup-result="failed"') !== -1 && w.html.indexOf('A copy is already being made.') !== -1);
      t.eq(label + ': the screen is reloaded to show the line as the server now says it', w.reloads, [true]);
    }
    {
      const w = world('admin');
      w.render(data(GOOD));
      w.fail = 'NOT_LOGGED_IN';
      await w.btn.onclick(); await settle();
      t.ok(label + ': a lost session goes to the sign-in handling, with no toast and no reload', w.rpcErrors.length === 1 && w.toasts.length === 0 && w.reloads.length === 0);
    }
  }

  // ── The built Operations page carries it ──
  t.section('The two apps');
  const built = require('child_process').execFileSync(process.execPath, [path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs'), '--stdout'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  t.ok('the built page has the line and the button', ['function backupLineHTML_(', 'async function runBackupNow_(', 'rpcRunBackupNow'].every(s => built.indexOf(s) !== -1));
  const src = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
  t.ok('Apps Script never loads the transport, so the button is never reachable there', src.indexOf('/transport.js') === -1);
  t.ok('no template tag in the page', src.indexOf('<?') === -1 && built.indexOf('<?') === -1);
  t.done();
})().catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
