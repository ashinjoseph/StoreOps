# ops/ — the Operations app

The new StoreOps server: a Cloudflare Worker in TypeScript over Postgres,
built beside the Apps Script app in `src/`. Not live yet; this is the skeleton.

Run these from `ops/` after `npm ci`:

- `npm run typecheck` — strict TypeScript, no emit
- `npm test` — Vitest; tests call the Worker's `fetch` handler directly
- `npm run dev` — `wrangler dev` (local Worker)

`contracts/` is frozen: never edit or move anything in it.
