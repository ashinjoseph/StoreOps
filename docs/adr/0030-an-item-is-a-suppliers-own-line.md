# 0030. An item is a supplier's own line; a cost is kept only when it is known exactly; a rise is a flag for a person

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [costs](../components/costs.md), [receipts](../components/receipts.md)

## Context

The owner wants the receipts to keep **what each item costs, from each
supplier, over time**, and to **flag a rise** so a manager can decide whether
to raise the selling price
([the design](../plans/2026-11-assistants-through-mcp.md#costs-and-price-rises-the-owners-idea-nov-27)).
A manager will change selling prices on what this shows, so what it shows must
be right and must not look more certain than it is.

Three facts shape it:

- **The app does not hold the cstore's product list**, and it changes no selling
  price: the cstore's prices live in its till, the vape's in the till's Office.
  A receipt line says what the *supplier* calls the goods, not what the shop
  does.
- **Receipts are read by an assistant or typed by a person**, and a line often
  lacks a figure (no unit price, no quantity, a discount, a return). A cost that
  cannot be read must stay absent, never become 0 and never be guessed
  ([ADR-0004](0004-blank-is-not-zero.md)).
- **The two businesses are separate companies** with separate books
  ([ADR-0029](0029-a-confirmed-receipt-is-final-and-a-mistake-is-voided.md)).
  Their costs must never be mixed in one list.

## Decision

1. **An item is a supplier's own line.** Its identity is the business, the
   supplier (a row of `ops.suppliers`: a confirmed receipt always has one) and
   the supplier's printed code for the line when there is one, otherwise the
   line's description, both in the repository's normal form (`normalise`:
   Unicode NFKC, lower case, no white space, no dashes). The same goods from two
   suppliers are two items; the same line in the two businesses is two items.
2. **A person can say two items are the same** (a supplier renamed a line, or
   printed a code one month and not the next). A join moves nothing and removes
   nothing: the joined item points at the one it was joined into (never a
   chain, same business and supplier, a reason of 3 to 300 characters), their
   histories read as one from then on, flags are worked out again for the joined
   history and say they were found by joining, and the join can be undone.
3. **A cost is observed when a receipt is confirmed, and only when it is known
   exactly.** A printed unit price is the cost. With no unit price, a line total
   and a quantity above zero give total ÷ quantity, worked out in integers and
   rounded half up to four decimals, and marked *worked out*. Anything else gives
   no observation: the line is counted as *no cost*, never stored as 0, never
   guessed. A line with a quantity or total of zero or less (a return, a free
   item) gives none. Costs are as printed, before tax.
4. **The history is ordered by the receipt's date**, then the receipt's
   confirmation time, so a receipt confirmed late takes its place; entering an
   older receipt can create, change or withdraw a flag between its neighbours.
   A void stops its observations counting (marked, kept) and works the
   neighbours' flags out again; the corrected receipt is observed afresh.
5. **A rise is a flag for a person, never a price change.** An observation is
   flagged when its cost is more than a set percentage above the counted
   observation just before it (the setting `price_rise_flag_percent`, default 5).
   "More than N percent" is compared in integers without division. A flag is
   `new`, `seen` or `price_raised` (a person, with a note), or `withdrawn` (the
   app only: it is marked and kept). The percentage in force when an observation
   is made is kept on it, so changing the setting never rewrites older flags.
6. **Nothing here writes to a till, a receipt or a message.** The app role cannot
   remove a row of any of these tables, nor change a figure on one; a confirmed
   receipt stays final.

## Consequences

- ✅ A manager sees a sentence they can act on (*Cola 12-pack from Fictional
  Wholesale: $6.00 → $6.72 each, up 12.0%, on the receipt of Nov 20*) and the
  list behind it, and nothing is changed for them.
- ✅ Nothing is invented: a worked-out cost is marked, a line with no cost is
  counted and shown as none, and a flag always names the two costs and the two
  receipts.
- ✅ The result does not depend on the order receipts were confirmed in, and a
  void or a join is a re-reading of a history that is still all there.
- ⚠️ **An item is only as good as the supplier's wording.** A supplier that
  prints no codes and rewords a line gives two items until a person joins them;
  a pack that changes (12 for $6.00 becomes 10 for $6.00) reads as the same item
  with a changed cost; a case price against a single price, a promotional price
  and a line that is a discount are not told apart. The list shows what was
  printed and flags what moved; the person decides whether it is a real rise.
- ⚠️ Comparing the same goods across suppliers is not here (an item belongs to
  one supplier).
- ⚠️ A catch-up is needed once for receipts confirmed before this card; it is a
  button for an admin, not a migration.

## Alternatives considered

- **Match each line to a product list.** The cstore's list is not in this app
  (and the vape's is the till's); building and keeping one here would be a second
  catalogue to drift from the real one, and a wrong match would put a cost on the
  wrong product silently.
- **Fuzzy matching of descriptions** ("cola 12pk" ≈ "cola 12-pack"). It joins
  lines nobody chose to join, and an unnoticed wrong join hides a real rise.
  A person's join is explicit, audited and undoable.
- **An average cost, or a weighted one.** It smooths exactly the jump a manager
  wants to see, and needs quantities that many lines do not print.
- **Flag against the lowest cost ever** (or a running best). One cheap promotion
  would make every later normal price a "rise". The comparison is with the cost
  just before.
- **Change selling prices automatically.** The prices live in the tills, a
  supplier's rise is not always to be passed on, and a person's decision is the
  point of the flag.
- **Compare with floating point.** `0.1001 > 0.1000 × 1.001` is true in floats
  and false on paper (it is exactly 0.1%, not more); a flag a manager acts on must be decided in integers.
