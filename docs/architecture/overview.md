# Architecture overview

StoreOps is a **serverless web app on Google Apps Script** that uses a **Google
Sheet as its database**. A cashier opens it on a phone, signs in with a PIN, and
runs the till; managers and the owner use the same app for schedules, cash,
reconciliation, payroll and commissions. Two pages are public (no login) and
show aggregates only.

| | |
|---|---|
| Runtime | Apps Script, V8, time zone `America/Toronto` |
| Storage | One Google Sheet: 23 data tabs + 4 import staging tabs ([schema](../reference/schema.md)) |
| Server code | 23 `.gs` modules, ~11k lines |
| Client | 3 HTML files: the app (`Index.html`, single page) and two public pages |
| API surface | 61 `rpc*` functions called through `google.script.run` |
| Integrations | Clover REST (card totals), WhatsApp Cloud API (templated messages) |
| Delivery | GitHub Actions → `clasp push` (branch → test project, `main` → prod) |
| Tests | 23 suites, 800+ assertions, run in Node against the real source |

## System context

Who uses it, and what it talks to.

```mermaid
flowchart TB
    subgraph people[" "]
        direction LR
        cashier(["👤 Cashier<br/>opens and closes tills"])
        manager(["👤 Manager<br/>schedule · cash · reconcile"])
        admin(["👤 Owner / admin<br/>payroll · rules · staff"])
        reader(["👥 Owners and partners<br/>no login"])
    end

    subgraph google["Google Workspace"]
        direction LR
        app["<b>StoreOps web app</b><br/>Apps Script · V8<br/>61 RPCs · 2 public pages"]
        sheet[("<b>Google Sheet</b><br/>23 data tabs<br/>+ 4 import staging tabs")]
        props[("Script properties<br/>sessions · lockouts")]
        app <--> sheet
        app <--> props
    end

    subgraph ext["External services"]
        direction LR
        clover["💳 Clover REST API<br/>vape card totals"]
        meta["💬 WhatsApp Cloud API<br/>approved templates"]
        gh["⚙️ GitHub Actions<br/>clasp push"]
    end

    cashier -- "PIN login" --> app
    manager -- "PIN login" --> app
    admin -- "PIN login" --> app
    reader -- "?v=sales · ?v=recon" --> app
    app -- "card totals per shift" --> clover
    app -- "open · close · shopping list" --> meta
    gh -- "main → prod · branch → test" --> app
```

## Containers and layers

Every request takes the same path: the browser calls an `rpc*` function, the
RPC checks the session and role, a domain module does the work, and the module
reads or writes the sheet. The UI holds no business logic it can't redraw from
the server's answer.

```mermaid
flowchart TB
    subgraph browser["Browser (phone first)"]
        spa["<b>Index.html</b><br/>single-page app<br/>token in localStorage"]
        pub["<b>PublicSales.html · Public.html</b><br/>data inlined at render"]
    end

    subgraph gas["Apps Script project"]
        doget["doGet(e)<br/>routes on ?v="]
        rpc["<b>WebApp.gs</b><br/>61 rpc* endpoints<br/>validate session → require role"]
        auth["Auth.gs<br/>PIN login · rolling sessions · lockout"]
        domain["<b>Domain modules</b><br/>TillSessions · Sales · Reconcile · CashHandling<br/>Attendance · Payments · Bonuses · Commissions<br/>ProductMaster · ShoppingList · PublicReport"]
        infra["<b>Infrastructure modules</b><br/>Util · AuditLog · Notifier · Clover · Setup"]
        menu["Sheet menu · onOpen<br/>setup · migrations · imports"]
        trig["Time trigger<br/>weekly commission run"]
    end

    subgraph store["Google storage"]
        sheet[("Google Sheet")]
        cache[("CacheService<br/>config · staff · products")]
        props[("PropertiesService<br/>sessions")]
    end

    spa -- "google.script.run" --> rpc
    pub -. "GET ?v=sales / ?v=recon" .-> doget
    spa -. "GET (no ?v)" .-> doget
    rpc --> auth
    rpc --> domain
    doget --> domain
    menu --> domain
    trig --> domain
    domain --> infra
    auth --> props
    domain --> sheet
    domain --> cache
    infra --> sheet
```

Three ways in, one way down:

- **The app** (`doGet` with no `?v`) serves `Index.html`. Everything after that
  is `google.script.run` → `rpc*`.
- **The public pages** (`?v=sales`, `?v=recon`) are rendered on the server with
  their data **inlined into the HTML**. They expose no RPC, so there is nothing
  callable without a session. See [ADR-0003](../adr/0003-public-pages-inline-their-data.md).
