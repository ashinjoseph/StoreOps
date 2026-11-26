# ops/ — the Operations app

The new StoreOps server: a Cloudflare Worker in TypeScript over Postgres,
built beside the Apps Script app in `src/`. Not live yet.

Run it locally, from `ops/` (after `npm ci`):

1. `cp .env.example .env` then `npm run db:up` (Docker Postgres on 127.0.0.1:54329)
2. `npm run db:migrate`
3. `cp .dev.vars.example .dev.vars` (fake local values; git ignores it)
4. Add a person to sign in as, then give them a PIN:
   `npm run db:psql`, `insert into ops.staff (staff_id, name, active, role, companies_authorized) values ('S1', 'Asha Example', true, 'manager', 'cstore,vape');`
   then `npm run -s pin:set -- S1 4821` (refuses any database that is not local)
5. `npm run dev`, then open http://localhost:8787 and sign in as "Asha Example"

`npm run build:ui` builds the page from `../src/Index.html` (`dev` does it for
you). `npm run typecheck` and `npm test` (needs `OPS_DB_SUPERUSER_URL`, see
`.env.example`) check the code. `GET /health` reports the database as `ok` or `down`.

`contracts/` is frozen: never edit or move anything in it.
