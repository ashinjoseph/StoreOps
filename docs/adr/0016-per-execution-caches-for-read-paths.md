# 0016. Per-execution caches on read paths, busted by writes

- **Status:** Accepted
- **Date:** 2026-08 (Batch 10)
- **Components:** [sales dashboard](../components/sales-dashboard.md), all read paths

## Context

Once real data arrived, the app felt slow. Rendering wasn't the problem; sheet
reads were. One dashboard load read the whole `sales` sheet twice (once for
the range, once for the insights baseline). Other modules (`TillSessions`,
`CashHandling`) had already solved this; `Sales` hadn't.

## Decision

Three layers, each with a clear owner:

| Layer | Lifetime | Holds | Invalidated by |
|---|---|---|---|
| Module variable | one execution | parsed rows of one sheet | that module's own writes |
| `CacheService` | 5–10 min | config, staff, product master | writes to those sheets |
| Client `rpcCache` | 60 s / 5 min / 30 min | RPC results | **any** successful write RPC |

A write **busts the cache before re-reading** its own result. Otherwise
`write_` → `getForSession_` returns the pre-write record from a warm cache.

## Consequences

- ✅ One sheet read per dashboard load, whatever the range (`perf`).
- ✅ A person never sees stale data right after their own write.
- ⚠️ Another person's write can take up to the client TTL to appear;
  **Refresh** forces a reload.

## Alternatives considered

- **No caching, smaller reads (`getRange` for a date window):** rows aren't
  guaranteed to be in date order in the Sheet (people edit and insert), so a
  date window isn't a contiguous range.
