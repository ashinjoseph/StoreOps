# 0025. Assistants come in through MCP, with a key per person, and only propose

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [assistants](../components/assistants.md), [settings](../components/settings.md), the Operations app (`ops/`; see the [plan for assistants](../plans/2026-11-assistants-through-mcp.md))

## Context

The owner wants AI assistants (Meta's Muse first, Claude after) to do work
that a person does today: read purchase receipts and emailed invoices, and
later plan deliveries. On Nov 27 the owner decided that, for the first
iteration, the app runs no model of its own: the assistant the owner already
uses does the reading, and the app gives it a way in.

That way in sits on the public internet, next to an app that holds pay, cash
and staff records. An assistant can be confused, or steered by text in a
document it reads ("ignore the above and…"). Whatever the door lets it do, a
misled assistant can do too.

The standard way to give an assistant tools is the Model Context Protocol
(MCP). Muse connects to a remote MCP server over streamable HTTP with a key
in a header.

## Decision

- **One door: `POST /mcp`**, an MCP server built on the official SDK
  (`@modelcontextprotocol/sdk`, pinned), stateless, answering with JSON. No
  server-kept session, no open stream, no Durable Object. `GET` and `DELETE`
  answer 405.
- **Off until switched on.** The setting `assistants_enabled` (default no).
  While it is off, `/mcp` answers 404 with an empty body to everyone and
  writes nothing.
- **A key per person, per assistant**, made and withdrawn by an admin on the
  Assistants screen: `ops_<key id>_<secret>`, 32 random bytes, shown once. The
  database keeps the SHA-256 of the key, never the key. A key belongs to one
  active person, has a label, an expiry (1 to 365 days, default 90), a right,
  and a yes/no for customers' personal details. It stops at once when it
  expires, is withdrawn, or its person is deactivated.
- **Two rights: read, and propose** (which includes read). A proposal changes
  nothing until a person confirms it on a screen. No tool confirms, pays,
  deletes, changes a setting, or reads pay, PINs or the audit log.
- **An allowlist of tools in one file** (`ops/src/mcp/tools.ts`). There is no
  tool that runs an arbitrary RPC, query or path, and nothing under
  `ops/src/mcp/` may import the RPC registry or router. A test pins the list.
- **Results are data, never instructions.** Each answer is one text block: a
  one-line summary, then JSON. Free text from outside the code passes through
  `asData` (one line, no control or direction-changing characters, capped).
- **Limits and a record.** Calls per minute and proposals per Toronto day,
  per key, counted under the key's row lock. Every call, allowed or refused,
  is a row in `ops.assistant_calls` (never the arguments or the answer); a
  flood of bad keys is answered but recorded only up to a per-address and a
  total limit. Making and withdrawing a key are audited.
- **A wrong key learns nothing**: every refusal is the same 401. **No
  browser**: a request with an `Origin` header is refused and no CORS header
  is ever sent.

## Consequences

- ✅ The owner's own assistant does the reading; the app pays for and runs no
  model, and the worst a misled assistant can do is file a wrong proposal,
  which a person sees before it counts.
- ✅ Every action is tied to a named person and a named key, and a key can be
  withdrawn in one tap without touching anyone else's.
- ✅ The SDK keeps the protocol right (versions, framing, errors); the
  official client is used in the tests, so compatibility is checked, not
  assumed.
- ⚠️ It works only on the hosted app: an assistant reaches it from its
  provider's cloud, never a copy on a home computer.
- ⚠️ The SDK and its schema library (zod) roughly triple the Worker's bundle
  (about 120 KB to about 330 KB gzipped). Still far under the platform limit.
- ⚠️ `ops.assistant_calls` grows with use and is never deleted by the app; a
  later card decides how long rows are kept.
- ⚠️ A bearer key is only as safe as the place it is pasted. The screen says
  to paste it only into the assistant's secure field, never a chat.

## Alternatives considered

- **A model run by the app** ([ADR-0022](0022-llm-calls-go-to-the-free-model-first.md)):
  postponed. It means paying for and operating a model, and the owner's
  assistant already reads documents well.
- **Let an assistant use a person's session** (sign in with a PIN, use the
  page's RPCs): it would hold every right that person has, pay and settings
  included, with nothing to tell its calls from the person's.
- **One shared key for the store:** cannot be withdrawn from one assistant
  without breaking the others, and ties no call to a person.
- **OAuth first:** Muse connects with a key, and a sign-in flow is a large
  piece of security code to get right. Claude's connectors may need it; that
  is a later card, decided by the trial (P5-10).
- **A generic "call any RPC" tool:** the RPC list includes payroll and
  settings; any allowlist would then live in a second place and drift. Tools
  are written one by one instead.
