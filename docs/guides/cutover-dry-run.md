# Dry run: the real Sheet into a local database

This is the rehearsal for the move off Google Sheets (card P4-04 in the
[task cards](../plans/2026-11-operations-app-tasks.md)). You download the real
Sheet, load it into a database on your own computer, and get a report that
says whether every row and every cent arrived. Nothing here touches the live
app or the live Sheet, and you can repeat it as often as you like.

It takes about 20 minutes. You need Docker, Node 22 and this repository.

## What is private and what is safe to share

| File | Holds | Share it? |
|---|---|---|
| The downloaded workbook (`.xlsx`) | Everything: pay, takings, login codes | No. Keep it outside the repository; delete it when done |
| The export directory | The same, as one file per tab | No. Same rule |
| `rejects.csv`, `import-report.json` | Tab, row number, column, reason, counts | Yes. No cell values |
| `reconcile-report.md`, `reconcile-report.json` | Counts, sums per month, the size of each difference | Yes, with care: it has monthly totals of takings and pay, but no names, notes or pay rates |

Work in a folder outside the repository, for example `~/storeops-dry-run`.
The steps below call it `$RUN`.

### On Windows (Command Prompt)

The commands below are written for a bash terminal. In Command Prompt the
`npm` commands are the same; three things differ:

| bash | Command Prompt |
|---|---|
| `export NAME="value"` | `set NAME=value` (no quotes: they would become part of the value) |
| `"$RUN/export"` | `"%RUN%\export"` |
| `cp a b` | `copy a b` |

Set the folder once with `set RUN=%USERPROFILE%\storeops-dry-run`. A `set`
lasts for that window only, so run every step in the same window. Keep `RUN`
outside OneDrive or any other synced folder: it holds the real workbook.

## 1. Start an empty local database

```sh
cp ops/.env.example ops/.env          # local-only passwords; fine as they are
npm --prefix ops ci
npm --prefix ops run db:reset         # a clean, fully migrated database
```

The import refuses to load into tables that hold rows, so start from
`db:reset` every time you repeat the run.

## 2. Download the Sheet and export it

In Google Sheets: **File → Download → Microsoft Excel (.xlsx)**. Save it as
`$RUN/storeops.xlsx`.

```sh
npm --prefix ops run export:sheet -- "$RUN/storeops.xlsx" "$RUN/export"
```

It prints one line per tab: rows, columns, date cells, formulas, errors. This
is the first time the tool reads a real Google download, so check:

1. The number of tabs matches the Sheet, hidden tabs included.
2. Each tab's row count matches the Sheet (its last row number minus 2).
3. Tabs with dates show a `dates` count. A date column that arrives as plain
   numbers shows `0` there.
4. The `errors` column is `0` for the tabs that matter. An error cell such as
   `#REF!` in a tab that gets loaded stops the import.
5. A few cells by eye, in the tab's file under `$RUN/export`: a date, a time,
   a blank, a figure with cents, an id with leading zeros.

If the tool refuses the file, send the message it printed. It never prints a
cell value.

## 3. Import as a dry run

```sh
export OPS_DB_APP_URL="postgres://ops_app:local-only-app@127.0.0.1:54329/ops"
export PIN_PEPPER="local-only-pepper-not-a-secret"   # the local value; never the real secret
npm --prefix ops run import:sheet -- "$RUN/export" --dry-run --report "$RUN/dry"
```

A dry run does everything and then rolls back, so the database stays empty.
Read the last lines it prints:

- **`rejects: 0`** is the goal. Each reject is one row that would not load.
  `$RUN/dry/rejects.csv` lists the tab, the row number as you see it in the
  Sheet, the column and the reason.
- **`ids re-keyed`**: duplicate ids in payment lines, handover lines and the
  audit log are kept and given a suffix (`-d2`). That is expected.
- **`PINs: N hashed, M blank`**: the blank ones cannot sign in until a PIN is
  set.