- **The spreadsheet menu** runs setup, schema migrations and product imports
  as the sheet owner. Imports live here rather than in the app because they run
  over hundreds of rows. See [ADR-0010](../adr/0010-bulk-import-reads-once-writes-once.md).

## Module map

Modules sit in four layers, and calls go down. The table below gives each
module's direct dependencies, computed from the source; the few calls that go
sideways or up are named under it.

```mermaid
flowchart TB
    entry["<b>Entry points</b><br/>WebApp (61 rpc* · doGet) · PublicReport · Setup (menu, migrations, imports) · Monday trigger"]
    flows["<b>Workflows</b>: one user action, several tables<br/>TillSessions · Reconcile · CashHandling · Commissions · ShoppingList"]
    records["<b>Records</b>: one table each, with its rules<br/>Attendance · Sales · Payments · Bonuses · CommissionRules · ProductMaster · ProductTypes"]
    shared["<b>Shared services</b><br/>Auth · Staff · Notifier · Clover · AuditLog · Util"]
    sheet[("Google Sheet")]
    ext["Clover API · WhatsApp Cloud API"]

    entry --> flows --> records --> shared
    entry -. "reads directly" .-> records
    records --> sheet
    flows --> sheet
    shared --> ext
```

| Module | Depends on (besides `Util` and `AuditLog`) |
|---|---|
| `TillSessions` | Attendance, Sales, Staff, Notifier |
| `Reconcile` | TillSessions, Sales, CashHandling, Clover, Staff, Notifier |
| `CashHandling` | TillSessions, Staff |
| `Commissions` | Sales, CommissionRules, Bonuses, Staff, Notifier |
| `ShoppingList` | ProductMaster, Staff, Notifier |
| `Attendance` | Payments (is a day paid?), Staff, TillSessions |
| `Payments` | Attendance, Bonuses, Staff, Notifier |
| `Bonuses` | Payments (paid amounts), Staff |
| `ProductMaster` ⇄ `ProductTypes` | each other (registry and machinery), Setup (sheet names) |
| `PublicReport` | Sales, Reconcile, CashHandling, TillSessions |
| `Auth` | Staff |

The exceptions: `Attendance` and `Bonuses` ask `Payments` how much of a day
or bonus is already paid, and `Attendance` reads the day's `TillSessions` when it
completes a workday. Apps Script resolves globals at call time, so
these cycles are safe, but they're the places to be careful when changing
either side.

Every module is an IIFE that returns a small public object (`const Sales = (()
=> { ... return { getDashboard, write, ... }; })();`). Private helpers end in
`_`. Apps Script loads all files into one global scope, so this is what keeps a
file's internals private.

## The daily flow, end to end

What happens when a cashier closes the last till of the day. This is the path
that matters most: it produces the numbers the owner reads every evening.

```mermaid
sequenceDiagram
    autonumber
    actor C as Cashier
    participant UI as Index.html
    participant W as WebApp.gs
    participant T as TillSessions
    participant S as Sales
    participant A as Attendance
    participant R as Reconcile
    participant CL as Clover API
    participant N as Notifier
    participant WA as WhatsApp

    C->>UI: count drawer, enter tenders, count lotto pot
    UI->>W: rpcCloseShift(token, input)
    W->>W: Auth.validate · role check
    W->>T: close(session, figures)
    T->>T: expected = float + cash sales + misc cash − cashback + reserve fed
    T->>S: write sales row (one card shape per row)
    T->>A: last till closed? complete the day, snapshot the rate
    T-->>UI: variance + status
    UI->>W: rpcReconcileDay(token, auto)
    W->>R: reconcileDay
    R->>CL: card totals for each shift window (vape only)
    CL-->>R: credit · debit · total, or not_configured
    R->>R: write validation_results (blank = not measured)
    R->>N: sendOp(shift_close_{till}, params)
    N->>WA: approved template, parameter count per template
    WA-->>N: 200, or an error that is reported back
    R-->>UI: summary, including whether WhatsApp was sent
```

## The Operations app (being built)

