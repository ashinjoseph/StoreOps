# Receipts and businesses

> Take a photo of a purchase receipt, or pick its PDF, and the app keeps it
> exactly as it was received, for the books and for a tax audit; and the two
> businesses, with what printed on a receipt says which one it belongs to.

<!-- No screenshot: these screens exist only in the Operations app (ADR-0023),
     and the docs runtime (scripts/docs/runtime.js) runs the Apps Script server,
     which has no receipt calls. Nothing in scripts/docs/screens.js can render it. -->

## What it does

Built so far (cards P5-12a and P5-12b), in the Operations app only (inside
Apps Script neither entry exists):

**More → Receipts**, for everyone signed in.

- **Add a receipt**: **Take a photo** (the phone's back camera) or **Choose a
  file** (a JPEG, PNG, WebP or HEIC photo, or a PDF), then which business
  (cstore, vape or *not sure*), an optional note, a preview of what will be
  sent and its size, and **Send**. While sending it says *Sending 2.4 MB…*;
  afterwards *Kept. 2.4 MB, added 2026-11-27 10:05.*, or the server's own
  words: too large, not a photo or a PDF, or *Already on file, added
  2026-11-26 16:40 by Priya Nair.* A photo over the limit is refused on the
  phone before anything is sent, with *Choose a smaller picture size in the
  phone's camera settings and take it again*: the page never shrinks a photo.
- **Admin, manager and payroll admin** see the list: **Waiting**, then **Set
  aside**, newest first, each row with a small preview (images, fetched a few
  at a time as they come into sight) or a PDF mark, who added it and when, its
  size, the business or *business not known*, and the note. Tapping opens the
  original large (a PDF opens in a new tab).
- **Admin and manager**, in that view: **Set aside** (it is not a receipt; a
  reason of 3 to 300 characters; it stays on file under *Set aside*),
  **Put back**, and **Change business** (cstore, vape or not known) on a
  waiting original.
- **An employee** sees *Add a receipt* and what they added in the last 7 days,
  so they can check the photo arrived. Nothing of anyone else's.
- **An original an assistant handed over** (card P5-12b) says *added by Priya
  Nair's assistant (Priya's Muse)*: the key's person and the key's label. One
  from an email also shows its sender and date, as text: *from Fictional
  Corner Supply <billing@…>, sent Nov 26, 09:14 a.m.* Everything else on the
  row is as for a person's upload.

**More → Businesses**, for admin, manager and payroll admin (read only for the
last two). Each business: its display name (the settings
`cstore_business_name`, `vape_business_name`), legal name and HST number
(*not recorded* until an admin types them), notes, and its **signs**: what on
a document says the document is that business's. An admin changes the legal
name, HST number and notes, and adds or removes signs:

| Sign | What it is | Rule |
|---|---|---|
| Name as printed | a trading or billing name as a supplier prints it | 2 to 120 characters, one line |
| HST number | the buyer's number as printed | nine digits, `RT`, four digits; spaces and dashes allowed and dropped (`123456789 RT 0001` is `123456789RT0001`) |
| Supplier account | an account or membership number with one supplier | the number (1 to 60) and the supplier's name (2 to 80) |
| Card ending | a card the business pays with | exactly four digits, never more of the number |

A sign that already belongs to the other business is refused: *The card
ending 4821 already belongs to vape (YV Vape Shop). A sign can belong to one
business only: remove it there first.* A removed sign is kept, marked removed.

**An assistant** (card P5-12b; [assistants](assistants.md)) can list the
originals waiting to be read, be shown one (the stored file itself), hand one
over through a one-time upload address, and ask whether an email has already
been handed over. It reads for the business: any key may list and be shown
every waiting original.

**Drafts: what was read off an original** (card P5-05a;
[ADR-0027](../adr/0027-the-app-decides-the-business-and-checks-the-arithmetic.md)).
An assistant with a `propose` key reads a waiting original and proposes its
figures with the tool `receipt_propose` ([assistants](assistants.md)); an
admin or a manager can instead tap a waiting original and **Enter the figures
by hand** (the same fields, the same code). The app decides the business from
what the document prints about the buyer, checks the arithmetic, and keeps a
**draft that counts for nothing** until a person confirms it (the next card).
The original moves from **Waiting** to **Read, waiting for review**, between
Waiting and Set aside, for admin, manager and payroll admin: each row says
*Read: <supplier> · <date> · <total> · <business or business not known>*, and
*needs attention (N checks failed)* when a check failed. Tapping it opens the
original large with the draft **read only** under it: every field (a blank one
reads *not on the receipt*), the business and how it was decided (*decided by
the card ending 4821*, *not known: nothing printed matched*, *the signs point
at both businesses*) with what a person said at upload beside it, who read it,
each failed check as a sentence with its numbers, the lines, where each figure
was read and the reader's note, and at the bottom *Reviewing and confirming
comes next: nothing here counts yet.* A read original can be set aside (admin,
manager); its business is not changed there. An employee's own list says only
*It has been read.*

**Not built yet** (later cards): no review screen (correct, confirm, void); no
cost history; no QuickBooks export; no import of the old purchase list; no
"this email is handled" list beyond the message ids of originals filed
(P5-13). The supplier list has no screen: a supplier is matched only when a
row for it exists.

