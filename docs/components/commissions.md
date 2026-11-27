# Commissions

> Rules say who earns what. Each Monday the engine works out the week and
> **proposes** bonuses; a person approves them before anything is paid.

| Commission runs | Rules | A fixed weekly fee |
|---|---|---|
| ![Commission runs with proposed bonuses awaiting approval](../images/commissions.png) | ![Commission rules: two percentage rules and a fixed management fee](../images/rules.png) | ![New rule form set to a fixed $120 weekly amount](../images/rule-form-fixed.png) |

## What it does

A **rule** is one of two kinds:

| Kind | Says | Example |
|---|---|---|
| **Percentage** | For this person (or everyone) on this till, pay *n*% of weekly sales **above** a threshold | 3% of cstore sales over $6,000 |
| **Fixed** | Pay this person a flat amount every week, whatever the sales | $120 management fee |

A fixed rule with a threshold above zero pays only in weeks when sales clear
it, which gives "a flat bonus for a good week" from the same rule type. Rules
have an effective-from date and an optional end date; ending a rule stops it
from that week on.

The **Commissions** screen lists each weekly run and its **proposed** bonuses.
An approver (payroll admin or admin) approves or cancels each one. Approved
bonuses appear as owed on [Payroll](payroll.md) and on the person's My Pay.

## Pausing the Monday run (Operations app)

In the Sheet an admin paused the weekly run by removing the trigger from a
menu. In the Operations app the schedule is part of the app, so the pause is a
**setting**: `commission_run_paused` (a yes/no, off by default), in the
Commissions group of [Settings](settings.md).

- **On:** when the Monday run comes round (09:00 Toronto time), it does nothing
  except write **one** audit row, `commissions.run_skipped` (actor `SYSTEM`,
  details "paused in Settings (commission_run_paused)", and the week it would
  have run for). No bonus and no run row is written. The row is in the
  [audit log](audit-log.md), so the missed Monday is visible, not silent.
- **Off** (or never set): the run is exactly what it was.
- **Run engine** on the Commissions screen (a person pressing a button) is
  **not** affected: it works while the run is paused, and that is how a paused
  week is caught up.
- The Commissions screen shows one line when the setting is on: **The Monday run
  is paused (Settings).** It learns this from one small read of its own,
  `rpcGetCommissionRunPaused` (admin, manager and payroll admin: the roles that
  open the screen; the settings list is for admins only). Apps Script never
  asks: the setting does not exist there.
- Pausing and un-pausing is a `config.update` row in the audit log, with who.

## How it works

```mermaid
sequenceDiagram
    participant T as Monday trigger / Run button
    participant C as Commissions
    participant S as Sales
    participant R as CommissionRules
    participant B as Bonuses
    actor A as Approver

    T->>C: runForWeek(last Mon–Sun)
    C->>C: run already exists for this week? → skip (unless forced)
    C->>S: aggregateByStaffCompany(week)
    C->>R: rules active on week start
    loop each rule × covered staff
        alt percentage
            C->>C: sales > threshold? amount = (sales − threshold) × %
            C->>B: already paid by another percentage rule this week? → skip
        else fixed
            C->>C: threshold set and not cleared? → skip
            C->>B: this rule already paid this week? → skip
        end
        C->>B: create bonus · status proposed · source_rule_id · source_run_id
    end
    C->>C: write commission_runs row
    A->>B: approve → pending  (or cancel)
```

## Data

| Tab | Reads | Writes |
|---|:-:|:-:|
| `commission_rules` | ✓ | ✓ (rules screen) |
| `commission_runs` | ✓ | ✓ |
| `bonuses` | ✓ | ✓ |
| `sales`, `staff` | ✓ | |

A till correction in the Operations app
([shifts and the close](shifts-and-close.md#corrections-after-the-close))
changes the sales figures a run summed but never recalculates a run or its
proposals: the correction names each run whose week contains the day, and the
admin decides whether to re-run it.

## Rules it must not break

- **Proposed, never paid automatically**
  ([ADR-0011](../adr/0011-commissions-are-proposed-then-approved.md)). A wrong
  rule costs a cancelled proposal, not money.
- **One run per week.** Re-running needs `force`, and the per-rule guards still
  prevent duplicates.
- **A fee and a sales commission don't block each other.** Each bonus records
  the **rule** that produced it (`source_rule_id`), so a percentage rule
  ignores fee rows and a fee asks only whether *it* has paid this week
  ([ADR-0013](../adr/0013-fixed-amount-rules-record-their-source-rule.md)).
- **A deleted fee rule stops blocking anything**, and a legacy bonus with no
  rule ID still blocks as it always did.
- **A rule that would pay nothing is refused** at creation: a fixed rule needs
  an amount above zero, a percentage rule a percentage.

## Code map

| What | Where |
|---|---|
| Server | `src/Commissions.gs`: `runForWeek_`, `runForPreviousWeek`, `installWeeklyTrigger` · `src/CommissionRules.gs`: `create`, `update`, `getActiveOn` · `src/Bonuses.gs`: `existsCommissionFor`, approve and cancel |
| RPC | `src/WebApp.gs`: `rpcGetCommissionRuns`, `rpcRunCommissionEngine`, `rpcGetProposedBonuses`, `rpcApproveBonus`, `rpcCancelBonus`, `rpcGetCommissionRules`, `rpcCreateCommissionRule`, `rpcUpdateCommissionRule` |
| UI | `src/Index.html`: `renderCommissionsTab`, `triggerCommissionRun`, `renderRulesTab`, `openRuleForm` |
| Trigger | Sheet menu: **Install Weekly Auto-Trigger**; Mondays at `commission_run_hour` |
| Pause (Operations app) | `ops/src/cron.ts`: `runWeeklyCommissions` reads `commission_run_paused`; `ops/src/rpc/handlers/commission-pause.ts`: `rpcGetCommissionRunPaused`; `src/Index.html`: `commissionRunPaused_` |

## Tests

| Suite | Holds down |
|---|---|
| `ops/test/cron.test.ts` (the pause) | paused: no run, no bonus, exactly one `commissions.run_skipped` row and a result that says it was skipped; not paused (unset, false, blank, any other word): identical to before; paused then un-paused runs the week; the manual Run engine still works while paused; the setting accepts only true or false through `rpcUpdateSetting`; the small read answers the three roles and refuses the rest |
| `tests/suites/ui-audit-log.js` (the line) | "The Monday run is paused (Settings)." shows only in the Operations app and only when paused; Apps Script makes no call |
| `commission-fixed` | a fee pays with or without sales; fee and commission both pay; order doesn't matter; once per week; stops when the rule ends; inactive pays nothing; deleted rule stops blocking; legacy rows still block; threshold makes a fee conditional; percentage rules unchanged; zero-paying rules refused |

## History

- **Nov 2026 (card P4-13):** the pause setting `commission_run_paused` and the
  line on the Commissions screen (Operations app only; nothing to port).
- **#23 (Sep 2026):** fixed-amount rules, for a weekly management fee.
- **Batch 3:** weekly engine, rules, proposed → approved bonuses.