The replacement for the Apps Script app (`ops/`, not live yet; see the
[migration plan](../plans/2026-11-operations-app-migration.md)) is one
Cloudflare Worker over Postgres. It serves the same page (`src/Index.html`,
built into the Worker's assets) and has five ways in, each with its own way of
saying who is calling:

```mermaid
flowchart LR
    page["Browser<br/>Index.html + transport.js"]
    asst["AI assistant<br/>(Muse, Claude)"]
    pub["Owners, no login"]
    subgraph worker["Cloudflare Worker (ops/src/index.ts)"]
        rpc["/rpc/*<br/>RPC router · session token"]
        files["/files/receipt-original<br/>PUT adds one · GET /id shows one<br/>session as a Bearer header"]
        mcp["/mcp<br/>MCP door · assistant key<br/>off unless switched on"]
        ticket["/files/receipt-original/by-ticket/…<br/>PUT one file · one-time ticket"]
        pages["/?v=recon · /?v=sales<br/>data inlined"]
    end
    pg[("Postgres<br/>(Hyperdrive)")]
    r2[("R2 bucket RECEIPTS<br/>receipt originals")]
    r2b[("R2 bucket BACKUPS<br/>the nightly copy, 90 days")]
    cron["Cron 03:00 Toronto<br/>(07:00 and 08:00 UTC)"]
    page --> rpc
    page --> files
    asst --> mcp
    asst --> ticket
    pub --> pages
    rpc --> pg
    files --> pg
    files --> r2
    mcp --> pg
    mcp --> r2
    ticket --> pg
    ticket --> r2
    pages --> pg
    cron --> pg
    cron --> r2b
    rpc -. "Make a copy now" .-> r2b
```

- **`/rpc/*`**: every screen's calls, checked against the contract
  (`ops/contracts/rpc.json` plus the app's own `rpc-ops.json`,
  [ADR-0023](../adr/0023-the-operations-app-has-rpcs-and-screens-of-its-own.md)).
- **`/mcp`**: the door for AI assistants, with a key per person and only
  read and propose tools
  ([ADR-0025](../adr/0025-assistants-come-in-through-mcp-and-only-propose.md);
  [assistants](../components/assistants.md)).
- **`/files/receipt-original`**: receipt originals, uploaded as raw bytes and
  served back only to a signed-in session; the bytes are kept in R2, their
  record in Postgres
  ([ADR-0026](../adr/0026-receipt-originals-are-kept-as-received.md);
  [receipts](../components/receipts.md)).
- **`/files/receipt-original/by-ticket/<ticket>`**: the third file route, for
  an assistant that has a file to hand over. A file never travels inside a
  tool call: the `receipt_upload_start` tool answers a one-time address (a
  ticket kept only as a hash, ten minutes, one file, tied to the key), and
  the assistant `PUT`s the raw file there; it then goes through the page's
  own checks and storage
  ([ADR-0026, amended](../adr/0026-receipt-originals-are-kept-as-received.md);
  [assistants](../components/assistants.md)).
- **The public pages**, as before: no session, the data inlined
  ([ADR-0003](../adr/0003-public-pages-inline-their-data.md)).

Two scheduled jobs run beside them, each told by its cron expression and each
independent of the other: the **Monday commission run** (09:00 Toronto, as
before) and the **nightly copy** (03:00 Toronto, both UTC hours that can be
03:00 there; the job does nothing unless it is). The copy reads every table in
one read-only, repeatable-read transaction and writes dated files plus a
manifest to a **second R2 bucket, `BACKUPS`**, apart from the receipts bucket so
that the receipts' permanent retention and the copies' 90 days never meet; the
app can only add to it, and a lifecycle rule on the bucket does the pruning. An
admin can also make a copy at once (`rpcRunBackupNow`, "Make a copy now" on
Settings). `npm run restore:nightly` loads a copy into an empty local database
and checks every table
([ADR-0028](../adr/0028-the-app-makes-its-own-nightly-copy.md);
[backups](../components/backups.md)).

## Cross-cutting rules

These hold across every module. Each has an ADR with the reasoning.

| Rule | Where it bites | ADR |
|---|---|---|
| **Blank is not zero.** A cell nobody measured reads back as `null`, never `0`. | Card columns, Clover figures, public report | [0004](../adr/0004-blank-is-not-zero.md) |
| **Add columns, never repurpose them.** A schema change is a migration that appends. | `sales` card shapes, `needs_detail`, `fixed_amount` | [0005](../adr/0005-card-shapes-are-mutually-exclusive-columns.md) |
| **The server decides.** Roles come from the session, never from the client. | Every `rpc*` | [0002](../adr/0002-pin-login-with-server-side-sessions.md) |
| **Read once, write once.** No sheet call inside a per-row loop. | Imports, dashboards, commission runs | [0010](../adr/0010-bulk-import-reads-once-writes-once.md) |
| **Fail loudly, degrade gracefully.** An integration failure is reported, never swallowed, and never blocks a close. | Clover, WhatsApp | [0007](../adr/0007-message-shape-follows-the-template.md) |
| **Every change is audited.** Money, roles and rules write to an append-only `audit_log`. | Payments, handovers, rules, logins | [0014](../adr/0014-append-only-audit-log.md) |

## Where to read next

- [Data model](data-model.md): the tables, how they relate, and the invariants
- [Security](security.md): login, sessions, roles, the public pages
- [Deployment](deployment.md): environments, CI, configuration, migrations
- [Components](../components/README.md): one page per feature, with screenshots
