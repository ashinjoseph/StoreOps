-- ============================================================
--  roles.sql — the three Operations roles and schema ops
-- ============================================================
--  Run ONCE, by a superuser (locally: the Docker init script; on Supabase:
--  the project's "postgres" user in the SQL editor), on an empty database,
--  BEFORE ops/contracts/schema.sql. Safe to run again: roles that exist get
--  their attributes and passwords reset, the schema is created only if
--  missing, and grants are idempotent.
--
--  Plain SQL: no psql meta-commands, so psql, a database driver and a web
--  SQL editor can all run it.
--
--  Passwords are never written in this file. Set them as three session
--  settings first, in the same session:
--
--    select set_config('ops.owner_password', '<strong password 1>', false),
--           set_config('ops.app_password',   '<strong password 2>', false),
--           set_config('ops.read_password',  '<strong password 3>', false);
--
--    - Supabase SQL editor: paste that statement, with the real passwords,
--      above the contents of this file and run both together. Don't save the
--      query afterwards.
--    - psql or any libpq client: pass them without touching the command
--      line's SQL, e.g.
--        PGOPTIONS="-c ops.owner_password=$A -c ops.app_password=$B -c ops.read_password=$C" \
--          psql -v ON_ERROR_STOP=1 -f ops/contracts/roles.sql
--  The file stops with an error if one of the three is missing or empty.
--
--  Roles (docs/plans/2026-11-ops-local-database.md, "Roles"):
--    ops_owner  owns schema ops; runs the migrations. Never the app.
--    ops_app    the Worker. select/insert/update on ops tables by default;
--               no delete by default. schema.sql narrows audit_log further
--               and grants delete on sessions and login_failures only.
--    ops_read   select only: nightly export, reconcile tool, a person looking.
--  None has CREATEDB or CREATEROLE, and none has rights outside schema ops.
-- ============================================================

-- 1. Login roles, created if missing, then (re)set to the intended shape.
do $roles$
declare
  r   text;
  pw  text;
begin
  foreach r in array array['owner', 'app', 'read'] loop
    pw := nullif(current_setting('ops.' || r || '_password', true), '');
    if pw is null then
      raise exception 'roles.sql: set ops.%_password in this session first (see the top of the file)', r;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'ops_' || r) then
      execute format('create role %I login', 'ops_' || r);
    end if;
    execute format('alter role %I with login nocreatedb nocreaterole password %L', 'ops_' || r, pw);
  end loop;

  -- Where the runner is not a true superuser (Supabase's "postgres"), it needs
  -- membership in ops_owner to create a schema owned by it and to set that
  -- role's default privileges. A real superuser needs nothing and gets nothing.
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant ops_owner to %I', current_user);
  end if;
end
$roles$;

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
