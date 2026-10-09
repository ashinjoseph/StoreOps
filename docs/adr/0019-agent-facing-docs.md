# 0019. AGENTS.md is the agents' entry point; their maps are generated

- **Status:** Accepted
- **Date:** 2026-10
- **Components:** [docs process](../guides/docs-process.md)

## Context

Much of the work on this repo is done with AI coding agents, and different
tools look for different files: Claude Code reads `CLAUDE.md`, most others read
`AGENTS.md`, and some fetch `llms.txt`. An agent starting cold needs three
things fast: the rules that mustn't be broken, where a given piece of code
lives, and what an RPC is allowed to do. Prose docs answer the first well but
drift on the other two, and an agent that trusts a stale map edits the wrong
function confidently.

## Decision

- **`AGENTS.md`** is the single hand-written entry point: layout, commands, the
  shape of the code, the hard rules (each linked to its ADR), task recipes and
  gotchas. **`CLAUDE.md` imports it** (`@AGENTS.md`) and adds only
  Claude-specific notes, so the two can't diverge.
- **What can be derived is generated**, never typed:
  - `docs/reference/code-map.md` (`npm run docs:codemap`): every module's
    purpose, public API, tabs, callers and loading suites; every `rpc*` with its
    parameters and the roles its `Auth.require` admits; the status
    vocabularies. Read from the booted source.
  - `docs/reference/schema.md` (`npm run docs:schema`): tabs, columns, config keys.
  - `llms.txt` (`npm run docs:llms`): an index of every doc with a one-line
    description, taken from each page's own heading and lead paragraph.
- The **docs guard** fails CI when any generated file is stale, when a doc is
  missing from `llms.txt`, or when `CLAUDE.md` stops importing `AGENTS.md`.

## Consequences

- ✅ An agent can find any module, RPC, column or rule in one or two reads,
  and the map is exact because it comes from the code.
- ✅ A new doc page appears in `llms.txt` without anyone remembering to add it.
- ✅ The same files help a new human developer just as much.
- ⚠️ Adding a module or RPC means running `npm run docs:generate`; CI says so
  when it's forgotten.
- ⚠️ `AGENTS.md` is hand-written, so its rules can drift from the code like any
  prose. Each rule links the ADR and suite that pin it, which is where a
  reviewer checks.

## Alternatives considered

- **Separate CLAUDE.md, AGENTS.md, .cursorrules, copilot-instructions:** the
  same rules in four places, guaranteed to disagree within a month.
- **Point agents at the prose docs only:** good for intent, but too slow to
  answer "where is X", and liable to be stale on structure.
