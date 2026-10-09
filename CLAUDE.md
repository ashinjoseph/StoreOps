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
