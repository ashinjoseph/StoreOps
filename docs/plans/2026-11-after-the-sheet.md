# After the Sheet: what an admin could do by hand, and the till link's build order

Two plans in one page, both asked for by the owner on Nov 27:

1. What the Google Sheet and its menu let an admin do that the Operations app
   cannot do yet, with a card for each gap. Adding a new staff member is the
   first of them.
2. The order in which to build the link to the till.

The cards named here are in the [task cards](2026-11-operations-app-tasks.md).
The rule for anything the new app does that the current app never did is
[ADR-0023](../adr/0023-the-operations-app-has-rpcs-and-screens-of-its-own.md).

## Part 1: what the Sheet used to do

### How the review was done

Three lists were read against the new app's 41 ported calls:

- every item of the Sheet's `StoreOps` menu (`onOpen` in `src/Setup.gs`);
- every table, asking "which screen can add a row, change it, or undo it?";
- every function in the current code that changes data but is called by no
  screen (those were only ever reachable by editing the Sheet).

The first dry run on real data also showed that hand edits are not rare:
`till_sessions` held formulas someone typed, two session rows copied by hand,
and two sales rows with no session.

### What is already covered

| What goes wrong | How it is put right in the app |
|---|---|
| A payment recorded wrongly | Undo the payment (it is kept, marked voided), then pay again |
| A cash handover recorded wrongly | Void it, then record it again |
| A bonus created wrongly | Cancel it, then create it again |
| A commission rule that is wrong | Edit it or switch it off |
| A till left open by someone who went home | A manager or admin closes it |
| A day's reconcile needs redoing today | "Reconcile today" |
| WhatsApp stopped arriving | "Check WhatsApp setup" |
| A person leaves | Deactivate them (needs the staff screen below); they are signed out at their next tap |

### The gaps

**Must be in place before the switch.** Without these the store gets stuck.

| # | Ability | Today | Card |
|---|---|---|---|
| 1 | Add a person, change their details, deactivate them, set or reset a PIN | Typed into the `staff` tab. The code has a `create` function no screen calls | P4-11 (done) |
| 2 | Change a setting | Typed into the `config` tab | P4-09 (done) |
| 3 | Correct a day's schedule after the fact | Typed into the `attendance` tab | P4-10 (done) |
| 4 | Correct a closed till: a mistyped count, cash or card figure, or note | Typed into `till_sessions` and `sales`. The code has an `edit` function no screen calls, and it covers only the float, the count and the note | P4-12a (done) |
| 5 | Enter a shift that was never put in the app, for a past day | Rows typed by hand | P4-12b |
| 6 | Run the reconcile again for a past day, after a correction | Not possible: only "today" | P4-12c (done) |

**Should be in place at the switch.** The store runs without them, but
someone will ask within the first week.

| # | Ability | Today | Card |
|---|---|---|---|
| 7 | Read the audit log: who changed what, when | Scroll the `audit_log` tab | P4-13 |
| 8 | Look anything up in bulk, filter it, hand a copy to the bookkeeper | The Sheet itself | P4-06 (the nightly read-only Google Sheet copy), moved to before the switch |
| 9 | Go back to how things were yesterday | The Sheet's version history | P4-14 (backups and a restore that has been tried) |
| 10 | Pause the Monday commission run | Remove the trigger from the menu | P4-13 (one setting) |

**Can wait.** Rare, or there is a workable route already.

| # | Ability | Until it is built |
|---|---|---|
| 11 | Run commissions for a week other than last week | The same limit exists today. A missed Monday is run by hand that week |
| 12 | Unlock someone locked out after wrong PINs | The lock lifts by itself after an hour; setting a new PIN (P4-11) also clears it |
| 13 | Change the pay rate of days already worked (a back-dated raise) | Not built; see the question under P4-11 |
| 14 | Move a till session to the person who really worked it | A written data fix (below) |
| 15 | More than one store, and who works at which | P5-01, after the switch |

