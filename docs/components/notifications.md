# Notifications

> The owner and manager get a WhatsApp message when a till opens, when the day
> is reconciled, and when the shopping list is sent. When a message fails, the
> app says that it failed.

An example close message for cstore, as the recipient sees it (fictional staff and figures):

```text
🧾 Shift Reconciliation
📅 Thu 8 Oct 2026

🏪 cstore
⏰ 08:00–22:15
👤 Maya Chen, Jordan Reyes

Σ Total sales
$4531.66 — cash $2005.37 · card $2526.29

💵 Cash · recorded / counted
$2255.37 / $2255.37 (var +$0.00) ✅
↳ float $250.00 back · $2005.37 in hand

🤝 Cash in hand
Sam Patel $2403.11 · Jordan Reyes $2229.16 · Maya Chen $1586.71

🎟 Lotto reserve
$500.00

💳 Cards
$2526.29 — single total, not independently verified

Result: ✅ Cash matched

StoreOps · automated
[ View 7-day report ]
```

## What it does

| Event | Template config key | Parameters |
|---|---|---|
| Till opened | `whatsapp_template_shift_open` | name, till, time |
| Day reconciled, cstore | `whatsapp_template_shift_close_cstore` | 11 |
| Day reconciled, vape | `whatsapp_template_shift_close_vape` | 12 (adds credit and debit lines; drops lotto) |
| Fallback for either till | `whatsapp_template_shift_close` | 13 |
| Shopping list generated | `whatsapp_template_shopping_list` | date·by, item lines, summary |

Every message goes to each number in `whatsapp_target_number`, so one field can
hold several recipients. The close message carries a **button** to the 7-day
[public report](public-reports.md); it's a static URL button, so adding it
didn't cost an extra template parameter.

The exact template bodies to submit to Meta, with sample values, are in the
[WhatsApp templates guide](../guides/whatsapp-templates.md).

## How it works

```mermaid
sequenceDiagram
    participant R as Reconcile / ShoppingList / WebApp
    participant N as Notifier
    participant C as config
    participant M as WhatsApp Cloud API

    R->>N: sendOp('shift_close_cstore', params, plainText)
    N->>C: whatsapp_template_shift_close_cstore set?
    alt template configured
        N->>N: flatten params (no newlines, tabs or 4+ spaces)
        loop each recipient
            N->>M: POST template message
            M-->>N: 200, or error body
        end
    else no template for this op
        N->>M: generic template (whatsapp_template_name) with the text as {{1}},<br/>or plain text, which Meta delivers only inside a 24h window
    end
    N-->>R: { sent, reason } with Meta's own error sentence
    R-->>R: status line in the UI toast and audit_log
```

`Notifier.notify(event, payload)` is a separate path. It writes an audit entry
for internal events (`shift.opened`, `payment.recorded`,
`commission.computed`) and sends nothing outside.

## When messages stop arriving

Managers and admins tap **💬 Check WhatsApp setup** on the
[Reconcile](reconcile.md) tab (or use **🏪 StoreOps → 💬 Check WhatsApp setup**
in the Sheet). It checks each setting in order, then asks Meta whether the
token and phone number are still valid. It sends no message and never shows
the token.

![The check naming an expired token, with the fix](../images/whatsapp-check.png)

Then, in order of likelihood:

| Symptom | Where to look | Usual cause |
|---|---|---|
| Toast after a close: *WhatsApp NOT sent — …* | the toast; `audit_log` rows `reconcile.day` (`whatsapp=…`) | Meta's reason is in the text: an expired token (`Session has expired`), a template not approved, or a parameter count mismatch |
| Toast after opening a till: *WhatsApp NOT sent — …* | `audit_log` rows `notify.shift_open_failed` | same as above |
| No toast at all after the last close of the day | Is another till still open? | The close message waits until **every** till for the day is closed, then sends once |
| The check says *Meta accepts the token: HTTP 401* | Meta Business Settings → System Users | A temporary or 60-day token expired. Generate a permanent System User token and paste it into `whatsapp_api_token`. |
| Messages arrive for some numbers only | the per-number results in the toast or audit row | A recipient that hasn't messaged the business number, on a test number, or an invalid E.164 number |

## Rules it must not break

- **The parameter shape follows the template, not the till's state**
  ([ADR-0007](../adr/0007-message-shape-follows-the-template.md)). A wrong
  parameter count gets an `http_400` from Meta, and before this rule the day
  reconciled with no sign that the message never arrived.
- **A failed send says why.** The result carries Meta's error message, and
  the UI shows "Reconciled · WhatsApp NOT sent — <reason>" instead of a ✓.
- **Parameters are flattened.** Meta rejects template parameters that contain
  newlines, tabs or long runs of spaces, and shows `*bold*` literally. An empty
  parameter is sent as `—` so the call isn't rejected.
- **Notifications never block the work.** A failed send never undoes a close
  or a reconcile.
- **Every failed send leaves a trace.** The close message writes its outcome to
  `audit_log` (`reconcile.day`); a failed shift-open notice writes
  `notify.shift_open_failed` and shows a warning toast. Only a notifier switched
  off on purpose stays quiet.
- **Clover doesn't gate messages.** `clover_enabled` decides whether cards are
  checked; `notifier_enabled` decides whether messages go out. Before Oct 2026,
  switching Clover off silently stopped every close message.

## Code map

| What | Where |
|---|---|
| Server | `src/Notifier.gs`: `sendOp`, `sendTemplate`, `notify`, `diagnose`, `dispatch_`, `apiError_` |
| Callers | `src/Reconcile.gs` (close), `src/ShoppingList.gs` (list), `src/WebApp.gs`: `rpcNotifyShiftOpen` |
| Diagnostic | `src/WebApp.gs`: `rpcCheckWhatsApp` · `src/Setup.gs`: `menu_checkWhatsApp` · `src/Index.html`: `renderWhatsAppCheck_` |

## Tests

| Suite | Holds down |
|---|---|
| `notifier` | the wire payload, flattening, recipients, what a Meta rejection reports back; `diagnose` asks Meta with a GET, names an expired token in Meta's words, flags missing settings without calling Meta, never returns the token |
| `rpc-guards` | the check is for managers and admins; a failed shift-open notice writes an audit row, a successful or deliberately disabled one doesn't |
| `ui-recon` | the check button is on the panel; the result marks pass and fail, shows the fix only on a failure, escapes Meta's text |
| `reconcile` | parameter count per template, shape follows the template, fallback key and shape |
| `link` | the report button: right view appended, or no link at all |
| `template-guard` | the Apps Script templating contract the pages rely on |

## History

- **Oct 2026:** the close message no longer depends on `clover_enabled`; a
  failed shift-open notice shows a toast and writes an audit row; **💬 Check
  WhatsApp setup** diagnoses the setup from the app or the Sheet.
- **#14–#16:** send the parameter count the template expects; bind the shape to
  the template; keep Meta's sentence that identifies the fault.
- **#12 (Batch 13):** one close template per till.
- **Batch 8:** the close message rebuilt on 13 parameters.
