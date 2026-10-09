# 0018. Screenshots and schema docs are generated from the running code

- **Status:** Accepted
- **Date:** 2026-10
- **Components:** [docs process](../guides/docs-process.md)

## Context

The repo needs to explain itself to a new developer, a manager or an
interviewer, with pictures. Hand-taken screenshots go stale with the next UI
change, and screenshots of the live store would publish real names, wages and
takings. The old data-model doc had drifted (it called live tables
"placeholders").

## Decision

- `scripts/docs/runtime.js` runs **every `src/*.gs` file in Node** over an
  in-memory spreadsheet: `firstTimeSetup` and the real migrations build the
  schema.
- `scripts/docs/fixtures.js` seeds **120 days of a fictional store** through
  the real module APIs. The commission engine proposes, payroll allocates,
  handovers settle, so the numbers on screen agree with each other.
- `scripts/docs/screenshots.js` serves the real `src/*.html` to Chromium and
  answers `google.script.run` with the real `rpc*` functions.
- `scripts/docs/schema.js` generates `docs/reference/schema.md` from the built
  schema.
- A **docs guard** in CI fails when the schema doc is stale, an ADR or
  component page isn't indexed, or a doc references an image that the
  screenshot list doesn't produce.

## Consequences

- ✅ Screenshots show the shipped UI with fictional data and can be
  regenerated in a minute after any change: `npm run docs:screenshots`.
- ✅ Producing them exercises the whole app end to end. The first run found
  four real bugs (a fictional card loss in reconcile history, an XSS path on
  the public page, My Pay overflowing a phone, a 100% margin on uncosted
  products).
- ⚠️ Screenshots need Playwright and Chromium, so they are regenerated locally,
  not in CI. CI checks that they exist and are referenced correctly.

## Alternatives considered

- **Manual screenshots of the test deployment:** stale quickly, and the test
  sheet is a copy of real data.
- **Figma mock-ups:** show what was intended, not what ships.
