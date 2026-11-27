# Working on StoreOps

@AGENTS.md

## Claude Code specifics

- `AGENTS.md` above is the source of truth for every agent; change it there,
  not here.
- After any change that alters behaviour, and always after a phase rolls out,
  follow `docs/guides/docs-process.md` in the same change. The docs guard in
  CI fails on the mechanical parts (stale generated references, unindexed
  ADRs or component pages, dead links, unknown images, unlisted suites,
  docs missing from `llms.txt`).
- Don't merge to `main` (production) without an explicit request.

## Who does the work (the owner's ground rule, Nov 27)

This applies to every Claude Code session in this repository.

- **When the session's model is Fable, it decides and orchestrates.** It
  reads the request, plans, writes the brief for each task, reviews what
  comes back, lands it and reports to the owner.
- **The implementation of a task goes to a sub-agent, on the model Fable
  judges best for that task.** Pick per task, not per session: a small model
  for mechanical work with one right answer, a mid model for a module with
  rules in it, a large model for money, security, contracts and anything
  with nothing to check it against. The tiers are in
  [the migration plan, section 5](docs/plans/2026-11-operations-app-migration.md).
  Each sub-agent works in its own git worktree and makes one commit; the
  orchestrator reviews it, runs every check again, and lands it.
- This is the owner's standing request to use sub-agents. It does not need
  to be asked for again in each session.
- What the orchestrator still does itself: answering a question; a plan or
  a spec; the review and landing of a sub-agent's work, including merge
  conflicts and a small fix found in review; and a change too small to be
  worth a brief (a typo, a line).
- On any other model, do the work in the session as usual.
