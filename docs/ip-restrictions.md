# Static IP restriction

Decides, per user, whether that person may work from outside a fixed set of
networks — typically a store's static IP.

Two independent settings on the `user` row:

| Column | Meaning |
| --- | --- |
| `allow_outside_access` | the decision. `1` (default) the user signs in from anywhere; `0` they are confined to `allowed_ips` |
| `allowed_ips` | the addresses they are confined to when the switch is off |

They are deliberately separate. The list is stored either way, so letting
someone work from home for a week does not mean deleting the store's
addresses and retyping them afterwards — you flip the switch back.

`allow_outside_access` defaults to `1`, so every existing account keeps
working from anywhere until an admin restricts it.

## Where the check runs

There are two checks, and both are needed:

1. **At login** (`usecase/user.js`). For a user with outside access off,
   correct credentials from an address outside the allow-list are refused
   with `403 IP_NOT_ALLOWED`, so a blocked user never receives a token.
2. **On every authenticated request** (`middlewares/ip_restriction.js`).
   Tokens last a day, so login alone would let someone sign in at the store
   and keep using that token from home. This middleware runs right after
   `auth`, sees the decoded user, and returns `403 IP_NOT_ALLOWED` the moment
   the caller is off-network.

Policies are cached per user for 60 seconds. Saving a change through the API
drops that user's cache entry, so an edit takes effect immediately.

A failed policy lookup returns `500`, never `next()` — failing open would
defeat the restriction. For the same reason, a user whose switch is off but
whose list is somehow empty is blocked rather than treated as unrestricted;
`validateIpPolicy` refuses to save that pairing, but a row edited straight in
SQL could still reach it.

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

## Troubleshooting: the screen shows 127.0.0.1

That is the server talking to itself, and it means the reverse proxy in
front of Node is not sending `X-Forwarded-For`. Express then has nothing to
read and falls back to the socket address, which is the proxy on localhost.

**Do not allow-list it.** Every request looks identical in this state, so an
allow-list containing a loopback address matches every user on every
network — a restriction that reads as configured while enforcing nothing.
`validateIpPolicy` refuses to save one, and the admin screen shows a banner
instead of offering the address.

nginx needs, in the `location` block that proxies to the app:

```nginx
proxy_set_header X-Real-IP       $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
```

Use `$remote_addr` rather than the more common `$proxy_add_x_forwarded_for`.
That variable *appends* to whatever the client sent, and `trust proxy: true`
reads the left-most entry — so a client could send an `X-Forwarded-For` of
their own and walk straight through the restriction. Overwriting means the
header only ever carries what the proxy actually saw.

If the appending form is needed (a CDN or load balancer in front that must
be preserved), set `TRUST_PROXY` to the number of proxy hops instead, so
Express counts in from the right and ignores anything the client injected.

`GET /user/my-ip` reports `is_loopback`, `is_private` and
`has_forwarded_header` alongside the address, which is what the banner keys
off and what to check after changing the proxy config.

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
locking someone out of every network. Turning outside access off with an
empty list is refused for the same reason — that pairing would leave the user
unable to sign in from anywhere.

## API

All three routes sit under `/user` and require a token. The two
`ip-restrictions` routes additionally require the `manage_ip_restrictions`
permission.

| Route | Purpose |
| --- | --- |
| `GET /user/my-ip` | the address this request came from — what an admin reads off the screen when allow-listing a store |
| `GET /user/ip-restrictions` | every active login with its allow-list |
| `POST /user/ip-restrictions` | replace one user's policy — body `{ user_id, allowed_ips, allow_outside_access }`, where `allowed_ips` is a comma-separated string or an array |

`POST /user/login` gains a third outcome alongside 200 and 400:

```json
{ "code": 403, "error": "IP_NOT_ALLOWED", "msg": "...", "ip": "49.207.1.1" }
```

The web app keys off `error: "IP_NOT_ALLOWED"` to explain the block instead of
sending the user back to a blank login form.

## Admin screen

**Miscellaneous → IP Restrictions** in the web app lists every active login
with its Outside Access state and addresses, and shows the admin's own
current IP for easy copying. One user can be flipped straight from the grid;
the editor changes the switch and the addresses together. Blocking a user who
has no addresses yet opens the editor instead of failing, since there would
be nothing to fall back on.

## Migrations

- `20260902150000-user-ip-restriction` adds `user.allowed_ips` (nullable) and
  the `manage_ip_restrictions` permission key.
- `20260902160000-user-outside-access-switch` adds
  `user.allow_outside_access`, defaulting to `1` so existing accounts stay
  unrestricted, and switches anyone already carrying a list to `0` to
  preserve what that list used to mean on its own.
