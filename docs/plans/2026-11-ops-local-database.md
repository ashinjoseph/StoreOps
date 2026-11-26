# Operations database: local in Docker first, then Supabase

> **Status: proposed (2026-11-22), for the owner to review.** How the new
> Operations database runs on a developer's machine, in CI, and then on its
> Supabase project. Cards P2-01, P2-02 and P2-10 build it. Plan decisions
> D2 and D3 are the background:
> [migration plan](2026-11-operations-app-migration.md).

**In short:** one plain Postgres container from Docker Compose, with the
same major version, roles, schema and migrations as the Supabase project.
CI runs the same image. Moving to Supabase means running the same role
script and migrations there. No code changes.

## Choices

| Choice | Picked | Why | Not picked |
|---|---|---|---|
| Local engine | The official `postgres` image, one container | Operations uses none of Supabase's extras: sign-in is its own, files go to R2, and the Worker speaks plain SQL. One container starts in seconds. | `supabase start`: about ten containers and a few GB of memory, for Auth, Storage and an API that Operations doesn't use |
| Version | The **same major version** as the Supabase project | Avoids surprises from a newer local Postgres | "latest" |
| Extensions | **None** | `gen_random_uuid()` is built in. Fewer differences between local and Supabase | `pgcrypto`, `uuid-ossp` |
| Who runs migrations | `ops_owner`, never a superuser, locally too | Anything that needs superuser fails on the laptop first, not on Supabase, where `postgres` isn't a full superuser | Migrating as `postgres` locally |
| Tests | The same Docker Postgres; each test file gets its own database, copied from a migrated template | Real row locks and two connections at once, which the handover test (P3-06) needs. Copying a template takes milliseconds. | In-process Postgres (PGlite): one connection only, no roles |
| CI | A Postgres service container in GitHub Actions, same image | Same engine as local and Supabase | No database in CI |
| Data | **Fictional only**, locally and in CI | Real pay, takings and names stay in the Supabase project | Copies of production on a laptop |

## Roles

The same names everywhere: laptop, CI and Supabase.

| Role | Can | Used by |
|---|---|---|
| `ops_owner` | Owns schema `ops`; creates and alters its tables | The migration runner |
| `ops_app` | Read and write the `ops` tables, under these limits: `audit_log` insert and read only; delete only on `sessions` and `login_failures` | The Worker (through Hyperdrive) |
| `ops_read` | Read the `ops` tables | Nightly export, reconcile tool, someone looking |

No role has rights outside schema `ops`. The grants come from default
privileges set once by `ops_owner`, so a new table is covered without anyone
remembering to grant it. The limits on `ops_app` are the hard rules
"never delete money records" and "audit is append-only", enforced by the
database as well as the code.

## Files

```
ops/
  .env.example        committed: the variable names, with local-only values
  .env                not committed (already ignored by .gitignore)
  db/
    compose.yml       the container
    init/
      01-roles.sh     creates the three roles and schema ops; runs once, on an empty volume
    seed/             fictional data, generated from scripts/docs/fixtures.js
```

### `ops/db/compose.yml`

```yaml
services:
  db:
    image: postgres:17-alpine        # set the major version to the Supabase project's (see "Version check")
    ports: ["127.0.0.1:54329:5432"]  # this machine only; 54329 avoids clashing with another Postgres
    environment:
      POSTGRES_DB: ops
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${OPS_DB_SUPERUSER_PASSWORD}
      OPS_OWNER_PASSWORD: ${OPS_OWNER_PASSWORD}
      OPS_APP_PASSWORD: ${OPS_APP_PASSWORD}
      OPS_READ_PASSWORD: ${OPS_READ_PASSWORD}
    command: ["postgres", "-c", "timezone=UTC"]   # as on Supabase; business days are worked out in code
    volumes:
      - ops-pgdata:/var/lib/postgresql/data
      - ./init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres", "-d", "ops"]
      interval: 2s
      retries: 30
volumes:
  ops-pgdata:
```

### `ops/.env.example`

```sh
OPS_DB_SUPERUSER_PASSWORD=local-only-super
OPS_OWNER_PASSWORD=local-only-owner
OPS_APP_PASSWORD=local-only-app
OPS_READ_PASSWORD=local-only-read
OPS_DB_OWNER_URL=postgres://ops_owner:local-only-owner@127.0.0.1:54329/ops
OPS_DB_APP_URL=postgres://ops_app:local-only-app@127.0.0.1:54329/ops
```

These values are for a database that only listens on this machine. Never use
them anywhere else. Real passwords live in a password manager, GitHub
secrets and the Hyperdrive configuration, never in the repo.

### `01-roles.sh`

