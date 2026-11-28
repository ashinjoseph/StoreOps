# The hosted setup: one checklist

Everything the Operations app needs when it stops running on your own
computer and runs hosted. It is the list for the hosted rehearsal (card
P2-10 in the [task cards](../plans/2026-11-operations-app-tasks.md)) and,
done a second time with production names, for the switch itself.

Each build that needs something from the hosted side wrote it in its own
card. This page gathers those in one place. Nothing here has been done yet:
the app has only ever run locally.

**Never put a key in the repository, a chat, a ticket or the Sheet.** Keys
go in your password manager and into the place named below, nowhere else.

## 1. What you provide

| What | Why |
|---|---|
| A Cloudflare account | It runs the app (a Worker), stores the receipt files and the nightly copies (R2), and holds the keys |
| A fresh Supabase project, in the slot freed from the till's staging | The database. A new project, not a reused one, so nothing of the till's is left in it |
| The keys you already have | WhatsApp, the two Clover tokens. Not needed for the rehearsal: leave them out and it sends nothing |
| A day's notice to the till side | For a staging key of theirs, when the till link is tried |

## 2. The database

1. Create the project. Check its Postgres version (`show server_version;`)
   and tell me: the local database is set to the same major version.
2. Run the roles script once in the SQL editor, with three new strong
   passwords (owner, app, read). Password manager first.
3. In the project's API settings, keep `ops` **out of the exposed schemas**.
4. The deploy runs the migrations (there are 14 so far) before the app.

To confirm in the rehearsal:

- that the connection the app uses can hold **one read open for the length
  of a nightly copy** (about a second for the store's size today), and for
  the 8 seconds a till read may take;
- how many connections the plan allows against what the app opens at a
  busy moment;
- that the free plan does not pause the project (a weekly request keeps it
  awake; that request is part of card P2-10 and is not built yet).

## 3. Cloudflare

| Thing | Name | Notes |
|---|---|---|
| The app | `storeops-ops` | Deployed by a workflow, never by hand from a laptop |
| Database connection (Hyperdrive) | binding `HYPERDRIVE` | Made with the **app** role's password. Its id replaces the placeholder in `ops/wrangler.toml` |
| Receipt files | bucket `storeops-receipts` | Private. **Put a retention lock on it** for seven years (the owner confirmed seven, Nov 28): the app cannot be denied the right to erase from its own storage, so the lock is the real guard. (The CRA's guide says six years from the end of the tax year a record belongs to, which can be nearly seven years after the purchase.) **Add a rule that moves a file to the cheaper "infrequent access" storage after 30 days** (the owner's choice, Nov 28: recent receipts at hand, older ones archived). An archived file still opens at once; opening it costs a little, and it cannot be moved back by a rule. **The app's setting `receipt_archive_after_days` (Settings, *Other*; default 30) must be the same number of days as this rule**: the app does not ask the storage which class a file is in, it counts days. If the app's number is the larger, the page opens previews of archived files unasked and each costs the small fee; if it is smaller, it only holds back previews it could have shown. Where the bucket is: no requirement (the owner, Nov 28), so the default location is fine. Every receipt file is in this bucket from the moment it is added; archiving moves it to a cheaper class **inside the same bucket**, not to another place, and the nightly copy holds the records about each file, not the files themselves |
| Nightly copies | bucket `storeops-backups` | Private. **Add a rule that removes copies after 90 days**: the app never deletes one, so without the rule they pile up |
| Schedules | four, already in `ops/wrangler.toml` | Two for the Monday commission run, two for the nightly copy at 03:00 Toronto. Two each so the hour is right in winter and summer |

To confirm in the rehearsal:

- the limits on a scheduled run (time, processing, memory) against a real
  nightly copy;
- that showing an assistant a large receipt photo (an answer of about 11 MB
  that takes about a third of a second to build) is inside the plan's
  limits;
- the size of the app's upload against the plan's limit (about 1.8 MB today,
  0.33 MB compressed).

## 4. The keys, and where each goes

All are set as the Worker's secrets (the dashboard, or `wrangler secret put
NAME`). The Settings screen lists each as "set" or "not set" and never
shows one.

| Key | Needed for | If it is missing |
|---|---|---|
| `PIN_PEPPER` | Every sign-in | Nobody can sign in. **Keep it for ever**: a restored copy of the records is useless without the same value |
| `WHATSAPP_API_TOKEN` | The close and reconcile messages | No message is sent, and the log says so |
| `CLOVER_CSTORE_TOKEN`, `CLOVER_VAPE_TOKEN` | Checking card takings | Cards read "not verified" |
| `TILL_API_KEY` | The till link | The link says "not set up". It lasts 90 days: type its expiry day into Settings when you install it |

Also in the password manager and nowhere else: the three database
passwords, and any assistant key you make (the app shows one once and keeps
only its fingerprint).

## 5. After the first sign-in

On the Settings screen, as an admin:

- check every setting that came over from the Sheet;
- press **Make a copy now** and see "Last copy: …" turn green;
- leave **the till link** and **the assistants' door** switched off until
  each has been tried on purpose;
- check that **`receipt_archive_after_days`** (Other) is the same number of days as the
  rule on the receipt bucket that moves files to the archive.

## 6. What to try in the rehearsal

In this order, each on the hosted app:

1. Sign in, open and close a till, reconcile. (No WhatsApp or Clover keys:
   it should say "not sent" and "not verified", not fail.)
2. A nightly copy, then **download it and restore it** on your computer
   ([the guide](restore-a-nightly-copy.md)). The restore has to end with
   "every table matches".
3. A receipt from **a real phone**: take a photo, see it on the Receipts
   screen. iPhone and Android both, if you have them.
4. The assistants' door with Muse: make a key, connect, ask it who it is
   ([the guide](connect-an-assistant.md)); then have it read a waiting
   receipt and propose the figures.
5. The till link, with the till's staging key: match the store and two
   people; look at sales by channel.
6. The Monday commission run, by waiting for one or by pressing "Run
   engine".

## 7. What it will cost

To be filled in at the rehearsal, service by service: the card requires the
report to name every paid service this turns on and its expected cost.
Known so far: the database plan in use has no automatic backups (hence the
nightly copy), and file storage is charged by how much is kept (a nightly
copy of the store's records today is about 4 MB; receipt photos are a few
MB each).

## 8. What is still not built for hosting

- The workflow that deploys to a staging address and runs the migrations
  first (card P2-10).
- The weekly request that keeps a free database project awake (P2-10).
- A limit on how often the public pages can be asked for.
- The readable Google Sheet copy each night (card P4-06b), if still wanted.
