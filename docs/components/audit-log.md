# Audit log

> An admin reads who did what, newest first, on a screen, where it used to be
> scrolling the Sheet's `audit_log` tab.

<!-- No screenshot: this screen exists only in the Operations app (ADR-0023),
     and the docs runtime (scripts/docs/runtime.js) runs the Apps Script server,
     which has no rpcGetAuditLog. Nothing in scripts/docs/screens.js can render it. -->

## What it does

**More → Audit log** (admins only, and only in the Operations app: inside Apps
Script the entry is hidden, because the Sheet is still the place to read the
tab). Every write that matters adds a row to `ops.audit_log`: who, what, which
record, and what it held before and after. The Operations app writes more of
them than the old app did (corrections with reasons, staff changes, raises,
assistant keys, a skipped Monday run). Until this screen, nobody could read them.

- **Filters on top:** a person (or *System*), a kind of action (one action, or
  a whole group such as *All of staff.\**), and a day. The lists come from the
  newest 20,000 rows. A filter change asks from the top.
- **The rows**, newest first: the time (Toronto), who, the action in plain words
  (*corrected a till*, *changed a setting*, *set a PIN*; an action the page has
  no words for is shown as it is), the record it was about, and the reason or
  details when there is one.
- **Tap a row** to open a sheet: the action, the record, the reason, and the
  *before* and *after* side by side as readable key/value lines, with a mark
  (●) on every line that changed. A key that is missing on one side shows a
  dash; a blank shows the word *blank*, never a zero. Everything shown goes
  through `esc()`: a row may hold text a person typed.
- **Older** loads the next page; there is no page number. **Refresh** (and the
  header ↻) reads again. A read is cached for a minute, no longer.

**Reading the log is not itself logged.** That is deliberate: a log that wrote
a row each time it was read would be read by the next reader, and the page
would grow under the person looking at it.

## How it works

```mermaid
sequenceDiagram
    actor A as Admin
    participant UI as Index.html (Audit log)
    participant R as Router
    participant M as modules/audit-view.ts
    participant DB as ops.audit_log
    A->>UI: open the screen / filter / Older
    UI->>R: rpcGetAuditLog(token, { actorId, action, day, before, limit })
    R->>R: admin only (contract), session from the token
    R->>M: page (a select; no lock)
    M->>M: refuse a filter of the wrong shape
    M->>DB: select ... where (filters, all parameters) order by seq desc limit n+1
    M->>M: mask phone numbers, hide secret-looking keys
    M-->>UI: { rows, nextBefore, total: null, actions, actors }
```

**Order and paging.** Newest first by `seq` (the order the database numbered
the rows in, migration 0004), never by time: the rows of one change are written
in one transaction and share a time. `before` is the `seq` of the last row of
the previous page; the next page is the rows with a smaller one, so a row
written between two page reads never shifts a page (there is no `offset`). A
page is at most 100 rows (default 50); one more is read to know whether there
is a next page. `nextBefore` is null at the end. `total` is always null: the
table has no end, and a count would read all of it.

**Filters**, all optional, joined with AND, every value a SQL parameter:

| Filter | Rule |
|---|---|
| `actorId` | a staff id, or `SYSTEM`; text, 200 characters at most |
| `action` | exactly this action, or a prefix when it ends in `.` (`staff.`). Lower-case letters, digits, `_` and `.`, 60 characters at most; anything else is refused with a message, never run or interpolated. A prefix is compared with `starts_with`, so `_` is a letter, not a pattern |
| `targetType`, `targetId` | exact; text |
| `day` | a real `yyyy-mm-dd` (`2026-02-30` is refused). The **Toronto** day the row was written: the day's two instants (23 or 25 hours long on the two clock-change days) are compared with the row's time |
| `before`, `limit` | paging, above |

**Each row** is answered as `{ seq, at (ISO), actorId, actorName, action,
targetType, targetId, before, after, details }`. `actorName` is the staff name,
*System* for `SYSTEM`, *System (Monday run)* for `SYSTEM_TRIGGER`, and the id
itself when the person is not on the staff list. `before` and `after` are the
stored JSON (or null; text that is not JSON, from an old row, comes back as
text); `details` is text. The answer also carries `actions` (the distinct
actions in the newest 20,000 rows, sorted) and `actors` (`{ id, name }` of who
appears there), one query each, for the filter controls.

### Masking, on the way out

The stored rows are never changed; only the answer is masked.

| What | Rule |
|---|---|
| **A phone number** in any text of a row (a string value of `before` or `after`, `details`, the target id) | a run of 8 to 15 digits, optionally with a leading `+` and up to two spaces, dashes or brackets between digits, is shown as `•` for all but its last four digits (`•••••••0199`), the shape the [Settings](settings.md) card gives a recipient. Also `416.555.0199` |
| **A secret-looking key** | any object key matching `/pin\|hash\|token\|secret\|password\|key$/i` has its value replaced by `"[hidden]"`, whatever it holds except a plain yes/no, at any depth, in objects and arrays. No writer puts such a value in a row (see below); this is the second line of defence. A yes/no value under such a key (the flag `hasPin`) is shown: it says whether a secret exists, not what it is |
| **Email addresses, pay rates** | shown as they are: an admin already sees both on the Staff screen, and "who changed whose rate" is what the log is for |
| **Names, reasons, notes** | shown as they are (they are free text a person typed; a phone number inside them is masked by the first rule) |

