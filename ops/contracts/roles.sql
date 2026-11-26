-- ============================================================
--  roles.sql — the three Operations roles and schema ops
-- ============================================================
--  Run ONCE, by a superuser (locally: the Docker init script; on Supabase:
--  the project's "postgres" user in the SQL editor), on an empty database,
--  BEFORE ops/contracts/schema.sql. Safe to run again: roles that exist get
--  their attributes and passwords reset, the schema is created only if
--  missing, and grants are idempotent.
--
--  Passwords come in as psql variables; none is written in this file:
--
--    psql -v ON_ERROR_STOP=1 \
--         -v owner_password="$OPS_OWNER_PASSWORD" \
--         -v app_password="$OPS_APP_PASSWORD" \
--         -v read_password="$OPS_READ_PASSWORD" \
--         -f ops/contracts/roles.sql
--
--  It uses \gexec (psql), because psql variables are not expanded inside a
--  DO block. In an SQL editor without psql, replace the three variables by
--  hand and run the statements the selects produce.
--
--  Roles (docs/plans/2026-11-ops-local-database.md, "Roles"):
--    ops_owner  owns schema ops; runs the migrations. Never the app.
--    ops_app    the Worker. select/insert/update on ops tables by default;
--               no delete by default. schema.sql narrows audit_log further
--               and grants delete on sessions and login_failures only.
--    ops_read   select only: nightly export, reconcile tool, a person looking.
--  None has CREATEDB or CREATEROLE, and none has rights outside schema ops.
-- ============================================================

\set ON_ERROR_STOP on

-- 1. Login roles, created if missing, then (re)set to the intended shape.
select format('create role %I login', r)
  from unnest(array['ops_owner', 'ops_app', 'ops_read']) as r
 where not exists (select 1 from pg_roles where rolname = r)
\gexec

select format('alter role ops_owner with login nocreatedb nocreaterole password %L', :'owner_password')
\gexec
select format('alter role ops_app   with login nocreatedb nocreaterole password %L', :'app_password')
\gexec
select format('alter role ops_read  with login nocreatedb nocreaterole password %L', :'read_password')
\gexec

-- Where the runner is not a true superuser (Supabase's "postgres"), it needs
-- membership in ops_owner to create a schema owned by it and to set that
-- role's default privileges. A real superuser needs nothing and gets nothing.
select format('grant ops_owner to %I', current_user)
 where not (select rolsuper from pg_roles where rolname = current_user)
\gexec

-- 2. Schema ops, owned by ops_owner. Nothing in public for the other two.
create schema if not exists ops authorization ops_owner;
revoke all on schema public from ops_app, ops_read;

-- 3. The app and the reader may see into ops (but not create in it).
grant usage on schema ops to ops_app, ops_read;

-- 4. Default privileges for everything ops_owner creates in ops, so a new
--    table is covered without anyone remembering to grant it.
alter default privileges for role ops_owner in schema ops
  grant select, insert, update on tables to ops_app;
alter default privileges for role ops_owner in schema ops
  grant select on tables to ops_read;
alter default privileges for role ops_owner in schema ops
  grant usage, select on sequences to ops_app;

-- 5. Unqualified names resolve in ops for every role.
alter role ops_owner set search_path = ops;
alter role ops_app   set search_path = ops;
alter role ops_read  set search_path = ops;
