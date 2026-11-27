# Restore a nightly copy into an empty local database

The Operations app writes a copy of every table to a bucket every night
([backups](../components/backups.md)). This guide is how you **try one**: you
download a copy's folder to your own computer, load it into an empty database
there, and a tool tells you whether every table came back. Nothing here touches
the live app or its database, and you can repeat it as often as you like. Do it
once before the switch to the new app (card P4-14), and again from time to
time: a backup nobody has restored is a hope, not a backup.

It takes about 15 minutes. You need Docker, Node 22 and this repository (the
same as the [dry run](cutover-dry-run.md)), and a Cloudflare login that can read
the `storeops-backups` bucket.

## What is private

| What | Holds | Share it? |
|---|---|---|
| The downloaded folder (`copy/`) | Everything: pay, takings, hashes of PINs | No. Keep it outside the repository and outside OneDrive or any synced folder; delete it when done |
| The tool's output (the lines it prints) | Table names, row counts, money totals | Yes, with care: it has totals of takings and pay, but no names and no row |

Work in a folder outside the repository, for example `~/storeops-restore`. The
steps call it `$RUN`.

### On Windows (Command Prompt)

The commands below are written for a bash terminal. In Command Prompt the `npm`
commands are the same; these differ:

| bash | Command Prompt |
|---|---|
| `export NAME="value"` | `set NAME=value` (no quotes: they would become part of the value) |
| `"$RUN/copy"` | `"%RUN%\copy"` |
| `cp a b` | `copy a b` |
| the `for` loop in step 2 | download the files in the Cloudflare dashboard instead (step 2, option A) |

Set the folder once with `set RUN=%USERPROFILE%\storeops-restore`. A `set` lasts
for that window only, so run every step in the same window.

## 1. Start an empty, freshly migrated local database

```sh
cp ops/.env.example ops/.env          # local-only passwords; fine as they are
npm --prefix ops ci
npm --prefix ops run db:reset         # a clean, fully migrated database
```

The restore refuses a database that holds any row (apart from the two rows the
migrations themselves insert: the main store and the two businesses), so start
from `db:reset` every time you repeat the run. It also refuses a database whose
newest migration is older than the copy's: use a checkout of the repository at
the version that made the copy, or newer.

## 2. Download one copy's folder

Pick the day in the bucket: the folders are `nightly/<Toronto day>/` (for example
`nightly/2026-11-27/`); a second copy the same day has a time after the day. **A
folder without `manifest.json` is an incomplete copy and cannot be restored:** use
another.

Download **the whole folder** into `$RUN/copy`, files and manifest, and nothing
else in it (the tool refuses a folder with an extra file).

**Option A: the Cloudflare dashboard.** R2, `storeops-backups`, open the folder,
and download each file (a store this size has about twenty). Put them all in
`$RUN/copy`.

**Option B: the command line** (bash; the file `manifest.json` lists the others):

```sh
DAY="nightly/2026-11-27"
mkdir -p "$RUN/copy" && cd "$RUN/copy"
npx wrangler r2 object get "storeops-backups/$DAY/manifest.json" --file manifest.json --remote
for f in $(node -e 'console.log(require("./manifest.json").files.map(f => f.file).join(" "))'); do
  npx wrangler r2 object get "storeops-backups/$DAY/$f" --file "$f" --remote
done
cd -
```

(`npx wrangler` needs a login to the Cloudflare account: `npx wrangler login`.)

## 3. Check it first (a dry run)

```sh
export OPS_DB_OWNER_URL="postgres://ops_owner:local-only-owner@127.0.0.1:54329/ops"
npm --prefix ops run restore:nightly -- "$RUN/copy" --dry-run
```

The tool uses the database's **owner** (or a superuser, in `OPS_DB_SUPERUSER_URL`),
not the app's role: a restore has to set the identity counters so that the next
new row continues after the restored ones, and the app's role may not do that.
It refuses any database that is not on this computer.

A dry run does everything and then rolls back, so the database stays empty. It
prints, in order:

```
copy: nightly/2026-11-27, snapshot 2026-11-27T08:00:12.000Z, 24 tables, 2268 rows, newest migration 12
files: 17 files checked: every length and SHA-256 is the manifest's.
sales                    rows     360 of 360     ok
    cash_sales                          184888.63  copy 184888.63
    …
dry run: every table matches (22 tables, 2269 rows); everything was done and rolled back, nothing was kept.
```

For each table: the rows restored against the rows the copy says, and for each
money or whole-number column the total restored against the copy's. The last line
is the answer.

## 4. Restore for real (into the local database)

```sh
npm --prefix ops run restore:nightly -- "$RUN/copy"
```

The last line is the answer:

- **`every table matches: 22 tables, 2269 rows, restored and kept.`** Every file
  was checked, every table was loaded in one transaction, every table was read
  back out and compared (row count, money sums per month, and a SHA-256 of what
  the database now holds against the copy's), and the result was kept.
- **`NOT RESTORED: …`** lists what does not match (a table and what differs).
  Nothing was kept: the database is exactly as it was.

If the tool **refuses** before loading anything, it says why and that nothing
was written. The usual reasons:

| It says | What to do |
|---|---|
| `this folder has no manifest.json` | That copy never finished: use another day's |
| `the file X is missing` / `holds X, which the manifest does not list` | The download is incomplete or has an extra file: download the folder again, into an empty folder |
| `X has the right length but its SHA-256 is not the manifest's` | The file was changed or damaged: download it again; if it does, that copy is damaged |
| `this database is not empty (…)` | Start from step 1 (`db:reset`) |
| `newest migration is N, older than the copy's M` | Run `npm --prefix ops run db:migrate`, or use a newer checkout |
| `the database is not on this computer` | You pointed it at a hosted database: don't. Use the local one |

## 5. Look at it in the app (optional)

```sh
cp ops/.dev.vars.example ops/.dev.vars
npm --prefix ops run dev
```

Open the address it prints and sign in with your own name and PIN. You are looking
at the copy's records in the app on your own computer. **PINs only work if
`PIN_PEPPER` in `ops/.dev.vars` is the same as the Worker's real one**: the copy
holds the hashes of the PINs, made with that secret. With the local example value
nobody can sign in (a real PIN hash does not match), and you set a PIN with
`npm --prefix ops run pin:set -- <staff_id> <pin>` instead.

## 6. Clean up

Delete `$RUN` (it holds real pay and takings), and run `npm --prefix ops run db:down`
to stop the database.

## What a restore needs besides the copy

The copy is the tables. After losing the hosted setup you also need the receipt
files (from the `RECEIPTS` bucket), the Worker's secrets (above all `PIN_PEPPER`),
the Cloudflare configuration and the assistants' keys: the list is in
[what a full recovery needs](../components/backups.md#what-a-full-recovery-needs).

## What this rehearsal does not cover

- It tests the copy and the restore on your computer. Whether the hosted app makes
  its copy on time, inside its limits and through the connection pooler is the
  hosted rehearsal (card P2-10).
- It does not load a copy into a hosted database. The tool will, with a flag whose
  name says what it is, but that path has not been rehearsed.
- It cannot show that the copy is the *live* database at the time: it shows that
  the files are the copy the manifest describes and that they load.
