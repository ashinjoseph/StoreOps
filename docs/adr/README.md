# Architecture decision records

An ADR records **one decision**: the situation that forced it, what was chosen,
what was given up, and what was rejected. They exist so that someone reading
the code a year from now (a new developer, a reviewer, an interviewer) can tell
a deliberate trade-off from an accident, and doesn't undo the first by
mistake.

Most of these were written after the fact, from the changelog, the pull
requests and the code. Their dates are when the decision took effect.

## Index

| # | Decision | Status | Date |
|---|---|---|---|
| [0001](0001-apps-script-and-sheets-as-the-platform.md) | Apps Script and a Google Sheet as the platform | Accepted | 2026-05 |
| [0002](0002-pin-login-with-server-side-sessions.md) | PIN login with server-side sessions | Accepted | 2026-05 |
| [0003](0003-public-pages-inline-their-data.md) | Public pages inline their data; no public RPC | Accepted | 2026-08 |
| [0004](0004-blank-is-not-zero.md) | Blank is not zero | Accepted | 2026-09 |
| [0005](0005-card-shapes-are-mutually-exclusive-columns.md) | Card shapes are mutually exclusive columns; schema changes append | Accepted | 2026-09 |
| [0006](0006-lotto-payouts-are-netted-into-cash-sales.md) | Lotto payouts are netted into cash sales | Accepted | 2026-08 |
| [0007](0007-message-shape-follows-the-template.md) | A message's shape follows its template, and a failed send says why | Accepted | 2026-09 |
| [0008](0008-lotto-reserve-is-derived-from-two-counts.md) | What the lotto pot fed the drawer is derived from two counts | Accepted | 2026-08 |
| [0009](0009-staging-imports-are-header-driven.md) | Staging imports are header-driven and refuse a stale header | Accepted | 2026-09 |
| [0010](0010-bulk-import-reads-once-writes-once.md) | Bulk work reads once and writes once | Accepted | 2026-08 |
| [0011](0011-commissions-are-proposed-then-approved.md) | Commissions are proposed, then approved by a person | Accepted | 2026-05 |
| [0012](0012-product-core-plus-per-type-detail.md) | Product core plus per-type detail tables | Accepted | 2026-08 |
| [0013](0013-fixed-amount-rules-record-their-source-rule.md) | Every bonus records the rule that produced it | Accepted | 2026-09 |
| [0014](0014-append-only-audit-log.md) | An append-only audit log; void, never delete | Accepted | 2026-05 |
| [0015](0015-needs-detail-is-a-stored-flag.md) | "Needs detail" is a stored flag, enforced on the server | Accepted | 2026-09 |
| [0016](0016-per-execution-caches-for-read-paths.md) | Per-execution caches on read paths, busted by writes | Accepted | 2026-08 |
| [0017](0017-tests-run-the-real-source.md) | Tests run the real source, and every assertion is seen failing | Accepted | 2026-09 |
| [0018](0018-docs-are-generated-from-the-running-code.md) | Screenshots and schema docs are generated from the running code | Accepted | 2026-10 |

## When to write one

Write an ADR in the same pull request as the change when the change:

- picks between two or more reasonable designs;
- accepts a known cost (a number that will look wrong, a check that no
  longer runs);
- adds or repurposes a column, a sheet, a config key or an integration;
- would look like a mistake to someone who didn't see the discussion.

A bug fix doesn't need one, unless the fix *is* a rule others must follow
from now on (0004 began as a bug fix).

## How

1. Copy [_template.md](_template.md) to `NNNN-short-title-in-kebab-case.md`,
   using the next number.
2. Fill in Context, Decision, Consequences and Alternatives. Short is fine;
   being specific matters more than length.
3. Add it to the index above. The docs guard fails the build if an ADR file is
   missing from the index.
4. Link it from the component pages it affects.

ADRs are **not edited to change the decision**. If a decision is reversed,
write a new ADR, set the old one's status to `Superseded by NNNN`, and leave
its text as it was.
