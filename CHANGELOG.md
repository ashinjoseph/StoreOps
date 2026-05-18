# Changelog

All notable changes to StoreOps are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versions `vX.Y.Z`.

## [Unreleased] — v1.0.0

### Foundation (Batch 1)
- Project scaffolding (clasp + git ready)
- `Util.gs` — date, ID, money, shift-time parsing helpers
- `Setup.gs` — 14-tab schema + placeholder rows + menu
- `Staff.gs` — roster CRUD, constant-time login code verification
- `Auth.gs` — token-based sessions, rate-limited login
- `AuditLog.gs` — append-only event log
- `Notifier.gs` — WhatsApp hook scaffold (logs only, ready for future)
- Documentation: README, quickstart, data-model, auth-design

### Shift lifecycle (Batch 2)
- `Attendance.gs` — per-day workday records; openOrPromote, schedule,
  complete (auto from TillSessions), cancel, editActualTimes
- `TillSessions.gs` — per-company reconciliation; open (rejects duplicate
  per company, validates float, auto-creates/promotes attendance), close
  (writes sales, computes variance, auto-completes attendance when last
  session for the day closes), edit (admin override)
- `Sales.gs` — 1:1 with till_sessions; write (idempotent), getDashboard
  (filters + pagination + totals), aggregateByStaffCompany (commission feed)
- `tests/test-cases-batch-1-2.md` — 9-section walkthrough for testing
  setup, auth, full shift lifecycle, edge cases, idempotency, audit log

### Payments + Commissions (Batch 3)
- `Payments.gs` — split into two flows: `payShifts` (chronological
  allocation against unpaid attendance, oldest first, partial supported,
  overpayment rejected) and `payBonus` (settle one bonus, partial
  supported, overpayment rejected). Also `undo`, `undoLastForStaff`,
  `getOwedSummary` (computes shifts owed + pending bonuses).
- `Bonuses.gs` — already in place from earlier work; doc comments
  updated to reference new payment API.
- `CommissionRules.gs` — CRUD for commission rules (create, update,
  deactivate, getRulesFor staff+company+date).
- `Commissions.gs` — weekly commission engine: walks rules, aggregates
  sales by (staff, company), proposes bonuses for sales above threshold,
  writes commission_runs row with totals. Idempotency check prevents
  duplicate runs. Includes time-driven trigger management:
  `installWeeklyTrigger` (Monday at configured hour), `removeWeeklyTrigger`,
  `isTriggerInstalled`. Top-level `commissionsTriggerHandler` is the
  function the trigger fires.
- `Setup.gs` — menu updated with three new items:
  - Run Commission Engine (last week) — manual trigger
  - Install Weekly Auto-Trigger
  - Remove Weekly Auto-Trigger

### Web UI (Batch 4)
- `WebApp.gs` — RPC layer (29 endpoints) with role guards on every
  write. `doGet` entry point serves `Index.html`. Pre-auth RPCs
  (`rpcGetActiveStaffForLogin`, `rpcLogin`, `rpcLogout`) accept no
  token; everything else validates the session and enforces roles.
- `Index.html` — single-page app with bottom tab navigation:
  - **My Shift** — card-based (cstore + vape) dashboard, status pills,
    open/close modals with live variance preview, recent shifts list
  - **Schedule** — weekly grid, swipeable nav, click-to-edit cells
    (admin/manager only), today highlighted
  - **Payroll** — total owed dashboard, per-staff cards, "Pay Full"
    one-tap + custom-amount partial with progress bar, proposed
    commissions panel for admin approval, pay individual bonuses
  - **Sales** — filterable + paginated dashboard with totals strip
  - **History** — payment list with item drill-down, admin can undo
- Role-based tab visibility:
  - Employee: My Shift + Schedule (read-only) + History (own only)
  - Manager: + Schedule (edit) + Sales
  - Admin: + Payroll + History (all + undo)
- Session: `localStorage` remembers last name, `sessionStorage` holds
  token (24h rolling). Refresh recovers state.
- `tests/manual-ui-test-guide.md` — 9-section walkthrough of the real
  UI like a real user (no Apps Script editor needed)

This completes v1.0.0.
