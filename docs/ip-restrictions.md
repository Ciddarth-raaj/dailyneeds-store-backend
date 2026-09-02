# IP restriction

Decides where a person may sign in from. There are two layers, and every
request is checked against both at once:

| Layer | Where it lives | Meaning |
| --- | --- | --- |
| **Branch** | `outlets.ip_restriction_enabled`, `outlets.allowed_ips` | while the switch is on, every employee assigned to the outlet (`new_employee.store_id = outlets.outlet_id`) is confined to these addresses — typically the branch's static IP. The list is kept while the switch is off so it need not be retyped. |
| **User** | `user.ip_policy`, `user.allowed_ips` | one of `branch` (default: follow the branch rule; personal list ignored), `custom` (personal list enforced, unioned with the branch list while that is on) or `unrestricted` (explicit exemption, no check). |

`user.allow_outside_access` from the previous release is still present but no
longer read or written; a later cleanup migration drops it.

## Resolution

`utils/ip.js#resolveIpPolicy(row)` folds the two layers into one
`{ exempt, rules, source }` answer:

```
unrestricted            → exempt
custom                  → rules = personal ∪ branch (branch part only while its switch is on)
branch, admin           → exempt        (user_type 2 never inherits branch rules)
branch, switch off      → exempt        (nothing to enforce — the default state for everyone)
branch, switch on       → rules = branch list
```

A non-exempt policy with an empty rule set is enforced as "nowhere". Saving
refuses those pairings (see Validation), but a row edited straight in SQL
must fail closed rather than quietly open up.

**Admins are exempt by default** — the migration sets every `user_type = 2`
account to `unrestricted`, and an admin left on `branch` is still treated as
exempt. An admin deliberately set to `custom` *is* enforced.

**Precedence is union.** A `custom` user at a restricted branch may sign in
from either their own addresses or the branch's.

## Where the check runs

There are two checks, and both are needed:

1. **At login** (`usecase/user.js`). Correct credentials from an address the
   resolved policy does not admit are refused with `403 IP_NOT_ALLOWED`, so a
   blocked user never receives a token.
2. **On every authenticated request** (`middlewares/ip_restriction.js`).
   Tokens last a day, so login alone would let someone sign in at the branch
   and keep using that token from home. This runs right after `auth`, resolves
   the caller's policy, and returns `403 IP_NOT_ALLOWED` the moment they are
   off-network.

The resolved policy is cached per user for 60 seconds. Saving a **user**
policy drops that user's entry; saving a **branch** rule clears the whole
cache, since every employee of the branch shares it. The branch is read live
from `new_employee.store_id` (not from the token), so moving an employee
between branches takes effect within that window.

A failed lookup returns `500`, never `next()` — failing open would defeat the
restriction.

> **Known gap:** routes listed in `unProtectedRoutes` in `middlewares/auth.js`
> never populate `req.decoded`, so the per-request check does not apply to
> them. That is a pre-existing property of the auth middleware.

## Resolving the client IP

`utils/ip.js#getClientIp` reads `req.ip`, which Express fills from
`X-Forwarded-For` when `trust proxy` is set. `server.js` sets it to `true` by
default because the app runs behind nginx in production.

If the app is ever exposed directly to the internet, set `TRUST_PROXY=false`
— otherwise a client can spoof `X-Forwarded-For` and defeat the restriction.
`TRUST_PROXY` also accepts anything Express accepts (a hop count, a subnet).

## Troubleshooting: the screen shows 127.0.0.1

That is the server talking to itself, and it means the reverse proxy in
front of Node is not sending `X-Forwarded-For`. Express then has nothing to
read and falls back to the socket address, which is the proxy on localhost.

**Do not allow-list it.** Every request looks identical in this state, so an
allow-list containing a loopback address matches every user on every
network. Validation refuses to save one, and the admin screens show a banner
instead of offering the address.

nginx needs, in the `location` block that proxies to the app:

```nginx
proxy_set_header X-Real-IP       $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
```

Use `$remote_addr` rather than `$proxy_add_x_forwarded_for`. That variable
*appends* to whatever the client sent, and `trust proxy: true` reads the
left-most entry — so a client could send an `X-Forwarded-For` of their own
and walk straight through. The `Fix Proxy Headers` workflow
(`.github/workflows/fix-proxy-headers.yml`) applies this change to the
server, validates with `nginx -t`, and reloads; it is a no-op once in place.

