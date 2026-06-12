# Adding a new feature to StoreOps

This is the playbook for adding a new domain capability — typically a new sheet tab + module + RPCs + UI. The worked example below uses a hypothetical **Refunds** feature.

Before starting, skim [`CLAUDE.md`](./CLAUDE.md) for the architecture invariants. Every step below assumes those rules.

---

## 0. Decide whether you actually need a new module

**Reuse first.** If your data fits an existing tab, extend that module instead of forking. Examples of when *not* to create a new module:

- "Refunds" that are really cash-out adjustments → extend `Bonuses.js` with a new bonus type.
- A new payment category → add a `payment_type` value in `Payments.js` instead of a parallel sheet.
- A new report → it's probably a read-side helper on an existing module, not a new module.

Create a new module only when there is a **distinct domain concept** that owns its own lifecycle and warrants its own tab.

---

## 1. Define the sheet schema (`Setup.js`)

1. Add the tab name to the `SHEETS` constant:
   ```js
   const SHEETS = {
     // ...existing tabs...
     REFUNDS: 'refunds',
   };
   ```
2. Add any dropdown source arrays near the existing ones (`ROLES`, `COMPANIES`, `PAYMENT_METHODS`):
   ```js
   const REFUND_REASONS = ['damaged', 'wrong_item', 'customer_complaint', 'other'];
   ```
3. Create a `createRefundsTab_()` modelled on existing `createXxxTab_()` helpers. It must:
   - Set the title row (row 1) and header row (row 2).
   - Freeze rows 1–2.
   - Set sensible column widths.
   - Attach data validations (dropdowns) for any constrained columns.
   - Seed a placeholder row (soft-yellow background) with the next-available formatting rules.
4. Call `createRefundsTab_()` from `firstTimeSetup()` **and** from `resetDataTables()`.
5. Decide on the column layout up front — changing it later means updating multiple files (see Common pitfalls below).

---

## 2. Create the module file

Add `Refunds.js` at the project root. Follow this skeleton (model it on `Payments.js` for a write-heavy module or `Staff.js` for a read-heavy cached module):

```js
const Refunds = (() => {
  const COL = {
    refund_id: 1,
    created_at: 2,
    staff_id: 3,
    company: 4,
    amount: 5,
    reason: 6,
    notes: 7,
    // ...
  };
  const NUM_COLS = 7;
  const DATA_START_ROW = 3;

  function sheet_() {
    return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.REFUNDS);
  }

  function rowToRecord_(row, rowIndex) {
    if (!row[COL.refund_id - 1]) return null;
    return {
      refundId:  String(row[COL.refund_id - 1]),
      createdAt: row[COL.created_at - 1] instanceof Date ? row[COL.created_at - 1] : new Date(row[COL.created_at - 1]),
      staffId:   String(row[COL.staff_id - 1]),
      company:   String(row[COL.company - 1]),
      amount:    Number(row[COL.amount - 1]) || 0,
      reason:    String(row[COL.reason - 1] || ''),
      notes:     String(row[COL.notes - 1] || ''),
      _rowIndex: rowIndex,
    };
  }

  function getAll_() {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const values = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    const out = [];
    values.forEach((row, i) => {
      const rec = rowToRecord_(row, DATA_START_ROW + i);
      if (rec) out.push(rec);
    });
    return out;
  }

  function write_(input, actorId) {
    const sh = sheet_();
    const existing = input.refundId ? getAll_().find(r => r.refundId === input.refundId) : null;
    const refundId = existing ? existing.refundId : Util.newId_('REF');
    const row = new Array(NUM_COLS);
    row[COL.refund_id - 1]  = refundId;
    row[COL.created_at - 1] = existing ? existing.createdAt : new Date();
    row[COL.staff_id - 1]   = input.staffId;
    row[COL.company - 1]    = input.company;
    row[COL.amount - 1]     = Util.roundMoney_(input.amount);
    row[COL.reason - 1]     = input.reason;
    row[COL.notes - 1]      = input.notes || '';

    if (existing) {
      sh.getRange(existing._rowIndex, 1, 1, NUM_COLS).setValues([row]);
    } else {
      sh.appendRow(row);
    }

    AuditLog.write({
      actorId,
      action: existing ? 'refund.updated' : 'refund.created',
      targetType: 'refund',
      targetId: refundId,
      before: existing || null,
      after: rowToRecord_(row, existing ? existing._rowIndex : sh.getLastRow()),
    });

    return { refundId };
  }

  return {
    list:   () => getAll_(),
    create: (input, actorId) => write_(input, actorId),
    update: (input, actorId) => write_(input, actorId),
  };
})();
```

Notes:
- Match the existing modules' style — don't introduce a new pattern unless you also update the others.
- If reads are hot, wrap `getAll_()` with `CacheService` + a `bustCache_()` and call `bustCache_()` from every writer. Model on `Staff.js`.

---

## 3. Wire RPC endpoints (`WebApp.js`)

