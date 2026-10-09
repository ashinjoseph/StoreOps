# Working on StoreOps

Google Apps Script + a Google Sheet. Server code in `src/*.gs`, UI in
`src/Index.html` (single page) and two public pages. Start with
[docs/README.md](docs/README.md) for the overall picture.

## Before you change anything

- `npm test` must be green. Suites load the real `src/` in Node; see
  `tests/suites/README.md`.
- **House rule:** every new assertion is confirmed FAILING against the code
  before the fix (or a deliberate mutation), and the commit message says so.
- **Blank is not zero** (docs/adr/0004). Absent figures are written blank and
  read back as `null`; never `Number(x) || 0` on a measured or optional column.
- **Schema changes append** via an idempotent `menu_migrate…` in `Setup.gs`
  (docs/adr/0005).

## Docs are part of every change

After any change that alters behaviour, and always after a phase rolls out,
follow `docs/guides/docs-process.md`:

1. Update the component page in `docs/components/` (what it does, rules,
   code map, tests, History).
2. Regenerate screenshots for touched screens: `npm run docs:screenshots -- <name>`.
   Never use screenshots or data from the live store. Fixtures are fictional
   and go through the real module APIs (`scripts/docs/fixtures.js`).
3. `npm run docs:schema` if any column, tab or config key changed.
4. New ADR in `docs/adr/` for any design choice or accepted cost; add it to
   the index.
5. Update `docs/architecture/*` if modules, integrations, roles or deploy
   changed. Check diagrams with `npm run docs:mermaid`.
6. `CHANGELOG.md` entry.

`tests/suites/docs-guard.js` fails CI when the schema doc is stale, an ADR or
component page isn't indexed, a link is dead, or an image isn't produced by
`scripts/docs/screens.js`.

## Deploys

Pushing the working branch updates the **test** Apps Script project.
Merging to `main` deploys **production**. Don't merge without an explicit
request.