`GET /user/my-ip` reports `is_loopback`, `is_private` and
`has_forwarded_header` alongside the address, which is what the banners key
off and what to check after changing the proxy config.

## Allow-list format

Entries are stored comma separated and may be:

| Format | Example | Matches |
| --- | --- | --- |
| Exact address | `203.0.113.10` | that address only (IPv4 or IPv6) |
| CIDR block | `203.0.113.0/24` | `203.0.113.0`–`203.0.113.255` |
| Wildcard | `203.0.113.*` | any last octet |
| Last-octet range | `203.0.113.10-20` | `203.0.113.10`–`203.0.113.20` |
| Full range | `203.0.113.10-203.0.114.5` | that span |

### Validation

`utils/ip.js#validateIpPolicy({ restricted, allowedIps })` runs on every save,
for users and branches alike:

- an unparseable entry is rejected;
- a loopback entry is rejected (see Troubleshooting);
- an empty list is rejected when it would actually be enforced — a `custom`
  user, or a branch with its switch on — since that would lock everyone it
  binds out of every network.

## API

Everything requires a token and the `manage_ip_restrictions` permission
unless noted.

| Route | Purpose |
| --- | --- |
| `GET /user/my-ip` | the caller's address plus `is_loopback` / `is_private` / `has_forwarded_header` (token only, no permission) |
| `GET /user/ip-restrictions` | every active login with `ip_policy`, `allowed_ips`, its branch's `branch_enabled` / `branch_ips`, and the resolved `effective` policy |
| `POST /user/ip-restrictions` | `{ user_id, allowed_ips, ip_policy }` — `allowed_ips` is a comma-separated string or an array; `ip_policy` is `branch` / `custom` / `unrestricted`. The previous release's `allow_outside_access` boolean is still accepted in place of `ip_policy` (true → `branch`, false → `custom`) |
| `GET /outlet/ip-restrictions` | every branch with `ip_restriction_enabled`, `allowed_ips` and `employee_count` |
| `GET /outlet/ip-restriction?outlet_id=` | one branch's rule (404 when missing) |
| `POST /outlet/ip-restriction` | `{ outlet_id, allowed_ips, ip_restriction_enabled }` — clears the whole policy cache on success |

The branch rule is deliberately **not** part of `POST /outlet/update-outlet`
or `POST /outlet/create`: those need no token, and their Joi schemas reject
the two IP columns, so nobody who can reach the outlet form can change where
a branch's staff may sign in from. The token-less outlet reads (`GET /outlet`,
`GET /outlet/id`, `GET /outlet/outlet_id`) strip the two columns in
`usecase/outlet.js` for the same reason.

`POST /user/login` gains a third outcome alongside 200 and 400:

```json
{ "code": 403, "error": "IP_NOT_ALLOWED", "msg": "...", "ip": "49.207.1.1" }
```

The web app keys off `error: "IP_NOT_ALLOWED"` to explain the block instead of
sending the user back to a blank login form.

## Admin screens

Both live under **Masters → Branch and Restrictions** in the web app.

- **Branches** (`/master/branch`, permission `view_branch`): the branch list
  with an IP badge, and the branch form. Holders of `manage_ip_restrictions`
  also see an **IP Access** section on an existing branch — the switch, the
  address list, and the admin's own current IP for easy copying — which saves
  through `POST /outlet/ip-restriction` separately from the branch form.
- **IP Restrictions** (`/master/ip-restrictions`, permission
  `manage_ip_restrictions`): every login with its branch, its policy, and the
  effective result; the editor offers the three policies and shows the
  branch's addresses when they also apply.

Old URLs (`/branch-details`, `/branch-details/<mode>`, `/misc/ip-restrictions`)
redirect.

## Lock-out recovery

An admin set to `custom` with only the branch's address loses remote access.
Both editors warn before saving. If it happens anyway:

```sql
UPDATE `user` SET `ip_policy` = 'unrestricted' WHERE `user_id` = <id>;
```

Nothing else needs restarting; the cache expires within a minute.

## Migrations

- `20260902150000-user-ip-restriction` — `user.allowed_ips` and the
  `manage_ip_restrictions` permission.
- `20260902160000-user-outside-access-switch` — `user.allow_outside_access`
  (now superseded, column retained for the moment).
- `20260902170000-branch-ip-restriction` — `outlets.allowed_ips`,
  `outlets.ip_restriction_enabled`, `user.ip_policy` (backfilled: admins →
  `unrestricted`, previously restricted users → `custom`, everyone else →
  `branch`), and the `view_branch` permission.
