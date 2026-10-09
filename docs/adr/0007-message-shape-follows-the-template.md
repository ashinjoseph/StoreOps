# 0007. A message's shape follows its template, and a failed send says why

- **Status:** Accepted
- **Date:** 2026-09 (#14–#16)
- **Components:** [notifications](../components/notifications.md), [reconcile](../components/reconcile.md)

## Context

WhatsApp business messages outside a 24-hour window must use a template
pre-approved by Meta, with a fixed number of parameters. The close message's
parameter list was built from the **till's state** (Clover or not, lotto or
not), so when state and template disagreed, the wrong count went to an
approved template. Meta answers `http_400`, the send path swallowed it, the day
reconciled, and **no message arrived for days**, while the UI showed
"✓ Reconciled".

## Decision

- **The template decides the shape.** Each config key
  (`whatsapp_template_shift_close_cstore`, `…_vape`, the shared fallback) maps
  to a known parameter count, and params are built for that template, whatever
  the till's state.
- **One template per till** where the content differs, instead of one template
  with "not tracked on this till" lines.
- **Failures are reported**, not swallowed: the result carries Meta's own error
  sentence (`error_data.details` names both counts), and the UI says
  "Reconciled · WhatsApp NOT sent — <reason>".
- Notifications **never block** a close or a reconcile.

## Consequences

- ✅ A mismatch shows up the first time it happens, with the counts named.
- ✅ Rollout is safe in any order: until a new template is approved and its key
  set, the till falls back to the shared one.
- ⚠️ A new template means a Meta approval round. Changing what a message says
  is a template change, not just a code change.

## Alternatives considered

- **Flatten everything into one `{{1}}` parameter:** Meta rejects newlines
  inside a parameter, so the whole message becomes one unreadable line.
- **Retry on failure:** a parameter-count error never succeeds on retry.
