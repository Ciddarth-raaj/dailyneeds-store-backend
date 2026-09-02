# Static IP restriction

Locks an account to one or more networks. A user with a configured allow-list
can only sign in — and only keep an existing session alive — from those
addresses. Users with an empty allow-list are unrestricted, so nothing changes
for an account until an admin configures it.

## Where the check runs

There are two checks, and both are needed:

1. **At login** (`usecase/user.js`). Correct credentials from an address
   outside the allow-list are refused with `403 IP_NOT_ALLOWED`, so a blocked
   user never receives a token.
2. **On every authenticated request** (`middlewares/ip_restriction.js`).
   Tokens last a day, so login alone would let someone sign in at the store
   and keep using that token from home. This middleware runs right after
   `auth`, sees the decoded user, and returns `403 IP_NOT_ALLOWED` the moment
   the caller is off-network.

Allow-lists are cached per user for 60 seconds. Saving a change through the
API drops that user's cache entry, so an edit takes effect immediately.

A failed allow-list lookup returns `500`, never `next()` — failing open would
defeat the restriction.

> **Known gap:** routes listed in `unProtectedRoutes` in `middlewares/auth.js`
> never populate `req.decoded`, so the per-request check does not apply to
> them. That is a pre-existing property of the auth middleware, not something
> this feature introduced.

## Resolving the client IP

`utils/ip.js#getClientIp` reads `req.ip`, which Express fills from
`X-Forwarded-For` when `trust proxy` is set. `server.js` sets it to `true` by
default because the app runs behind a reverse proxy in production.

If the app is ever exposed directly to the internet, set `TRUST_PROXY=false`
— otherwise a client can spoof `X-Forwarded-For` and defeat the restriction.
`TRUST_PROXY` also accepts anything Express accepts (a hop count, a subnet).

## Allow-list format

Entries are stored comma separated in `user.allowed_ips` and may be:

| Format | Example | Matches |
| --- | --- | --- |
| Exact address | `203.0.113.10` | that address only (IPv4 or IPv6) |
| CIDR block | `203.0.113.0/24` | `203.0.113.0`–`203.0.113.255` |
| Wildcard | `203.0.113.*` | any last octet |
| Last-octet range | `203.0.113.10-20` | `203.0.113.10`–`203.0.113.20` |
| Full range | `203.0.113.10-203.0.114.5` | that span |

Entries are validated on save, so a typo is rejected rather than silently
locking someone out of every network.

## API

All three routes sit under `/user` and require a token. The two
`ip-restrictions` routes additionally require the `manage_ip_restrictions`
permission.

| Route | Purpose |
| --- | --- |
| `GET /user/my-ip` | the address this request came from — what an admin reads off the screen when allow-listing a store |
| `GET /user/ip-restrictions` | every active login with its allow-list |
| `POST /user/ip-restrictions` | replace one user's allow-list — body `{ user_id, allowed_ips }`, where `allowed_ips` is a comma-separated string or an array; empty removes the restriction |

`POST /user/login` gains a third outcome alongside 200 and 400:

```json
{ "code": 403, "error": "IP_NOT_ALLOWED", "msg": "...", "ip": "49.207.1.1" }
```

The web app keys off `error: "IP_NOT_ALLOWED"` to explain the block instead of
sending the user back to a blank login form.

## Admin screen

**Miscellaneous → IP Restrictions** in the web app lists every active login
with its allow-list, shows the admin's own current IP for easy copying, and
edits one user's list at a time.

## Migration

`20260902150000-user-ip-restriction` adds `user.allowed_ips` (nullable, so
existing accounts stay unrestricted) and the `manage_ip_restrictions`
permission key.