**How a phone number is told from an id or an amount.** The log is full of
digits that are not phone numbers, so a run is a phone number only when what
is around it says so:

- an **id** has a letter or an underscore beside its digits (`PAY_20261120_ab1`,
  `A_20261120_S_001`, `CST-20261120-S_003`, `S_001`, a hex hash): the character
  before and after the run must not be a letter, a digit or `_` (nor a letter
  on the far side of a dash);
- an **amount** has a decimal point (`1234567.89`, `0.12345678`, `$12.50`): a
  run touching a `.` with a digit beyond it is left alone. Amounts here are
  under a million, so a whole amount never has 8 digits. Numbers that are JSON
  numbers (not text) are never touched at all;
- a **date** (`2026-11-20`, with or without a time) is set aside before the
  phone rule looks at the text, so `2026-11-20 14:30` is not "ten digits with
  separators"; a bare date stamp `20261120` is left alone;
- a **business number** `123456789 RT0001` is left alone;
- the target id of a `session` row is a few characters of a sign-in token and
  is not looked at.

A run of fewer than 8 or more than 15 digits is not a phone number. (So a card
number of 16 digits is not masked; no writer records one.)

## The actions found

From every `audit.write` and `audit.writeMany` in `ops/src`, grouped. "Holds"
says what the row can contain that is personal or secret.

| Group | Actions | What a row holds |
|---|---|---|
| **Sign-in** | `login.success`, `login.fail`, `login.logout` | `details` is a code (`session created`, `wrong_code`, `unknown_name`, `inactive`, `rate_limited: Nmin`). A `login.fail` for an unknown name has the **name that was typed** as its target id: a person could type a phone number there (masked) or a PIN (4 digits: **not** recognised as a number; a typed PIN could show). `login.logout` holds the first 8 characters of the session token, as the old app did, and nothing else. Never the PIN or its hash |
| **Settings** | `config.update` | `{ value }` before and after. The recipients setting holds each number already masked and a count. Never a secret (secrets are not settings) |
| **Staff** | `staff.create`, `staff.update`, `staff.rate_applied`, `staff.pin_set` | name, role, companies, **hourly rate**, start date, **email**, **notes**, created time, and `hasPin` (a flag, never the hash); the reason a rate or role changed in `details`. `staff.rate_applied` lists the days re-rated with the old rate. `staff.pin_set` holds nothing but who set it (the PIN and its hash are never written) |
| **Till** | `till.open`, `till.close`, `till.edit`, `till.correct`, `till.enter_missed` | figures, counts and ids; the **reason** for a correction or a missed shift in `details`; a till's free-text notes |
| **Sales** | `sales.create`, `sales.update` | the cash and card figures of a till |
| **Reconcile** | `reconcile.day`, `reconcile.past_day` | verdicts and figures; `reconcile.day` `details` holds the **WhatsApp message text** (takings, names) and how each send went (a Meta error text may follow) |
| **Cash** | `cash.handover`, `cash.handover.void` | who handed what to whom, the amount, free-text notes |
| **Payroll** | `payment.shifts`, `payment.bonus`, `payment.undo`, `payment.allocation_error` | the person's id, **amounts**, attendance ids |
| **Bonuses and commissions** | `bonus.created`, `bonus.proposed`, `bonus.approved`, `bonus.cancelled`, `bonus.paid`, `bonus.reverted`, `commission.run`, `commissions.run_skipped`, `commission.trigger_error`, `commission_rule.create`, `commission_rule.update` | **amounts**, week dates, the bonus reason (100 characters), a cancel reason, a rule's name and percentages. `commission.trigger_error` holds the error message of a failed run |
| **Schedule** | `attendance.schedule`, `attendance.schedule_update`, `attendance.cancel`, `attendance.edit_times`, `attendance.adjust_hours`, `attendance.correct`, `attendance.open`, `attendance.promote`, `attendance.complete` | times, hours, the day's **rate**, a cancel note, the correction **reason** |
| **Notices** | `notify.<event>` (`shift.opened`, `shift.closed`, `payment.recorded`, `commission.computed`, …) and `notify.shift_open_failed` | a one-line summary with a name and amounts. `notify.shift_open_failed` holds **the full recipient number** and Meta's error text (masked on the way out) |
| **Assistants** | `assistant_key.create`, `assistant_key.revoke` | the person, the key's label, its right, whether it may see personal details, its expiry, and a revoke reason. **No key**: the key itself is shown once and only its hash is stored, in `assistant_keys`, not here |

