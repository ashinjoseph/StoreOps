# Import the old purchase list

For years the purchases were kept as a list in a spreadsheet. This brings that
list into the Operations app as **history** (card P5-16 in the
[task cards](../plans/2026-11-operations-app-tasks.md)): every row with the
little it has, marked *from the old list: no original on file*. It does not
turn the rows into receipts, it does not guess which business bought what, and
it never changes the list. You sort the rows afterwards, in the app, when you
have time ([What you do in the app](#what-you-do-in-the-app-afterwards)).

It takes about 15 minutes, and you can run it as often as you like: the same
file twice adds nothing. You need Node 22, this repository, and the database
the app uses (the one `db:up` starts; see the
[dry run guide](cutover-dry-run.md) if you have not set it up).

## What is private and what is safe to share

| File | Holds | Share it? |
|---|---|---|
| The workbook (`.xlsx`) | Every supplier, amount and note | No. Keep it outside the repository; delete your copy when done |
| `rejects.csv`, `import-report.json` | Row numbers, the column's heading, a reason, and counts | Yes. They never hold a supplier, a note or an amount |
| What the tool prints | The file's name and SHA-256, counts, reasons | Yes, for the same reason. The file's own name is printed, so give it a plain one, such as `purchases.xlsx` |

The tool never prints a cell. If it refuses the file, the message names a tab,
a heading or a row number, never what is in it.

Work in a folder outside the repository, for example `~/storeops-purchases`.
The steps call it `$RUN`.

### On Windows (Command Prompt)

The commands are written for a bash terminal. In Command Prompt the `npm`
commands are the same; these differ:

| bash | Command Prompt |
|---|---|
| `export NAME="value"` | `set NAME=value` (no quotes: they would become part of the value) |
| `"$RUN/purchases.xlsx"` | `"%RUN%\purchases.xlsx"` |
| a command split over lines with `\` | the same command on one line (or `^` at the end of each line) |

Set the folder once with `set RUN=%USERPROFILE%\storeops-purchases`. A `set`
lasts for that window only, so run every step in the same window. Keep `RUN`
outside OneDrive or any other synced folder: it holds the real workbook.

## 1. Save the workbook

In Google Sheets: **File → Download → Microsoft Excel (.xlsx)**. Save it as
`$RUN/purchases.xlsx`. The tool reads one tab, **Purchase Invoices**, and that
tab must have its headings in **row 1**: `Date`, `Supplier Name`, `Amount` and
`Item`. Capitals, the order of the columns and spaces around a heading do not
matter; the tool finds each column by what it says and never by its position,
and refuses if one is missing. Any other tab (the `ATM DEPOSIT` tab, for one)
is not imported.

## 2. Say who you are, and where the database is

The import is recorded under an admin's staff id (for example `S_001`): yours.
The tool says in the audit log that it was run on your computer.

```sh
export OPS_DB_APP_URL="postgres://ops_app:local-only-app@127.0.0.1:54329/ops"
```

(Command Prompt: `set OPS_DB_APP_URL=postgres://ops_app:local-only-app@127.0.0.1:54329/ops`.)

The database must have every migration applied, `0015_legacy_purchases.sql`
included (`npm --prefix ops run db:migrate`). The tool refuses a database that
is not on this computer (`127.0.0.1` or `localhost`); see
[the hosted database](#the-hosted-database) for the one exception.

## 3. Dry run first

```sh
npm --prefix ops run import:purchases -- "$RUN/purchases.xlsx" --as S_001 --dry-run --report "$RUN/dry"
```

A dry run does everything and then rolls back, so the database stays as it
was. It prints, for example:

```
file: purchases.xlsx, SHA-256 9f3c…
tab: Purchase Invoices; columns found by their headings: Date, Supplier Name, Amount, Item
rows read: 296 (and 3 empty rows skipped)
kept: 291
rejected: 5 (NOT imported: see rejects.csv for each row number and reason)
  2 x date: no date
  2 x amount: no amount
  1 x date: the date is text, not a date
kept with no supplier written: 2; with no item: 198; with an amount of zero: 0; below zero (refunds): 4
repeats of an earlier row (same date, supplier and amount; all kept): 6
supplier spellings: 74
dry run: everything was done and rolled back; nothing was kept.
```

What each line means:

- **rows read**: rows with something in any of the four columns. A row with
  nothing in them is skipped and counted, not a row of the list.
- **kept + rejected = rows read**, always.
- **rejected**: rows that cannot be history, left out and listed in
  `$RUN/dry/rejects.csv` as *row, column, reason*. The row number is the one you
  see in the spreadsheet. See [What to do with rejects](#what-to-do-with-rejects).
- **no supplier written / no item**: kept, as blanks. The app says *supplier
  not written*.
- **below zero (refunds)**: kept as they are (a negative amount), and counted so
  you can look at them.
- **repeats**: rows with the same date, supplier and amount as an earlier row.
  **All are kept**: two trips to the same shop in a day look exactly like a row
  typed twice, and nothing tells them apart. Look at them in the app.
- **supplier spellings**: how many different suppliers the tool sees once
  capitals, spaces and dashes are ignored. The same supplier typed six ways
  will be several spellings: that is for you to join in the app.

Check the numbers against the spreadsheet: the last row number minus 1 is the
rows (plus any skipped), and in the app, once imported, the total of *all* the
rows should equal the sum of the Amount column less the rejected rows.

## What to do with rejects

Each reject is a row the tool would not guess about. Decide, for each reason:

| Reason | Why | What to do |
|---|---|---|
| no date | the row cannot be placed in time | type the date in the spreadsheet, or accept losing the row |
| the date is text, not a date | the cell looks like a date but is text (a leading space or apostrophe, or a format Sheets did not read) | retype it as a real date |
| the date is before 2000, or after the day of the import | usually a typing slip in the year | fix the year |
| no amount | nothing to record | type it, or accept losing the row |
| the amount is not a number | text such as `12.50`, `$12.50`, `n/a` | retype it as a number |
| the amount has fractions of a cent | for example `10.005` | fix it |
| the supplier or the item is not text | the cell holds a date or a true/false | retype it as text |

If you fix cells, download the workbook again and **start again from step 3**.
A fixed file is a different file; if you have already imported the first one,
see [Running it again](#running-it-again).

## 4. Import for real

```sh
npm --prefix ops run import:purchases -- "$RUN/purchases.xlsx" --as S_001 --report "$RUN/import"
```

It ends with `committed: 291 rows are in the old purchase list.` Any other
ending means nothing was kept. Note the **SHA-256** it printed: it is how the
tool recognises this file again.

Rejected rows are **not** imported, whether or not you looked at them: read the
`rejected:` line every time.

## Running it again

- **The same file again** adds nothing: *This file was imported before.
  Nothing was added.*
- **A changed file** (you fixed a typo and downloaded it again) is refused:
  *A different file is already in the app…* with the exact command to use.
  Give it the old file's SHA-256:

  ```sh
  npm --prefix ops run import:purchases -- "$RUN/purchases.xlsx" --as S_001 --replace-file 9f3c… --report "$RUN/replace"
  ```

  The old file's rows are marked **replaced** (never deleted), and the business
  and the supplier you chose for them are carried over to the new rows that are
  the same line (same row number, date, amount and supplier text). It prints
  how many were carried over and how many were not: a row you changed, or
  moved, starts again with no business. Check that second number.

## What a real workbook may hold that this does not expect

The tool was tested on a workbook built to the description of yours, not on
yours. Read this before the first run; the dry run will show each of these as
a count or a reject.

| If the workbook has | The tool does |
|---|---|
| a **total row** at the bottom | the row has no date, so it is rejected (*no date*) and listed with its row number. It is never added up |
| **two header rows**, or the headings not in row 1 | the second header row has text where a date should be, so it is rejected (*the date is text*); if row 1 is not the heading row at all, it refuses: *no column headed …* |
| a **date typed as text** | rejected (*the date is text, not a date*); never read as a date |
| an **amount with a currency sign, or any text** | rejected (*the amount is not a number*) |
| an amount like `12.345` | rejected (*fractions of a cent*): never rounded |
| **merged cells** | the value belongs to the first cell, the others read as blank: a merged supplier looks like *supplier not written* on the rows under it. Unmerge them first |
| **hidden rows**, filtered rows, or a **hidden tab** | read like any other: hidden does not mean left out |
| a **formula** | its last calculated value is read. A formula with no calculated value anywhere in the workbook makes the tool refuse the whole file (it names the tab and cell, never the content): open the file, let it calculate, and save it again |
| an **error cell** (`#REF!`) in the amount | rejected (*the amount is not a number*) |
| a **time** with the date | the day is taken in Toronto time |
| an **empty row** in the middle | skipped and counted |
| **two columns with the same heading** | refused: it cannot be told which to read |

## What you do in the app afterwards

**More → Receipts → Old purchase list**, for an admin, a manager or a payroll
admin (only an admin or a manager can change anything). Nothing from here is in
*On the books*, and nothing here is offered to an assistant.

1. **Supplier spellings**, most rows first. For each, **Sort or link**:
   - *Which business bought all N* sets cstore or vape for every row written
     that way, at once. Nothing does this for you, not even a supplier that
     only one business uses.
   - *Which supplier this means* links every row written that way to a supplier
     on the app's list (or makes the supplier). The text as typed stays on each
     row. It also teaches the app the spelling, so a future receipt printed that
     way is matched to the supplier.
2. **Rows**: *cstore*, *vape* or *not sorted*, newest first, with a date filter.
   Each row has its own business control, for the ones that do not fit their
   spelling.

## The hosted database

The tool loads only into a database on this computer unless it is given
`--yes-load-into-a-database-that-is-not-on-this-computer` (the same words as
`restore:nightly`). Use it only when you mean to load the real hosted
database, with `OPS_DB_APP_URL` set to that database's own address, after a dry
run against it. Nothing else changes.

## What to send back

- What the dry run printed (step 3), and `rejects.csv` if there are rejects.
- Anything from [the table above](#what-a-real-workbook-may-hold-that-this-does-not-expect)
  that you saw.

Then delete `$RUN`. The workbook is private; the report is not.
