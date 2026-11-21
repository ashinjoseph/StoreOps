# Plan — StoreOps becomes the Operations app, off Sheets

> **Status: draft for owner review.** Nothing here is built. The decisions in
> section 3 carry a proposed default each; change any of them and the task
> cards that depend on it are listed beside it. The work itself is split into
> small cards in [the task file](2026-11-operations-app-tasks.md), written so
> that a small, cheap model can do most of them and a stronger model only
> plans, reviews the money paths and unblocks.

## 1. Why

- **Sheets is the bottleneck.** Every request re-reads whole tabs, the audit
  log grows by about 1,200 rows a month, and Apps Script adds a cold start and
  a 6-minute limit. It gets slower with every month of trading.
- **Staff type what the till already knows.** The vape till platform records
  each shift's float, cash sales, counted cash, variance and card split. The
  vape close in StoreOps asks the cashier for the same figures again.
- **New work needs things Apps Script can't do well:** an installable phone
  app, photo upload for purchase receipts, delivery runs, and LLM calls with
  a spending cap.
- **Operations must stay separate from the till.** The till carries audit and
  tax duties. Payroll, attendance, cash handovers and internal planning are
  internal, and must not live in or write to the till's database.

## 2. Target

```mermaid
flowchart TB
    subgraph people[" "]
        direction LR
        staff(["Staff phones<br/>installable web app"])
        owner(["Owners<br/>no-login pages"])
    end

    subgraph cf["Cloudflare"]
        direction LR
        app["<b>Operations Worker</b><br/>today's UI and rpc names<br/>cron: weekly commissions, nightly export"]
        wai["Workers AI<br/>first-pass model"]
        r2[("R2<br/>receipt images")]
    end

    subgraph data["Operations data"]
        direction LR
        opsdb[("Operations data<br/>ops schema on Supabase")]
        sheet[("Google Sheet<br/>nightly read-only copy")]
    end

    subgraph ext["Outside services"]
        direction LR
        till["Till platform API<br/>read figures · send proposals"]
        claude["Claude API<br/>behind a flag, prepaid"]
        wa["WhatsApp Cloud API"]
    end

    staff --> app
    owner --> app
    app --> wai
    app --> r2
    app --> opsdb
    opsdb --> sheet
    app --> till
    app -. "only on failed checks" .-> claude
    app --> wa
```

What stays the same on purpose:

- **The 62 `rpc*` names, parameters and role rules.** The UI keeps calling
  them; only the transport and the storage underneath change. This is what
  makes the port checkable: old and new must return the same answer.
- **Every rule in the ADRs.** Blank is not zero becomes `NULL` is not zero.
  Append-only audit, void-never-delete, proposed-then-approved, public pages
  with inlined data, and the WhatsApp template shapes all carry over.
- **The UI.** `Index.html` moves as it is. It already talks to the server only
  through `call()` and `cachedCall()`.

What changes:

| Today | After |
|---|---|
| Google Sheet tabs | Postgres tables, one per tab, same column names |
| `Setup.gs` and menu migrations | Numbered SQL migration files |
| Sessions in script properties | `sessions` and `login_failures` tables |
| Secrets in the `config` tab | Worker secrets; `config` keeps only non-secret settings |
| No locking on payments and handovers | One database transaction with a row lock per allocation |
| Monday trigger installed by hand | Cloudflare cron trigger |
| Staging tabs for product import | CSV upload, same validation |
| Vape close typed by the cashier | Figures fetched from the till API, confirmed by the cashier |
| `cstore` / `vape` per person | Person assigned to stores; every record carries a store |

## 3. Decisions to confirm

Each has a proposed default. Cards that change if you choose differently are
named in the last column.

