# Auth Design — StoreOps v1

## Threat model

Protect against: staff seeing each other's pay; cashier accidentally
recording payment as someone else; opportunistic prying.

Not protected against: a determined attacker with Google account access;
staff who share their PIN; someone with sheet edit access.

## Login flow

1. Web app loads → server renders the login pane (built into `Index.html`)
2. Dropdown of active staff names (from `staff` sheet)
3. User picks name + types 4-digit PIN → POSTs to `Auth.login(name, pin)`
4. Server validates against `staff.login_code` (constant-time compare)
5. On success:
   - Random UUID token generated
   - `PropertiesService` stores `session:<token>` →
     `{staff_id, name, role, companies_authorized, expires_at}`
   - Token + identity returned to client
6. Client stores token in `sessionStorage` (clears on browser close)
7. Every subsequent RPC includes token; server validates + extends

## Rate limiting

Track failed login attempts per-name in `PropertiesService` under
`loginFails:<lowercased-name>`. After `login_max_fails` (default 5)
within `login_lockout_mins` window (default 60), reject for that user
until window passes.

Reset counter on successful login.

## Roles

| Role | Cashier ops | Schedule edit | Payments | Sales dashboard | Rates/staff mgmt |
|------|-------------|---------------|----------|-----------------|------------------|
| **employee** | ✓ own | ✗ | ✗ | ✗ | ✗ |
| **manager** | ✓ own | ✓ | view only | ✓ | ✗ |
| **admin** | ✓ own | ✓ | ✓ | ✓ | ✓ |

Every staff member can do cashier ops (open/close their own
till_sessions). Manager can also schedule and view sales. Admin can
also do payroll and manage staff.

## Server-side enforcement

Pattern for every RPC:

```javascript
function rpcGetSalesDashboard(token, filters) {
  const session = Auth.validate(token);            // throws if invalid
  Auth.require(session, ['admin', 'manager']);     // throws if wrong role
  return Sales.getDashboard(filters);
}
```

For RPCs where employees see their own data only:

```javascript
function rpcGetMyHistory(token) {
  const session = Auth.validate(token);
  return Payments.getHistoryForStaff(session.staff_id);
}
```

**Never trust client-sent role.** Always read fresh from validated session.

## Session lifetime

- 24 hours default (configurable via `_Config.session_hours`)
- Rolling: every successful RPC extends to 24h from "now"
- Token is opaque; no client-visible expiry; UI just redirects to login
  if any RPC returns `NOT_LOGGED_IN`

## Audit

Every login attempt (success or fail) writes to audit_log:
- `login.success` — `details = name`
- `login.fail` — `details = reason` (unknown_name / wrong_code / rate_limited)
- `login.logout` — explicit logout

Lets you spot pattern abuse: "5 failed Blesson attempts from 3am Tuesday."
