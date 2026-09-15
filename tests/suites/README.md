# Test suites

Node suites that load the **real** module source — `src/*.gs` through
`new Function`, `src/*.html` by lifting the inline script — and run it over
stubbed Apps Script globals. No production test hooks, no copied logic: a suite
that passes is exercising the code that ships.

Run everything:

```
node tests/suites/run.js
```

Or one suite, by substring:

```
node tests/suites/run.js lotto
node tests/suites/lotto-payout.js
```

Each suite runs in its own process, so a crash in one cannot take the rest with
it and global stubs never leak between suites — the old scratchpad harnesses
shared globals, which hid at least one ordering-dependent pass.

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

Not a suite, but run it before any push — Apps Script reports a template or
parse error as a runtime failure blamed on an unrelated line:

```
node -e 'const fs=require("fs"),vm=require("vm");let b=0;
for (const f of fs.readdirSync("src")) { const p="src/"+f,s=fs.readFileSync(p,"utf8");
 try { if (f.endsWith(".gs")) new vm.Script(s,{filename:p});
  else if (f.endsWith(".html")) { const re=/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;let m;
   while ((m=re.exec(s))) new vm.Script(m[1].replace(/<\?[\s\S]*?\?>/g,"null"),{filename:p}); } }
 catch(e){ b++; console.log("FAIL "+f+": "+e.message); } }
console.log(b?"SYNTAX FAILURES":"syntax gate ok");'
```
