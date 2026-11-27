# Backups: the nightly copy and the restore

> Every night the app writes every table to dated files in its own bucket, and
> a tool on the owner's computer can load any of those copies into an empty
> database and prove that every table came back.

<!-- No screenshot: the line lives on the Settings screen of the Operations app (ADR-0023),
     and the docs runtime (scripts/docs/runtime.js) runs the Apps Script server, which has
     no rpcGetSettings. Nothing in scripts/docs/screens.js can render it. -->

## What it does

The Sheet's version history was the safety net: "go back to how things were
yesterday". The Operations app's hosted database has **no automatic backups**,
so the app makes its own:

- **Every night at 03:00 Toronto time** the app writes a copy of every table to
  the `BACKUPS` bucket, in a folder named for the Toronto day
  (`nightly/2026-11-27/`). Nobody has to do anything.
- **"Make a copy now"** on **More → Settings** (admins only) does the same
  thing at once, for example before something risky. A second copy the same
  day goes to a new folder (`nightly/2026-11-27-151530/`); nothing is
  overwritten.
- **One line at the top of Settings** says how the copies are going (below).
  No message is sent anywhere: a warning is a line on a screen an admin looks
  at.
- **A restore tool** (`npm --prefix ops run restore:nightly -- <folder>`) loads a
  copy into an empty database on the owner's computer, checks it, and ends
  with one line saying whether every table matches. The step-by-step guide is
  [restore a nightly copy](../guides/restore-a-nightly-copy.md).

### The line on Settings

| It says | It means | Colour |
|---|---|---|
| `Last copy: 2026-11-27 03:00:12, 24 tables, 2268 rows` | The newest run was good and is less than 36 hours old. The time is Toronto time. | green |
| `Last copy: no copy yet. …` | No copy has been made and none has failed. Normal until the first night; press the button. | amber, with a warning sign |
| `The newest good copy is more than 36 hours old (…)` | A night was missed. Press "Make a copy now" and look at the [audit log](audit-log.md) for `backup.failed`. | amber |
| `The last copy failed on …: <reason>. The newest good copy is from …` | The newest run failed (a good one after it clears this). The reason names what failed, never a row. | amber |

36 hours: a nightly copy is never more than about a day old; a day and a half
means a night was missed.

## How it works

```mermaid
sequenceDiagram
    participant C as Cron 07:00 / 08:00 UTC<br/>or "Make a copy now"
    participant N as backup/nightly.ts
    participant P as Postgres
    participant R as R2 BACKUPS
    C->>N: due? (03:00 in Toronto) / admin
    N->>P: begin; set transaction repeatable read, read only; try the advisory lock
    loop each table, from the catalogue
        N->>P: declare cursor … order by seq / primary key; fetch 200 at a time
        N->>R: put <table>.NNNN.ndjson (a part: ≤ 5,000 rows or ~2 MB)
    end
    N->>R: put manifest.json (LAST)
    N->>P: commit
    N->>P: begin; insert one audit row (backup.nightly); commit
```

**One consistent picture.** The whole copy is read inside a single read-only,
repeatable-read transaction, so every table is as of the same instant, however
long the copy takes and whatever the store commits meanwhile (a till close that
lands in the middle is in the copy completely or not at all; a test pins it).
It takes no lock that blocks the store; the one advisory lock it takes is a
private key that makes copies run one at a time (a second request while one
runs is refused: "A copy is already being made…").

**Every table, found at run time.** The tables are read from the catalogue, so
a table a later migration adds is copied with no change to the code. The
exceptions are a short list in `ops/src/backup/snapshot.ts`, each with its
reason:

| Not copied | Why |
|---|---|
| `sessions` | Live sign-ins last hours; a restored copy would revive sign-ins nobody means to keep. People sign in again with their PIN. |
| `login_failures` | Counts of recent wrong PINs; a restore starts with nobody locked out. |
| `receipt_upload_tickets` | One-time tickets for an assistant's upload that last minutes. |
| `assistant_calls` | The record of assistant calls (no arguments, no answers): large, and it starts again as assistants call. |
| `schema_migrations` | The migration tool's own bookkeeping. A restore needs a database that tool has just made (it keeps its own rows); the manifest records the newest migration instead, and the restore refuses a database whose newest migration is older. |

Everything else is copied, **including the hashes of PINs (`staff.pin_hash`)
and of assistants' keys (`assistant_keys.key_hash`)**: a restore must let
people sign in again, and a hash is not the secret. A test fails if a table
exists that is neither copied nor on this list, and if a copied table has a
foreign key to an excluded one (a restore of that copy could not load).