The same SQL also bootstraps the Supabase project (see step 3 of "Flip to
Supabase"), so it is plain SQL wrapped in a small shell script that passes
the passwords as `psql` variables.

1. Create `ops_owner`, `ops_app` and `ops_read` as login roles with the
   given passwords; no `CREATEDB` and no `CREATEROLE`.
2. `create schema ops authorization ops_owner;` and
   `revoke all on schema public from ops_app, ops_read;`
3. Grant `usage` on `ops` to `ops_app` and `ops_read`.
4. As `ops_owner`, set default privileges in `ops`: `select, insert, update`
   to `ops_app`; `select` to `ops_read`; `usage, select` on sequences to
   `ops_app`.
5. Set each role's `search_path` to `ops`.

The exceptions for `audit_log`, `sessions` and `login_failures` go in the
migration that creates those tables, next to the tables themselves.

## Commands

Added to `ops/package.json` by P2-02:

| Command | Does |
|---|---|
| `npm --prefix ops run db:up` | Starts the container and waits until it's healthy |
| `npm --prefix ops run db:migrate` | Applies `ops/migrations/*.sql` as `ops_owner`, each file once, in order |
| `npm --prefix ops run db:seed` | Loads the fictional data |
| `npm --prefix ops run db:reset` | Deletes the volume, then up, migrate, seed: a clean database in under a minute |
| `npm --prefix ops run db:psql` | Opens `psql` as `ops_app` |
| `npm --prefix ops run db:down` | Stops it; the data stays in the volume |

## How each piece connects

| Piece | Locally | On Supabase |
|---|---|---|
| Worker (`wrangler dev`) | Hyperdrive's local connection string = `OPS_DB_APP_URL` | Hyperdrive config with `ops_app`, through Supabase's session pooler |
| Migrations | `db:migrate` with `OPS_DB_OWNER_URL` | The deploy workflow, with `ops_owner`'s URL from a GitHub secret, before the Worker deploys |
| Tests | Template database `ops_template`, migrated once per run; each test file gets `create database … template ops_template` | Never: tests don't touch Supabase |
| Export and reconcile tools | `ops_read` | `ops_read`, from a GitHub secret |

## Flip to Supabase (card P2-10)

1. **Owner:** after the till's staging is moved off, **delete that project
   and create a fresh one for Operations** in the same region. This leaves
   no till tables, Auth users or roles behind, and the new project gets
   Supabase's current Postgres.
2. **Version check:** run `show server_version;` in the new project's SQL
   editor and set the same major version in `compose.yml`. Run `db:reset`
   and the tests again.
3. **Owner:** run the SQL inside `01-roles.sh` once in the SQL editor, with
   three new strong passwords. Store them in the password manager, then:
   `ops_owner` in a GitHub secret for the deploy workflow, `ops_app` in the
   Hyperdrive config, and `ops_read` in a GitHub secret for the export.
4. **Owner:** in the project's API settings, keep `ops` **out of the exposed
   schemas**. The Supabase Data API never sees Operations' tables.
5. The deploy workflow runs the migrations, then deploys the Worker.
   `/health` checks it can read from `ops`.
6. The weekly keep-awake request and the nightly R2 copy are switched on
   (P2-10, P4-06): the free plan pauses idle projects and has no automatic
   backups.

From then on there is one way to change the database: a numbered migration
file, tried locally, run in CI, then applied by the deploy workflow.
Nobody edits tables by hand in the Supabase dashboard.

## The till, while building

Operations reads the till through two settings, never a hard-coded address:
`TILL_API_BASE_URL` and `TILL_API_KEY` (a Worker secret; locally in
`ops/.dev.vars`, which is not committed).

| When | `TILL_API_BASE_URL` | Key |
|---|---|---|
| Now | The till's current staging, `https://staging--scarbromart-office.netlify.app/ops/v1` (invented data) | The till's staging key |
| Once the till team runs its staging in Docker | The address of that setup | Its own staging key |
| Production | `https://office.scarbromart.ca/ops/v1` | The production key, made by the owner |

Changing between them is a settings change, not a code change.

**Where a till key is kept.** Never in the repo, the chat, a ticket, or the
current app's `config` tab, which anyone with Sheet access can read.

| Place | What goes there |
|---|---|
| The owner's password manager | Every key, with the date it expires (90 days after it was made). This is the copy the others are made from |
| `ops/.dev.vars` (ignored by git) | The staging key, for `wrangler dev` and the retrieval check on a developer's machine |
| Cloudflare Worker secret `TILL_API_KEY`, per environment | Staging key on the staging Worker; production key on production only |
| The cloud session's network secret for the till's host | Only so Claude can run the retrieval check; entered in a secure form, injected by the proxy, never seen by Claude |
| Apps Script **Script Properties** | Only if P1-03 is built on the current app: the production key, never in the `config` tab |

Operations stores only the expiry date as a setting (`till_api_key_expires_on`),
for the 14-day warning. A leaked key is revoked in the Office and replaced;
that is all it takes. Unit tests
never call a till: they use a fake built from the contract. Only the
retrieval check (card P1-04) calls a real one. If the till team's Docker
staging is reachable only on their own machine, Operations' cloud staging
can't call it; the retrieval check then runs from a machine that can.

## Running the tests

`npm --prefix ops test` needs `OPS_DB_SUPERUSER_URL`, a superuser connection
to a Postgres on **this machine**; the Docker database's is in
`ops/.env.example`. The tests refuse any other host, because once per run
they drop and rebuild a template database (`ops_template`) and reset the
three roles' passwords. They reset them to the same local-only values as
`.env.example`, so the Docker database's logins keep working afterwards.
Each test file gets its own database copied from the template
(`createTestDb()` in `ops/test/helpers/db.ts`) and drops it at the end.
Don't run two test runs against one server at the same moment.

## Checks

The setup is done when:

- `db:reset` on a clean machine with Docker gives a migrated, seeded
  database, and `db:psql` shows the `ops` tables;
- a test connected as `ops_app` can't delete an `audit_log` row, can't
  update one, and can't read or create anything outside schema `ops`;
- two connections can lock the same row, and the second one waits;
- CI runs the same tests against the service container and passes;
- after the flip, the same checks pass against Supabase, run once by hand
  as `ops_app`.
