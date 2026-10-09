# Shopping list

> Anyone who notices something running low adds it from the catalogue in a
> tap; a manager sends the list as one WhatsApp message.

| The list | The picker |
|---|---|
| ![Shopping list grouped by category, with who added each item](../images/shopping.png) | ![Picker on the Vape chip: + to add, a quantity stepper, and two "needs details" rows with Fix](../images/picker.png) |

## What it does

**The list** groups pending items by category and shows the quantity and who
added each one. Items can be ticked off as bought, edited or removed. Removing
is instant, with **Undo** in the toast.

**The picker** is a sheet that stays open while you add:

- **Category chips** (Vape, Cigarettes, Beer, Grocery, Other). Tapping one
  shows the **whole** category, so a full vape shelf can be browsed without
  typing.
- **Search** narrows within the chip by name, brand, SKU or barcode. Every
  term must match.
- **+** adds one; the row turns into a **− qty +** stepper. Taps are written
  optimistically and debounced, so several quick taps make one call.
- A product flagged **needs details** is listed (so nobody creates a duplicate)
  but shows **Fix** instead of **+**. Fix opens the product form; once the
  flavour or variant is filled in, it can be ordered.
- **Create new product** opens the same form when something isn't in the
  catalogue yet.

A manager or admin taps **Generate**. The pending items become copyable text,
are sent through the shopping-list WhatsApp template, and are stamped
`ordered` with a shared batch ID. History is kept rather than deleted.

## How it works

```mermaid
sequenceDiagram
    actor U as Staff
    participant P as Picker (Index.html)
    participant W as WebApp.gs
    participant S as ShoppingList
    participant PM as ProductMaster
    actor M as Manager
    participant N as Notifier

    U->>P: tap + (×3 quickly)
    P->>P: update the row at once · debounce 600 ms
    P->>W: rpcAddToShoppingList(productId, qty 3)
    W->>S: add
    S->>PM: getById → active? needs detail?
    alt needs detail
        S-->>P: NEEDS_DETAIL → open the product form
    else ok
        S->>S: write shopping_list row (product_id, name, unit, cost)
    end
    M->>W: rpcGenerateShoppingList
    W->>S: generate
    S->>N: sendOp('shopping_list', [date·by, items, summary])
    S->>S: stamp rows ordered + batch_id
```

The picker loads a slim 8-field projection of the catalogue
(`rpcGetProductsForPicker`) when the Shopping tab is first opened, not at login.

## Data

| Tab | Reads | Writes |
|---|:-:|:-:|
| `shopping_list` | ✓ | ✓ |
| `product_master` | ✓ | |

## Rules it must not break

- **An incomplete product can't be ordered.** The server refuses it with its
  own `NEEDS_DETAIL` reason, so the client's redirect to the form is backed by
  the server and not just a suggestion.
- **An inactive product can't be ordered.**
- **Generating never deletes.** Rows move to `ordered` with a batch ID;
  removing one by hand marks it `removed`.
- **A missing cost isn't shown as free** in the picker.

## Code map

| What | Where |
|---|---|
| Server | `src/ShoppingList.gs`: `add_`, `edit_`, `removeEntry_`, `setBought_`, `generate_`, `clearAll_` |
| RPC | `src/WebApp.gs`: `rpcGetShoppingList`, `rpcAddToShoppingList`, `rpcEditShoppingListEntry`, `rpcRemoveShoppingListEntry`, `rpcSetShoppingItemBought`, `rpcGenerateShoppingList`, `rpcClearShoppingList`, `rpcGetProductsForPicker` |
| UI | `src/Index.html`: `renderShoppingTab`, `openAddShoppingItem`, `openEditShoppingItem`, `generateShoppingList` |

## Tests

| Suite | Holds down |
|---|---|
| `ui-picker` | a chip shows the whole category; search narrows within it; needs-detail rows are listed but can't be added; no "$0.00" cost; every row painted can be tapped |
| `shopping-gate` | complete products go on; incomplete ones are refused with their own reason; filling in the detail opens the door, a rename alone doesn't |

## History

- **#19 (Sep 2026):** the whole vape shelf is orderable; needs-detail rows show
  in the picker and redirect to the form.
- **Batch 6:** one-tap adding, debounced writes, Undo, slim picker projection.