| # | Decision | Proposed default | Affects |
|---|---|---|---|
| D1 | Where the new code lives | An `ops/` folder in this repo. Docs, ADRs, history and the old source stay beside it for porting. | P2-01 |
| D2 | Database | **Revised (Nov 21):** a separate `ops` schema inside the existing Supabase projects, with its own database role that has no grants on the till's tables, and not exposed through Supabase's public API. Move it to its own project when the organization goes to a paid plan. See "Answers" below. | P0-03, P2-02, P2-10 |
| D3 | How the Worker reaches it | Plain SQL through Supabase's connection pooler, via Cloudflare Hyperdrive. Tests run on an in-process Postgres, so CI needs no database server. | P2-02, P2-03 |
| D4 | Company and store | `cstore` and `vape` stay as companies. A store is a location; there is one today. A till belongs to a company in a store. | P0-03, P5-01 |
| D5 | Login | Name and 4-digit PIN with lockout, as today, at launch. A stronger second step for admin and payroll roles in phase 5. | P2-06, P5-02 |
| D6 | Where PINs are checked | Operations' own PINs at launch. Delegated to the till API in phase 5 for people who have a till login. | P2-06, P5-02 |
| D7 | cstore ePOS | **Answered:** no integration; the cstore close stays manual. One-off exports are possible, so P4-03 may use one to cross-check past cstore card totals during the dry run. | P3-05, P4-03 |
| D8 | Which Claude model handles escalations | The smallest current model, with the model name as a setting. Changing it is a config edit. | P5-04 |
| D9 | Quick wins on the current app | Do the audit-log archive now. Do the vape prefill on the current app only if the till API is ready before phase 3 ends. | P1-01, P1-03 |
| D10 | Owner's view of the data | A nightly read-only export to a Google Sheet. | P4-06 |
| D11 | Cutover | One switch on a quiet morning, after a full dry run, with the Sheet app kept read-only for 30 days as the way back. | P4-04, P4-05 |
| D12 | Who orchestrates | A strong-model session hands out cards and reviews. The owner approves every merge to `main` and every production step. | section 5 |

### Answers (Nov 21)

1. **Hosting moves from Netlify to Cloudflare; the database stays on
   Supabase.** The till's database needs no migration: Workers reach
   Supabase through its connection pooler, via Hyperdrive or Supabase's own
   client library. What does need care in that move: secrets and environment
   variables, Netlify functions rewritten for the Workers runtime, and using
   the pooler rather than direct connections.
2. **cstore ePOS:** no daily export, and its API is paid, so no integration.
   One-off exports can be done (see D7).
3. **The owner builds the till-side API**, from
   [the till API request](2026-11-till-api-for-operations.md), and shares the
   resulting contract back.

