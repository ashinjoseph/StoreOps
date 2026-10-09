# Keeping the docs current

The docs are part of the change, not a follow-up. A phase isn't finished until
the pages that describe it describe what shipped. This page is the checklist,
and CI enforces the parts a machine can check.

## The rule

**Every pull request that changes behaviour updates the docs in the same pull
request.** The PR template asks; the reviewer checks; the docs guard fails the
build for anything mechanical that was missed.

## Checklist for a phase

| If the change… | Update |
|---|---|
| changes what a user sees or does | the component page in `docs/components/`, and its screenshot (`npm run docs:screenshots -- <name>`) |
| adds a screen | an entry in `scripts/docs/screens.js`, then reference the new image from the component page |
| adds or changes a column, tab or config key | a migration in `Setup.gs`, then `npm run docs:schema`; the meaning goes in [data-model.md](../architecture/data-model.md) |
| adds or changes a module, an exported function or an RPC | `npm run docs:codemap` |
| adds a doc page | `npm run docs:llms` (or `npm run docs:generate` for all three) |
| changes how agents should work here (a new hard rule, a recipe) | [AGENTS.md](../../AGENTS.md) |
| picks between designs, or accepts a known cost | a new ADR in `docs/adr/`, added to the [index](../adr/README.md) |
| adds a module, an integration or a new way in | [architecture/overview.md](../architecture/overview.md): the diagrams and the module map |
| changes login, roles or the public pages | [architecture/security.md](../architecture/security.md), including the role table |
| changes deploy, CI, triggers or config | [architecture/deployment.md](../architecture/deployment.md) |
| changes a WhatsApp message | [guides/whatsapp-templates.md](whatsapp-templates.md); a template change needs Meta approval |
| ships anything | a `CHANGELOG.md` entry, and the component page's **History** line |

Then run:

```sh
npm test                 # suites, including the docs guard
npm run docs:check       # the docs guard on its own
npm run docs:mermaid     # every diagram renders (needs mermaid, see below)
```

## What the docs guard checks

`tests/suites/docs-guard.js` runs in CI with the rest of the suites. It fails
when:

- `docs/reference/schema.md` doesn't match what `Setup.gs` builds, or
  `docs/reference/code-map.md` doesn't match `src/`, or `llms.txt` doesn't
  match the docs (a page is missing from it, or a link in it is dead);
- `CLAUDE.md` stops importing `AGENTS.md`;
- a file in `docs/adr/` isn't in the ADR index, or the index links a file that
  doesn't exist;
- a component page isn't in the components index, or is missing a required
  section (*What it does*, *How it works*, *Rules it must not break*, *Code
  map*, *Tests*);
- any doc links a relative file that doesn't exist;
- any doc shows an image that isn't in `docs/images/`, or an image there isn't
  produced by `scripts/docs/screens.js`;
- a test suite in `tests/suites/` isn't listed in `tests/suites/README.md`.

It doesn't check whether the prose is still *true*. That's the reviewer's job,
and it's why each component page names the tests that hold its rules.

## Screenshots

```sh
npm run docs:screenshots            # all of them, ~1 minute
npm run docs:screenshots -- recon   # names containing "recon"
```

They're taken from the real `src/` code running in Node over a fictional store
([ADR-0018](../adr/0018-docs-are-generated-from-the-running-code.md)). Needs
Playwright with Chromium (a global install works).

**Never** add a screenshot of the live store or the test deployment. Both hold
real names, pay and takings. If a screen needs data the fixtures don't have,
add it to `scripts/docs/fixtures.js` through the real module APIs, so the
numbers stay consistent with each other.

## Diagrams

Diagrams are Mermaid in fenced blocks, which GitHub renders. Keep each one
small enough to read on a laptop; split rather than cram. Check they all
render:

```sh
npm i --no-save mermaid@11
npm run docs:mermaid
```

## After a phase rolls out

1. Regenerate screenshots for every screen the phase touched.
2. Re-read the component pages it touched, top to bottom, against the deployed
   app.
3. Move anything that turned out different from the plan into the page, and,
   if a decision changed, into a new ADR that supersedes the old one.
4. Add the phase to the **History** of each page it touched.

## Known gaps

Things the docs say are missing, kept here so they're not forgotten:

- **No suite for payroll** (oldest-first allocation, overpayment, mismatch
  guard, undo) or for the attendance state machine. Both are exercised only
  indirectly.
- **No script lock** around payment and handover allocation (see
  [deployment](../architecture/deployment.md#operational-limits)).
- `commission_run_day` is in config but the trigger is always Monday; only the
  hour is read.
