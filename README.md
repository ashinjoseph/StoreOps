# StoreOps — Schedule, Payroll, Sales & Reconciliation

Single Apps Script project that runs the store's daily operations:

- **Cashiers** open/close till sessions per company (cstore + vape), enter
  sales by tender, count cash, reconcile float.
- **Admins** manage staff, schedule shifts in advance, record payments,
  approve commissions, view audit logs.
- **Managers** edit shifts, view sales dashboard, review payments
  (read-only).
- **Payroll** computes from actual hours worked (attendance), pays via
  chronological allocation against unpaid attendance days, includes a
  bonuses/commissions module that auto-proposes weekly commissions.

Replaces:
- The Schedule_Payroll v3 project (never deployed)
- The Scarbro Mart Reconciliation app (cashier flow + reconciliation)

Both apps' ideologies are preserved; data starts fresh.

## Project layout

```
StoreOps/
├── appsscript.json         Apps Script manifest
├── package.json            clasp + types for IDE
├── .clasp.json.example     template — copy to .clasp.json (gitignored)
├── .gitignore, .claspignore
├── README.md, CHANGELOG.md
├── src/                    *.gs and *.html — what clasp push uploads
├── docs/                   design + setup
└── tests/                  manual test scenarios
```

## First-time setup

See [`docs/quickstart.md`](docs/quickstart.md).

## Daily workflow

```
git add -A && git commit -m "..."
npx clasp push                  # pushes HEAD; test deployment auto-updates
# verify on the test URL
npx clasp deploy --description "vX.Y description" --deploymentId <prod_id>
git tag vX.Y && git push --tags
```

## Source files (overview)

| File | Purpose |
|------|---------|
| `Util.gs` | Date helpers, ID generation, money math, shift parsing |
| `Setup.gs` | First-time schema + menu + placeholder rows |
| `Staff.gs` | Roster + login code verification |
| `Auth.gs` | Sessions, tokens, rate limiting |
| `AuditLog.gs` | Append-only event log |
| `Notifier.gs` | Future WhatsApp hook (no-op for now) |
| `Attendance.gs` | Per-day work record + payroll source |
| `TillSessions.gs` | Per-company cash reconciliation |
| `Sales.gs` | Sales by tender, per till_session |
| `Payments.gs` | Payment recording + chronological allocation walk |
| `Bonuses.gs` | Bonuses + commissions storage |
| `Commissions.gs` | Weekly commission engine |
| `CommissionRules.gs` | Rule CRUD |
| `WebApp.gs` | RPC layer with auth + role guards |
| `Index.html` | Single-page UI (login + cashier + admin + manager views) |

See [`docs/data-model.md`](docs/data-model.md) for the schema.
See [`docs/auth-design.md`](docs/auth-design.md) for the auth model.
