# Delivery runs: first draft of the spec

Status: draft (2026-11-27), for the owner to correct. Nothing here is built.
Card P5-07 in the [task cards](2026-11-operations-app-tasks.md). The owner's
request (Nov 27): **see the deliveries, mark them delivered, and see the
delivery plan.**

This page says what that needs, what the till must be asked for, and what
is still to be decided. Each assumption is marked so it can be struck out.

## Where a delivery lives

A delivery order is placed on the website and lives in the **till's** system.
The till already knows when one is delivered: its daily figures count a
delivery "by the day delivered", and cash paid at the door goes into the
till shift that was open when the delivery was recorded
([what was agreed](2026-11-till-api-agreed.md)).

So the till is the record of a delivery, and the Operations app must not
keep a second version of the truth. Operations adds what the till does not
have: **the plan** (which deliveries go together, in what order, who
drives) and **the driver's screen**.

| | Kept by the till | Kept by Operations |
|---|---|---|
| The order, its items, the customer, the address | Yes | No. Shown when asked for, not copied |
| Whether it is waiting, out, delivered or failed | Yes | No. Read from the till |
| Door cash and the driver's handover | Yes | Read, and shown beside the cashier's variance (P5-03) |
| Which run it is in, its place in the run, the driver | No | Yes |

## What the till offers today, and what is missing

| Need | Today |
|---|---|
| How many deliveries a day, their sales and fees | Yes: the `delivery` line of the daily sales |
| Door cash per till shift | Yes: `door_cash` on a shift |
| A list of deliveries with their state | **No** |
| The address, the time window, what to collect at the door | **No** |
| Marking a delivery delivered, or failed, from outside the till | **No** |
| The driver's cash handover | Asked on Nov 23, not yet in the contract |

The till's own assistant tools do not cover it either: their order board
is pickup orders only.

## The request to the till side

Three additions, none of which rename anything in the contract.

**1. A list of deliveries.** `GET /deliveries` for a store, by state and
day. For each: its id and order number; when it was placed; the promised
window; the state (waiting, out for delivery, delivered, failed, cancelled);
how many items and whether anything is bulky; what is to be collected at the
door and how (already paid online, cash, card at the door); whether proof of
age is needed; the driver, when one is recorded; when it was delivered, or
why it failed.

**2. The customer's details, separately.** Name, address, phone and any
note for the driver, on a call of their own (`GET /deliveries/{id}/address`)
that needs a key allowed to see them. The list above carries only the
postal code. That keeps personal details out of every place that only needs
to count or plan.

**3. Recording the outcome.** `POST /deliveries/{id}/delivered` (when; which
driver; cash collected; proof of age checked) and
`POST /deliveries/{id}/failed` (why). Each with a key that makes a repeat
harmless, as proposals have. This is a real change of approach: until now
Operations only *proposes* to the till and a person approves in the Office.
A driver at a door cannot wait for an approval, so this would be the first
thing Operations writes to the till directly. The other way is that the
driver keeps marking deliveries where they do today and Operations only
shows the result. Which one depends on question 2 below.

## What Operations would build

**Deliveries (manager and admin).** Today's deliveries by state, with the
window and what is to be collected. Yesterday's and earlier by day.

**The plan (manager and admin).** Deliveries waiting to go out are put into
**runs**: a run has a day, a driver and its stops in order. A manager makes
the plan by hand, or asks for a suggested one and changes it (the
suggestion can come from an AI assistant; see
[Assistants through MCP](2026-11-assistants-through-mcp.md)). A delivery is
in at most one run. A run is planned, then out, then back.

**The driver's run (the driver, on a phone).** Their stops in order. For
each: the address with a link to open it in a map, the window, what to
collect, whether to check proof of age, and two buttons: **Delivered** and
**Could not deliver** (with a reason). The customer's details are fetched
when the stop is opened and are not stored on the phone.

**Back at the shop.** The run shows the cash the deliveries say was
collected. The handover is counted at the till, as agreed on Nov 23; the
run then shows collected, handed over, and the driver's gap. A gap is shown
to a manager and never taken from pay.

### Rules

- A run cannot start while one of its deliveries is no longer waiting (the
  till says it was cancelled or already delivered).
- "Delivered" is refused when proof of age is needed and not ticked.
- A failed stop stays in the day's list and can go into a later run.
- If the till cannot be reached, the driver's screen says so and keeps the
  tap to send again; it never shows "delivered" before the till has said
  yes.
- Every plan change and every outcome is in the audit log with who did it.
- Operations stores the delivery's id, its postal code, its place in a run
  and its outcome. It does not store names, addresses or phone numbers.

### What can be built before the till answers

The fake till (card P5-02a) can be given deliveries in the shape requested
above, and the plan and the driver's screen built and tested against it.
They go live only when the real calls exist.

## Questions for the owner

1. **Who drives?** Staff who already sign in to the app, or outside
   drivers? An outside driver would need a sign-in limited to their own run.
2. **How is a delivery marked delivered today**, and where: by the driver on
   a phone, or by someone at the till afterwards? This decides whether
   Operations must write to the till (request 3) or only read.
3. **Proof of age at the door:** is it checked on every delivery, and should
   the app refuse "Delivered" without it?
4. **Windows and runs:** do customers pick a time window? How many runs go
   out on a normal day, and does one driver ever carry both stores' orders?
5. **Paying at the door:** cash only, or a card machine too?
6. **A failed delivery:** what happens to the order: tried again the same
   day, the next day, cancelled with the fee kept?
7. **Which store:** the vape website only, or does the cstore deliver too?
8. **A suggested plan from an AI assistant:** may it see customers' names
   and addresses, or only the postal code and the window? (The same
   question as in the assistants plan.)
