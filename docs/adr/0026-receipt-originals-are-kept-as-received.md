# 0026. Receipt originals are kept as received, and served back only to a signed-in session

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [receipts](../components/receipts.md), [assistants](../components/assistants.md), the Operations app (`ops/`; see the [plan for assistants](../plans/2026-11-assistants-through-mcp.md))

## Context

The store is two businesses (cstore and vape): separate companies, separate
HST numbers, separate books. Purchases are a list in a spreadsheet today, with
no receipt behind any row, no business and no tax. A tax audit asks for the
documents, and for HST paid on a purchase to be claimed back, the receipt is
the evidence. The owner decided on Nov 27 that the original (a photo or a PDF)
is kept exactly as received and never deleted, that an assistant later reads
the stored copy, and that every receipt belongs to exactly one business,
decided from signs on the document.

Two things make this the riskiest part of the Operations app so far. A file
comes from a phone, chosen by anyone with a PIN, so it can be anything,
including a page written to run script. And the same file is later sent back
to a manager's browser, on the app's own origin, next to pay and cash.

## Decision

- **The bytes are kept byte for byte, in object storage (Cloudflare R2,
  binding `RECEIPTS`, bucket `storeops-receipts`); the record is in Postgres**
  (`ops.receipt_originals`): the SHA-256 (unique), the size, the type, the
  storage key, who added it and when, where it came from, the business when
  someone says so, and its status. The Worker never resizes, re-encodes,
  strips metadata or converts.
- **Never erased, never overwritten.** All storage goes through one interface
  with `put`, `get` and `head` only (`ops/src/receipts/storage.ts`); a `put` to
  a key that exists is refused; keys are made from a random id and the Toronto
  month, never from anything a person typed. A test fails if the word "delete"
  appears under `ops/src/receipts/`. The app's database role cannot remove a
  row or change the hash, size, type, key or uploader. Because a Worker
  binding cannot be denied the right to erase objects, the hosted bucket also
  gets a retention lock, which is the hosted setup's job.
- **The same bytes twice are one original.** The hash is unique and the
  upload takes a lock on it before looking, so a second upload stores nothing
  and answers "already on file, added … by …".
- **The type is decided by the file's first bytes**: JPEG, PNG, WebP,
  HEIC/HEIF or PDF, by signature. The name and the `Content-Type` sent are
  never used to decide; anything else is refused. The size limit is a setting
  (`receipt_max_mb`, default 10, 1 to 25), checked from `Content-Length`
  before a byte is read and again while reading, with a hard cap.
- **Served back only through `GET /files/receipt-original/<id>`**, to a
  session allowed to see that original, with the stored type,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` with a name
  the app makes, `Cache-Control: private, no-store` and
  `Content-Security-Policy: sandbox; default-src 'none'`. The session comes
  from an `Authorization: Bearer` header, never a URL or a cookie. The page
  fetches the file and shows it from a blob URL. An id the session may not see
  answers exactly as an id that does not exist.
- **One business per receipt, never guessed.** At upload a person may say
  cstore or vape; "not sure" is stored as NULL. The businesses and their signs
  (a name as printed, an HST number, a supplier account, a card's last four
  digits) are kept in `ops.businesses` and `ops.business_signs`; one live sign
  belongs to one business only.

## Consequences

- ✅ The document an audit asks for is the one kept, provably: its SHA-256 was
  taken on arrival and the object can be checked against it at any time.
- ✅ A hostile file cannot run script on the app's origin, whether it is
  opened from the page (a blob of a type the server chose) or by address (the
  sandbox policy, `nosniff`, and no answer at all without the session header).
- ✅ The status column, the reserved sources (`assistant`, `email`) and their
  columns are in place, so the cards that read receipts and file emailed
  invoices add states and rows, not a migration of this table.
- ⚠️ If the row cannot be written after the object was stored, the object
  stays in the bucket, unreferenced. It is harmless and is never removed by
  the app; an upload of the same bytes again makes a new object and the row.
- ⚠️ Holding the hash lock across the R2 write keeps one database connection
  busy for the length of the upload. Fine for one small store.
- ⚠️ Chrome and Firefox cannot show a HEIC photo. It is kept and served as
  received; the page says the device cannot show it.
- ⚠️ A 10 MB limit refuses a large phone photo; the page tells the person to
  choose a smaller picture size, rather than shrinking it, because a shrunk
  copy is not the original.

## Alternatives considered

- **Store the files in Postgres** (`bytea`): the database is backed up,
  restored and copied for every test and staging run; tens of megabytes a
  week of images would make every one of those slower and dearer, and object
  storage exists to hold exactly this.
- **Resize or convert on upload** (to JPEG, smaller): smaller and always
  viewable, but the kept file would no longer be the document received, and
  its fingerprint would not match the one the supplier sent.
- **Public or signed URLs** (a link that works by itself for a while): any
  link can be forwarded, logged by a proxy or kept in a browser's history;
  an original would then be readable without a session, by anyone.
- **Trust the type the browser sends**, or the file name: both are chosen by
  the sender. An SVG or an HTML page sent as `image/png` would be stored and
  served back as whatever it really is.
- **Decide the business from the supplier alone**: the same supplier sells to
  both businesses (a cash-and-carry, a hardware store). The supplier is the
  weakest sign, used last by a later card, and only for a supplier that sells
  to one of the two; nothing in this card guesses.

## Amendment (2026-11-27, card P5-12b): a third route, by one-time ticket

- **`PUT /files/receipt-original/by-ticket/<ticket>`** takes an original from
  an assistant. The ticket (32 random bytes, kept only as a SHA-256) is
  answered once by the tool `receipt_upload_start` to a `propose` key, is for
  one file, lasts 10 minutes, and is dead at once if its key expires or is
  withdrawn, its person is deactivated, or the door is off. It is the only
  credential on that route; every refused ticket is the same 404.
- **Why a ticket in a URL, when originals are never in one:** this address
  only adds a file, never shows one; it works once and briefly; and an
  assistant with a computer can send a plain `PUT` but cannot be given a
  session. A file cannot travel in a tool call (see
  [ADR-0025](0025-assistants-come-in-through-mcp-and-only-propose.md)).
- **The same path as the page's upload**: the size cap and capped reading, the
  type from the bytes, the SHA-256, the duplicate rule and the storage are the
  same functions. The original is added by the key's person, with the key and
  the source (`assistant`, or `email` with the message's id, sender and date).
  0010's check tying the key to source `assistant` only is widened so that an
  emailed original keeps its key.
