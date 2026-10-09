# 0015. "Needs detail" is a stored flag, enforced on the server

- **Status:** Accepted
- **Date:** 2026-09 (#19)
- **Components:** [product master](../components/product-master.md), [shopping list](../components/shopping-list.md)

## Context

Imported vape rows sometimes arrive without a flavour ("Corvo Pod 25K —
flavour TBC"). Several variants then look like the same product, and ordering
one is guesswork. Hiding them from the picker led people to create duplicates.

## Decision

- `product_master.needs_detail` is a **stored boolean**, set on import or by
  anyone who spots a problem, and cleared when the product is completed.
- The picker **lists** these rows with a **needs details** badge and a **Fix**
  button instead of **+**. Fix opens the product form.
- `ShoppingList.add` **refuses** them with its own `NEEDS_DETAIL` error, so the
  client's redirect is backed by the server.

## Consequences

- ✅ No duplicates: the incomplete product is visible and findable.
- ✅ The gate can't be bypassed by an old client or a direct RPC.
- ⚠️ Someone has to clear the flag; a rename alone doesn't (`shopping-gate`).

## Alternatives considered

- **Infer it from the name** ("TBC", "?"): brittle, and wrong as soon as a
  real product contains the word.
- **Hide incomplete products:** led to duplicates.
