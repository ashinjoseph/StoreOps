# 0028. The app makes its own nightly copy of every table, and a restore tool proves it

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [backups](../components/backups.md), [settings](../components/settings.md), the Operations app (`ops/`; see the [migration plan](../plans/2026-11-operations-app-migration.md), cards P4-06 and P4-14)

## Context

The Google Sheet's version history was the store's safety net: "go back to how
things were yesterday". The Operations app keeps the same records in a hosted
Postgres whose plan has **no automatic backups**, so on the day of the switch
the app would hold the only copy of the store's cash, pay and sales with
nothing behind it. The plan already says the nightly job also writes every
table to R2, kept 90 days, and that a backup must be restored before the
switch ("a backup nobody has restored is a hope, not a backup").

What can go wrong with a home-made copy is mostly quiet: a table added by a
later migration that nobody remembered to list; money written as a float; a
copy of table A from Tuesday night and table B from Wednesday morning that no
restore can reconcile; a failed run that leaves half a folder that looks like
a copy; an app that "tidies" old copies and removes the one that was needed.

## Decision

- **A consistent snapshot, to dated files, with a manifest written last.** The
  whole copy is read inside ONE read-only, repeatable-read transaction, so
  every table is as of one instant. It takes no lock that blocks the store
  and writes nothing to the database but one audit row at the end, in its own
  transaction. Each table goes to newline-delimited JSON files
  (`ops/src/backup/encode.ts`; one row per line, columns in a fixed order,
  money and `numeric` as strings, instants as UTC, `bytea` as hex, NULL as
  `null`), in parts of at most 5,000 rows or about 2 MB. `manifest.json`
  (every file's table, part, rows, length and SHA-256, and per-table totals)
  is the last object written. A folder without one is an incomplete copy and
  the restore refuses it.
- **Every table, found at run time, with a short written list of exceptions.**
  The tables are read from the database's catalogue, so a table a later
  migration adds is copied without anyone remembering. The exceptions are
  named in code with their reasons (`ops/src/backup/snapshot.ts`): live
  sign-ins, failed sign-in counts, one-time upload tickets, the record of
  assistant calls, and the migration tool's own bookkeeping. A test fails if a
  table is neither copied nor on the list. Hashes of PINs and of assistants'
  keys are copied: a restore must let people sign in again, and a hash is not
  the secret.
- **Never deleted, never overwritten, by the app.** The storage interface has
  `put` (a new key only) and `anyUnder`, nothing else; a folder that already
  holds anything is never written into, so a second copy the same day goes to
  `nightly/<day>-<HHmmss>`. Keeping only 90 days is a lifecycle rule on the
  bucket, set where the bucket is made, never code in the app. The copies go
  to their own bucket (`BACKUPS`, `storeops-backups`) so that the receipts
  bucket's permanent retention and this one's 90 days never meet.
- **Receipt originals are not in the copy.** They live in their own bucket
  under a retention lock ([ADR-0026](0026-receipt-originals-are-kept-as-received.md));
  the copy holds their records (the tables), not the files.
- **Nightly at 03:00 in Toronto, and on demand by an admin**, one at a time.
  The cron fires at both UTC hours that can be 03:00 there (07:00 and 08:00)
  and the job does nothing unless it is 03:00 in Toronto, as the Monday
  commission run does for 09:00. "Make a copy now" on the Settings screen is
  `rpcRunBackupNow` (admin only); a second request while one runs is refused
  in words.
- **It reports itself and never takes another job down.** One audit row per
  run (`backup.nightly`, or `backup.failed` with what failed and never a row's
  content). The Settings screen shows admins one line: the last copy, or a
  warning when the newest good copy is more than 36 hours old or the last run
  failed. Nothing is sent anywhere. A failed copy is returned, not thrown, so
  the scheduled handler never fails because of it and the Monday run is
  untouched.
- **Restored by a tool that checks itself.** `restore:nightly` runs on the
  owner's computer, into an empty, freshly migrated local database, from a
  folder downloaded from the bucket (it never contacts the bucket or a hosted
  database). It checks the manifest and every file's length and SHA-256
  before loading anything, refuses a database that has rows or an older
  migration, loads every table in foreign-key order in one transaction, sets
  the identity counters to continue after the restored rows, reads every table
  back out with the same reader the copy was made with, and keeps the result
  only if every row count, money sum per month (the cutover reconcile's own
  measures) and part SHA-256 matches. It ends with one line.

## Consequences

- ✅ The store has a copy of every record that does not depend on the
  database provider, one a person can read with a text editor, and a restore
  that has been run end to end by a test (a round trip through a second
  database, a sign-in with a PIN, new rows after the restore getting fresh
  numbers).
- ✅ A table nobody remembered is copied; a half-made copy cannot be mistaken
  for a good one; a bad file is found before it is loaded.
- ✅ Because the app can only add, a bug cannot erase the history; the cost is
  that the bucket needs its lifecycle rule (without it copies pile up: a few
  MB a night).
- ⚠️ The copy holds pay, takings and PIN hashes in the clear (as files). The
  bucket must never be public and its keys must go to nobody who does not
  need them; the guide for the restore says the same of the downloaded folder.
- ⚠️ It does not hold the receipt files, the Worker's secrets, or the settings
  that live outside the database (the Cloudflare configuration). A full
  recovery needs those from their own places
  ([backups](../components/backups.md#what-a-full-recovery-needs)).
- ⚠️ The copy is read in one long transaction through the connection pooler.
  The hosted rehearsal must show that it holds for the time a copy takes; the
  Worker's CPU and wall-time limits for a scheduled job are open questions for
  the same rehearsal.
- ⚠️ A table with no primary key and no `seq` makes the copy fail (loudly)
  rather than copy it in an unstable order; every migration so far has a key.

## Alternatives considered

- **Rely on the database provider's backups.** The plan has none, and a
  provider's restore is a provider's tool: slow, whole-database, and not
  something the owner has tried. Even with them, a copy in files the app
  controls is the one that can be read, checked and restored on a laptop.
- **A SQL dump (`pg_dump`) from inside a Worker.** A Worker cannot run
  `pg_dump`; rebuilding one in the Worker means writing a dump format and a
  loader for it, with none of the checks (manifest, hashes, totals) this has.
  Newline-delimited JSON is plain text, exact, and trivially checked.
- **A copy into a Google Sheet as the only backup.** A Sheet cell cannot hold
  every value exactly (a long number, a NUL-like text, microseconds), has a
  cell limit, and needs Google credentials; it cannot be a consistent
  snapshot or be restored mechanically. A readable Sheet copy is still wanted
  as a second one ([the plan](../plans/2026-11-operations-app-tasks.md), P4-06),
  not as the only one.
- **Letting the app prune old copies.** An app that can delete copies can
  delete the one that was needed (a bug, a wrong clock, a bad date). A
  lifecycle rule on the bucket does the same job from outside the app, and
  the app's credentials cannot be used to erase history.
- **One transaction per table.** Simpler and lighter on the database, but
  a till closed while the copy runs would be in one table's file and not
  another's, and no restore could tell. A test pins the single transaction.