**Menu items that need no replacement:** first-time setup and every "add
column" item (migrations do this now), installing the weekly trigger (the
schedule is part of the app), the four product imports and the vape
diagnosis (those areas are not being moved), syncing config keys (a setting
with no row uses its default), and "Reset Data" (never wanted in production).

### The escape hatch, and its rule

The Sheet let anyone with access change anything, with no record. The
database has the same door for whoever holds the owner password. The rule
proposed for it:

- A change made directly in the database is written first as a short file in
  the repository (`ops/data-fixes/YYYY-MM-DD-what.sql`), saying what, why and
  who asked, and is run once by the owner.
- It never deletes a money record.
- If the same kind of fix is needed twice, it becomes a screen.

### P4-11: staff (the plan the owner asked for)

**Who:** an admin, for everything. A manager may add an employee and
nothing else (the owner, Nov 27; see the answers below). **Where:** a
"Staff" entry in the More drawer, new app only.

**Adding a person.** The admin fills in:

| Field | Rule |
|---|---|
| Name | Required. Must not match another active person: people sign in by picking their name |
| Role | Employee, manager, payroll admin or admin |
| Tills | cstore, vape, or both. Decides which tills they may open |
| Hourly rate | May be left blank ("no rate yet"). A blank rate is not $0: a day worked with no rate shows as "no rate set" and is not payable until one is |
| Start date, email, notes | Optional |
| PIN | The admin types a first PIN (4 to 8 digits) and tells the person |

The app gives them the next staff id (`S_008` after `S_007`), stores only a
slow, salted hash of the PIN, and writes an audit row that names the admin
and never contains the PIN.

**Changing a person.** Any field above, with these guards:

- A new rate applies to days worked from now on. Days already worked keep the
  rate they were worked at (it is stored on the day).
- The last active admin cannot be demoted or deactivated, and nobody
  deactivates themselves.
- Someone who is the cash manager in settings cannot be deactivated until
  the setting names someone else.
- Deactivating someone with an open till is refused: close the till first.
- Someone who still holds shop cash can be deactivated, with a warning that
  shows the amount. The cash stays on the cash screen under their name.

**PINs.**

- An admin can set a new PIN for anyone who forgot theirs. That signs the
  person out everywhere and clears any lockout.
- Nobody changes their own PIN (the owner, Nov 27): they ask an admin.

**The owner's answers (Nov 27).**

1. A manager may add people. Built as: a manager adds an employee with a
   name, tills, a start date and a first PIN. The pay rate, any role above
   employee, later changes, deactivating and PIN resets stay with an admin,
   because a manager sees no pay rates today.
2. A raise may also apply to unpaid days: the admin gives a date, and worked
   days from that date with nothing paid against them take the new rate.
   Days with any payment are left as they are and listed. The change is
   shown (how many days, how much more is owed) before it is saved.
3. People do not change their own PIN. An admin sets it.

### P4-12: correcting a closed till, and entering a missed shift

**Who:** admin only, with a reason every time.

- **Correct a closed till session:** the opening float, the cash counted,
  cash sales, the card figures (in the shape the till uses), the misc
  figures, the lotto count and the notes. The app works out expected cash,
  the variance and the cash removed again, exactly as a close does.
- **Refused when it would break something already settled:** if cash from
  that shift has been handed over and the correction would make the shift's
  cash smaller than what was handed over, the handover is voided first.
- **Enter a missed shift for a past day:** the same form with nothing
  prefilled, for a named person, till and day. It creates the session, the
  sales row and the day's attendance together, as an open and a close would.
- **Reconcile a past day again:** after either of these, the admin can run
  the reconcile for that day. The earlier result is kept; the new one is
  added, as a forced re-run does today.
- Every change writes an audit row with the figures before and after.

This is the gap behind two things the first dry run showed: a reconcile row
with a card figure that is plainly a typo, and hand-typed session rows.

### P4-13: the audit log on a screen, and pausing the Monday run

- **Audit log (admin):** the newest entries first, filtered by person, by
  kind of action and by day. Read-only. Phone numbers and anything else
  personal that older entries contain are masked on the screen.
