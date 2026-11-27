-- P5-15: what each item costs, from each supplier, over time, and a flag when a cost rises
-- (docs/components/costs.md; docs/adr/0030-an-item-is-a-suppliers-own-line.md).
-- Four Operations-only tables; no Sheet tab feeds them and the cutover tools neither load nor compare them.
-- No migration writes data: receipts confirmed before this one are observed by the page's
-- "Work out costs for earlier receipts" (an admin), not here.
--
-- An ITEM is a supplier's own line: one business, one supplier, and the supplier's printed code for the
-- line when there is one, otherwise its description, both in the normal form of receipts/businesses.ts
-- (item_key). The app does not hold the cstore's product list, so it never matches a line to a product.
-- A person can say two items are the same (joined_into): nothing moves and nothing is deleted; the
-- joined item points at the one it was joined into, and the join can be undone.
--
-- A COST OBSERVATION is written for each line of a receipt at the moment the receipt is CONFIRMED, when
-- the line gives enough to know a unit cost exactly. Observations are never deleted: a voided receipt's
-- stop counting (counted = false, with why and when). A PRICE FLAG says one counted observation costs
-- more than the counted one just before it (by receipt date) by more than the percentage in force when
-- it was observed; a flag is withdrawn (kept, marked) when the history it rested on changes.

