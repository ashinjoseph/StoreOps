#!/usr/bin/env node
// ============================================================
//  screenshots.js — regenerate every image in docs/images
// ============================================================
//  Usage:   node scripts/docs/screenshots.js            (all shots)
//           node scripts/docs/screenshots.js sales      (names containing "sales")
//
//  Boots the real server (runtime.js) over fictional data (fixtures.js),
//  serves the real src/*.html on a local origin, and answers every
//  google.script.run call by invoking the real rpc* function in Node. What
//  you see in the images is what the code renders — not a mock-up.
//
//  Needs Playwright with Chromium. Resolved from a local install, then the
//  global one, so it works in a dev container without adding a dependency.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  const globalRoot = execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'docs', 'images');
const ORIGIN = 'https://storeops.local';

const R = require('./runtime');
const F = require('./fixtures');

// ── Backend ──────────────────────────────────────────────────
const { api, ss } = R.boot();
F.seed(api, ss);

// Sessions by token. The real Auth issues and validates these against
// PropertiesService; the screenshots only need to say who is looking.
const SESSIONS = {};
F.STAFF.forEach(s => {
  SESSIONS['tok-' + s.id] = { staffId: s.id, name: s.name, role: s.role,
                              companiesAuthorized: ['cstore', 'vape'] };
});
api.Auth.validate = token => {
  const s = SESSIONS[token];
  if (!s) throw new Error('NOT_LOGGED_IN');
  return s;
};

// google.script.run cannot carry a Date or a function across the wire; a
// JSON round trip is the closest honest stand-in.
function rpc(method, args) {
  const fn = api[method];
  if (typeof fn !== 'function') throw new Error('No such RPC: ' + method);
  const out = fn.apply(null, args || []);
  return out === undefined ? null : JSON.parse(JSON.stringify(out));
}

// The shim the page sees as google.script.run.
const SHIM = `
  (function () {
    function runner(ok, fail) {
      return new Proxy({}, {
        get(_, prop) {
          if (prop === 'withSuccessHandler') return fn => runner(fn, fail);
          if (prop === 'withFailureHandler') return fn => runner(ok, fn);
          if (prop === 'withUserObject') return () => runner(ok, fail);
          return (...args) => {
            window.__rpc(prop, JSON.stringify(args)).then(res => {
              const r = JSON.parse(res);
              if (r.error) { if (fail) fail(new Error(r.error)); }
              else if (ok) ok(r.value);
            });
          };
        },
      });
    }
    window.google = { script: { run: runner(null, null),
                                host: { close() {}, setHeight() {} } } };
  })();`;

// ── Pages ────────────────────────────────────────────────────
// The public pages are templates: Apps Script substitutes the payload into
// the scriptlet before serving. Do the same here.
function publicPage(file, payload) {
  return fs.readFileSync(path.join(SRC, file), 'utf8')
    .replace(/<\?!=\s*payload\s*\?>/, () => api.inlineJson_(payload));
}

async function main() {
  const filter = process.argv[2] || '';
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const shots = [];

  async function newPage(opts) {
    const ctx = await browser.newContext({
      viewport: opts.viewport || { width: 390, height: 844 },
      deviceScaleFactor: 2, isMobile: !opts.desktop, hasTouch: !opts.desktop,
    });
    await ctx.route(ORIGIN + '/**', route => {
      const u = new URL(route.request().url());
      const name = u.pathname.replace(/^\//, '') || 'Index.html';
      let body;
      if (name === 'PublicSales.html') body = publicPage('PublicSales.html', api.PublicReport.buildSales(60));
      else if (name === 'Public.html') body = publicPage('Public.html', api.PublicReport.build(7));
      else body = fs.readFileSync(path.join(SRC, name), 'utf8');
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
    });
    // Fonts and anything else off-origin are not part of the app.
    await ctx.route(url => !url.toString().startsWith(ORIGIN), r => r.abort());
    const page = await ctx.newPage();
    await page.exposeFunction('__rpc', (method, argsJson) => {
      try { return JSON.stringify({ value: rpc(method, JSON.parse(argsJson)) }); }
      catch (e) { return JSON.stringify({ error: e.message }); }
    });
    await page.addInitScript(SHIM);
    if (opts.token) {
      const s = SESSIONS[opts.token];
      await page.addInitScript(([t, me]) => {
        localStorage.setItem('storeops_token', t);
        localStorage.setItem('storeops_me', me);
      }, [opts.token, JSON.stringify(Object.assign({ staffId: s.staffId }, s))]);
    }
    page.on('pageerror', e => console.warn('  page error: ' + e.message));
    return page;
  }

  // Wait until no spinner is visible and the page has had a moment to paint
  // anything a resolved RPC triggered.
  async function settle(page) {
    await page.waitForTimeout(250);
    await page.waitForFunction(() =>
      !Array.from(document.querySelectorAll('.spinner')).some(el => el.offsetParent !== null),
      null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(350);
  }

  async function shot(name, page, opts) {
    if (filter && name.indexOf(filter) === -1) return;
    const file = path.join(OUT, name + '.png');
    await page.screenshot(Object.assign({ path: file }, opts || {}));
    shots.push(name);
    console.log('  ✓ ' + name + '.png');
  }

  const SCREENS = require('./screens');
  for (const screen of SCREENS) {
    if (filter && screen.name.indexOf(filter) === -1 && !(screen.also || []).some(n => n.indexOf(filter) !== -1)) continue;
    const page = await newPage(screen);
    await page.goto(ORIGIN + '/' + (screen.file || 'Index.html'));
    await settle(page);
    try {
      await screen.run({ page, settle, shot: (n, o) => shot(n, page, o) });
    } catch (e) {
      console.warn('  ✗ ' + screen.name + ': ' + e.message);
    }
    await page.context().close();
  }

  await browser.close();
  console.log('\n' + shots.length + ' screenshots written to docs/images/');
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
module.exports = { rpc, api, SESSIONS };
