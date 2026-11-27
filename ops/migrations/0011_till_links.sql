-- P5-02b: the till link's two matches (docs/components/till-link.md, ADR-0024).
-- Two Operations-only tables; no Sheet tab feeds them and the cutover tools neither load nor compare them.
-- Nothing here is ever deleted: a match is ended (who, when), the row stays.
-- The till is only read: these rows are Operations' own record of which till store and which till login
-- stand for which Operations store and person. Nothing about unmatched till people is stored.
--
-- till_stores: one Operations store <-> one till store (a uuid). Among live rows (ended_at is null) each
-- Operations store has at most one till store, and each till store belongs to at most one Operations store.
create table ops.till_stores (
  match_id       bigint generated always as identity primary key,
  store_id       text not null references ops.stores (id),
  till_store_id  uuid not null,
  till_name      text not null check (till_name <> ''),       -- the till's name for it, as given when matched
  matched_by     text not null,                               -- staff id; no FK, like the other actor columns
  matched_at     timestamptz not null,
  ended_by       text,
  ended_at       timestamptz,
  constraint till_stores_ended check ((ended_at is null) = (ended_by is null))
);
create unique index till_stores_live_store_idx on ops.till_stores (store_id) where ended_at is null;
create unique index till_stores_live_till_idx on ops.till_stores (till_store_id) where ended_at is null;

comment on table ops.till_stores is 'Which till store stands for which Operations store. Ended, never deleted.';

-- till_staff_links: one Operations person <-> one till login (the till's staff_id, a uuid), for one till
-- store. Among live rows a person has at most one login per till store, and a till login belongs to at
-- most one person. The nil uuid ("Not known": the till recorded no one) is never a login.
create table ops.till_staff_links (
  link_id        bigint generated always as identity primary key,
  staff_id       text not null references ops.staff (staff_id),
  till_store_id  uuid not null,
  till_staff_id  uuid not null,
  till_name      text not null check (till_name <> ''),       -- the till's name for the person when matched
  till_role      text not null check (till_role <> ''),       -- and its role for them (owner, store_manager ...)
  matched_by     text not null,
  matched_at     timestamptz not null,
  last_seen_at   timestamptz,                                 -- the last time the till's staff list held them
  ended_by       text,
  ended_at       timestamptz,
  ended_reason   text,
  constraint till_staff_links_not_known check (till_staff_id <> '00000000-0000-0000-0000-000000000000'),
  constraint till_staff_links_ended check (
    (ended_at is null) = (ended_by is null) and (ended_at is null) = (ended_reason is null)
  )
);
create unique index till_staff_links_live_person_idx on ops.till_staff_links (staff_id, till_store_id) where ended_at is null;
create unique index till_staff_links_live_till_idx on ops.till_staff_links (till_staff_id) where ended_at is null;
create index till_staff_links_staff_idx on ops.till_staff_links (staff_id);

comment on table ops.till_staff_links is 'Which till login stands for which Operations person. Ended, never deleted. Unmatched till people are not stored.';

-- ── Grants: the exceptions to roles.sql's defaults ───────────
-- Who a match is between, and when and by whom it was made, never change after it is made: the app may
-- only end a match, and (for a person) note when the till's list last held them.
revoke update on ops.till_stores from ops_app;
grant update (ended_by, ended_at) on ops.till_stores to ops_app;
revoke update on ops.till_staff_links from ops_app;
grant update (last_seen_at, ended_by, ended_at, ended_reason) on ops.till_staff_links to ops_app;
