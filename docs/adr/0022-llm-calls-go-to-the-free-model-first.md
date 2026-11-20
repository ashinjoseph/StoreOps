# 0022. LLM calls go to the free model first, with Claude behind a flag

- **Status:** Proposed (pending owner review of the migration plan)
- **Date:** 2026-11
- **Components:** purchase receipts and delivery runs (planned; see the [migration plan](../plans/2026-11-operations-app-migration.md))

## Context

Two planned features need a language model: reading purchase receipts from a
photo, and turning orders into a delivery run sheet. Volume is small, around
a hundred receipts a month. The shop has no security engineers, so a
pay-as-you-go key that leaks and runs up a bill is a real worry. A free
hosted model exists on the platform the shop is moving to, but open vision
models read messy receipts less reliably.

## Decision

- **One gateway module.** Features call `extractReceipt(image)` and the like;
  they never talk to a provider.
- **Two providers behind it:** Cloudflare Workers AI and the Claude API.
- **A mode per task**, changed in config with no deploy:
  `cf_only` (the starting mode; no Claude key is installed at all),
  `cf_then_claude` (Claude only when a check fails), `claude_only`.
- **Code decides what a failure is**, never the model's own confidence: the
  reply doesn't fit the required structure, the lines don't add up to the
  total, a required field is missing, or the provider errored.
- **A person confirms every result** before anything is posted. The app
  records each field the reviewer corrected, per provider. That correction
  rate is the measure used to change the mode.
- **Spending is capped three ways:** a prepaid balance with auto-reload off,
  a daily cap on escalations, and the model and output size fixed on the
  server. The key is a Worker secret.
- **The model never writes to money or stock.** It drafts; code checks; a
  person approves.

## Consequences

- ✅ Starts at zero cost and zero billing risk, and can step up per task.
- ✅ Swapping or adding a provider touches one module.
- ✅ The decision to pay for a better model rests on measured corrections.
- ⚠️ Checks in code catch arithmetic, not a wrong product name on a receipt
  that adds up. The reviewer is the last line.
- ⚠️ Two providers to keep working and to test.
- ⚠️ In `cf_only`, a receipt the free model can't read is typed in by hand.

## Alternatives considered

- **Claude only:** simplest and most accurate, with a bill from day one.
- **An in-house model:** a machine to run and maintain to save a few dollars
  a month, with weaker reading.
- **A free tier that trains on what it is sent:** supplier invoices are
  confidential business documents.