- **Pause the weekly commission run:** one setting, off by default. When on,
  the Monday run does nothing and says so in the audit log. "Run engine" on
  the Commissions screen still works by hand.

### P4-14: backups, and a restore that has been tried

The Sheet's version history was the safety net. The plan:

- find out, in the hosted rehearsal, what backups the hosted database plan
  gives and how far back;
- keep the nightly Google Sheet copy (P4-06) as a second, readable copy;
- before the switch, restore one backup into a scratch database and run the
  Sheet-against-database check's row counts on it. A backup nobody has
  restored is a hope, not a backup.

### Order

1. P4-09 settings and P4-10 schedule corrections (both done).
2. P4-11 staff.
3. P4-12 closed-till corrections, missed shifts, reconcile for a past day.
4. P4-13 audit log screen and the pause setting; P4-06 nightly copy.
5. P4-14 backups, with the hosted rehearsal.

Items 1 to 3 are needed for the day of use beside the live app to be a fair
test: on that day someone will mistype a figure.

## Part 2: the link to the till, in build order

What is agreed is in [the agreed note](2026-11-till-api-agreed.md) and the
contract `ops/contracts/till-api.v1.yaml` (1.1.0). The till's side answers
`GET` requests on its staging address today; nothing in Operations calls it
yet. The cards exist (P5-02, P5-03, P5-07, P5-08); this is the order, and
what each one waits for.

| Step | What gets built | Waits for | Card |
|---|---|---|---|
| 1 | **The till client and a fake till.** One place that calls the till: never throws, waits when told to slow down, times out, and keeps the key out of every log. A fake till built from the contract, so every later step can be tested without the real one | Nothing. Can start now | P5-02 (first half) |
| 2 | **People and stores matched.** Each Operations person linked to their till login, offered from the till's staff list; the till's stores mapped to ours. A till person with no match is listed, never created. The key's expiry date shown to admins 14 days ahead | Step 1. The staff screen (P4-11), which is where the link is shown | P5-02 (second half) |
| 3 | **The vape close starts from the till's figures.** At close the app fetches the shift, keeps it as a snapshot with the time fetched, and prefills the close for the cashier to confirm. Till down: the close works by hand as today. A later change at the till is flagged, never applied. E-transfer becomes its own column | Step 2. One migration | P5-03 |
| 4 | **Delivery cash at the door.** Each shift's door cash shown as its own line. The driver's handover (collected, handed over, by whom, when) shown beside it, with the driver's gap separate from the cashier's variance | Step 3, and **the till side**: the four handover fields asked for on Nov 23 are not in the contract yet | P5-03 (handover part) |
| 5 | **Sales by channel.** In store, online and delivery as three lines in the sales screen, from the till's daily figures | Step 1. Independent of steps 3 and 4 | new card, P5-03b |
| 6 | **Delivery runs.** Who drives, what an order needs at the door, what counts as delivered. A spec written with the owner first, then cards | Step 4, and the owner's answers | P5-07 |
| 7 | **Send a vape delivery to the till on a button.** A confirmed supplier receipt goes to the till as one proposal, only when a person presses the button | Purchase receipts (P5-05), which wait for the model gateway (P5-04) | P5-08 |

### What can start now, and what cannot

- **Now:** steps 1 and 5 need nothing from anyone. Step 2 needs the staff
  screen.
- **After the switch, by the plan as written:** phase 5 was set to follow the
  cutover. Steps 1, 2 and 5 only read from the till and change nothing in
  the store's records, so they can be built before the switch and left
  switched off. Step 3 changes how a till is closed; it should go live only
  after the switch has settled.
- **Waiting on the till side:** the driver handover fields (step 4), the
  flagged-sales field, more staging data, what an auto-closed shift returns,
  and the production key.

### The owner's answers (Nov 27)

1. "Delivery" means delivery runs (step 6): see the deliveries, mark them
   delivered, and see the delivery plan. The till's API has no call that
   lists deliveries or marks one delivered, so step 6 starts with a spec and
   a request to the till side; it no longer waits for step 4.
2. Steps 1, 2 and 5 are built now and left switched off.
