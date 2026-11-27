# 0023. The Operations app has RPCs and screens of its own, listed apart and hidden in Apps Script

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [app shell and auth](../components/app-shell-and-auth.md), the Operations app (`ops/`; see the [migration plan](../plans/2026-11-operations-app-migration.md))

## Context

The Operations app was built as a port: every call it answers exists in the
Apps Script app, `ops/contracts/rpc.json` is generated from that app, and the
comparison harness checks each ported call against the original. The page is
one file, `src/Index.html`, shipped by both apps.

Once the Sheet is gone, an admin can no longer fix things by editing a cell.
The first two needs are editing settings and correcting a schedule after the
fact. Neither exists in the Apps Script app, where the Sheet does that job,
so neither can be "ported": there is nothing to generate the contract entry
from and nothing to compare with.

Without a decision, a new call would have to be squeezed into the generated
contract by hand (and be overwritten at the next generation), and a new
screen would appear in the live Apps Script app with no server behind it.

## Decision

- **Calls.** RPCs that only the Operations app has are listed in
  `ops/contracts/rpc-ops.json`, written by hand. The Worker enforces
  `rpc.json` and `rpc-ops.json` merged (`mergeOpsContract`). An own entry
  must need a session and must write out its roles (`null` for any signed-in
  person has to be explicit), cannot reuse a name from `rpc.json`, and is
  always live. `rpc.json` stays generated and stays the only list the
  comparison harness uses.
- **Tests.** An own RPC has no original to be compared with, so the harness's
  rule "no handler without a comparison case" does not apply to it. Instead:
  every entry of `rpc-ops.json` has a handler and every handler is in one of
  the two files (a test checks both), and each own RPC has unit tests that
  cover who may call it, what it writes, its audit row, and what it refuses.
- **Screens.** A screen only the Operations app has lives in `src/Index.html`
  like every other screen and is listed in `MORE_ITEMS` with `opsOnly: true`.
  The drawer shows it only when `window.STOREOPS_APP === 'ops'`, which the
  Operations app's `transport.js` sets and Apps Script never loads. A control
  added to an existing screen for an own RPC checks `isOpsApp_()` the same
  way.
- **Rules that do not change.** Identity and role come from the session;
  every write that matters writes an audit row; blank is not zero; money
  records are never deleted.

## Consequences

- ✅ An admin can do in the app what used to need the Sheet, and each such
  action is role-checked and audited, which a cell edit never was.
- ✅ The generated contract and the comparison harness stay exactly what
  they were; nothing an agent adds by hand can be lost at generation.
- ✅ The live Apps Script app is unaffected: it never shows a screen whose
  calls it cannot answer.
- ⚠️ `src/Index.html` now carries code the Apps Script app never runs. It is
  inert there and is covered by the page's own suites, but it ships.
- ⚠️ Own RPCs are held to unit tests only. Their rules are new, so the tests
  are the specification; a reviewer reads them as such.
- ⚠️ After cutover, when Apps Script is retired (P4-07), the `opsOnly` flag
  and the marker lose their purpose and should be removed, and the two
  contract files can become one.

## Alternatives considered

- **Add the features to the Apps Script app too, then port them:** double
  work in an app that is being retired, to fix a problem (no Sheet to edit)
  it does not have.
- **Edit `rpc.json` by hand:** it is generated from `src/WebApp.gs`; the next
  `npm run docs:generate` would drop the entries, or the generator would have
  to learn exceptions.
- **Inject the new screens from a separate script at build time:** keeps
  `src/Index.html` untouched, but the screens would have to patch the page's
  internals (its tab list, titles and loaders) from outside. Fragile, and the
  page becomes the Operations app's own at cutover anyway.
- **A flag from the server in the bootstrap answer:** changes an answer the
  comparison harness holds equal between the two apps.
