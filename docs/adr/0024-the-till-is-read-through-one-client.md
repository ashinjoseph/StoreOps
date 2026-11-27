# 0024. The till is read through one client that never throws, and ships switched off

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [till link](../components/till-link.md), [settings](../components/settings.md)

## Context

[ADR-0021](0021-till-figures-come-through-an-api.md) decided that Operations
reads the till only through its versioned API, with a key. The contract is
`ops/contracts/till-api.v1.yaml` (1.1.0). Several later cards call it: people
and stores matched, sales by channel, the vape close, the delivery receipt.

Calling it is not like calling Clover or WhatsApp. The request carries a key
that is good for 90 days and can read every figure the till holds for the
store, so a key that went to the wrong address, or into a log, would be a
leak worth acting on. The till rate-limits (60 a minute per key), can be down
at close time, and can answer with something that is not what the contract
says. And the people who will call it are several later cards, each tempted
to call `fetch` for itself.

## Decision

- **One client, `ops/src/till/client.ts`, is the only place that calls the
  till.** Every later card gets a client from `tillClientFor` and calls its
  functions; none calls `fetch` for the till. A test searches the code for any
  other importer.
- **It never throws.** Each function answers `{ ok: true, data }` or
  `{ ok: false, error: { kind, status?, code?, message, retryAfterSeconds? } }`
  with `kind` one of twelve (`not_configured`, `bad_address`, `bad_input`,
  `timeout`, `network`, `rate_limited`, `unauthorized`, `forbidden`,
  `not_found`, `server`, `bad_answer`, `rejected`). A caller handles an
  answer; it never needs a `try`.
- **The key goes only to the till's own addresses.** `isTillUrl` accepts
  `https`, no user name or password, no port written, no fragment, a host
  that is exactly one of the contract's `servers`, and a path inside that
  server's base path. Anything else is `bad_address` and no request is made.
  The Settings screen refuses a `till_api_url` that fails the same function.
- **The key is in a header, and scrubbed from every message.** It is sent
  only as `Authorization: Bearer`, never in a URL. Every text that leaves the
  client (the till's own error message, our messages) has the key replaced,
  in its raw, URL-encoded, JSON-escaped and base64 forms, even when the till
  echoes the header back. It is in no thrown value and no log line (the
  client logs nothing).
- **A redirect is never followed** (`redirect: "manual"`): it is `bad_answer`,
  so the key cannot follow one to another host.
- **Slowing down is the client's job, and bounded.** On 429 it waits for
  `Retry-After` (seconds, or an HTTP date read against the injected clock;
  missing or unreadable counts as 1 second) with the injected `sleep`, at
  most twice and at most 10 seconds in all, then answers `rate_limited` with
  `retryAfterSeconds`. A request that takes over 8 seconds is `timeout`. A 5xx
  and a timeout are **not** retried: the caller decides.
- **Light checks in the Worker, the full check in the tool.** The client
  checks that the answer is JSON, has the top-level keys the contract
  requires for that endpoint, has lists where the contract says list, and
  names the store that was asked about. The schema check (types, enums,
  formats, arithmetic) is `ops/tools/till-check.ts`, which loads the contract
  with ajv in Node. The hand-written types are held to the contract by a test
  that validates every answer of a fake till against it.
- **Time, waiting, the network and the key come from outside** (`now`, `sleep`,
  `fetch`, the Worker's binding), so a test sees all of them. The client has no
  `new Date()`, timer, `process` or randomness.
- **GET only.** The client has no code path that can send anything. Sending a
  proposal (a supplier receipt) is a later card, and will add its own function
  and its own tests.
- **A fake till built from the contract** (`ops/src/till/fake.ts`) serves the
  GET endpoints from fictional data, with switches for every failure, so no
  test ever calls the real till.
- **It ships off.** `till_enabled` is false by default, `till_api_url` is blank,
  and the key (`TILL_API_KEY`) is a Worker secret that is not bound. Until all
  three are set, every call answers `not_configured` and makes no request.
  Nothing calls the client yet; a test finds any caller outside `ops/src/till`.

## Consequences

- ✅ A mistyped or hostile setting cannot send the key anywhere else, and the
  Settings screen says so when it refuses one.
- ✅ A till that is down, slow, throttling, or wrong is an answer the caller
  can show ("till down: enter it by hand"), not an exception in the middle of a
  close.
- ✅ Every later card is tested against the same fake, so the cases the
  contract describes (an `auto_closed` shift with nothing counted, the nil
  uuid, takings short of the total, door cash) are built once.
- ✅ The Worker bundle stays small: no ajv, no YAML parser, no `node:fs`.
- ⚠️ The light check lets through a wrong *value* (a string where the contract
  says a number). That is deliberate: the tool, run against staging before
  anything is switched on, is where the contract is held to its word; a Worker
  that rejected a whole close for one wrong field would be worse than one that
  hands the field on. A later card that depends on a field's type checks that
  field.
- ⚠️ Waiting out a 429 holds the caller for up to 10 seconds. A caller that
  cannot wait (a page load) passes a smaller `maxWaitMs`.
- ⚠️ The client must be given a `sleep` that really waits (and clears its
  timer when told); a stub that returns at once is tolerated (it is not
  mistaken for a timeout) but then 429s are not waited for.

## Alternatives considered

- **Each module calls `fetch` itself, as Clover and WhatsApp do.** Rejected:
  the rules above (address, key scrubbing, redirects, throttling, timeouts)
  would be copied by every caller and tested once each, and one caller that
  forgot one would be the leak. Clover and WhatsApp send a token to one fixed
  host; the till's key reaches into the money and is checked in one place.
- **Validate every answer with ajv in the Worker.** Rejected: it would put a
  schema compiler (and the contract's YAML) in the bundle and on the request
  path to catch problems the staging check catches once. The tool does it with
  the real contract; the Worker does the light part.
- **Follow redirects, as `fetch` does by default.** Rejected: a redirect to
  another host would carry the request on, and a client cannot be sure what a
  runtime does with the `Authorization` header across one. The till does not
  redirect; if it starts to, that is news to be read, not followed.
- **Retry a 5xx.** Rejected: the till does not say whether a failed request
  was applied, and the caller knows whether a second try is safe or useful
  (a close can fall back to hand entry; a nightly copy can wait). A retry in
  the client would also hide a till that is down behind a long wait.
- **Throw, and let callers catch.** Rejected: every caller would need the same
  `try`, and one that forgot would turn a till outage into a failed close.
