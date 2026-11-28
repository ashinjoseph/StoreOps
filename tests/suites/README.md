# Test suites

Node suites that load the **real** module source — `src/*.gs` through
`new Function`, `src/*.html` by lifting the inline script — and run it over
stubbed Apps Script globals. No production test hooks, no copied logic: a suite
that passes is exercising the code that ships.

Run everything (CI runs this on every push and pull request):

```
npm test
```

Or one suite, by substring:

```
node tests/suites/run.js lotto
node tests/suites/lotto-payout.js
```

Each suite runs in its own process, so a crash in one cannot take the rest with
it and global stubs never leak between suites — the old scratchpad harnesses
shared globals, which hid at least one ordering-dependent pass.

## What is covered

| suite | what it holds down |
| --- | --- |
| `cash-handling` | oldest-first allocation across companies, overpayment and partial guards |
| `commission-fixed` | fixed weekly amounts beside sales commissions: once a week, no mutual blocking, `source_rule_id` |
| `docs-guard` | docs stay in step with the code: schema, indexes, links, images, this table |
| `import-perf` | a bulk paste costing a fixed number of master reads, and the dedup keys |
| `link` | the dashboard link on the close message — appended view, or no link at all |
| `lotto-payout` | netting, reserve-fed-to-till derived from two counts, no double-counted top-up |
| `notifier` | the wire payload, flattening, and what a Meta rejection reports back |
| `ops-schema-contract` | the Postgres contract covers every migrated tab and column, leaves out the deprecated ones by name, no money default, append-only audit grants |
| `ops-ui-build` | the Worker's copy of the page: no template tags, transport loaded first, the three unmoved screens out of the More drawer and nothing else changed, build fails loudly on altered input; the Settings screen (opsOnly, admin only, its two calls named only by its own functions, escaped) |
| `parity` | the app and the public page rendering one payload the same way |
| `perf` | the dashboard read path, counted |
| `public-chart` | bar labels, proportional heights, and opening on the newest day |
| `public-inline` | a cashier's note can't close the public page's inline script |
| `public-render` | the whole PublicSales page rendering rather than going blank |
| `public-report` | what a no-login payload may carry, and sections that fail politely |
| `reconcile` | not-configured vs outage, no fictional variance, shape follows the template |
| `routing` | what each `?v=` serves, the clamped window, and a degraded report |
| `rpc-guards` | privilege read from the session, never from the payload |
| `sales-cards` | two card shapes, mutually exclusive per row, blank never zero |
| `sales-insights` | per-trading-day averaging over a 61-day fixture |
| `shopping-gate` | a needs-detail product can't be ordered until completed |
| `syntax` | every `.gs` file and inline page script compiles |
| `template-guard` | the Apps Script scriptlet contract, read as the preprocessor reads it |
| `ui-assistants` | the Assistants screen: opsOnly and admin only; a new key shown once, in the sheet only (not the read cache, a toast, storage or the address bar) and wiped when the sheet closes; the built page carries it |
| `ui-audit-log` | the Audit log screen: `opsOnly` and admin only, never inside Apps Script; hostile text (`<script>`, quotes) is escaped in the list, the before/after sheet and the filters; changed keys are marked, a missing key is a dash and a blank is the word blank (never 0); Older asks for the page after `nextBefore`; the Commissions screen shows "The Monday run is paused (Settings)." only in the Operations app and only when paused, and Apps Script makes no call; the built page carries the screen |
| `ui-close-sheet` | card shape, the lotto pot, the sign button, and the running sums |
| `ui-dashboard` | tender tiles that never lose a tender, and where the chart sits |
| `ui-picker` | chips show a whole category, needs-detail rows listed but not addable |
| `ui-products` | no cost is "no cost recorded", not a 100% margin; margin sort |
| `ui-receipts` | the Receipts and Businesses screens: both `opsOnly` (Receipts for every role, Businesses for admin, manager and payroll admin); an employee is shown only their own additions and no set-aside or business control; a photo over the limit refused before any request; the token only ever in an Authorization header, never in a URL, a toast or storage; blob URLs revoked when a view closes; the built page carries both; receipt drafts (card P5-05a): the *Read, waiting for review* group, the read-only draft per role with blanks as words and failed checks as sentences, hostile text escaped, and the by-hand sheet sending exactly the fields typed; the old purchase list (card P5-16): its group and one sentence offered to admin, manager and payroll admin and not to an employee, *supplier not written*, hostile and formula-looking text shown as text, the sort and link controls for admin and manager only, the empty state |
| `ui-costs` | the Costs screen (card P5-15): the drawer entry `opsOnly` for admin, manager and payroll admin and hidden inside Apps Script; a flag as one sentence a manager can act on; a worked-out cost says so; a cost that is not there is never `$0.00`; a unit cost keeps its decimals; the screen cannot be asked for without a business (no call is made); admin and manager act, payroll admin only reads, only an admin sees the catch-up; hostile text escaped; the confirm and void sheets repeat the server's cost summary; the built page carries the screen |
| `ui-no-rate` | a day worked with no pay rate (card P4-11b): My Pay, Payroll, the pay form and the Schedule cell sheet inside Apps Script byte-identical to a frozen copy for every role and every answer (even null and the added fields); in the Operations app null reads "no rate set" and 0 reads $0.00; the no-rate days listed with dates and hours, the fix sentence, "not counted" on the totals, no Pay Shifts for no-rate-only; hostile text escaped |
| `ui-recon` | reconcile history shows "not verified", never a $0 measurement |
| `ui-recon-unverified` | today's Reconcile panel: a till whose cards were not measured reads "not verified" with no difference and no red, whatever the reason; measured tills unchanged |
| `ui-reconcile-past` | "Run again for a past day" only in the Operations app and only for the roles that open the Reconcile screen; the Apps Script screen renders the same HTML as before; a day with several sets of results shows the newest and says how many it replaced; the form says no message is sent and earlier results are kept; the built page carries the control |
| `ui-schedule-corrections` | "Correct this day" only for an admin in the Operations app, today or earlier; Toronto instants across both clock changes; the Apps Script cell sheet unchanged |
| `ui-staff-admin` | the Staff screen: `opsOnly`, offered to admin and manager only; a manager's sheet has no rate, role, email or notes; a blank rate is "no rate set", never $0.00; the PIN goes only to `call`, never to the read cache, a toast or storage; the raise preview and the after-save words |
| `ui-till-link` | "Till logins" on the Staff screen only for an admin in the Operations app (a manager's screen makes no till call and has no section; Apps Script unchanged); each state of the link shows its message and, when the till cannot be read, no matching control, with the stored matches read-only; a suggestion sends nothing until the confirm's Match button; choosing someone else, ending a match and matching the store; the key's expiry warning at the top of the section and above the Till group on Settings, only when the server says so; every server string escaped; the built page carries the section |
| `ui-backups` | the nightly copy's line and "Make a copy now" on Settings, Operations app only: the line is the server's sentence at the top, above the groups; each state of `lastBackup` (never, ok, stale, failed) renders its words; a warning is visibly one (amber, an alert, marked) and a good copy is not; the control is there for an admin and only when the server sent the line; pressing it calls rpcRunBackupNow with the token only, shows the result in words and reloads, a refusal as written, a lost session to the sign-in handling; everything escaped; the built page carries it |
| `ui-sales-channels` | "From the till" on the Sales screen only in the Operations app and only for the All and Vape views, drawn after the screen with a placeholder and never delaying it; each state's message and no figures (off said only to an admin); "no figures" against $0.00; negatives; the "to check" and "did not all add up" notes; the side-by-side of entered and rung with no verdict; everything escaped; the Sales screen inside Apps Script byte-identical to a frozen copy for every role; the built page carries it |
| `ui-till-corrections` | "Correct this till" only for an admin in the Operations app, on a closed till; the Apps Script Sales screen unchanged; the close's inputs in the row's card shape; a blank shown in words and sent as null |
| `ui-missed-shifts` | "Enter a shift that was not put in" only for an admin in the Operations app, on a day before today; the Sales day byte-identical for every other role and in Apps Script; the close's inputs for each till and card shape (redrawn in the shape the server names); the server's preview, debounced, and its refusals as worded; a blank in words; what was created and what went stale |
| `wiring` | every close-sheet field, from the browser's payload to the ledger |

One suite from the lost set is **not** rebuilt: `realdata`, which read the live
spreadsheet and asserted against the store's actual figures. It cannot run
offline, and a version that ran against a fixture would be a different test
wearing its name. Its checks belong in a script run against the sheet, not here.

## Writing one

```js
const H = require('./_lib/harness');
const t = H.suite('what this covers');

H.sheets({
  till_sessions: { headers: [...], rows: [[...]] },
  config: { variance_ok_threshold: 1 },        // plain object is fine
});
const M = H.load(['Util.gs', 'TillSessions.gs'], { Staff: {...} });

t.eq('label', actual, expected);
t.done();
```

`H.load` evaluates the real source and returns both module objects (`Sales`,
`TillSessions`) and top-level functions (`rpcCloseShift`) — `WebApp.gs` has no
module object, so its endpoints come back by name. `H.clientScript('Index.html')`
lifts the inline script for client-side assertions, and `H.fnSource` pulls one
function out of a file so it can be run in a sandbox.

**Stub only what the module calls.** If a stub is thinner than the real
collaborator the suite fails loudly rather than silently diverging — that is the
point.

## Why they live here

They used to live in a session scratchpad and were lost when the container was
recycled — roughly 620 assertions across 26 suites, gone in one step, right in
the middle of diagnosing a production defect. Anything worth re-running belongs
in the repo.

`clasp push` uploads `rootDir: src` only, so nothing here reaches Apps Script.

## The house rule

**Every new assertion must be confirmed to FAIL against the commit it fixes.**
It has caught wrong tests more than once — a test written after the fix, against
the fixed code, proves nothing. Run the suite with the change stashed before
trusting it.

## Syntax gate

Now the `syntax` suite, so CI runs it. The one-liner below does the same check
without the harness — Apps Script reports a template or parse error as a
runtime failure blamed on an unrelated line:

```
node -e 'const fs=require("fs"),vm=require("vm");let b=0;
for (const f of fs.readdirSync("src")) { const p="src/"+f,s=fs.readFileSync(p,"utf8");
 try { if (f.endsWith(".gs")) new vm.Script(s,{filename:p});
  else if (f.endsWith(".html")) { const re=/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;let m;
   while ((m=re.exec(s))) new vm.Script(m[1].replace(/<\?[\s\S]*?\?>/g,"null"),{filename:p}); } }
 catch(e){ b++; console.log("FAIL "+f+": "+e.message); } }
console.log(b?"SYNTAX FAILURES":"syntax gate ok");'
```