## How it works

```mermaid
sequenceDiagram
    actor P as Person (phone)
    participant UI as Index.html (Receipts)
    participant W as Worker /files/receipt-original
    participant DB as Postgres
    participant R2 as R2 bucket (RECEIPTS)
    P->>UI: take a photo, Send
    UI->>UI: size within receipt_max_mb? (else refused here)
    UI->>W: PUT, Authorization: Bearer token, the file as the body
    W->>W: Origin is the app's own (or none)
    W->>DB: the session, as the RPC router resolves it (own transaction)
    W->>W: Content-Length within the limit · read with a hard cap · type from the first bytes · SHA-256
    W->>DB: lock on the hash · already on file? (yes: answer the first, store nothing)
    W->>R2: put originals/YYYY-MM/<id> (type, sha256)
    W->>DB: insert the row · audit receipt_original.add · commit
    W-->>UI: { duplicate, message, record }
    Note over UI,W: Viewing: GET /files/receipt-original/<id> with the same header,<br/>shown from a blob URL, revoked when the view closes
```

**Adding.** `PUT /files/receipt-original`, beside `/rpc/*` and `/mcp` in
`ops/src/index.ts`. Its order: the `Origin` check (a request naming another
origin is refused 403; the page and the API share one origin, so this closes
cross-site uploads with a stolen token); the session from
`Authorization: Bearer <token>` (the page's own token, resolved by the same
`resolveSession` as the RPC router, in its own transaction, so a renewal is
kept as it is for a refused RPC; no token, a bad one, an expired one or a
deactivated person: 401 `NOT_LOGGED_IN`); `Content-Length` required (411) and
within the limit (413) before a byte is read; the body read with a hard cap of
the size claimed (a longer body is refused 413, a shorter one 400); the type
from the first bytes (415 for anything else); the SHA-256; then, in one
transaction: an advisory lock on the hash, the duplicate check, the object put
in R2, the row, and one audit row. New: 201; already on file: 200.