-- ── supplier_items ──
create table ops.supplier_items (
  item_id               text primary key check (item_id ~ '^it[0-9a-f]{20}$'),
  business              text not null references ops.businesses (business),
  supplier_id           text not null references ops.suppliers (supplier_id),
  -- The supplier's printed code, and the line's name, as FIRST printed (later spellings are the
  -- observations' own text).
  item_code             text check (item_code is null or (item_code <> '' and char_length(item_code) <= 60)),
  item_name             text not null check (item_name <> '' and char_length(item_name) <= 300),
  -- The identity: 'c:' and the code in its normal form, or 'd:' and the description in its normal form.
  item_key              text not null check (item_key ~ '^[cd]:.' and char_length(item_key) <= 2000),
  first_seen_at         timestamptz not null,
  created_from_receipt  text not null references ops.purchase_receipts (purchase_id),
  -- Joined into another item of the same business and supplier (never itself, never a chain: the trigger).
  joined_into           text,
  joined_by             text,                                              -- staff id; no FK, like the other actor columns
  joined_at             timestamptz,
  join_reason           text check (join_reason is null or char_length(join_reason) between 3 and 300),
  constraint supplier_items_key unique (business, supplier_id, item_key),
  constraint supplier_items_scope unique (item_id, business, supplier_id),
  constraint supplier_items_joined_scope foreign key (joined_into, business, supplier_id) references ops.supplier_items (item_id, business, supplier_id) deferrable initially deferred,
  constraint supplier_items_not_self check (joined_into is distinct from item_id),
  constraint supplier_items_joined check ((joined_into is null) = (joined_at is null) and (joined_into is null) = (joined_by is null) and (joined_into is null) = (join_reason is null))
);
create index supplier_items_supplier_idx on ops.supplier_items (business, supplier_id, item_key, item_id);
create index supplier_items_joined_idx on ops.supplier_items (joined_into) where joined_into is not null;
comment on table ops.supplier_items is 'A supplier''s own line (its printed code, else its description), per business. Joined into another item by a person, never deleted.';

-- A joined item points at a root: joining into an item that is itself joined, or joining an item that
-- others are joined into, would make a chain. The code refuses both with words; this holds it past the code.
create function ops.supplier_items_no_chain() returns trigger language plpgsql as $$
begin
  if new.joined_into is not null then
    if exists (select 1 from ops.supplier_items t where t.item_id = new.joined_into and t.joined_into is not null) then
      raise exception 'an item cannot be joined into an item that is itself joined' using errcode = 'check_violation', constraint = 'supplier_items_no_chain';
    end if;
    if exists (select 1 from ops.supplier_items t where t.joined_into = new.item_id) then
      raise exception 'an item that others are joined into cannot itself be joined' using errcode = 'check_violation', constraint = 'supplier_items_no_chain';
    end if;
  end if;
  return new;
end;
$$;
create trigger supplier_items_no_chain before insert or update on ops.supplier_items for each row execute function ops.supplier_items_no_chain();

-- ── item_costs: one observation per receipt line that gives a cost ──
create table ops.item_costs (
  cost_id                text primary key check (cost_id ~ '^ic[0-9a-f]{20}$'),
  item_id                text not null,
  business               text not null references ops.businesses (business),
  supplier_id            text not null,
  receipt_id             text not null,
  line_no                integer not null,
  receipt_date           date not null,                                    -- the order of the history
  receipt_confirmed_at   timestamptz not null,                             -- breaks a tie between two receipts of one date
  -- The cost of one unit, as printed (before tax), to four decimals; always above zero. 'printed': the
  -- line printed a unit price. 'worked_out': line total / quantity, exactly, rounded half up to four decimals.
  unit_cost              numeric(14, 4) not null check (unit_cost > 0),
  how                    text not null check (how in ('printed', 'worked_out')),
  quantity               numeric(12, 3),                                   -- NULL: not on the line (never 0)
  line_total             numeric(12, 2),
  taxed                  boolean,                                          -- NULL: not marked on the receipt
  line_code              text,                                             -- the line's own words
  line_description       text not null,
  -- The threshold (hundredths of a percent) in force when this was observed: a later change of the
  -- setting does not rewrite an older observation's flag.
  flag_hundredths        integer not null check (flag_hundredths between 10 and 50000),
  counted                boolean not null default true,
  uncounted_reason       text check (uncounted_reason is null or uncounted_reason in ('receipt_voided')),
  uncounted_at           timestamptz,
  observed_at            timestamptz not null,
  observed_by            text not null,                                    -- staff id; no FK
  constraint item_costs_item foreign key (item_id, business, supplier_id) references ops.supplier_items (item_id, business, supplier_id),
  constraint item_costs_line foreign key (receipt_id, line_no) references ops.purchase_receipt_lines (purchase_id, line_no),
  constraint item_costs_once unique (receipt_id, line_no),
  constraint item_costs_scope unique (cost_id, business),
  constraint item_costs_counted check (counted = (uncounted_at is null) and counted = (uncounted_reason is null))
);
-- An item's history in order.
create index item_costs_history_idx on ops.item_costs (item_id, receipt_date, receipt_confirmed_at, receipt_id, line_no) where counted;
create index item_costs_receipt_idx on ops.item_costs (receipt_id);
comment on table ops.item_costs is 'What one unit of an item cost on one receipt line, observed when the receipt was confirmed. A voided receipt''s rows stop counting; never deleted.';

-- ── receipt_observations: which receipts have been observed, and what came of it ──
create table ops.receipt_observations (
  receipt_id        text primary key references ops.purchase_receipts (purchase_id),
  business          text not null references ops.businesses (business),
  lines             integer not null check (lines >= 0),
  lines_observed    integer not null check (lines_observed >= 0),
  lines_no_cost     integer not null check (lines_no_cost >= 0),
  source            text not null check (source in ('confirm', 'catch_up')),
  observed_at       timestamptz not null,
  observed_by       text not null,
  unobserved_at     timestamptz,                                           -- the receipt was voided
  constraint receipt_observations_sum check (lines_observed + lines_no_cost <= lines)
);
comment on table ops.receipt_observations is 'One row per confirmed receipt whose lines were observed (a receipt with no lines too), so a catch-up never does one twice. Never deleted.';

-- ── price_flags ──
create table ops.price_flags (
  flag_id            text primary key check (flag_id ~ '^pf[0-9a-f]{20}$'),
  business           text not null references ops.businesses (business),
  supplier_id        text not null,
  item_id            text not null,                                        -- the item of the later observation
  cost_id            text not null,                                        -- the observation that costs more
  prev_cost_id       text not null,                                        -- the counted one just before it
  unit_cost          numeric(14, 4) not null check (unit_cost > 0),
  prev_unit_cost     numeric(14, 4) not null check (prev_unit_cost > 0),
  rise_percent       numeric(20, 1) not null check (rise_percent > 0),    -- to one decimal, half up
  threshold_hundredths integer not null check (threshold_hundredths between 10 and 50000),
  cost_date          date not null,                                        -- the later receipt's date: newest rise first
  cost_confirmed_at  timestamptz not null,
  -- Why it was written: the receipt's confirmation, a void's re-working of the neighbours, a join or an
  -- undone join, or the catch-up for earlier receipts.
  raised_because     text not null check (raised_because in ('confirm', 'void', 'join', 'unjoin', 'catch_up')),
  raised_at          timestamptz not null,
  state              text not null default 'new' check (state in ('new', 'seen', 'price_raised', 'withdrawn')),
  state_by           text,                                                 -- staff id of the person who marked it; kept when the app withdraws it
  state_at           timestamptz,
  state_note         text check (state_note is null or char_length(state_note) between 1 and 300),
  withdrawn_reason   text check (withdrawn_reason is null or withdrawn_reason in ('receipt_voided', 'history_changed', 'joined', 'unjoined')),
  withdrawn_at       timestamptz,
  constraint price_flags_item foreign key (item_id, business, supplier_id) references ops.supplier_items (item_id, business, supplier_id),
  constraint price_flags_cost foreign key (cost_id, business) references ops.item_costs (cost_id, business),
  constraint price_flags_prev foreign key (prev_cost_id, business) references ops.item_costs (cost_id, business),
  constraint price_flags_distinct check (cost_id <> prev_cost_id),
  constraint price_flags_rise check (unit_cost > prev_unit_cost),
  constraint price_flags_state check (
    (state = 'withdrawn') = (withdrawn_at is not null)
    and (withdrawn_at is null) = (withdrawn_reason is null)
    and (state_by is null) = (state_at is null)
    and (state <> 'new' or state_by is null)
    and (state not in ('seen', 'price_raised') or state_by is not null)
    and (state_note is null or state_by is not null)
  )
);
-- One live flag per observation; a withdrawn one stays beside it.
create unique index price_flags_live_cost on ops.price_flags (cost_id) where state <> 'withdrawn';
-- The flags of a business by state, newest rise first.
create index price_flags_state_idx on ops.price_flags (business, state, cost_date desc, cost_confirmed_at desc, flag_id desc);
create index price_flags_item_idx on ops.price_flags (item_id);
comment on table ops.price_flags is 'A cost more than a set percentage above the one before it. For a person to act on; the app changes no price. Withdrawn, never deleted.';

-- A withdrawn flag stays withdrawn.
create function ops.price_flags_final() returns trigger language plpgsql as $$
begin
  if old.state = 'withdrawn' then
    raise exception 'a withdrawn flag cannot change' using errcode = 'check_violation', constraint = 'price_flags_final';
  end if;
  return new;
end;
$$;
create trigger price_flags_final before update on ops.price_flags for each row execute function ops.price_flags_final();

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
-- Each row is written once, and the app may change only what a person or a void changes.
revoke update on ops.supplier_items from ops_app;
grant update (joined_into, joined_by, joined_at, join_reason) on ops.supplier_items to ops_app;
revoke update on ops.item_costs from ops_app;
grant update (counted, uncounted_reason, uncounted_at) on ops.item_costs to ops_app;
revoke update on ops.receipt_observations from ops_app;
grant update (unobserved_at) on ops.receipt_observations to ops_app;
revoke update on ops.price_flags from ops_app;
grant update (state, state_by, state_at, state_note, withdrawn_reason, withdrawn_at) on ops.price_flags to ops_app;
