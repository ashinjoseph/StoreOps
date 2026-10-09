# 0009. Staging imports are header-driven and refuse a stale header

- **Status:** Accepted
- **Date:** 2026-09 (#20, #21)
- **Components:** [product master](../components/product-master.md)

## Context

Products arrive as supplier CSVs pasted into a per-type staging tab. The
layout of those tabs changes as types gain fields. A paste under an old header
was mapped **by position** into the new layout, so values landed in the wrong
columns without any error. Failed rows were reported only as a count ("Errors:
50"), with no way to find them.

## Decision

- The importer reads **row 2 (the header)** and maps by **name**. If the header
  doesn't match the current layout, the import is **refused**, naming the
  missing or unexpected columns. **Refresh staging headers** rewrites row 2.
- Every failing row is reported **by row number and reason**; the error count
  is the number of rows that failed, not the length of a message list.
- Blank rows and repeated header rows are skipped and counted, not reported as
  errors.

## Consequences

- ✅ A stale paste fails loudly, before any write.
- ✅ "Which rows failed and why" can be answered from the import result.
- ⚠️ Pasting at A3 under the app's header is a rule people must follow; the
  tab's title row says so.

## Alternatives considered

- **Positional mapping with a version marker:** still silent when someone
  pastes without the marker.
- **Fuzzy header matching:** guesses, and this is exactly where a guess costs
  a wrong price.
