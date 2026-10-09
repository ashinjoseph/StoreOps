// ============================================================
//  screens.js — what screenshots.js captures, and how to get there
// ============================================================
//  One entry per screen: who is signed in (token), which page, and the
//  steps to reach the state worth showing. Add an entry when a phase ships
//  a new screen; the docs guard test fails if a doc references an image
//  this list no longer produces.
//
//  Tokens map to the fictional staff in fixtures.js:
//    tok-S_001 Priya Nair (admin) · tok-S_002 Daniel Okafor (manager)
//    tok-S_003 Maya Chen (cashier, has the cstore till open today)
// ============================================================
'use strict';

const tab = async (page, settle, name) => {
  await page.evaluate(t => switchTab(t), name);
  await settle(page);
};
const scrollTop = page => page.evaluate(() => window.scrollTo(0, 0));

module.exports = [
  // ── Signing in ────────────────────────────────────────────
  { name: 'login', run: async ({ page, settle, shot }) => {
      await settle(page);
      await shot('login');
  } },

  // ── A cashier's day ───────────────────────────────────────
  { name: 'shift', token: 'tok-S_003', also: ['close-sheet'],
    run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'shift');
      await shot('shift');
      await page.click('[data-action="close"]');
      await settle(page);
      // A night with a payout: takings net below zero, the reserve feeds the
      // drawer, and the summary says so instead of reporting a surplus.
      await page.fill('#closeCash', '-180');
      await page.dispatchEvent('#closeCash', 'input');
      await page.fill('#closeCard', '1240.55');
      await page.fill('#closeLotto', '300');
      await page.dispatchEvent('#closeLotto', 'input');
      // Float $250, takings -$180 after the payout, $200 fed in from the pot:
      // $270 expected, and a careful cashier counts exactly that.
      await page.fill('#closeCount', '270');
      await page.dispatchEvent('#closeCount', 'input');
      // The reason row only appears once a count exists — asking earlier
      // would be answering the previous cashier's question.
      await page.fill('#closeLottoNote', 'Paid $900 winning ticket from the reserve');
      await settle(page);
      await shot('close-sheet');
  } },

  // ── Management views ──────────────────────────────────────
  { name: 'sales', token: 'tok-S_001', also: ['sales-insights'],
    run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'sales');
      await shot('sales');
      await shot('sales-insights', { fullPage: true });
  } },
  { name: 'recon', token: 'tok-S_001', run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'recon');
      // Open the history so the per-shift rows are on screen.
      await page.click('#reconHistToggle');
      await settle(page);
      await shot('recon');
  } },
  { name: 'cash', token: 'tok-S_002', run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'cash');
      await shot('cash');
  } },
  { name: 'payroll', token: 'tok-S_001', run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'payroll');
      await shot('payroll');
  } },
  { name: 'commissions', token: 'tok-S_001', run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'commissions');
      await shot('commissions');
  } },
  { name: 'rules', token: 'tok-S_001', also: ['rule-form-fixed'],
    run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'rules');
      await shot('rules');
      await page.click('#newRuleBtn');
      await settle(page);
      await page.selectOption('#ruleType', 'fixed');
      await page.dispatchEvent('#ruleType', 'change');
      await page.selectOption('#ruleAppliesTo', 'specific_staff');
      await page.dispatchEvent('#ruleAppliesTo', 'change');
      await page.fill('#ruleName', 'Management fee');
      await page.fill('#ruleFixedAmount', '120');
      await settle(page);
      await shot('rule-form-fixed');
  } },

  // ── Ordering ──────────────────────────────────────────────
  { name: 'shopping', token: 'tok-S_003', also: ['picker'],
    run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'shopping');
      await shot('shopping');
      await page.click('#addItemBtn');
      await settle(page);
      await page.click('.si-chip[data-cat="vape"]');
      await settle(page);
      // Bring an incomplete row fully into view: listed, badged, and offering
      // Fix where the + would be.
      await page.evaluate(() => {
        const box = document.getElementById('siResults');
        const row = box && box.querySelector('.si-row-fix');
        if (box && row) box.scrollTop = row.offsetTop - box.offsetTop - 140;
      });
      await settle(page);
      await shot('picker');
  } },
  { name: 'products', token: 'tok-S_001', run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'products');
      await shot('products');
  } },
  { name: 'more', token: 'tok-S_001', run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'more');
      await shot('more');
  } },

  // ── Pages with no login ───────────────────────────────────
  { name: 'public-sales', file: 'PublicSales.html', run: async ({ page, settle, shot }) => {
      await settle(page);
      await shot('public-sales');
      await shot('public-sales-full', { fullPage: true });
  }, also: ['public-sales-full'] },
  { name: 'public-recon', file: 'Public.html', run: async ({ page, settle, shot }) => {
      await settle(page);
      await shot('public-recon');
  } },

  // ── Desktop, for the README ───────────────────────────────
  { name: 'desktop-sales', token: 'tok-S_001', desktop: true,
    viewport: { width: 1280, height: 860 },
    run: async ({ page, settle, shot }) => {
      await tab(page, settle, 'sales');
      await scrollTop(page);
      await shot('desktop-sales');
  } },
];
