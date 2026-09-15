# Test suites

Node suites that load the **real** module source — `src/*.gs` through
`new Function`, `src/*.html` by lifting the inline script — and run it over
stubbed Apps Script globals. No production test hooks, no copied logic: a suite
that passes is exercising the code that ships.

Run one from the repo root:

```
node tests/suites/public-render.js
```

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