**Why D2 changed.** The Supabase organization is on the free plan and
already runs two projects, staging and production. A third and fourth
project for Operations would likely need the paid plan; check Supabase's
current limits. A separate schema with its own role keeps the boundary that
matters (Operations can't read or write the till's tables, and the till
never reads Operations'), costs nothing, and moves out to its own project
with one dump and restore. What it doesn't separate: both share one
database's capacity, backups and maintenance windows.

## 4. Phases

```mermaid
flowchart LR
    p0["<b>0 Contracts</b><br/>decisions · schema · API contract"]
    p1["<b>1 Quick wins</b><br/>audit archive · till API · vape prefill"]
    p2["<b>2 Foundation</b><br/>Worker · database · login · parity harness"]
    p3["<b>3 Port</b><br/>module by module, checked against the old app"]
    p4["<b>4 Data and cutover</b><br/>import · dry run · switch · way back"]
    p5["<b>5 New abilities</b><br/>stores · till link · LLM · receipts · deliveries"]
    p6["<b>6 App</b><br/>installable · optional store listings"]

    p0 --> p2 --> p3 --> p4 --> p5 --> p6
    p0 --> p1
    p1 -. "till API reused" .-> p5
```

| Phase | Ends when | Ships to staff? | Cards |
|---|---|---|---:|
| 0 Contracts | The schema, the till API contract and the RPC list are files in the repo, and the remaining decisions are answered | No | 4 |
| 1 Quick wins | The audit log is archived; the till API answers for one real shift | Yes, on the current app | 3 |
| 2 Foundation | An empty Operations app runs on a staging URL: login works, one RPC answers, the parity harness runs | No | 10 |
| 3 Port | Every RPC returns the same answer as the old app over the same data, and the UI suites pass | No | 12 |
| 4 Data and cutover | Production data is imported, totals match the Sheet, staff use the new URL | **Yes: the switch** | 7 |
| 5 New abilities | Store assignment, the till link, the LLM gateway, receipts and deliveries each ship on their own | Yes, one at a time | 7 |
| 6 App | The app installs to a home screen | Yes | 2 |

Phase 1 is independent of phases 2–4 and can run alongside them. Inside
phase 3, cards that don't share files can run in parallel.

I haven't put dates on this. Phase 3 is the bulk: about 11,000 lines of
server code to port, in 12 cards. A fair first measure is how long the first
three cards of phase 3 take; the rest are the same shape.

## 5. How the work is run

The aim is that a card can be done correctly by a small model that has read
nothing but the card. That only works if the hard thinking is done before the
card is handed out, and if "correct" is something a command decides.

### Three roles

| Role | Who | Does | Reads |
|---|---|---|---|
| **Orchestrator** | A strong model, with the owner approving | Picks the next card, pastes it to a worker, reviews the result, updates the ledger, resolves anything blocked | This plan, the task file, the diff |
| **Worker** | A small or mid model, one fresh session per card | Exactly one card, on one branch, as one pull request | Only the card, the worker rules, and the files the card lists |
| **Checker** | CI, not a model | Runs the tests, the parity comparison and the docs guard | Nothing: it runs commands |

### Three tiers of card

| Tier | Kind of work | Model |
|---|---|---|
| **T1** | Mechanical, with one right answer: SQL tables from the schema reference, simple read and write functions, porting pure functions, moving tests | Small |
| **T2** | A module with rules in it, where the old code and its tests say what right means | Mid |
| **T3** | Contracts, anything with no oracle yet, the cutover, security review, and any card a worker marked blocked | Large |

A card marked **money** or **security** gets a T3 review of its diff whatever
tier wrote it. Review reads the card and the diff, not the whole codebase.

### Why this keeps token use low

- **The worker never reads the plan.** The orchestrator pastes one card and
  the worker rules, about 60 lines together.
- **Each card names the exact files to read.** For `Index.html` it names the
  functions, and the worker searches for them. Nobody reads 6,000 lines.
- **Lookups go to generated references**, which are exact and short:
  [code-map.md](../reference/code-map.md) for modules and RPCs,
  [schema.md](../reference/schema.md) for columns.
- **Correctness is a command, not a conversation.** A card is done when its
  commands pass, so there is no long review loop.
- **Pull requests stay small**, about 400 changed lines at most. A card that
  would exceed that gets split by the orchestrator before it is handed out.
- **Strong-model time goes only where judgment is needed:** phase 0, the
  parity harness, reviews of flagged cards, and the cutover.

### The oracle: old and new must agree

The repo can already run the whole current server in Node over an in-memory
spreadsheet, with 120 days of fictional data (`scripts/docs/runtime.js` and
`scripts/docs/fixtures.js`). Card P2-09 turns that into a comparison:

1. Freeze the clock. Seed the old runtime with the fixture.
2. Copy the same rows into the new database.
3. Call the same RPC with the same arguments on both.
4. The answers must be equal, apart from generated IDs and timestamps.

Every phase 3 card ends with "parity passes for these RPCs". That is what
lets a small model port a module and know it is right.

Parity is not enough alone for writes, so write RPCs are also checked by the
ported unit tests, and by comparing the rows each side wrote.

### The card loop

```mermaid
flowchart TD
    pick["Orchestrator picks a card<br/>whose needs are all done"] --> hand["Paste card + worker rules<br/>into a fresh worker session"]
    hand --> work["Worker: read listed files,<br/>write listed files, run listed commands"]
    work --> ok{"All commands pass?"}
    ok -- no, after 2 tries --> blocked["Worker stops and writes<br/>a BLOCKED note"]
    blocked --> t3["T3 resolves: fixes the card,<br/>the contract or the harness"]
    t3 --> pick
    ok -- yes --> pr["Pull request:<br/>diff + command output + ledger row"]
    pr --> flag{"money or security?"}
    flag -- yes --> rev["T3 reviews card + diff"]
    flag -- no --> ci["CI green"]
    rev --> ci
    ci --> own["Owner approves merge"]
    own --> pick
```

### Worker rules

These are pasted with every card. They are the whole contract.

```text
1. Do exactly one card. Read only the files it lists. If you need another
   file, read it, and name it in your report.
2. Write only the files under "Make". Never edit src/ (the live app),
   ops/contracts/, or another card's files unless the card says so.
3. Do not change a contract: RPC names, parameters, return shapes, table or
   column names, roles. If the card can't be done without changing one,
   stop and report BLOCKED.
4. Port behaviour, don't improve it. If the old code looks wrong, keep the
   behaviour and note it in your report. Parity decides.
5. Money is numeric with 2 decimals, rounded at every write. An absent
   figure is NULL, never 0. Dates are stored as real dates; the business
   day is America/Toronto.
6. Write the test first and see it fail. Then make it pass.
7. Run every command under "Done when" and paste the last lines of output.
8. If a command still fails after two honest attempts, stop. Report
   BLOCKED with: the command, the output, what you tried, your best guess.
   Do not weaken a test, skip a check, or guess a contract.
9. Use fictional people only in tests and fixtures. No real names, pay,
   takings or phone numbers.
10. Finish with: files changed, commands and results, anything surprising,
    and the ledger row set to "review".
```

### The ledger

The table at the top of the [task file](2026-11-operations-app-tasks.md) is
the single record of state: `todo`, `doing`, `review`, `done` or `blocked`.
A card's pull request updates its own row. Two cards may run at the same time
when all their needs are `done` and their "Make" lists don't overlap.

### Stop rules for the orchestrator

- No card starts while a card it needs is not `done`.
- No merge to `main` without the owner. Merging to `main` deploys the current
  production app, so card P2-01 first limits that deploy to changes under
  `src/`.
- Nothing touches production data before phase 4, and phase 4 runs on a copy
  first.
- Three blocked cards in a row means the contract or the harness is wrong.
  Stop handing out cards and fix that.

## 6. Data migration and the switch

1. **Export** every tab of the production Sheet to files (card P4-01).
2. **Import** into an empty staging database. Blank cells become `NULL`.
   Every row that can't be imported goes to a rejects file with its reason;
   nothing is dropped silently (P4-02).
3. **Reconcile**: per table and per month, compare row counts and money
   totals between the Sheet and the database (P4-03). The switch does not
   happen until every line matches or has a written explanation.
4. **Dry run** the whole thing on a copy, then have two people use the
   staging app for a normal day beside the real one (P4-04).
5. **Switch** on a quiet morning: put the old app in read-only, run the
   import, run the reconcile, point staff at the new URL (P4-05).
6. **Way back** for 30 days: the Sheet app stays, read-only. Going back means
   re-entering the days since the switch, so the decision to go back is made
   within the first two trading days or not at all.
7. **After**: a nightly export keeps a Sheet the owner can open (P4-06). The
   Apps Script deploy is retired (P4-07).

## 7. Risks

| Risk | What limits it |
|---|---|
| A ported rule behaves differently | Parity against the old runtime on every RPC; ported unit tests; T3 review of money cards |
| The fixture doesn't cover a real-world case | The dry run reconciles real production data, month by month |
| A small model guesses instead of stopping | Worker rule 8; contracts are files it may not edit; CI is the judge |
| Two people pay the same shift at once | Fixed by design in the new app: one transaction with a row lock (P3-09, P3-06) |
| The till API isn't ready | Phases 2–4 don't need it. The vape close stays manual until phase 5 |
| A leaked LLM key runs up a bill | Starts in free-model-only mode with no key installed; prepaid balance with auto-reload off; daily escalation cap (P5-04) |
| Operations is down at close time | The close keeps a manual-entry path; a failed message or till lookup never blocks a close |
| Cost creeps on the new hosting | Each phase 2 and 5 card that adds a paid service names it in its report |

## 8. What this plan does not cover

- The till platform's own move to Cloudflare.
- The work inside the till's repository for its API, beyond the contract.
- A delivery feature design. Card P5-07 starts with writing that spec.
- Store listings for a native app. Card P6-02 is a decision, not a build.

## 9. Related decisions

Proposed, pending this review:

- [ADR-0020](../adr/0020-operations-moves-off-sheets.md): Operations moves to
  its own app, with its own schema and database role. Would supersede ADR-0001.
- [ADR-0021](../adr/0021-till-figures-come-through-an-api.md): till figures
  come through an API, and Operations keeps its own snapshot.
- [ADR-0022](../adr/0022-llm-calls-go-to-the-free-model-first.md): LLM calls
  go to the free model first, with Claude behind a flag.
