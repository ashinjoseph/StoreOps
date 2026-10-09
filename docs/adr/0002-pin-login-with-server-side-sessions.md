# 0002. PIN login with server-side sessions

- **Status:** Accepted
- **Date:** 2026-05; token storage revised 2026-08
- **Components:** [app shell and auth](../components/app-shell-and-auth.md), [security](../architecture/security.md)

## Context

Staff don't have work Google accounts and log in on their own phones, often
several times a day. The threat is a coworker seeing pay or recording as
someone else, not a nation-state. The web app has to run as the deploying
user (so it can read the Sheet) and be open to anyone (for the public pages),
so Google's own login can't identify the person.

## Decision

- Log in with **name + 4-digit PIN**, compared in constant time. The same
  error for an unknown name and a wrong PIN. Lock a name out after
  `login_max_fails` failures within `login_lockout_mins`.
- Issue a random **opaque token**. The session (`staffId`, `role`,
  companies, expiry) lives **server-side** in script properties.
- **Rolling expiry:** renew when an RPC arrives past the half-life of
  `session_hours`.
- Every RPC starts `Auth.validate(token)` → `Auth.require(session, roles)`
  and takes identity and role **only** from the session.
- Keep the token in **`localStorage`** (revised from `sessionStorage`, see below).

## Consequences

- ✅ Nobody needs a Google account; logging in takes two seconds.
- ✅ The client can't claim a role; `rpc-guards` asserts a client-sent role is
  ignored.
- ✅ Logout or deleting the property revokes a session immediately.
- ⚠️ A 4-digit PIN is weak on its own. Lockout and audit are what make it
  acceptable at this scale.
- ⚠️ `localStorage` survives closing the browser, so a shared phone stays
  logged in until logout or expiry.

## Alternatives considered

- **`sessionStorage` for the token** (the original choice): mobile browsers
  discard tabs aggressively, so staff re-entered their PIN all day despite a
  valid 24-hour server session. Replaced in Batch 6.
- **Google sign-in:** staff don't have accounts, and the web app runs as the
  deployer.
- **Signed stateless tokens (JWT-style):** no way to revoke one without a
  server-side list, which is what script properties already are.
