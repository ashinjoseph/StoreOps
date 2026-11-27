-- P5-11: the MCP door for AI assistants (docs/adr/0025-assistants-come-in-through-mcp-and-only-propose.md).
-- Two Operations-only tables; no Sheet tab feeds them and the cutover tools neither load nor compare them.
--
-- assistant_keys: one key per person per assistant. The key itself is never stored: only the SHA-256 of
-- the whole key ("ops_<key_id>_<secret>"), as ops.sessions stores a token's hash, so a copy of the table
-- cannot be replayed. A key is never deleted: it is withdrawn (withdrawn_*), or it expires.
create table ops.assistant_keys (
  key_id            text primary key check (key_id ~ '^ak[0-9a-f]{16}$'),
  staff_id          text not null references ops.staff (staff_id),
  label             text not null check (label <> ''),
  key_right         text not null check (key_right in ('read', 'propose')),   -- propose includes read
  personal_details  boolean not null default false,                         -- may later tools show customers' details
  key_hash          bytea not null unique check (octet_length(key_hash) = 32),
  created_by        text not null,                                          -- staff id; no FK, like the other actor columns
  created_at        timestamptz not null,
  expires_at        timestamptz not null,
  withdrawn_by      text,
  withdrawn_at      timestamptz,
  withdrawn_reason  text,
  last_used_at      timestamptz,
  constraint assistant_keys_expiry check (expires_at > created_at),
  constraint assistant_keys_withdrawn check (
    (withdrawn_at is null) = (withdrawn_by is null) and (withdrawn_at is null) = (withdrawn_reason is null)
  )
);
create index assistant_keys_staff_idx on ops.assistant_keys (staff_id);

comment on table ops.assistant_keys is 'Keys an AI assistant uses at /mcp. Only a SHA-256 of each key is kept. Withdrawn, never deleted.';
comment on column ops.assistant_keys.key_hash is 'sha256 of the whole key text; the key is shown once, when made, and never stored';

-- assistant_calls: one row per call at the door, allowed or refused: which key (none when the key was
-- missing or unknown), which tool, when, the reason for a refusal, how long it took, and a SHA-256 of
-- the caller's address (for the bad-key flood limit). Never the arguments, never the answer.
-- Append-only: the app may add and read rows, never change or remove them.
create table ops.assistant_calls (
  seq          bigint generated always as identity primary key,
  key_id       text references ops.assistant_keys (key_id),
  tool         text not null check (char_length(tool) <= 100),
  at           timestamptz not null,
  allowed      boolean not null,
  refusal      text check (refusal in ('bad_key', 'expired', 'withdrawn', 'person_inactive', 'no_right', 'rate_limited', 'unknown_tool', 'bad_input', 'failed')),
  took_ms      integer check (took_ms >= 0),
  proposal     boolean not null default false,
  caller_hash  bytea check (caller_hash is null or octet_length(caller_hash) = 32),
  constraint assistant_calls_refusal check ((allowed and refusal is null) or (not allowed and refusal is not null))
);
-- The per-minute count (rule: calls per key per minute) and the per-day proposal count.
create index assistant_calls_key_at_idx on ops.assistant_calls (key_id, at);
create index assistant_calls_proposals_idx on ops.assistant_calls (key_id, at) where proposal and allowed;
-- The bad-key flood limit: refused sign-ins per caller address, and in total, per minute.
create index assistant_calls_flood_idx on ops.assistant_calls (caller_hash, at) where refusal in ('bad_key', 'expired', 'withdrawn', 'person_inactive');
create index assistant_calls_flood_total_idx on ops.assistant_calls (at) where refusal in ('bad_key', 'expired', 'withdrawn', 'person_inactive');

comment on table ops.assistant_calls is 'Every call at /mcp, allowed or refused. No arguments, no answers. Append-only.';

-- ── Grants: the exceptions to roles.sql's defaults ───────────
-- assistant_calls: insert and select only, like audit_log.
revoke update, delete on ops.assistant_calls from ops_app;
-- assistant_keys: a key's person, label, right and hash never change after it is made; the app may
-- only mark it used or withdrawn.
revoke update on ops.assistant_keys from ops_app;
grant update (last_used_at, withdrawn_by, withdrawn_at, withdrawn_reason) on ops.assistant_keys to ops_app;