- **`open till sessions`**: how many tills were open at download time.

For each reject, decide one of three things: fix the cell in the Sheet and
start again from step 2; accept losing that row; or ask for the import rule
to change. Common reasons are listed in the P4-02 card.

## 4. Import for real (into the local database)

With no rejects:

```sh
npm --prefix ops run import:sheet -- "$RUN/export" --report "$RUN/import"
```

If you decided to accept some rejects, say exactly how many. The import
commits only when the number matches:

```sh
npm --prefix ops run import:sheet -- "$RUN/export" --report "$RUN/import" --accept-rejects 3
```

It ends with `committed.` Any other ending means nothing was kept.

## 5. Check the Sheet against the database

```sh
export OPS_DB_READ_URL="postgres://ops_read:local-only-read@127.0.0.1:54329/ops"
npm --prefix ops run reconcile:import -- "$RUN/export" \
  --import-report "$RUN/import/import-report.json" --out "$RUN/reconcile"
```

The last line is the answer:

- **`RESULT: no unexplained difference.`** Every row and every figure in the
  Sheet is in the database, apart from the rows listed under "not loaded, per
  the import report".
- **`RESULT: N unexplained differences.`** Open
  `$RUN/reconcile/reconcile-report.md`. Each difference names the table, the
  Sheet row and the column, and for money the size of the gap in cents.

Read the "not loaded" list in the report even when the result is clean: it
shows the rows that were rejected or left out on purpose, with the money they
carry. That list is the part a person has to judge.

## 6. Look at it in the app (optional)

```sh
cp ops/.dev.vars.example ops/.dev.vars     # the same local values as above
npm --prefix ops run dev
```

Open the address it prints and sign in with your own name and PIN. You are
looking at your real records in the new app, on your own computer.

## 7. Use it as staging (the owner's choice, Nov 26)

The same local setup is the staging environment for now: the app and the
database both run on this computer, and other people reach it over the Wi-Fi.

```sh
npm --prefix ops run dev -- --ip 0.0.0.0
```

Find this computer's address on the network (for example `192.168.1.23`) and
open `http://192.168.1.23:8787` on a phone on the same Wi-Fi. Each person
signs in with their usual name and PIN.

What to know before two people use it for a day beside the live app:

- **It sends no WhatsApp messages and asks Clover nothing**, because the keys
  are not on this computer. Leave them out of `ops/.dev.vars`. A close then
  records "not sent" in the audit log, which is expected here. With the real
  WhatsApp key in place, every staging close would message the real
  recipients.
- **Use a Wi-Fi you trust.** The address is plain `http`, so names and PINs
  cross the network unencrypted. Do not open the port to the internet. If
  someone needs it from outside, ask for a tunnel that gives `https` to be set
  up first.
- **The computer has to stay on and awake**, and the data is the real data.
  It stays in Docker until `npm --prefix ops run db:reset`.
- **Everything is entered twice** that day: once in the live app, once here.
  The point is to compare what the two say at the end of the day.
- **The Monday commission run does not fire by itself here.** Use "Run
  engine" on the Commissions screen.
- **To refresh the data**, start again from step 1 with a new download.
  Anything entered on staging is lost, which is what you want.

What this does not test is the hosted setup: the deployed app, the keys held
by Cloudflare, the schedule, and the hosted database's connection limits and
speed. One hosted rehearsal before production still covers those (card P2-10).

## What to send back

- The table the export printed (step 2), and anything odd from the five checks.
- `rejects.csv` and `import-report.json` from the dry run.
- `reconcile-report.md`.

Then delete `$RUN`, and run `npm --prefix ops run db:down` to stop the
database.

## What this rehearsal does not cover

- It compares the export with the database. Whether the export matches the
  live Sheet rests on the five checks in step 2.
- It does not test the hosted setup (Cloudflare and the hosted database).
  That is the hosted rehearsal in card P2-10.
- A time inside the repeated hour of the November clock change is read as the
  first of the two.
