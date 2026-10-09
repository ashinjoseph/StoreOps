# 0003. Public pages inline their data; no public RPC

- **Status:** Accepted
- **Date:** 2026-08 (Batch 9); escaping added 2026-10
- **Components:** [public reports](../components/public-reports.md)

## Context

Owners and partners want to see trade and the week's cash without a PIN, and
the close message needed a link to tap. Any RPC callable without a session
is reachable by anyone who has the URL, with any arguments they like.

## Decision

`?v=sales` and `?v=recon` are rendered on the server. `PublicReport` builds an
aggregate payload, and the template inlines it as
`var DATA = <?!= payload ?>;`. **No RPC is callable without a session**, so
the only thing a visitor can get is the document for that view, with a clamped
`?days=`.

- The payload is built from aggregates; the sales page carries no names or
  IDs. The 7-day report names who holds cash, deliberately.
- Each section is wrapped: a failure costs one "unavailable" card, never the
  page, and never a stack trace.
- The inlined JSON writes `<` as `<` (`inlineJson_`), because the
  unescaping scriptlet hands it to the HTML parser raw, and cashier notes
  appear in the payload.

## Consequences

- ✅ The public attack surface is two documents, not an API.
- ✅ One request per page view, which is fast on a phone.
- ⚠️ No live refresh; reload for new numbers.
- ⚠️ The template must use `<?!= ?>` (the escaping `<?= ?>` turns the JSON into
  a string and blanks the page), and nothing else in the file may contain
  scriptlet syntax, comments included. `template-guard` and `public-inline`
  pin both.

## Alternatives considered

- **A public read RPC with a shared key in the URL:** a key in a link that gets
  forwarded is not a secret, and an RPC accepts arbitrary arguments.
- **Publishing a Sheet range:** exposes rows, not aggregates, and can't apply
  the reconcile rules.
