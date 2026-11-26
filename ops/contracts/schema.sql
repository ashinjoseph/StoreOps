-- ============================================================
--  schema.sql — the Operations database contract (card P0-03)
-- ============================================================
--  Purpose
--    The frozen Postgres schema every later card builds on: one table per
--    migrated Sheet tab, with the SAME table and column names as the Sheet
--    (docs/reference/schema.md), so the import from the Sheet is a lossless
--    column-for-column copy; plus four tables that exist only in Operations
--    (stores, staff_stores, sessions, login_failures). Workers never edit this
--    file; a change is a numbered migration (ops/migrations/) and, if it changes
--    the contract, a new version of this file agreed by the owner.
--
--  How to load
--    1. ops/contracts/roles.sql, once, as a superuser (creates ops_owner,
--       ops_app, ops_read and schema ops, and the default privileges).
--    2. This file, as ops_owner, in ONE transaction, into an empty schema ops:
--         psql -v ON_ERROR_STOP=1 --single-transaction \
--              "postgres://ops_owner:…@host:port/ops" -f ops/contracts/schema.sql
--       The migration runner does the same: it wraps each file in a
--       transaction. The file is plain SQL with no psql meta-commands and no
--       begin/commit of its own, so any driver can run it.
--
--  Conventions (each with its reason)
--    - Money is numeric(12,2): the Sheet rounds with Util.roundMoney at every
--      write. Postgres ROUNDS a third decimal silently on insert, so the
--      import must reject a cell that does not round-trip, not rely on this.
--    - Hours are numeric(6,2) (hours_worked is Util.roundMoney'd hours; a
--      day is < 10,000 h). Hourly rates are numeric(10,4): the Sheet writes
--      the rate as typed, unrounded, and pay = round(hours × rate), so a rate
--      keeps more precision than a cent. Commission percentage is
--      numeric(7,4), 0–100 (5 means 5%, Commissions.gs divides by 100).
--      Counts (staff_count, bonuses_created) are integer.
--    - Business dates are date (formatted in America/Toronto in the Sheet).
--      Moments are timestamptz. Flags are boolean.
--    - Blank is not zero (ADR-0004): every measured or optional figure is
--      nullable with NO default. No numeric column has a default at all. The
--      import writes a blank cell as NULL, never 0.
--    - Text IDs from the Sheet stay text primary keys (S_001, A_…, CST-…).
--    - Actor columns (created_by, recorded_by, validated_by, computed_by,
--      modified_by, voided_by, audit_log.actor_id) are text WITHOUT a foreign
--      key: the Sheet writes 'SYSTEM' and 'SYSTEM_TRIGGER' there as well as
--      staff ids.
--    - Enum CHECKs use the canonical values from src/Setup.gs (code-map.md,
--      "Vocabulary"). The Sheet's own validation is advisory and code reads
--      some columns case-insensitively ('Closed'), so the import normalises
--      case before insert and sends anything else to the rejects file.
--    - store_id: a store is a location, a till belongs to a company in a
--      store (decision D4). Every operational table has store_id, defaulting
--      to the one store seeded below. company (cstore | vape) stays a column
--      wherever the Sheet has it.
--    - config: key/value as in the Sheet. Secret keys (clover_*_token,
--      whatsapp_api_token, …) are simply not imported; nothing here.
--    - Grants come from roles.sql's default privileges (ops_app: select,
--      insert, update; ops_read: select). The exceptions are at the end:
--      audit_log is insert/select only for ops_app, and delete is granted on
--      sessions and login_failures only. Money is never deleted (AGENTS.md
--      hard rule 9). The owner role is trusted; the app role is not, so the
--      limits are grants, not triggers.
--
--  Left out, and why
--    Tabs deprecated by the owner (Nov 21; migration plan, "Not migrated:
--    deprecated areas"). Their data stays readable in the archived Sheet:
--    tab    product_master             deprecated: product master (new design in P5-05)
--    tab    product_beer_detail        deprecated: product master per-type detail
--    tab    product_cigarettes_detail  deprecated: product master per-type detail
--    tab    product_vape_detail        deprecated: product master per-type detail
--    tab    _pm_beer_staging           deprecated: import staging, not data
--    tab    _pm_cig_staging            deprecated: import staging, not data
--    tab    _pm_vape_staging           deprecated: import staging, not data
--    tab    _pm_other_staging          deprecated: import staging, not data
--    tab    suppliers                  deprecated: supplier reference (new design in P5-05)
--    tab    order_catalog              deprecated: legacy order catalogue
--    tab    shopping_list              deprecated: shopping list
--    tab    pos_extracted              never implemented: nothing writes it
--    tab    clover_batches             never implemented: nothing writes it
--    Columns of migrated tabs:
--    column staff.login_code           the plaintext PIN. Operations checks
--                                      its own PINs (decision D6) and stores
--                                      only a hash, added by the login card
--                                      (P2-06) as a migration; a plaintext
--                                      PIN never enters this database.
--    Config rows (not columns; listed for completeness): the secret keys are
--    not imported, and whatsapp_template_shopping_list goes with the
--    shopping list.
-- ============================================================

set local search_path = ops;

-- ── Operations-only: stores ──────────────────────────────────
-- A location. There is one today; every operational row defaults to it.
create table ops.stores (
  id          text primary key,
  code        text not null unique,
  name        text not null,
  active      boolean not null default true
);

insert into ops.stores (id, code, name, active)
values ('store_main', 'main', 'Main store', true);

-- ── config ───────────────────────────────────────────────────
-- Key/value, read by every module. value is text: the Sheet holds numbers,
-- booleans and dates there too, and each reader parses its own key (a blank
-- value means "use the default", so it is NULL, not '').
create table ops.config (
  key          text primary key,
  value        text,
  description  text
);

-- ── staff ────────────────────────────────────────────────────
create table ops.staff (
  staff_id              text primary key,
  name                  text not null,
  hourly_rate           numeric(10,4),                 -- rate as typed; blank = no rate recorded
  active                boolean not null,              -- Staff.gs: only TRUE is active; blank imports as false
  role                  text not null
                        check (role in ('admin', 'manager', 'employee', 'payroll_admin')),
  companies_authorized  text,                          -- comma list as in the Sheet: 'cstore,vape'
  email                 text,
  start_date            date,
  created_at            timestamptz,
  notes                 text
);

-- ── staff_stores (Operations-only) ───────────────────────────
-- Which store a person works at, with which role, and optionally when.
create table ops.staff_stores (
  staff_store_id  bigint generated always as identity primary key,
  staff_id        text not null references ops.staff (staff_id),
  store_id        text not null references ops.stores (id),
  role            text not null
                  check (role in ('admin', 'manager', 'employee', 'payroll_admin')),
  from_date       date,
  to_date         date,
  constraint staff_stores_dates check (to_date is null or from_date is null or to_date >= from_date),
  constraint staff_stores_once unique nulls not distinct (staff_id, store_id, role, from_date)
);
create index staff_stores_store_idx on ops.staff_stores (store_id);

-- ── sessions (Operations-only) ───────────────────────────────
-- A login. Only a SHA-256 hash of the token is stored, never the token, so a
-- read of this table cannot be replayed as a login.
create table ops.sessions (
  token_hash    bytea primary key check (octet_length(token_hash) = 32),
  staff_id      text not null references ops.staff (staff_id),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz,
  constraint sessions_expiry check (expires_at > created_at)
);
create index sessions_staff_idx on ops.sessions (staff_id);
create index sessions_expires_idx on ops.sessions (expires_at);

-- ── login_failures (Operations-only) ─────────────────────────
-- One row per failed attempt, keyed as Auth.gs keys it: the typed name,
-- trimmed and lower-cased (an unknown name is counted too). Lockout counts
-- rows inside login_lockout_mins; a success deletes that name's rows.
create table ops.login_failures (
  failure_id  bigint generated always as identity primary key,
  name_key    text not null check (name_key = lower(btrim(name_key)) and name_key <> ''),
  failed_at   timestamptz not null default now()
);
create index login_failures_name_idx on ops.login_failures (name_key, failed_at);

-- ── attendance ───────────────────────────────────────────────
-- One person's workday: the payroll source of truth.
create table ops.attendance (
  attendance_id       text primary key,              -- A_<yyyyMMdd>_<staff>, deterministic
  staff_id            text not null references ops.staff (staff_id),
  date                date not null,
  scheduled_start     text,                          -- 'HH:MM' text in the Sheet; blank = not scheduled
  scheduled_end       text,
  actual_start        timestamptz,
  actual_end          timestamptz,
  hours_worked        numeric(6,2),                  -- hours; blank = not computed
  rate_at_attendance  numeric(10,4),                 -- rate snapshotted at close
  status              text not null
                      check (status in ('scheduled', 'in_progress', 'worked', 'cancelled')),
  notes               text,
  created_by          text,
  created_at          timestamptz,
  modified_by         text,
  modified_at         timestamptz,
  hours_basis         text check (hours_basis in ('scheduled', 'actual')),  -- blank = not reviewed
  store_id            text not null default 'store_main' references ops.stores (id)
);
create index attendance_store_date_idx on ops.attendance (store_id, date);
create index attendance_staff_date_idx on ops.attendance (staff_id, date);

-- ── till_sessions ────────────────────────────────────────────
-- One till (cstore or vape), opened and closed by one person on one day.
create table ops.till_sessions (
  session_id             text primary key,           -- CST-/VAP-<yyyyMMdd>-<staff>
  attendance_id          text not null references ops.attendance (attendance_id),
  staff_id               text not null references ops.staff (staff_id),
  company                text not null check (company in ('cstore', 'vape')),
  date                   date not null,
  status                 text not null check (status in ('open', 'closed', 'validated')),
  start_time             timestamptz,
  end_time               timestamptz,
  expected_opening       numeric(12,2),
  opening_float          numeric(12,2),              -- counted at open
  opening_note           text,
  closing_cash_counted   numeric(12,2),
  cash_left_in_till      numeric(12,2),
  cash_removed_at_close  numeric(12,2),
  expected_cash          numeric(12,2),
  closing_variance       numeric(12,2),
  variance_status        text check (variance_status in ('OK', 'minor', 'investigate', 'pending_validation')),
  notes                  text,
  lotto_reserve_counted  numeric(12,2),              -- cstore only; blank elsewhere (ADR-0008)
  lotto_topup_from_till  numeric(12,2),
  lotto_reserve_note     text,
  store_id               text not null default 'store_main' references ops.stores (id)
);
create index till_sessions_store_date_idx on ops.till_sessions (store_id, date);
create index till_sessions_attendance_idx on ops.till_sessions (attendance_id);
create index till_sessions_staff_date_idx on ops.till_sessions (staff_id, date);

-- ── sales ────────────────────────────────────────────────────
-- The tenders for one till session (sales_id = session_id in the Sheet).
-- Card shapes are mutually exclusive columns (ADR-0005): a row fills
-- credit + debit (+ misc credit/debit) OR card total (+ misc card), never
-- both. Card revenue = credit + debit + card_total + the misc three.
create table ops.sales (
  sales_id           text primary key,
  session_id         text not null unique references ops.till_sessions (session_id),
  staff_id           text not null references ops.staff (staff_id),
  company            text not null check (company in ('cstore', 'vape')),
  date               date not null,
  cash_sales         numeric(12,2),                  -- may be negative on cstore (lotto payout)
  credit_card_sales  numeric(12,2),                  -- blank on a single-total till
  debit_card_sales   numeric(12,2),
  cashback_paid      numeric(12,2),
  hst_collected      numeric(12,2),
  bottle_deposit     numeric(12,2),
  round_off          numeric(12,2),
  misc_cash_sales    numeric(12,2),
  misc_credit_sales  numeric(12,2),
  misc_debit_sales   numeric(12,2),
  misc_notes         text,
  card_total_sales   numeric(12,2),                  -- blank on a split till
  misc_card_sales    numeric(12,2),
  store_id           text not null default 'store_main' references ops.stores (id),
  constraint sales_one_card_shape check (
    (credit_card_sales is null and debit_card_sales is null
       and misc_credit_sales is null and misc_debit_sales is null)
    or (card_total_sales is null and misc_card_sales is null))
);
create index sales_store_date_idx on ops.sales (store_id, date);
create index sales_staff_date_idx on ops.sales (staff_id, date);

-- ── validation_results ───────────────────────────────────────
-- One reconciliation of one shift window (Reconcile.gs). Blank = not
-- measured: the Clover columns and the diffs are NULL when Clover was not
-- asked (ADR-0004).
create table ops.validation_results (
  validation_id   text primary key,
  business_date   date not null,
  window_start    timestamptz,
  window_end      timestamptz,
  merchant        text,
  companies       text,                              -- 'cstore+vape' as in the Sheet
  cashier_credit  numeric(12,2),
  clover_credit   numeric(12,2),
  cashier_debit   numeric(12,2),
  clover_debit    numeric(12,2),
  cashier_card    numeric(12,2),
  clover_card     numeric(12,2),
  card_variance   numeric(12,2),
  cash_counted    numeric(12,2),
  cash_variance   numeric(12,2),
  status          text check (status in ('OK', 'investigate', 'clover_unavailable')),
  mode            text check (mode in ('auto', 'manual')),
  session_ids     text,                              -- comma list of till_sessions ids; no FK (see report)
  validated_at    timestamptz,
  validated_by    text,
  cash_sales      numeric(12,2),
  store_id        text not null default 'store_main' references ops.stores (id)
);
create index validation_results_store_date_idx on ops.validation_results (store_id, business_date);

-- ── cash_handovers ───────────────────────────────────────────
-- Cash moving from a cashier to the cash manager. Voided, never deleted.
create table ops.cash_handovers (
  handover_id    text primary key,
  from_staff_id  text not null references ops.staff (staff_id),
  to_staff_id    text not null references ops.staff (staff_id),
  amount         numeric(12,2) not null,
  handed_on      date,
  recorded_by    text not null,                      -- permanent, shown on screen (ADR-0014)
  recorded_at    timestamptz,
  method         text check (method in ('cash', 'bank', 'etransfer', 'other')),
  status         text not null check (status in ('recorded', 'voided')),
  notes          text,
  voided_by      text,
  voided_at      timestamptz,
  store_id       text not null default 'store_main' references ops.stores (id)
);
create index cash_handovers_store_date_idx on ops.cash_handovers (store_id, handed_on);
create index cash_handovers_from_idx on ops.cash_handovers (from_staff_id);
create index cash_handovers_to_idx on ops.cash_handovers (to_staff_id);

-- ── cash_handover_items ──────────────────────────────────────
-- How much of a handover settles which shift, oldest first. Its store is
-- its handover's.
create table ops.cash_handover_items (
  item_id      text primary key,
  handover_id  text not null references ops.cash_handovers (handover_id),
  session_id   text not null references ops.till_sessions (session_id),
  amount       numeric(12,2) not null,
  notes        text
);
create index cash_handover_items_handover_idx on ops.cash_handover_items (handover_id);
create index cash_handover_items_session_idx on ops.cash_handover_items (session_id);

-- ── commission_rules ─────────────────────────────────────────
create table ops.commission_rules (
  rule_id         text primary key,
  name            text not null,
  applies_to      text not null check (applies_to in ('all_staff', 'specific_staff')),
  staff_id        text references ops.staff (staff_id),  -- set only for specific_staff
  company         text not null check (company in ('cstore', 'vape')),
  threshold       numeric(12,2),                     -- weekly sales threshold, dollars
  percentage      numeric(7,4) check (percentage between 0 and 100),
  active          boolean not null,                  -- CommissionRules.gs: only TRUE is active
  effective_from  date,
  effective_to    date,
  created_by      text,
  created_at      timestamptz,
  notes           text,
  rule_type       text not null default 'percentage' -- a blank cell has always meant percentage
                  check (rule_type in ('percentage', 'fixed')),
  fixed_amount    numeric(12,2),                     -- blank on rules older than ADR-0013
  store_id        text not null default 'store_main' references ops.stores (id),
  constraint commission_rules_staff check (applies_to <> 'specific_staff' or staff_id is not null)
);
create index commission_rules_staff_idx on ops.commission_rules (staff_id);
create index commission_rules_store_idx on ops.commission_rules (store_id, company);

-- ── commission_runs ──────────────────────────────────────────
create table ops.commission_runs (
  run_id                   text primary key,
  week_start               date,
  week_end                 date,                     -- the Sheet holds Sunday 23:59:59; its Toronto date
  staff_count              integer,
  bonuses_created          integer,
  total_commission_amount  numeric(12,2),
  computed_at              timestamptz,
  computed_by              text,                     -- staff id or 'SYSTEM_TRIGGER'
  notes                    text,
  store_id                 text not null default 'store_main' references ops.stores (id)
);
create index commission_runs_store_week_idx on ops.commission_runs (store_id, week_start);

-- ── bonuses ──────────────────────────────────────────────────
-- A bonus, commission or fee owed. The engine only proposes (ADR-0011).
create table ops.bonuses (
  bonus_id        text primary key,
  staff_id        text not null references ops.staff (staff_id),
  date            date not null,
  type            text not null
                  check (type in ('bonus', 'commission', 'incentive', 'deduction', 'tip', 'adjustment')),
  amount          numeric(12,2) not null,
  reason          text,
  status          text not null check (status in ('proposed', 'pending', 'paid', 'cancelled')),
  period_start    date,
  period_end      date,
  company         text check (company in ('cstore', 'vape')),   -- blank allowed (Setup.gs)
  -- The engine writes its bonuses before its run row, so this one is checked
  -- at commit.
  source_run_id   text references ops.commission_runs (run_id) deferrable initially deferred,
  created_by      text,
  created_at      timestamptz,
  notes           text,
  source_rule_id  text references ops.commission_rules (rule_id),  -- ADR-0013
  store_id        text not null default 'store_main' references ops.stores (id)
);
create index bonuses_store_date_idx on ops.bonuses (store_id, date);
create index bonuses_staff_period_idx on ops.bonuses (staff_id, period_start);
create index bonuses_status_idx on ops.bonuses (status);
create index bonuses_run_idx on ops.bonuses (source_run_id);
create index bonuses_rule_idx on ops.bonuses (source_rule_id);

-- ── payments ─────────────────────────────────────────────────
-- Money paid to one person on one occasion.
create table ops.payments (
  payment_id    text primary key,
  staff_id      text not null references ops.staff (staff_id),
  paid_on       date not null,
  total_amount  numeric(12,2) not null,
  method        text not null check (method in ('cash', 'bank', 'etransfer', 'other')),
  recorded_by   text,
  notes         text,
  store_id      text not null default 'store_main' references ops.stores (id)
);
create index payments_store_date_idx on ops.payments (store_id, paid_on);
create index payments_staff_date_idx on ops.payments (staff_id, paid_on);

-- ── payment_items ────────────────────────────────────────────
-- How much of a payment went to which shift or bonus. ref_id is an
-- attendance_id (item_type 'shift') or a bonus_id ('bonus'): one column for
-- two parents, so no foreign key; Payments checks it. Its store is its
-- payment's.
create table ops.payment_items (
  item_id     text primary key,
  payment_id  text not null references ops.payments (payment_id),
  item_type   text not null check (item_type in ('shift', 'bonus')),
  ref_id      text not null,
  amount      numeric(12,2) not null,
  notes       text
);
create index payment_items_payment_idx on ops.payment_items (payment_id);
create index payment_items_ref_idx on ops.payment_items (item_type, ref_id);

-- ── audit_log ────────────────────────────────────────────────
-- One change: who, what, before, after. Append-only (ADR-0014). before and
-- after stay text: the Sheet holds JSON.stringify output, and jsonb would
-- reorder keys, so the copy would no longer be byte-for-byte.
create table ops.audit_log (
  log_id       text primary key,
  "timestamp"  timestamptz not null default now(),
  actor_id     text,                                 -- staff id or 'SYSTEM'; no FK
  action       text not null,
  target_type  text,
  target_id    text,
  "before"     text,
  "after"      text,
  details      text
);
create index audit_log_timestamp_idx on ops.audit_log ("timestamp");
create index audit_log_target_idx on ops.audit_log (target_type, target_id);
create index audit_log_actor_idx on ops.audit_log (actor_id, "timestamp");

-- ── Grants: the exceptions to roles.sql's defaults ───────────
-- audit_log: the app may add and read rows, never change or remove them.
-- The owner role (migrations) is trusted; the app role is not.
revoke update, delete on ops.audit_log from ops_app;

-- A session or a failed-login row is disposable: logout, expiry and a
-- successful login remove them. Nothing else may be deleted by the app.
grant delete on ops.sessions to ops_app;
grant delete on ops.login_failures to ops_app;
