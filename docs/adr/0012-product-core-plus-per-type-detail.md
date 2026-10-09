# 0012. Product core plus per-type detail tables

- **Status:** Accepted
- **Date:** 2026-08 (Batch 5, product master v2)
- **Components:** [product master](../components/product-master.md)

## Context

Beer is priced from an LCBO case price, units per case and a deposit;
cigarettes from a carton cost and packs per carton; vape has puffs, mL,
nicotine and flavour; groceries just have cost and sell. One wide table would
be mostly empty columns, and the pricing rules would turn into a tangle of
`if (category === …)` branches.

## Decision

- A **thin core** `product_master` holds identity and the **resolved** per-unit
  numbers every consumer reads (cost, sell, margin, `needs_detail`).
- Each type with its own inputs has a **1:1 detail tab** keyed by `product_id`.
- `ProductTypes.gs` is a **declarative registry** per type: detail columns,
  `derivePricing`, `validate`, the UI `fieldSchema`, and the dedup key. The
  shared machinery (cache, audit, dedup, import) doesn't fork per type.
- Lists and search read **only the core**; detail is loaded when a single
  product is opened.

## Consequences

- ✅ Adding a type adds a registry entry and a tab, not columns on every row.
- ✅ Fast lists: no joins on the hot path.
- ⚠️ Resolved prices are recomputed on every write, so a hand edit to a core
  price in the Sheet is overwritten the next time the product is saved.

## Alternatives considered

- **One wide table:** dozens of mostly empty columns, and a form that shows
  every field for every product.
- **A JSON blob column for type fields:** unreadable and unsortable in the
  Sheet, which is the owner's main tool.