**Receipt originals are not in the copy.** The photos and PDFs live in their
own bucket (`RECEIPTS`, under a retention lock,
[ADR-0026](../adr/0026-receipt-originals-are-kept-as-received.md)). The copy
holds their records (`receipt_originals`: the hash, the size, the key, who and
when), not the files.

### The format

One folder per copy, in the `BACKUPS` bucket:

```
nightly/2026-11-27/
  audit_log.0001.ndjson     one table, one part (more rows → .0002, .0003 …)
  sales.0001.ndjson
  staff.0001.ndjson
  …                         (a table with no rows has no file)
  manifest.json             written LAST
```

A **file** is newline-delimited JSON: one row per line, one JSON object per
row, the keys in the table's column order. Every value is exact:

| Column type | In a file |
|---|---|
| text | a JSON string (newlines, quotes, backslashes, tabs, U+2028 and U+2029 escaped, so it is always one line) |
| `numeric` (money, hours, rates) | a JSON **string**, as the database prints it: `"12.50"`, `"17.6000"`, `"-3.25"`. Never a number. |
| `bigint` (identity columns such as `seq`) | a JSON string of digits (a number past 2^53 would lose digits in JavaScript) |
| `integer` | a JSON number |
| `boolean` | `true` / `false` |
| `date` | `"2026-03-08"` |
| `timestamptz` | `"2026-03-08T05:00:00.000000Z"`: UTC, six decimals (the database's own precision) |
| `bytea` | `{"$hex":"0a0b…"}` |
| `json` / `jsonb` | the JSON value itself (a JSON `null`, or an object with the key `$json`, is wrapped as `{"$json":…}` so it can never be read as SQL NULL) |
| NULL | `null`: never `""`, never `"null"` (those are texts) |

Rows are in a stable order: `seq` where the table has one (the order rows were
written in), otherwise the primary key (text keys with the `C` collation, so the
order is the same on every server). A table with neither makes the copy fail
loudly instead of copying in an unstable order.

**Parts.** A large table is written in parts of at most **5,000 rows**, and a
part is closed at the first row end after it reaches **2 MB**. The bound exists
so that what the Worker holds in memory at once is one part, never a table: it
reads from a server-side cursor 200 rows at a time and writes each part to R2
as soon as it is full. A part is always written as a whole buffer, so its length
is known (R2 needs the length of anything that is not a string or buffer).

**The manifest** (`manifest.json`) is the last object written. A folder without
one is an incomplete copy, and the restore refuses it. It holds: the format
(`storeops-nightly-copy/1`), the folder, the Toronto business day, the instant
of the snapshot, the newest migration applied (number, name, checksum), the part
limits, the exceptions with their reasons, then **for each file** its table,
part number, row count, byte length and SHA-256, and **for each table** its
columns (name, type, kind), its row count and its totals: the row count, the
exact sum of every money and whole-number column (in cents, never as floating
point; pay rates left out, as the cutover leaves them out) and the same per month
in Toronto time. They are the cutover reconcile's own measures
(`ops/src/cutover/compare.ts`), so the restore compares like with like.

The manifest holds money sums: it is as private as the files.

### Never deleted, never overwritten

The storage interface (`ops/src/backup/storage.ts`) has `put` (a new key only:
R2 is asked to refuse a key that exists) and `anyUnder`. There is no delete, no
overwrite and no read. A test fails if the word "delete" appears under
`ops/src/backup/`. A folder that already holds anything is never written into
again: a second copy the same day goes to `nightly/<day>-<HHmmss>`, and a copy
that failed part-way leaves its folder (files, no manifest) where it is.

**Keeping only 90 days is a lifecycle rule on the bucket, not code in the
app.** The app only ever adds. Where the bucket is made, add a rule that
deletes objects 90 days after they are written (below). The copies go to their
own bucket so that the receipts bucket's permanent retention and this one's 90
days never meet.

### When it runs

`wrangler.toml` schedules the Worker at `0 7 * * *` and `0 8 * * *` (UTC). Toronto
is UTC−4 in summer and UTC−5 in winter, so **03:00 in Toronto is 07:00 UTC in
summer time and 08:00 UTC in winter time**. Both fire every day and the job runs
only the one that is 03:00 in Toronto (the same pattern as the Monday commission
run's 13:00 and 14:00). Exactly one of the two counts every day of the year: on
the spring clock-change day (the second Sunday of March, 02:00 jumps to 03:00)
07:00Z is 03:00 EDT; on the autumn day (the first Sunday of November, 02:00 repeats)
08:00Z is 03:00 EST; 03:00 is never skipped or repeated. A test walks every day of
two years. A firing that is not 03:00 does nothing and opens no connection.

The firing is told from the Monday commission cron by its cron expression; each is
an independent job. The copy never throws out of the scheduled handler (a failure
is audited and logged, and the Settings line shows it), so it cannot stop the
Monday run; `runWeeklyCommissions` is unchanged.

### What it writes in the audit log

One row per run, `target_type = backup`:

| Action | When | Holds |
|---|---|---|
| `backup.nightly` | a good copy | the folder, tables, rows, bytes, files, seconds |
| `backup.failed` | a run that did not finish | what failed (`the bucket refused nightly/…/sales.0001.ndjson: Error (10001)`, `database error (…)`, `the Worker has no BACKUPS bucket bound…`), never a row's content |

The actor is `SYSTEM` for the cron and the admin's staff id for the button. A
request refused because a copy is already running is not a failure and writes
nothing.

## What the hosted setup must do

1. **Create the bucket:** `npx wrangler r2 bucket create storeops-backups`. The
   binding `BACKUPS` is declared in `ops/wrangler.toml`.
2. **Add the 90-day rule:** `npx wrangler r2 bucket lifecycle add storeops-backups keep-90-days --expire-days 90`
   (or in the dashboard: R2, `storeops-backups`, Settings, Object lifecycle
   rules). Without it the copies pile up (a few MB a night): nothing in the app
   removes them.
3. **Keep it private,** with no public address and no API token shared with
   anything that does not need it.
4. **Check the pooler.** The copy is one read transaction held open for the whole
   copy. The plan reaches Postgres through the connection pooler via Hyperdrive;
   the hosted rehearsal must show the transaction holds for the time a copy
   takes (see the open questions below), and that
   `idle_in_transaction_session_timeout` on the database is longer than the
   gap between one table's last read and the next table's first (a few
   seconds).
5. **Run it once and restore it,** as the guide says, before the switch.

## What a full recovery needs

The copy is the **tables**. A full recovery after losing the hosted setup also
needs, from their own places:

| Needs | From | Why |
|---|---|---|
| **The receipt files** (photos, PDFs) | the `RECEIPTS` bucket (under its retention lock) | the copy holds their records, not the files |
| **`PIN_PEPPER`** | wherever the owner keeps the Worker's secrets | the PIN hashes in `staff` are made with it; without the same value nobody can sign in, and every PIN must be set again |
| **The other secrets** (`WHATSAPP_API_TOKEN`, `CLOVER_CSTORE_TOKEN`, `CLOVER_VAPE_TOKEN`, `TILL_API_KEY`) | their providers | they live only as Worker secrets, never in the database |
| **Assistants' keys** | the people who hold them | only a hash of each key is stored (copied), the key text is not; if a key is lost, make a new one |
| **The Cloudflare setup** (Worker, Hyperdrive config, both R2 bindings, the cron lines, the assets) | `ops/wrangler.toml` and the dashboard | none of it is in the database |
| **A migrated, empty database** | the repository: `ops/contracts/roles.sql`, then `npm --prefix ops run db:migrate` | the restore loads into one; the copy has no schema |
| **The app at the copy's version** (or newer) | the repository | the restore refuses a database whose migrations are older than the copy's |
| **Settings** | inside the copy (`config`) | nothing extra: they are a table |

Loading a copy into a **hosted** database uses the same tool and a flag whose
name says what it is (`--yes-load-into-a-database-that-is-not-on-this-computer`).
That path has not been rehearsed; it belongs to the hosted rehearsal.

## Size and time

On the fictional fixture (22 tables copied, 2,269 rows, about 120 days of two
tills) a copy is **about 0.9 MB in 17 files**, and takes **about 0.1 s** against
a local database. The first rehearsal loaded about 10,000 rows, most of them
audit log: that is about **4 MB** at the same shape. Adding 100,000 synthetic audit
rows to the fixture makes a copy of **about 35 MB in 37 files**, taking about 1 s
of wall time and about 1.1 s of CPU on a local database, with no part larger than
about 1.7 MB. R2 on a real network adds a round trip per put and per fetch: tens
of puts and a few hundred fetches for a store this size. These are measurements on
a laptop, not on a Worker.

**Open questions for the hosted rehearsal.** What a scheduled Worker may use is
stated here from Cloudflare's documentation as it was last read and was *not
verified in this repository*: a cron-triggered Worker may run for up to about 15
minutes of wall time with a CPU limit of 30 seconds by default (configurable up to
5 minutes with `limits.cpu_ms`), in 128 MB of memory, with a cap on subrequests per
invocation (R2 and database calls count). A copy of this store is far inside all of
them, but the rehearsal should confirm, with the real Hyperdrive and R2: the wall
time of a copy; that the repeatable-read transaction survives the pooler for that
long; that the subrequest count is under the plan's limit; and that "Make a copy
now" (which holds one HTTP request open for the whole copy) finishes inside a
request's limits.

## Rules it must not break

- **One consistent picture.** The copy is read in one read-only, repeatable-read
  transaction; no table is read in a transaction of its own. A test commits a till
  close in the middle and finds none of it in the files.
- **Every table, found at run time**, with exceptions only in the written list. A
  test compares the catalogue with the manifest and the list.
- **The manifest is written last.** A failure at any file leaves none; the restore
  refuses a folder without one.
- **Money is a string, never a float; NULL is `null`**, never `""` or `0`
  ([ADR-0004](../adr/0004-blank-is-not-zero.md)).
- **Never delete, never overwrite.** No delete in the storage interface or the
  folder; a folder with anything in it is never reused. Pruning is the bucket's
  lifecycle rule.
- **No row content in a log or an audit row.** A failure names a table, a key, a
  code; never a value.
- **A failed copy never stops another job.** The scheduled handler resolves; the
  Monday run is a separate firing.
- **The restore leaves nothing half-done.** One transaction: a refusal, an error or
  a difference keeps nothing. It never contacts the bucket or a hosted database.
- **Roles from the session only.** "Make a copy now" is admin only
  ([ADR-0023](../adr/0023-the-operations-app-has-rpcs-and-screens-of-its-own.md)).

## Code map

| What | Where |
|---|---|
| The format, both ways (pure) | `ops/src/backup/encode.ts` |
| The table list, the exceptions, reading a table in parts | `ops/src/backup/snapshot.ts` |
| Per-table totals (the cutover's measures) | `ops/src/backup/totals.ts` |
| The bucket interface (put and anyUnder only) and an in-memory bucket for tests | `ops/src/backup/storage.ts` |
| The run: transaction, files, manifest, audit row; the 03:00 gate | `ops/src/backup/nightly.ts` |
| The Settings line (from the audit log) | `ops/src/backup/status.ts` |
| The restore (Node only) | `ops/src/backup/restore.ts`, `ops/tools/restore-nightly.ts` (`npm run restore:nightly`) |
| RPC `rpcRunBackupNow` (admin) | `ops/src/rpc/handlers/backup.ts`; `ops/contracts/rpc-ops.json` |
| `lastBackup` in `rpcGetSettings` | `ops/src/rpc/handlers/settings.ts` |
| The scheduled handler (told by cron expression) | `ops/src/index.ts` |
| The schedule and the binding | `ops/wrangler.toml` (`[[r2_buckets]] BACKUPS`, `crons`) |
| UI: the line and "Make a copy now" | `src/Index.html`: `backupLineHTML_`, `runBackupNow_`, `renderSettingsTab` |

## Tests

| Suite | Holds down |
|---|---|
| `ops/test/backup-encode.test.ts` | the format as a table in both directions: money with trailing zeros, a 4-decimal rate, a negative, a very large numeric, NULL against `""` against the text `"null"`, newlines, quotes, backslashes, tabs, U+2028, a NUL-like escape, midnights of both clock-change days, a date, `bytea`, nested JSON, a boolean, a bigint past 2^53 |
| `ops/test/backup-copy.test.ts` | the round trip into a second database (every table equal value for value, the cutover reading equal, identity counters continue, a PIN signs in); one consistent picture; the table list; parts and the memory bound; the manifest written last, every length and SHA-256 recomputed independently, a failure at every file leaving none, a second run the same day in a new folder, no delete; that a copy only reads |
| `ops/test/backup-run.test.ts` | failures (the bucket refusing, the database dropping mid-read, the binding missing: audited with no row content, never thrown); the scheduled handler for each cron and every day of two years; who may press the button; two at once; each state of `lastBackup` |
| `ops/test/backup-restore.test.ts` | the restore refusing (no manifest, a missing, a changed, a shorter and an extra file, a database with rows, an older migration, not local) and leaving the database exactly as it was; a difference reported and nothing kept; a dry run; the tool's exit codes and last line |
| `ops/test/settings.test.ts`, `ops/test/cron.test.ts` | `lastBackup` in `rpcGetSettings`; `wrangler.toml` lists the Monday and nightly crons |
| `tests/suites/ui-backups.js` | the line and the control on Settings: for an admin only, each state's words, a warning visibly a warning, the button's call, result and refusal, everything escaped |

## History

- **Nov 2026 (card P4-06a):** the nightly copy, "Make a copy now", the Settings
  line and the restore tool; [ADR-0028](../adr/0028-the-app-makes-its-own-nightly-copy.md).
  A second, readable copy in a Google Sheet is a later card.
