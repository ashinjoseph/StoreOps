# 0017. Tests run the real source, and every assertion is seen failing

- **Status:** Accepted
- **Date:** 2026-09 (#17, #18)
- **Components:** [testing guide](../guides/testing.md)

## Context

Apps Script has no test runner, and its services (SpreadsheetApp, UrlFetchApp,
HtmlService) don't exist outside Google. Early test harnesses lived in a
scratchpad, shared globals between suites (hiding at least one pass that
depended on run order), and were lost when the container was recycled: about
620 assertions in one go. Twice, a test was found passing **for the wrong
reason**, because its stub already returned the answer the code was supposed
to produce.

## Decision

- Suites live in `tests/suites/`, run with `npm test`, each **in its own
  process**.
- They load the **real** `src/*.gs` with `new Function`, and the real client
  code by lifting the inline `<script>` out of `src/*.html`. Only Google's
  services are stubbed, never the module under test.
- **House rule: every assertion is confirmed failing** against the code it
  guards (the commit before the fix, or a deliberate mutation) before it's
  kept. The commit message says so.
- Performance is asserted as **counts** (sheet reads, writes), never as time.
- CI runs every suite on every push and pull request.

## Consequences

- ✅ A green suite means the shipped code works, not a copy of it.
- ✅ Tests can't silently pass for the wrong reason without someone having
  skipped the house rule.
- ⚠️ Stubs must be faithful. A stub that returns `null` where the sheet returns
  `''` hides a blank-is-zero bug ([0004](0004-blank-is-not-zero.md)), so a
  path that matters is also tested through the in-memory sheet.

## Alternatives considered

- **Testing inside Apps Script (GasT, QUnitGS2):** slow, needs a deployed
  project and a real sheet, and can't run in CI.
- **Rewriting modules as ES modules for Jest:** the deployed code would differ
  from the tested code.