Optional headers, all cleaned on the server: `x-receipt-business` (`cstore` or
`vape`; anything else is "not sure", stored as NULL), `x-receipt-source`
(`photo` or `upload`; anything else is `upload`), `x-receipt-filename` and
`x-receipt-note` (percent-encoded UTF-8). The file name keeps only its last
part after `/` or `\`, loses control and direction characters and leading
dots, and is cut to 120 characters; the note becomes one line of at most 300.
Both are shown to people and never used in a path or a key.

**An assistant's original: `PUT /files/receipt-original/by-ticket/<ticket>`**
(card P5-12b). A file never travels inside a tool call: the tool
`receipt_upload_start` (a `propose` key, counted against its daily cap)
answers a one-time address holding a ticket, 32 random bytes from `crypto` as
base64url, kept in `ops.receipt_upload_tickets` only as its SHA-256. The
ticket is the only credential: no session or assistant key is read on this
route. Its order: `PUT` only (405); **any** `Origin` header refused (403: no
browser has business there); the door on (`assistants_enabled`; off: the same
404 as below, nothing written); `Content-Length` required (411) and within
`receipt_max_mb` (413), before a byte is read and without using the ticket up;
then, in one transaction, the ticket found under a row lock (two PUTs with one
ticket at the same instant take one file). An unknown or malformed ticket, one
used already, one past its 10 minutes, or one whose key has expired or been
withdrawn or whose person is inactive: **the same 404 with one fixed body**,
the reason only in the door's record of calls (flood-limited). A usable ticket
is spent and the PUT recorded, committed **before** the body is read, so the
first PUT that gets that far uses it up whether or not the file is accepted.
Then exactly the page's path: the body read with the same hard cap, the type
from the bytes, the SHA-256, the duplicate rule under the hash lock, the same
storage and audit (`checkLength`, `receiveFile` and `originals.add`, shared
by both routes). The answer is the page's: 201 kept (`id`, `size`, `type`,
*Kept. …*), 200 already on file (`id`, `addedAt`, *Already on file, added …
by …*), or the page's refusal; the ticket is then marked `kept`,
`duplicate` (with the original's id) or `refused` (`not_accepted`, `empty`,
`too_long`, `incomplete`), and one that expires unused is marked `expired`
when it is next seen. Nothing is removed.

**What is recorded for an assistant's or an emailed original.** `added_by` is
the key's person; `assistant_key_id` the key; `source` `assistant`, or `email`
with `email_message_id`, `email_sender` and `email_date` as the assistant gave
them (the message id at most 300 characters and the sender at most 200, with
control characters refused, direction marks removed and the surrounding white
space trimmed; the date a real instant). The file name and the note are
cleaned by the page's own `cleanFileName` and `cleanNote`. The business is
what the assistant declared (`cstore`, `vape`) or NULL. The audit row is the
same `receipt_original.add`, with `assistantKeyId` added. 0010 tied
`assistant_key_id` to source `assistant` only; migration 0012 widens that
check so an emailed original keeps its key (and a later forwarding address can
add an emailed one with none).

**If the row cannot be written after the object was stored** (the database
fails between the two), the answer is an error (500, `SERVER_ERROR` with an
id) and the object stays in the bucket, unreferenced. It is harmless, it is
never removed by the app, and sending the same file again stores it again
with a row.

**Viewing.** `GET /files/receipt-original/<id>` with the same bearer header.
The page cannot put a header on an `<img>`, so it fetches the original and
shows it from a blob URL (an image) or opens a blob URL in a new tab (a PDF).
The answer carries the stored type, `X-Content-Type-Options: nosniff`,
`Content-Disposition: inline; filename="receipt-<id>.<ext>"` (a name the app
makes, never the uploaded one), `Cache-Control: private, no-store` and
`Content-Security-Policy: sandbox; default-src 'none'`, and no cookie or CORS
header. No token in a URL, ever: a token in the query string or a cookie is
ignored (401). An id the session may not see (an employee asking for someone
else's, or their own older than 7 days) answers exactly as an id that does
not exist (404).

**The files accepted**, decided by signature (`ops/src/receipts/sniff.ts`),
never by the name or the type sent:

| Kind | Stored as | Signature |
|---|---|---|
| JPEG | `image/jpeg` | `FF D8 FF` |
| PNG | `image/png` | `89 50 4E 47 0D 0A 1A 0A` |
| WebP | `image/webp` | `RIFF`, four bytes, `WEBP` |
| HEIC / HEIF | `image/heic` | an `ftyp` box first (size 16 or more, within the file), major brand `heic`, `heix`, `hevc`, `hevx`, `heim` or `heis`; or `mif1`/`msf1` with one of those among the compatible brands (AVIF is refused) |
| PDF | `application/pdf` | `%PDF-`, a digit, `.`, a digit |

Anything else (an empty file, a signature cut short, SVG, HTML, a zip, a GIF,
text) is refused with *This file is not a photo or a PDF the app can keep.
Send a JPEG, PNG, WebP or HEIC photo, or a PDF.* A file whose name or header
says one of the five but whose bytes are another of the five is kept as what
its bytes are.

**Storage, locally and hosted.** All storage goes through
`ops/src/receipts/storage.ts`: `put`, `get`, `head`, nothing else. Locally,
`npm --prefix ops run dev` (`wrangler dev`) emulates the bucket on disk under
`ops/.wrangler/` (git-ignored), with no account. Hosted, the bucket
`storeops-receipts` must exist before the Worker is deployed (the hosted setup
creates it; it is never public). **A Worker binding cannot be denied the right
to erase objects**: the code has no way to, and a test keeps it so, but the
binding itself could. So the hosted setup puts a retention lock (an R2 bucket
lock rule) on the bucket, so that nothing, the app included, can remove or
replace an original during the retention period. That is a step of the hosted
setup, not of this code.

**Statuses.** An original is `waiting` (to be read), `drafted` (read: it has a
live draft; card P5-05a) or `set_aside` (not a receipt: reason, by whom, when).
The column's CHECK is named (`receipt_originals_status`); migration 0013 dropped
and re-added it with `drafted` (a check, not a table rewrite). The set-aside
columns are tied to `set_aside` only. A drafted original may be set aside; its
draft leaves the live list with it (kept, unchanged) and putting it back makes
it `drafted` again. The sources
`assistant` and `email` are allowed already, with their own columns (the
assistant key; the email's message id, sender and date), so those cards need
no migration of this table.

**Sign values** are compared in a normal form (`normalise` in
`ops/src/receipts/businesses.ts`): Unicode NFKC (full-width digits become
digits), lower case, every white space and every dash removed. For a supplier
account the key is the supplier's key, a bar, then the number's key, so the
same number at two suppliers is two signs. The database's partial unique index
on `(kind, value_key)` for live signs holds the rule even past the code, and
every sign change takes one advisory lock, so two admins adding the same card
to the two businesses at once cannot both succeed. The HST number of a
business and an `hst_number` sign are checked against each other across the
two businesses.

### Drafts (card P5-05a)

One function makes every draft, `propose` in `ops/src/receipts/drafts.ts`,
called by the tool `receipt_propose` (the reader is the key and its person) and
by `rpcEnterReceiptDraft` (the reader is the signed-in admin or manager). Its
order: read and clean the fields (a refusal here writes nothing); take one
advisory lock for all drafts; lock the original's row; refuse an original that
does not exist, is set aside, or whose live draft a person made; decide the
business from the live signs; match the supplier; look for duplicates; run the
checks; supersede the live draft if there is one; write the draft and its lines;
mark the original `drafted`; audit.

**What is stored** (`ops.purchase_receipts`, one row per reading):

- the original it was read from, and who read it: `read_by_kind` `assistant`
  (with `read_by_key`, and `read_by` the key's person) or `person`, and when;
- **as printed**: the supplier's name and HST number, the invoice number, the
  date (`receipt_date_text` as given; `receipt_date` when it is a real day),
  how it was paid (`cash`, `card` with its last four digits, `account`,
  `other`), the subtotal, HST, total, other charges (a total in `other_total`
  and the labelled parts in the JSON column `other_charges`: they are written
  once, shown to the reviewer and never queried alone, so a child table would
  add a join and nothing else; the total is a column for the checks and the
  export), the kind of purchase, and what it prints about the buyer (name, HST
  number, account number, card's last four);
- **decided by the app**: the business, `business_decided_by` (the kinds of
  sign, or `{conflict}`, `{not_known}`; `{person}` is for the next card), the
  signs that matched (`business_signs`), what a person said at upload
  (`business_person_said`), the supplier it matched (`supplier_id`, or NULL),
  the HST rate used, `needs_attention`, and every check with its result and
  words (`checks`);
- **for the reviewer, as text**: where each figure was read (`where_read`, one
  phrase per field) and the reader's note;
- `ops.purchase_receipt_lines`: per line, the description, the supplier's item
  code, the quantity (`numeric(12,3)`, three decimals), the unit price
  (`numeric(14,4)`, up to four decimals: fuel at 1.459 a litre, 0.3333 each),
  the line total (two decimals) and whether it is taxed (`true`, `false`, or
  NULL when not marked). Lines are optional; nothing is computed from them here
  but the checks, which use the line totals only: quantity × unit price is never
  computed (a pump's 41.287 × 1.459 is 60.237733, printed 60.24, and raises no
  check).

Every field but the original and the total may be left out: it is stored NULL
and answered `null`, and the page says *not on the receipt* (ADR-0004). An HST
of `0` is `0.00`, and is checked as a number.

**Money.** Every amount is a JSON number or a decimal string with at most two
decimals, read through its own spelling and held as integer cents
(`parseMoney`): `12`, `12.5`, `"12.50"`, `-3.10` are accepted; `12.505`,
`"1e3"`, `"1,200.00"`, `"$12.50"`, `"NaN"`, `""`, a number beyond
9,999,999,999.99 and `0.1 + 0.2` (whose spelling is `0.30000000000000004`)
are refused. Sums are of integers; amounts are written to `numeric(12,2)` as
exact text (`centsText`) and read back as text. A quantity is the same with
three decimals (`parseQuantity`). A line's unit price is the one amount with
up to four decimals (`parseUnitPrice`, integer ten-thousandths, the same
refusals otherwise: `1.45901` is refused); it is stored as `numeric(14,4)` and
answered as text with at least two decimals and no trailing zeros past the
second (`unitPriceText`: `1.4590` is answered `1.459`, `6.0000` is `6.00`,
`0.3333` stays), and the page shows that text with a dollar sign, never through
`money()`. Every other amount (line total, subtotal, HST, other charges,
total) still has exactly two decimals.

**The business, decided from the signs** (`decideBusiness`, pure). Each piece
of evidence is compared, in the Businesses card's normal form, with the live
signs of its kind (a removed sign never counts); the card the receipt says it
was paid with is the buyer's card too; an account number counts only at the
supplier printed on the receipt.

| What matched | Business | `business_decided_by` | Words | Check |
|---|---|---|---|---|
| one or more signs, all of one business | that business | the kinds that matched, e.g. `{name,card_last4}` | *decided by the name "…" and the card ending 4821* | passes |
| the same, and a person said that business at upload | that business | the kinds | *…; a person said cstore when it was added, and they agree* | passes |
| the same, and a person said the other business | that business | the kinds | *A person said vape when it was added, but the signs say cstore (…)* | **fails** |
| signs of both businesses | not set | `{conflict}` | *the signs point at both businesses* | **fails**, naming each sign and whose it is |
| nothing | not set | `{not_known}` | *not known: nothing printed matched* | **fails** |

The reader's own guess (`suggested_business`) is stored and shown as *decides
nothing*; the same evidence with and without it gives the same decision. The
supplier is never used to guess. The original's own business is not changed.

**The supplier.** Kept as printed. Matched (`matchSupplier`) against
`ops.supplier_names` by the same normal form, among live spellings of active
suppliers: matched, the supplier's id; not matched, no id (the review card will
let a person pick or create one). This card never creates a supplier.

**The checks** (each a pure exported function; the next card reruns them when a
person edits). Each answers passed, failed or *not checked* (nothing to
check), in words. A failure marks the draft *needs attention*; the draft is
kept.

| Check | Rule, exactly | Passes | Fails |
|---|---|---|---|
| `lines_add_up` | when there are lines, every line has a total, and there is a subtotal: the line totals sum to the subtotal, to the cent | lines 0.10 + 0.20, subtotal 0.30: *The 2 lines add up to $0.30, the subtotal.* | subtotal 0.31: *The 2 lines add up to $0.30, but the subtotal is $0.31 ($0.01 apart).* |
| `parts_add_up` | when there is a subtotal: subtotal + HST + other charges = total, to the cent; a blank HST or other charges count as nothing and the words say so | *Subtotal $50.00 + HST $6.50 = $56.50, the total.* | total 56.51: *… = $56.50, but the total is $56.51 ($0.01 apart).* |
| `hst_plausible`, lines marked | when every line has a total and a taxed/not-taxed mark: HST = rate × the taxed lines, rounded half up to the cent, **within $0.02** either way | taxed 40.00 at 13%, HST 5.22: *HST $5.22 is 13% of the taxed lines ($40.00) = $5.20, within $0.02.* | HST 5.23: *… should be 13% of the taxed lines ($40.00) = $5.20, within $0.02; it is $0.03 more.* |
| `hst_plausible`, not marked | when there is a subtotal: $0.00 ≤ HST ≤ rate × subtotal **+ $0.02** | subtotal 50.00, HST 6.52 | HST 6.53: *HST $6.53 is more than 13% of the subtotal ($50.00) = $6.50, plus $0.02 for rounding.*; HST −0.01: *HST -$0.01 is less than nothing.* |
| `date` | a real day written `YYYY-MM-DD`, not after today in Toronto, not before the same day **7 years** ago (29 February: the 28th) | on Nov 27, 2026: 2026-11-27 and 2019-11-27 | 2026-11-28 (*in the future*), 2019-11-26 (*more than 7 years old*), 2026-02-30 (*not a real day*) |
| `duplicate` | another live reading (a draft or a confirmed receipt of **either** business, of another original, whose original is not set aside) from the same supplier (the same normalised name, or the same matched supplier): the same invoice number (normalised) is a *Duplicate*; with no invoice number on one of the two, the same date and total is a *Possible duplicate*; each names the other draft, its business and its original | another invoice number, another day, a cent different | *Duplicate: invoice INV-77 from … is already on file (draft pr…, vape, receipt original ro…).* |
| `supplier_hst_number` | when printed: nine digits, RT, four digits (spaces and dashes allowed; the Businesses card's `checkHst`) | `123456789 RT 0001` | `12345` |
| `business` | the decision above | decided, and agreeing with a person if one said | not known, conflict, or disagreeing |

The rate is the setting `hst_rate_percent` (default 13, Ontario; 0 to 30 with up
to three decimals; read as exact text, so 0 means 0%); the draft keeps the rate
it was checked with. A draft with only a total has nothing to check: every
check but the business is *not checked*, and with one sign of the buyer
printed it passes outright.

**Refused outright**, with a sentence ending *Nothing was kept.* and nothing
written: no such original (unknown or malformed id); one set aside; one whose
live draft a person made (*A person is working on this one…*); no total; an
amount that is not money (naming the field: *amounts.subtotal is not an
amount…*); a quantity with more than three decimals; a unit price with more
than four; more than 300 lines; a
line with no description; text over its limit (supplier name 120, its HST
number 40, invoice number 60, date 40, buyer's name 120, HST number 40, account
60, a charge's label 80, a line's description 300 and code 60, a where-read
phrase 200, the note 500); a card's last four digits that are not exactly four
digits (never more of a card number), or given for a payment that is not by
card. Text is cleaned first: control and direction characters removed, white
space made single.

**Replacing.** An original has at most one live draft (the database holds it
too: a unique index on the original among `draft` and `confirmed` rows). While
the live draft was proposed by an assistant, any reader may propose again: the
new draft becomes the live one, and the old is marked `superseded` with
`superseded_by` and `superseded_at`, the new one naming it in `supersedes`.
Nothing is deleted. A draft typed by a person (and, with the next card, one a
person edited) is never replaced by a proposal; a person typing over an
assistant's draft supersedes it. Two proposals for one original at the same
instant are taken one after the other (the drafts' advisory lock, then the
original's row lock): exactly one is live afterwards.

**Statuses of a draft.** `draft` (live) and `superseded` are the only ones this
card reaches. `confirmed` (with `confirmed_by`, `confirmed_at`) and `voided`
(`voided_by`, `voided_at`, `void_reason`) are allowed by the CHECK and their
columns exist, unused, for the next cards.

**What the next card needs.** A person's correction is a new row that
supersedes (the figures never change after insert), with `read_by_kind`
`person`; "every field the person changed" is the difference between the two
rows. Confirming and voiding fill the columns above (the app role may already
update them). Learning a sign or a supplier's spelling from a confirmed receipt
inserts into `business_signs` (`learnt_from` `confirmed_receipt`, there since
0010) or `supplier_names` (`learnt_from` `confirmed_receipt`).

### What the model cannot hold yet

Questions for the owner and the bookkeeper. Each is what happens **today**:

| Receipt | Today |
|---|---|
| A credit note or a return (negative total) | accepted (`-3.10` is money); the parts and lines checks work; the HST check fails on a negative HST (*less than nothing*), so it is flagged. Nothing marks it as a credit |
| Tax included in the price, with no HST line | HST left blank: *not checked*; parts add up if the subtotal is the total. The HST paid is then not recorded, so it cannot be claimed |
| A deposit or environmental fee that is itself taxed | goes in other charges, which the HST check does not see: with marked lines the HST is short of rate × taxed lines by the fee's tax and may be flagged |
| Tobacco with its own tax | its tax has no field: as an other charge the parts add up; it cannot be told apart from a deposit |
| A foreign-currency invoice | no currency field: the amounts are stored as if dollars, the HST check runs on them; the note is the only place to say so |
| A statement covering several invoices | one draft per original: one invoice number, one date; the duplicate check does not see the invoices inside it |
| A tip on a meal | an other charge; parts add up; nothing marks it as a tip |

## Data

| Table | Reads | Writes |
|---|:-:|:-:|
| `ops.receipt_originals` | ✓ | ✓ (add; status, set-aside, business only) |
| `ops.receipt_upload_tickets` | ✓ | ✓ (add; spend and outcome only) |
| `ops.assistant_calls` | | ✓ (a PUT to the ticket route) |
| `ops.businesses` | ✓ | ✓ (legal name, HST number, notes only; the two rows are seeded) |
| `ops.business_signs` | ✓ | ✓ (add; mark removed only) |
| `ops.purchase_receipts` | ✓ | ✓ (add; status and the superseded link only; the confirm and void columns for the next cards) |
| `ops.purchase_receipt_lines` | ✓ | ✓ (add only) |
| `ops.suppliers`, `ops.supplier_names` | ✓ (matching) | (none in this card; the app role may add, rename or mark inactive a supplier and mark a spelling removed) |
| `ops.audit_log` | | ✓ |
| `ops.config` | `receipt_max_mb`, `cstore_business_name`, `vape_business_name`, `hst_rate_percent` | |

The first three tables come from `ops/migrations/0010_receipt_inbox.sql`, the
upload tickets from `ops/migrations/0012_receipt_upload_tickets.sql`, the drafts
and the supplier list from `ops/migrations/0013_receipt_drafts.sql`; all are the
Operations app's own (no Sheet tab feeds them) and are not loaded or compared
by the cutover tools (`LATER_OPS_TABLES` in `ops/src/cutover/compare.ts`).
`ops.suppliers` has the name of the Sheet's deprecated `suppliers` tab: it is
the new design that `schema.sql` says the tab's data waits for, never loaded
from it, so the cutover tool's "deprecated tabs have no table" check skips a
later table of the same name. The
legal names and HST numbers start blank: the settings hold display names, not
legal names, and a migration runs before the cutover import has loaded the
settings, so the screen shows the setting's name until one is typed.

## Rules it must not break

- **An original is never erased, overwritten or converted**
  ([ADR-0026](../adr/0026-receipt-originals-are-kept-as-received.md)). No
  `delete` under `ops/src/receipts/`; a `put` never reuses a key; the app's
  database role cannot remove a row or change its hash, size, type, key or
  uploader.
- **The type comes from the bytes**, never from the name or the header.
- **The same bytes are one original**: the SHA-256 is unique, and two uploads
  at once store one object.
- **No original without a session, and none in a URL**: the session comes
  only from the `Authorization` header; the view answer carries the sandbox
  policy and `nosniff`; an id the session may not see answers as a missing one.
  The one exception adds, never shows: an assistant's one-time ticket in the
  upload address, kept as a hash, for one file, for 10 minutes.
- **Every refused ticket is the same 404**, with the same body; the reason is
  only in the record of calls.
- **The business is never guessed**: "not sure" is NULL; one live sign
  belongs to one business.
- **Roles from the session only** (AGENTS.md hard rule 5): a planted `role`,
  `actorId`, `addedBy` or `staffId` changes nothing.
- **Every change is audited**: `receipt_original.add` (id, hash as hex, size,
  type, business, source; never the bytes), `receipt_original.set_aside`,
  `receipt_original.put_back`, `receipt_original.set_business` (before and
  after), `business.update` (before and after), `business_sign.add`,
  `business_sign.remove`; and for drafts (card P5-05a) `receipt_draft.create`
  (the figures as text, the reader, the business decision, the failed checks;
  never the original's bytes or hash), `receipt_draft.supersede`,
  `receipt_draft.taken_out` (its original set aside) and
  `receipt_draft.restored` (put back).
- **The reader reports; the app decides the business** from the live signs
  ([ADR-0027](../adr/0027-the-app-decides-the-business-and-checks-the-arithmetic.md)).
  A reader's guess, the supplier and what a person said at upload never decide
  it.
- **Money is exact**: integer cents from the reader's own spelling, at most two
  decimals; no float sum anywhere (`ops/src/receipts/drafts.ts`).
- **Blank is not zero** (ADR-0004): a field not on the receipt is NULL and
  reads *not on the receipt*; an HST of 0 is a number.
- **A check flags, it never refuses**; a refusal writes nothing.
- **A draft counts for nothing** and changes nothing else; its figures never
  change (a new reading supersedes; the app role cannot update them); nothing
  is deleted.
- **What a reader wrote is data**: cleaned and capped, through `asData` to an
  assistant and `esc()` on the page.

| Who | Add an original | List and view | Set aside, put back, change business | Read businesses | Change businesses | See a draft | Enter a draft by hand |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| employee | ✓ | own, last 7 days (*It has been read.*) | | | | | |
| payroll admin | ✓ | ✓ | | ✓ | | ✓ | |
| manager | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ |
| admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| an assistant key | | waiting and read originals (tools) | | ✓ (tool) | | its own (`my_proposals`) | `propose` right: `receipt_propose` |

## Questions for a real phone test

Read from the code and the platforms' documentation, not yet tried on a phone:

- **iPhone:** the camera saves HEIC by default ("High Efficiency"). Through
  `<input type="file" accept="image/*" capture="environment">`, Safari usually
  hands the page a **JPEG** it converted, not the HEIC; *Choose a file* from
  Files may hand over the HEIC itself. Which one arrives, and whether it is
  still the camera's original, is to be checked.
- **Size:** a 12-megapixel photo is typically 2 to 5 MB as JPEG (1.5 to 3 MB as
  HEIC); a 48- or 50-megapixel "high resolution" mode can pass 10 MB. The
  limit is a setting if 10 MB proves tight.
- **`capture`:** on Android Chrome and iOS Safari it opens the camera
  directly; on a computer it is ignored and the file picker opens. Some
  Android browsers ignore it and offer a chooser.
- **HEIC display:** Safari shows HEIC; Chrome and Firefox on a computer do
  not, so a manager on a laptop sees "this device cannot show this kind of
  photo" for a HEIC original (it is still kept as it was sent).

## Code map

| What | Where |
|---|---|
| Routes | `ops/src/receipts/routes.ts`: `handleUpload`, `handleView`, `handleTicketUpload`, `checkLength`, `receiveFile`, `readCapped`, `NO_TICKET_BODY`, `VIEW_CSP`; wired in `ops/src/index.ts` (`/files/receipt-original`, `/files/receipt-original/by-ticket/`) |
| Upload tickets | `ops/src/receipts/tickets.ts`: `ask`, `lockForPut`, `spend`, `markOutcome`, `proposals`, `byMessageIds`, `cleanEmailText`, `parseEmailDate`, `TICKET_PREFIX` |
| Originals | `ops/src/receipts/originals.ts`: `add`, `inbox`, `forView`, `toRead`, `forAssistant`, `setAside`, `setBusiness`, `maySee`, `maxBytes`, `cleanFileName`, `cleanNote` |
| The type | `ops/src/receipts/sniff.ts`: `sniff`, `CONTENT_TYPES`, `NOT_ACCEPTED` |
| Storage | `ops/src/receipts/storage.ts`: `ReceiptStorage`, `bucketStorage`, `memoryBucket`, `isBucket`; the binding in `ops/wrangler.toml` (`[[r2_buckets]]`, `RECEIPTS`) |
| Businesses | `ops/src/receipts/businesses.ts`: `list`, `update`, `addSign`, `removeSign`, `normalise`, `signKey`, `checkHst` |
| Drafts (card P5-05a) | `ops/src/receipts/drafts.ts`: `propose`, `getDraft`, `proposals`, `takenOut`, `restore`; the pure parts `readFields`, `decideBusiness`, `checkLinesAddUp`, `checkPartsAddUp`, `checkHstPlausible`, `checkDate`, `checkDuplicates`, `checkSupplierHst`, `checkBusiness`, `parseMoney`, `parseQuantity`, `centsText`, `moneyText`, `expectedHst`, `hstRateMilli`; the shared input `draftInputSchema`, `parsePageInput`; `matchSupplier`, `liveSigns`, `isRefusal` |
| RPCs | `ops/src/rpc/handlers/receipts.ts`: `rpcGetReceiptInbox`, `rpcSetReceiptAside`, `rpcSetReceiptBusiness`, `rpcGetBusinesses`, `rpcUpdateBusiness`, `rpcAddBusinessSign`, `rpcRemoveBusinessSign`, `rpcGetReceiptDraft`, `rpcEnterReceiptDraft` (card P5-05a); listed in `ops/contracts/rpc-ops.json` |
| Tables | `ops/migrations/0010_receipt_inbox.sql`; `ops/migrations/0012_receipt_upload_tickets.sql` (the tickets); `ops/migrations/0013_receipt_drafts.sql` (drafts, lines, suppliers and their spellings; `drafted`) |
| Setting | `receipt_max_mb` and `hst_rate_percent` in `ops/src/lib/config-keys.ts` (`OPS_ONLY_KEYS`) and `ops/src/modules/settings.ts` (group *Other*) |
| The assistant's view | the `businesses`, `receipts_to_read`, `receipt_original`, `receipt_upload_start`, `receipts_from_email` and `receipt_propose` tools in `ops/src/mcp/tools.ts` ([assistants](assistants.md)) |
| UI | `src/Index.html`: `loadReceiptsTab`, `renderReceiptsTab`, `sendReceiptOriginal_`, `fetchReceiptOriginal_`, `receiptTooLarge_`, `openReceiptSheet_`, `revokeReceiptBlobs_`, `receiptDraftHeadHTML_`, `receiptDraftHTML_`, `openReceiptDraftEntry_`, `receiptDraftInput_`, `receiptDraftLineHTML_`, `loadBusinessesTab`, `renderBusinessesTab`, `openBusinessSignSheet_`; the `receipts` and `businesses` entries of `MORE_ITEMS` (`opsOnly`) |

## Tests

| Suite | Holds down |
|---|---|
| `ops/test/receipt-inbox.test.ts` | through the Worker's own `fetch` with the in-memory bucket: each of the five types kept with the type its bytes say, whatever was sent; the exact signatures; SVG, HTML, zip, GIF, empty, cut-short refused with nothing stored or written; over the limit refused before the body is read, a lying `Content-Length` stopped at its claim, the limit following the setting; byte for byte and the real SHA-256; the same bytes twice (and twice at once on two connections) one object and one row; no `delete` under `src/receipts/`, no key reused, the database role unable to remove or rewrite; set aside and put back leaving the object and hash; who may add, list, view, set aside and change business; a foreign `Origin`; the view's headers for an image and a PDF, no cookie, no CORS, the same 404 for a forbidden and a missing id, no answer without the header; the audit rows; names and notes cleaned and kept out of the key; a failure after the object was stored; no other table moved |
| `ops/test/mcp-receipts.test.ts` | card P5-12b: an assistant's originals by ticket through the Worker's `fetch` and the tools through the SDK client: the whole flow; byte for byte both ways for the five kinds; the ticket single use, 10 minutes exactly, the same 404 for every refused ticket, one file from two PUTs at once, nowhere stored or answered but once; the page's file rules on this route; who it belongs to and what is recorded; email ids; planted text cleaned; nothing else moved. The refactor of the upload path (`checkLength`, `receiveFile`) is held by `ops/test/receipt-inbox.test.ts`, unchanged |
| `ops/test/receipt-drafts.test.ts` | card P5-05a, against a real database, the pure functions directly, the tool through the SDK's own client and the RPCs through the real router: money spellings accepted and refused and sums in cents where floats differ; every check at and just past its tolerance with its sentence; a draft with every check failing kept and flagged; only a total; the business decision as a table (each kind, two agreeing, both businesses, nothing, a removed sign, spellings, the paid card, a person's word at upload agreeing and disagreeing, a suggestion deciding nothing); supplier matching, never created; every left-out field NULL; HST 0 checked; duplicates across both businesses, possible duplicates, superseded and set-aside ones not counted; replacing, a person's draft not replaceable, two at once one live, the unique index; each refusal writing nothing; a fuel receipt kept exactly (quantity 41.287, unit price 1.459) through the tool and the by-hand RPC, a fifth decimal refused, nothing computed from quantity × unit price; drafted, `receipts_to_read`, set aside and put back; who may (tool rights, daily cap, RPC roles, planted fields); hostile text cleaned; audit rows; the role's rights; nothing else moved; the setting; the by-hand path and the inbox headline |
| `ops/test/businesses.test.ts` | the seven RPCs' roles in the merged contract; the two seeded businesses, blank until typed; every field rule; the HST number normalised and never shared; each kind of sign, normalised; a sign refused at the other business however it is spaced, dashed or cased, also by the database; two admins at once; removal kept and audited; who may; the assistant's `businesses` tool through the SDK client showing the new fields and nothing else |
| `ops/test/mcp-door.test.ts` | the `businesses` tool's exact keys; the pinned tool list (with `receipt_propose`, card P5-05a) |
| `ops/test/db-migrate.test.ts`, `ops/test/cutover-tool.test.ts` | the new tables (0010, 0012, 0013) present and skipped by the cutover tools |
| `tests/suites/ui-receipts.js` | an assistant's original says *added by <person>'s assistant (<key label>)*, an emailed one its sender and date, all escaped (card P5-12b); both drawer entries `opsOnly` with their roles; per role, what is rendered (an employee: no list of others, no set-aside or business control); the oversize photo refused before any request; the token only in an `Authorization` header, never in a URL, a toast or storage; blob URLs revoked; the built page carries both screens and Apps Script hides them; card P5-05a: the *Read, waiting for review* group between Waiting and Set aside (asked for only when there are some), its headline, the read-only draft per role (blank reads *not on the receipt*, a failed check reads as its sentence, hostile text escaped), an employee's *It has been read.*, *Enter the figures by hand* for admin and manager only, the by-hand sheet sending exactly the fields typed (nothing as 0 or ""), lines added one at a time |

## History

- **Nov 2026 (card P5-05a):** drafts: what was read off an original, proposed
  by an assistant (`receipt_propose`) or typed by an admin or manager (*Enter the
  figures by hand*, `rpcEnterReceiptDraft`), checked by the app and kept as a
  draft that counts for nothing; the business decided by the app from the signs;
  the *Read, waiting for review* group and the read-only draft view
  (`rpcGetReceiptDraft`); the original's new status `drafted`; four tables
  (`ops.purchase_receipts`, `ops.purchase_receipt_lines`, `ops.suppliers`,
  `ops.supplier_names`, migration 0013); the setting `hst_rate_percent`
  ([ADR-0027](../adr/0027-the-app-decides-the-business-and-checks-the-arithmetic.md)).
  `receipt_original` now also shows a read original, so a draft can be looked at
  again and corrected; the inbox's counts gain `drafted`.

- **Nov 2026 (card P5-12b):** an assistant's way in: the ticket route
  `PUT /files/receipt-original/by-ticket/<ticket>` and its table
  (`ops.receipt_upload_tickets`, migration 0012), the assistant's four inbox
  tools ([assistants](assistants.md)), and on the Receipts screen *added by
  <person>'s assistant (<key label>)* and an emailed original's sender and date
  ([ADR-0026, amended](../adr/0026-receipt-originals-are-kept-as-received.md)).

- **Nov 2026 (card P5-12a):** the two businesses and their signs, the receipt
  inbox (originals kept byte for byte in R2 with a SHA-256 in Postgres), the
  upload and view routes, the Receipts and Businesses screens, and more in the
  assistant's `businesses` tool
  ([ADR-0026](../adr/0026-receipt-originals-are-kept-as-received.md)).
