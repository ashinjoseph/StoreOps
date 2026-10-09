# 0010. Bulk work reads once and writes once

- **Status:** Accepted
- **Date:** 2026-08 (Batch 10), extended 2026-09 (#22)
- **Components:** [product master](../components/product-master.md), [sales dashboard](../components/sales-dashboard.md)

## Context

Each Sheet call costs tens to hundreds of milliseconds, and an execution is
capped at 6 minutes. The product import re-read `product_master` twice **per
row** (to dedup, then to return the created record): **667 full reads for 222
rows**. Imports of a few hundred vape products timed out partway through.

## Decision

Bulk paths are **collect, then commit**:

1. Read each sheet involved **once**.
2. Build in-memory indexes (SKU; brand + name, case- and space-insensitive) and
   update them as rows are processed.
3. Accumulate inserts and updates in memory.
4. Write each sheet **once** (`setValues` over the whole block) and bust the
   cache once.

## Consequences

- ✅ Cost stops growing with the paste: re-importing the same file costs the
  same, and an empty tab costs nothing.
- ✅ `import-perf` asserts **read and write counts**, not wall-clock time, so
  it means the same on any machine.
- ⚠️ A failure partway through processing writes nothing; the import is all
  or nothing per sheet. That's a deliberate trade-off.

## Alternatives considered

- **Chunked imports across several executions:** state stored between runs,
  and partial imports to reason about. Unnecessary once the per-row reads were
  gone.
