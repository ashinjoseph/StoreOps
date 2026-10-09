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