Found, and how each is treated: **phone numbers** (the recipients setting is
already masked at write time; `notify.shift_open_failed` stores a recipient in
full, and an old row imported from the Sheet may hold any number: all are
masked on the way out), **emails** (`staff.*`; shown), **pay rates** (`staff.*`,
`attendance.*`; shown), **PINs and hashes** (none: confirmed for `staff.pin_set`,
`login.*`, `staff.create`, `staff.update`, whose `stored()` shape carries
`hasPin`, never `pin_hash`; hidden anyway if one appeared), **assistant keys**
(none: confirmed for `assistant_key.create` and `.revoke`), and **free text**
(reasons, notes, a typed login name, a WhatsApp message: shown, with any
phone number inside masked).

## Growth, and what would need an index

The log only grows (the app's database role can add and read a row, never
change or remove one). From the writers: two rows per sign-in and sign-out, one
or more per till open, close, correction and reconcile, one per payment, bonus,
setting or staff change, and one per commission line each Monday. A two-till
store is on the order of tens of rows a day, so tens of thousands a year, some
of them several kilobytes (a till correction holds the whole session and sales
row twice).

| Question | Index it uses |
|---|---|
| The newest page, and `before` | `audit_log_seq_idx` (unique): a backward scan of `seq`, stopping after the page |
| A person | `audit_log_actor_idx (actor_id, timestamp)` finds their rows, but the order wanted is `seq`: the planner either sorts a person's rows or walks `seq` backward and filters. Cheap for a busy person, a long walk for one with few rows in a long log |
| A record | `audit_log_target_idx (target_type, target_id)` |
| A day | `audit_log_timestamp_idx`: the day's two instants bound the scan; the day's rows are then sorted by `seq` |
| An action | **none**: a backward walk of `seq`, filtering. Fast for a common action, a walk of the whole table for a rare one |
| The lists of actions and people | `audit_log_seq_idx`: the newest 20,000 rows only, one `distinct` each |

Up to some hundreds of thousands of rows this is fast enough. Past that, the
two indexes worth adding (this card adds none) are `(action, seq desc)` and
`(actor_id, seq desc)`, which let a filtered page stop early too.

## Rules it must not break

- **Only an admin.** The router applies the contract's `roles`, the handler
  checks again, and identity comes from the session: a `role` or `actorId` in
  the input is only ever a filter.
- **Read only.** The module contains no statement that writes and takes no
  lock; a test reads its source. Reading is not logged.
- **Never change or remove a row.** The app role cannot; this module does not
  try. A stored row is byte-identical after any number of reads.
- **Order by `seq`, never by time.**
- **No SQL from the input.** Every filter value is a parameter; an action is
  checked for its shape first.
- **Mask on the way out, not in the table.** Phone numbers by their last four
  digits, secret-looking keys hidden; ids, amounts and dates not mangled.
- **Every value on the page goes through `esc()`.**
- **Blank is not zero** ([ADR-0004](../adr/0004-blank-is-not-zero.md)): a blank
  before or after is shown as *blank*.

## Code map

| What | Where |
|---|---|
| Module | `ops/src/modules/audit-view.ts`: `page`, `maskText`, `maskValue` |
| RPC | `ops/src/rpc/handlers/audit-view.ts`: `rpcGetAuditLog`; listed in `ops/contracts/rpc-ops.json` |
| UI | `src/Index.html`: `loadAuditLogTab`, `renderAuditTab`, `auditRowHTML_`, `auditSheetHTML_`, `auditDiff_`, `loadOlderAudit_`; the `audit` entry of `MORE_ITEMS` (`opsOnly`) |
| What it reads | `ops/src/lib/audit.ts` (the writer, not changed), `ops.audit_log`, `ops.staff` (names) |

## Tests

| Suite | Holds down |
|---|---|
| `ops/test/audit-view.test.ts` | who may call (admin; manager, payroll admin, employee, no token refused through the real router; a planted role changes nothing; the handler's own check), paging (150 rows in three pages, none twice or missed, rows arriving between page reads do not shift the next page, `seq` order when times are equal), each filter alone and combined (both clock-change days), every refusal with a message and no SQL text, hostile `action` values never run and text filters matched literally, every value a parameter, the masking tables (phones in many spellings masked; ids, amounts, dates, business numbers, hashes not touched; a realistic payload of every kind of action unchanged; planted `pinHash`, `token`, `apiKey` hidden at any depth), the stored rows unchanged by any read, the module's source having no write, the story of a till corrected twice and a rate changed, `actions` and `actors` |
| `tests/suites/ui-audit-log.js` | the entry is `opsOnly` and admin only; hostile text is escaped in the list, the sheet and the filters; changed keys are marked, a missing key is a dash and a blank is *blank*; Older uses `nextBefore`; the Commissions line; the built page carries the screen and Apps Script hides it |

## History

- **Nov 2026 (card P4-13):** the Audit log screen and `rpcGetAuditLog`: an
  admin can read the log in the Operations app. A new call and screen only the
  Operations app has ([ADR-0023](../adr/0023-the-operations-app-has-rpcs-and-screens-of-its-own.md)).
