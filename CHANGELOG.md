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

### Coming (later batches)
- Payments + Bonuses + Commissions (Batch 3)
- WebApp RPC layer + UI (Batch 4)
- Phase 2 reconciliation features (later)
