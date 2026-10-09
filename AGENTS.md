# AGENTS.md

Instructions for AI coding agents (and humans in a hurry) working in this
repository. Read this file first; it is short on purpose and links to the
detail.

## What this is

StoreOps: daily operations for a two-till store (cstore + vape) — till
open/close, cash and card reconciliation, cash handovers, schedule, payroll,
commissions, product catalogue, shopping list. **Google Apps Script (V8) with
a Google Sheet as the database.** The browser calls server functions through
`google.script.run`; there is no other backend, no database server, no
framework, no build step.

## Where things are

| Need | Go to |
|---|---|
| Every module, its public API, tabs, callers and tests; every RPC with its roles | [docs/reference/code-map.md](docs/reference/code-map.md) (generated) |
| Every tab and column, every config key | [docs/reference/schema.md](docs/reference/schema.md) (generated) |
| What a feature does and the rules it must keep | [docs/components/](docs/components/README.md) — one page per feature |
| Why something is the way it is | [docs/adr/](docs/adr/README.md) — one record per decision, with the alternatives rejected |
| How the pieces fit | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Domain words (float, variance, lotto reserve, handover…) | [docs/context.md#glossary](docs/context.md#glossary) |
| Machine-readable index of all docs | [llms.txt](llms.txt) |

```
src/                 everything that ships (clasp rootDir)
  *.gs               23 server modules, one global scope
  Index.html         the whole app UI: one page, inline <script>, ~6k lines
  Public.html        no-login 7-day report   (?v=recon)
  PublicSales.html   no-login sales page     (?v=sales)
  appsscript.json    manifest: V8, America/Toronto, webapp ANYONE_ANONYMOUS
tests/suites/        Node test suites over the real src/ (npm test)
scripts/docs/        runtime (src/ in Node), fixtures, screenshots, schema/code-map generators
docs/                architecture, components, ADRs, guides, generated reference
.github/workflows/   ci.yml (tests), test-deploy.yml (branch → test), deploy.yml (main → prod)
```

## Commands

```sh
npm test                              # all suites; must be green before and after your change
node tests/suites/run.js reconcile    # suites whose filename contains "reconcile"
npm run docs:generate                 # regenerate schema.md, code-map.md and llms.txt (run after structural changes)
npm run docs:check                    # docs guard only
npm run docs:screenshots -- <name>    # regenerate a screenshot (needs Playwright + Chromium)
npm run docs:mermaid                  # render every diagram (needs: npm i --no-save mermaid@11)
```

No `npm install` is needed to run tests: suites use only Node built-ins.
Never run `clasp push` / `clasp deploy` yourself; CI deploys.

## How the code is shaped

- **One module per `.gs` file**, as an IIFE returning a public object:
  `const Sales = (() => { function write_(…) {…} return { write: write_ }; })();`
  Private helpers end in `_`. All files share **one global scope**, so module
  names are globals and load order doesn't matter at call time.
- **`WebApp.gs`** holds `doGet` and every `rpc*` endpoint. Each RPC is:
  ```js
  function rpcThing(token, input) {
    const session = _session(token);                   // throws NOT_LOGGED_IN
    Auth.require(session, ['admin', 'payroll_admin']); // throws FORBIDDEN (omit = any signed-in)
    return Module.thing({ ...input, actorId: session.staffId });
  }
  ```
  Identity and role come **only** from the session, never from arguments.
  Return plain JSON-safe objects (Dates don't survive `google.script.run`;
  `JSON.parse(JSON.stringify(x))` or ISO strings).
- **`Setup.gs`** builds the schema (`firstTimeSetup`), the sheet menu
  (`onOpen`), and one idempotent `menu_migrate…` per schema change.
- **Sheets:** row 1 = title banner, row 2 = header, data from row 3. Modules
  address columns through a `COL` map (1-based). Tab names are `SHEETS.*`.
- **Config** is the `config` tab (key/value). Modules read it through their
  own `configValue_(key, default)` helper; a blank value means "use the
  default".
- **Every write that matters** calls `AuditLog.write({ actorId, action, targetType, targetId, before, after, details })`.
- **Client (`Index.html`):** `call(method, …args)` for writes,
  `cachedCall(method, args, ttl)` for reads; a successful write clears the
  read cache. Each tab has `load<Tab>Tab` → `render<Tab>Tab`. Escape every
  interpolated string with `esc()`; format money with `money()`.

## Hard rules

Breaking one of these has caused a production incident before. Each links its
reasoning.

1. **Blank is not zero.** Never `Number(x) || 0` on a measured or optional
   column. Write absence as `''`, read it back as `null` (`numOrNull_`), and
   make displays say *not verified* / *no cost recorded*. Sums may treat
   `null` as 0. [ADR-0004](docs/adr/0004-blank-is-not-zero.md)
2. **Schema changes append.** New column at the end, via a `menu_migrate…`
   that is safe to run twice. Never reuse, rename or reorder a column.
   [ADR-0005](docs/adr/0005-card-shapes-are-mutually-exclusive-columns.md)
3. **Card revenue = credit + debit + card_total (+ the misc three).** A row
   fills one shape or the other, never both. Sum all three.
4. **No sheet call inside a per-row loop.** Read once, build an index, write
   once with `setValues`. Tests count reads.
   [ADR-0010](docs/adr/0010-bulk-import-reads-once-writes-once.md)
5. **Roles from the session only**, checked in the RPC with `Auth.require`.
   Hiding a button is not enforcement.
6. **Public pages expose no RPC.** Their data is inlined via
   `inlineJson_(payload)` (escapes `<`); the template must use
   `<?!= payload ?>`, and no other `<?` may appear in those files — not even
   in a comment. [ADR-0003](docs/adr/0003-public-pages-inline-their-data.md)
7. **A WhatsApp template's parameter count is fixed by the template**, not by
   till state; a send failure must be reported, never swallowed.
   [ADR-0007](docs/adr/0007-message-shape-follows-the-template.md)
8. **Money:** round with `Util.roundMoney` at every write. Dates are real Date
   cells; business dates are formatted in `America/Toronto` via `Util.formatDate`.
9. **Never delete money records.** Void (handovers), mark (`removed`,
   `ordered`), or undo through `Payments.undo`, which audits.
10. **Commission engine only proposes.** Nothing is payable until approved.

## Making a change

1. Read the component page for the feature and the ADRs it links.
2. Find the code via [code-map.md](docs/reference/code-map.md); find the
   tests in the component page's **Tests** table.
3. **Write the test first.** Confirm it **fails** against current code (or
   against a deliberate mutation of your fix) — this is the house rule, and the
   commit message must say it was done. A test that never failed proves
   nothing; two suites here once passed for the wrong reason.
4. Make the change. `npm test` green.
5. Update docs in the same change (CI enforces the mechanical parts):
   component page (incl. **History**), `npm run docs:schema` /
   `npm run docs:codemap` if structure changed, an ADR for any design choice,
   screenshots for touched screens, `CHANGELOG.md`.
   Full checklist: [docs/guides/docs-process.md](docs/guides/docs-process.md).

### Recipes

| Task | Do |
|---|---|
| Add an RPC | Function in `WebApp.gs` following the pattern above; call it from `Index.html` via `call`/`cachedCall`; add a guard assertion in `tests/suites/rpc-guards.js` if it is role-restricted; `npm run docs:codemap`. |
| Add a column | Append to the `COL` map of the owning module; add a `menu_migrate…` in `Setup.gs` (idempotent: check the header first) and a menu item in `onOpen`; make readers tolerate the column being absent; `npm run docs:schema`. |
| Add a config key | Add `[key, default, description]` to the defaults list in `Setup.gs` (`menu_syncConfigKeys` adds it to existing sheets); read via `configValue_`; `npm run docs:schema`. |
| Add a screen / tab | Render in `Index.html`; add to `MORE_ITEMS` with roles if it lives in the drawer; add an entry to `scripts/docs/screens.js`; screenshot; reference it from the component page. |
| Add a product type | A registry entry in `ProductTypes.gs` (`detailSheet`, `detailColumns`, `derivePricing`, `validate`, `fieldSchema`), its detail tab + staging tab in `Setup.gs`. [ADR-0012](docs/adr/0012-product-core-plus-per-type-detail.md) |
| Add a test suite | `tests/suites/<name>.js` using `_lib/harness.js` (`H.suite`, `H.sheets`, `H.load`, `H.clientScript`, `H.fnSource`); add a row to `tests/suites/README.md` (docs guard checks). |
| Add a WhatsApp message | New template config key, a params builder sized to the template, `Notifier.sendOp`; document the body in `docs/guides/whatsapp-templates.md`; it needs Meta approval before it sends. |

## Testing model

Suites load the **real** `src/*.gs` with `new Function` and the real client
code by lifting the inline `<script>` from `src/*.html`; only Google services
(`SpreadsheetApp`, `UrlFetchApp`, …) are stubbed. In-memory sheets via
`H.sheets({ tab: { headers, rows } })`. Stub only what the module calls, and
make stubs return what the real thing returns — `''` for an empty cell, not
`null`. Details: [docs/guides/testing.md](docs/guides/testing.md),
[tests/suites/README.md](tests/suites/README.md).

## Gotchas

- Apps Script templating is a **text preprocessor**: `<?` inside a JS string or
  comment in an `.html` template still opens a scriptlet. `template-guard` and
  `syntax` suites catch it.
- `google.script.run` can't return `Date` objects — they arrive as `null`.
- `var` inside a client function hoists over a module-level helper of the same
  name (this blanked the public sales page once). Use `const`/`let`.
- A per-execution cache must be busted **before** a write re-reads its own
  result, or it returns the pre-write row.
- The docs runtime (`scripts/docs/runtime.js`) runs the whole server in Node —
  useful for reproducing a bug end to end: `const { api } = require('./scripts/docs/runtime').boot();`
- Test data, fixtures and screenshots use **fictional** people
  (`scripts/docs/fixtures.js`). Never put real staff names, pay, takings or
  phone numbers in the repo.

## Git and deploys

- Pushing the working branch deploys to the **test** Apps Script project;
  merging to `main` deploys **production**. Do not merge or push to `main`
  unless explicitly asked.
- Commit messages: imperative subject saying what changed for the user; body
  says why, what was tested, and that new assertions were seen failing.