Add `rpc*` functions next to related domains (e.g. put refund RPCs near `rpcPayment*`):

```js
function rpcRefundList(token) {
  const session = _session(token);
  Auth.require(session, ['admin', 'manager', 'payroll_admin']);
  return Refunds.list();
}

function rpcRefundCreate(token, input) {
  const session = _session(token);
  Auth.require(session, ['admin', 'manager']);
  return Refunds.create(input, session.staffId);
}
```

Rules:
- Every RPC validates the token and calls `Auth.require` — no exceptions.
- Return plain JSON-serializable objects. No functions, no Dates that the frontend isn't prepared to parse (prefer ISO strings or formatted strings via `Util.formatDateTime_`).
- Throw on error. The frontend's `withFailureHandler` receives the error message.

---

## 4. Audit log + notifications

- **Audit**: confirm every write path in your module calls `AuditLog.write` with a stable, dotted action name (`refund.created`, `refund.voided`). Search the codebase for existing `action:` strings and follow the same verb style.
- **Notifications**: if humans need to be alerted (e.g. WhatsApp ping to managers when a refund exceeds a threshold), study how `Payments.js` and `Bonuses.js` call `Notifier`. Check the `config` sheet for `notifier_enabled` and any threshold values before sending.

---

## 5. Frontend wiring (`Index.html`)

`Index.html` is monolithic. Find the tab navigation block and an existing tab implementation to copy:

1. Add a new top-level tab/section following the existing pattern (look at how Payments or Bonuses tabs are structured).
2. Add a list view that calls `rpcRefundList` on tab open and renders rows.
3. Add a create form that submits via `rpcRefundCreate`.
4. Reuse existing helpers — search for `formatMoney`, `renderListRow`, `showError`, `toast`, etc. Don't reinvent.
5. Respect role: hide write controls when `session.role` isn't authorized, but **always rely on the server-side guard** for actual enforcement.

---

## 6. Validate locally

There is no automated test suite. Manual validation:

1. `clasp push` to upload.
2. Open the deployed web app URL.
3. Run "⚙️ First-time Setup" once from the spreadsheet menu so the new tab is created with its headers (or `resetDataTables()` for a clean wipe).
4. Exercise the create/read/update paths from the UI.
5. Inspect the new sheet — values stored as expected? Dates are real Date cells, not strings?
6. Open the `audit_log` sheet — every write produced a row with the right `actorId` and `action`.
7. Open Apps Script → Executions log — no exceptions on the golden path.

---

## 7. Checklist before declaring done

- [ ] New tab appears with correct headers after `firstTimeSetup()`.
- [ ] `COL`, `NUM_COLS`, and `rowToRecord_` agree on every column.
- [ ] Every RPC has `_session(token)` + `Auth.require(session, [...])`.
- [ ] Every write logs to `audit_log` with stable `action` string.
- [ ] Cache invalidates on writes if caching is in use (read-after-write returns fresh data).
- [ ] Money values round-tripped through `Util.roundMoney_`; comparisons via `Util.moneyEquals_`.
- [ ] Dates stored as Date, formatted on output via `Util.formatDate_` / `Util.formatDateTime_`.
- [ ] Frontend uses existing helpers (no parallel `formatMoney`, no new date formatter).
- [ ] Apps Script execution log clean on golden path and at least one error path.

---

## Common pitfalls

- **Forgot `NUM_COLS` after adding a column** → row slice is short, the new column reads as `undefined`. Symptom: blank cells on read.
- **Skipped `bustCache_()` after a write** → reads return stale data for up to 10 minutes.
- **Missing `AuditLog.write`** → compliance gap, no trail of who changed what.
- **Trusted the frontend role** → security hole. Always `Auth.require` on the server.
- **Float-compared money with `===`** → spurious variance flags. Use `Util.moneyEquals_(a, b, tolerance)`.
- **Used `new Date('2025-01-15')` directly** → UTC parsing, wrong day in `America/Toronto`. Use `Util` helpers and pass through the script timezone.
- **Re-imported records with random IDs** → duplicates. Use the deterministic ID helpers for attendance / till sessions.
- **Returned a Date from an RPC and assumed the frontend gets a Date** → `google.script.run` serializes to JSON. Format on the server (`Util.formatDateTime_`) or parse explicitly on the client.

---

## Reference: where each invariant lives

| Concern | Authoritative file | Notes |
|---|---|---|
| Sheet names & creation | `Setup.js` | `SHEETS` constant + `createXxxTab_()` helpers |
| Sessions & roles | `Auth.js` | `validate`, `require`, login flow |
| Audit logging | `AuditLog.js` | `AuditLog.write({ ... })` is the only writer |
| IDs / dates / money | `Util.js` | No sheet access — pure helpers |
| RPC routing | `WebApp.js` | All `rpc*` functions, `_session(token)` helper |
| Notifications | `Notifier.js` | Reads `notifier_enabled` from the `config` sheet |
| Frontend SPA | `Index.html` | Vanilla JS, single file |
