# Authentication decoupling audit

An inspection. **Nothing has been changed.**

Scope: the login and authorisation path end to end across
`dailyneeds-store` (frontend) and `dailyneeds-store-backend`, and how much of
it depends on Digisme. Companion to [hr-schema.md](hr-schema.md) and
[payroll-target-architecture.md](payroll-target-architecture.md).

**The headline, up front: login does not call Digisme. It never has.**
Authentication is already fully local — username and password are checked
against the `user` table in this database. Digisme's only influence is
*indirect*, through one column it writes, and that dependency is removable in
a single line of code.

That is the good news. The bad news is that the local authentication which
already exists has several serious weaknesses, and one of them means a large
share of accounts are protected by a password that can be derived from the
employee code. Those are documented in §9 and pulled into Stage 0 in §16.

No password, key, token or secret value is reproduced in this document. Where
a credential pattern matters, the file and line are cited instead.

---

## 1. Current login flow

### 1.1 End to end

```
pages/login.js
  └─ helper/login.js
       └─ util/api.js  (axios, baseURL = NEXT_PUBLIC_API_URL)
            POST /user/login?username=…&password=…        ← credentials in the QUERY STRING
                 │
                 ▼
       server.js  → app.use(cors())
                  → app.use(auth)              middlewares/auth.js
                       /user/login POST is in unProtectedRoutes → skipped
                  → app.use(ipRestriction)     middlewares/ip_restriction.js
                       no req.decoded → next()
                  → app.use("/user", userRouter)
                 │
                 ▼
       routes/user.js  POST /login
            Joi validates { username, password } from req.query
            getClientIp(req)
                 │
                 ▼
       usecase/user.js  login(username, password, clientIp)
            ├─ userRepo.login(username, password)      ← the only credential check
            ├─ employeeRepo.getNameById(username)      ← display name lookup
            ├─ resolveIpPolicy / isAccessAllowed       ← network check
            └─ jwt.sign(info, "1d")                    services/jwt.js, RS256
                 │
                 ▼
       repository/user.js  login()
            SELECT … FROM `user` u
              LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
              LEFT JOIN outlets o       ON o.outlet_id   = ne.store_id
            WHERE u.status = 1 AND ne.status = 1
              AND u.username = ? AND u.password = SHA1(?)
                 │
                 ▼
       response { data: { token, store_id, designation_id, employee_id,
                          user_type, name, designation, employee_image } }
                 │
                 ▼
       pages/login.js → userContext.updateUserConfig(…) → localStorage
       pages/_app.js  → axios default header x-access-token
```

### 1.2 Files involved

| Layer | File | Role |
| --- | --- | --- |
| Frontend page | `pages/login.js` | the form; handles `IP_NOT_ALLOWED`; writes the session to context |
| Frontend helper | `helper/login.js` | the single API call |
| Frontend transport | `util/api.js` | axios instance; `updateToken()`; global `403 → /login` redirect |
| Frontend session | `contexts/UserContext.js` | `localStorage`, permission fetch |
| Frontend bootstrap | `pages/_app.js` | reads `localStorage`, sets the `x-access-token` header |
| Frontend logout | `components/header/header.js` | clears `localStorage` |
| Backend route | `routes/user.js` `POST /login` | validation, IP capture, response shaping |
| Backend usecase | `usecase/user.js` `login()` | orchestration, IP policy, JWT issue |
| Backend repository | `repository/user.js` `login()` | the credential check, in SQL |
| Backend repository | `repository/employee.js` `getNameById()` | display name/designation/photo |
| Backend service | `services/jwt.js` | RS256 sign/verify, global cutoff |
| Backend middleware | `middlewares/auth.js` | token verification, `unProtectedRoutes` |
| Backend middleware | `middlewares/ip_restriction.js` | per-request network check |
| Backend middleware | `middlewares/permissions.js` | authorisation |
| Backend util | `utils/ip.js` | `resolveIpPolicy`, `isAccessAllowed`, `getClientIp` |

### 1.3 What input is accepted

Exactly two fields: **`username`** and **`password`**, both strings, both
required, both trimmed. No employee ID field, no mobile field, no PIN, no
OTP, no MFA, no "remember me", no SSO.

`username` is matched against `user.username` — a plain `VARCHAR(100)` with
**no unique constraint**. In practice two different conventions are in use,
written by two different code paths:

| Path | `username` written as | Where |
| --- | --- | --- |
| Manual employee creation | the employee's **mobile number** | `usecase/employee.js:236` |
| Digisme sync (`bulkCreate`) | the **employee code** (`employee_id`) | `usecase/employee.js:259` |
| Seeded admin | a mobile-number-shaped literal | migration `20220106131113` |

Migration `20251117080329` deleted every `user_type = 1` row and let the sync
recreate them, so the **live convention for staff logins is the employee
code**. This matters for §1.5.

### 1.4 Is Digisme called during login?

**No.** Every Digisme reference in the backend lives in
`services/synker.js`, plus a one-line passthrough in `usecase/employee.js`
(`sync()`). Neither is reachable from `routes/user.js`,
`usecase/user.js`, `repository/user.js`, `services/jwt.js` or any
middleware. There is **no Digisme endpoint in the authentication path**, so
there is no request/response flow to describe.

**If Digisme is down, login is unaffected.** The 07:00 employee sync fails
and logs an error; nobody is prevented from signing in. There is no fallback
local login because there is nothing to fall back *from* — local is the only
path.

### 1.5 A defect worth noting in passing

`usecase/user.js:41` calls `employeeRepo.getNameById(username)`, and that
method (`repository/employee.js:78`) resolves by
`WHERE primary_contact_number = ?` — by **mobile number**, not by
`employee_id` and not by `user.employee_id`.

Since the live convention writes the employee code into `username`
(§1.3), this lookup will not match for sync-provisioned accounts, and
`name`, `designation` and `employee_image` come back `undefined` in the login
response and in the JWT payload. The header display is saved by
`GET /employee/get-details`, which resolves correctly from
`req.decoded.employee_id`, so the symptom is largely invisible.

It is worth recording because it shows the login path resolving identity by
phone number where it should resolve by key, and because that lookup would
also return the wrong person if two employees ever shared a contact number.

---

## 2. Password and credential storage

### 2.1 Are passwords stored locally?

**Yes.** Every credential lives in this database. Nothing about
authentication is delegated.

| | |
| --- | --- |
| **Table / column** | `` `user`.`password` `` |
| **Column type** | `TEXT NOT NULL` (migration `20211227151705`) |
| **Hashed?** | Yes — but see below |
| **Algorithm** | **SHA-1, single round** |
| **Where computed** | **In SQL**, by MySQL's `SHA1()` — not in application code |
| **Salt** | **None** |
| **Pepper / KDF / work factor** | None. No bcrypt, argon2 or scrypt anywhere in `package.json` |

Three call sites, all using the same construction:

- `repository/user.js:26` — `AND u.password = SHA1(?)` (login)
- `repository/user.js:~190` — `WHERE user_id = ? AND password = SHA1(?)` (verify current password)
- `repository/user.js:~215` — `SET password = SHA1(?)` (change password)
- `repository/user.js:~240, ~265` — `VALUES (…, SHA1(?))` (create login)

Unsalted SHA-1 is the weakness that compounds everything else here. It is
fast to compute at scale, and identical passwords produce identical hashes,
so one leaked column reveals which accounts share a password without any
cracking at all.

### 2.2 Digisme credentials

**No Digisme password, token or credential is ever stored or cached
locally.** The Digisme bearer token obtained in
`services/synker.js#getDigismeToken()` is held in a local variable for the
duration of one sync call and discarded. It is never written to the database.

The Digisme **API key and custom key** are a different matter: they are
hardcoded as constants in `services/synker.js` (lines 15–18) and committed
to the repository. They are not *cached* — they are *published*. See §9.

### 2.3 How passwords are set today — the serious finding

Neither provisioning path asks anyone to choose a password.

**Sync-provisioned accounts** (`usecase/employee.js:255-265`, reached from
`bulkCreate`, which the 07:00 Digisme sync calls for every employee): the
default password is a **deterministic string derived from the employee's
own code** by a fixed rule visible in that source line. The employee code
is the username. So for any account where the employee has never changed
their password, **knowing the employee code is sufficient to know the
password**, and employee codes are small integers that appear throughout the
application's own UI.

**Manually created employees** (`usecase/employee.js:236-241`): a **fixed
literal string**, identical for every employee ever created this way.

**The seeded admin account** (migration `20220106131113`): a
`user_type = 2` account — which bypasses every permission check (§5.4) —
with a well-known weak literal password.

There is no forced change on first login, no expiry, no complexity rule
beyond a 6-character minimum on *self-service change*
(`usecase/user.js:19`), and no way to tell from the schema which accounts
are still on their default. `user` has `created_at` and `updated_at`, and
`updated_at` moves on any write, so it is not a reliable indicator either.

`POST /user/change-password` exists and is sound (§3.5), but it is opt-in.

---

## 3. JWT and session flow

### 3.1 Signing

`services/jwt.js`. **RS256**, asymmetric, keys read from
`keys/jwt/private.key` and `keys/jwt/public.key` at module load.

`usecase/user.js:62` — `jwt.sign(info, "1d")`. **Token lifetime: 24 hours.**

### 3.2 Payload

Built at `usecase/user.js:52-60`:

| Claim | Source |
| --- | --- |
| `id` | `user.user_id` |
| `employee_id` | `user.employee_id` |
| `user_type` | `user.user_type` (2 = admin) |
| `designation_id` | `new_employee.designation_id` |
| `store_id` | `new_employee.store_id` |
| `name`, `designation`, `employee_image` | `getNameById()` — see §1.5 |

Plus standard `iat` / `exp`.

**Permissions are not in the token.** Only `designation_id` and `user_type`
are, and the permission set is resolved server-side per request (§5). That is
the right design and it is worth keeping: revoking a permission does not
require reissuing tokens.

**`store_id` and `designation_id` are snapshots taken at login.** Both are
columns the Digisme sync overwrites nightly. A branch transfer or promotion
does not take effect until the user's next login, up to 24 hours later. The
IP-restriction middleware deliberately re-reads the branch live rather than
trusting the token (`repository/user.js#getIpPolicy`, and the note in
`docs/ip-restrictions.md`); the permission middleware does **not** — it
trusts the token's `designation_id`.

### 3.3 Verification

`middlewares/auth.js`, mounted app-wide at `server.js:615`, before
`ipRestriction` and before every router.

1. If `req.path` matches an entry in `unProtectedRoutes` for that method →
   `next()` with **no `req.decoded`**.
2. Otherwise read the **`x-access-token`** header. Absent → `{code: 403}`.
3. `jwt.verify(token, publicKey, …)`; on success copy `id`, `store_id`,
   `user_type`, `designation_id`, `employee_id` onto `req.decoded`.
4. Any verification error → `{code: 403, msg: "Access Denied"}`.

Note that failures are returned with **HTTP 200** and a `403` in the body —
the older convention in this codebase. `util/api.js` relies on that, reading
`res.code === 403` to redirect to `/login`.

### 3.4 Revocation and logout

**There is no per-token or per-user revocation.** No denylist, no session
table, no refresh token, no `jti`.

**Logout is client-side only** (`components/header/header.js:145`): it
removes the keys from `localStorage` and navigates away. The token itself
stays valid on the server for the remainder of its 24 hours. A token copied
before logout keeps working.

The only revocation mechanism that exists is a **global** one:
`services/jwt.js` holds a hardcoded `TOKEN_CUTOFF` epoch and rejects any
token whose `iat` is earlier. It signs everyone out at once, and changing it
requires a code edit and a deploy. Its current value corresponds to
2025-11-17, matching the employee-import migration that deleted and recreated
every staff login.

Deactivating a user (`user.status = 0`) does **not** invalidate their
existing token — only their next login. The IP-restriction middleware
comments on this explicitly and keeps enforcing policy for exactly that
reason.

### 3.5 Password change

`POST /user/change-password`, authenticated, credentials in the **body**.
`usecase/user.js#changePassword` takes the user id from `req.decoded.id`
rather than the body, requires the current password, enforces a 6-character
minimum and rejects an unchanged password. This is the best-constructed piece
of the authentication code and its design should be preserved.

It does not invalidate other sessions after a change — a consequence of §3.4,
not of this handler.

### 3.6 What is already local

**Everything.** Credential storage, credential verification, JWT issue, JWT
verification, session lifetime, the IP policy check and the entire
permission system run against this database with no external call. There is
no "after Digisme validates the user" step, because Digisme never validated
anyone.

---

## 4. User ↔ employee relationship

### 4.1 Does every login map to an employee?

**In effect, yes — and more strictly than intended.**

`repository/user.js#login` is written with a `LEFT JOIN new_employee`, but
the `WHERE` clause contains `ne.status = 1`. A `WHERE` predicate on the
right-hand table of a `LEFT JOIN` **converts it into an inner join**: for a
`user` row with `employee_id IS NULL`, `ne.status` is `NULL`, `NULL = 1` is
not true, and the row is excluded.

So **an account with no `new_employee` row cannot authenticate at all**,
whatever its `user_type`.

The schema does not enforce the relationship: `user.employee_id` is
`INT NULL DEFAULT NULL` with **no foreign key** to `new_employee`. The
constraint is accidental, living in one join condition.

### 4.2 Do admin or system accounts exist outside `new_employee`?

The seeded admin (migration `20220106131113`) was inserted with **no
`employee_id`**. Under the query as it stands today that account cannot log
in.

**This needs verifying against the production database before anything is
changed** — I can read the code but not the data. Two possibilities:

- The row still has `employee_id IS NULL`, so it is dormant and every working
  admin login is attached to a real employee. Then §4.5 applies to admins
  too, and Digisme can lock an administrator out.
- Someone has since set an `employee_id` on it, or created other admin rows.
  Same conclusion.

Either way, **there is currently no supported way to have a break-glass
administrator that is independent of the employee master.** Creating one is
a Stage 0 item (§16) — it is exactly what you want to exist *before* changing
anything about authentication.

### 4.3 Are duplicates possible?

**Yes, on both sides.**

- `user.username` has **no unique index**. Two rows may share a username;
  `login()` resolves the set and `usecase/user.js` takes `details[0]` —
  whichever the optimiser returns first. With two username conventions in
  use (§1.3), a mobile number that happens to equal an employee code is a
  real collision, and mobile numbers seeded as usernames make it plausible.
- `user.employee_id` has **no unique index** either. `createLoginIfNeeded`
  guards with `WHERE NOT EXISTS (… employee_id = ?)`, but `createLogin` —
  the manual path — does not. One employee may end up with several accounts.
- `new_employee.employee_id` is a primary key, so employee IDs themselves
  cannot duplicate.

### 4.4 How are inactive and resigned employees blocked?

Two conditions in the login query, both required:

- `u.status = 1` — the login account is enabled.
- `ne.status = 1` — the **employee** is active.

`usecase/resignation.js` keeps them together: creating a resignation sets
both `new_employee.status` and `user.status` to 0; deleting one sets both
back to 1.

Neither affects an **already-issued token**, which remains valid for up to 24
hours (§3.4).

### 4.5 Does Digisme currently control login access?

**Yes — indirectly, and this is the entire dependency.**

`syncDigismeEmployees()` maps Digisme's `IsTerminated` flag onto
`new_employee.status` and includes `status` in the `bulkCreate` payload, so
the 07:00 job writes it every night. `ne.status = 1` is in the login query.

Therefore:

- Marking someone terminated in Digisme **locks them out of dnds.co.in** at
  07:00 the following morning.
- Un-terminating them **restores their access** the same way.
- A Digisme data error, a mis-mapped `IsTerminated` value, or a partial sync
  can lock out staff who have not resigned. `syncDigismeEmployees()` wraps
  its whole body in `try { … } catch (err) { console.error(err) }` and
  swallows the error, so a partial run leaves partial data and reports
  nothing.

The sync also **creates** logins (§2.3), so Digisme currently controls both
account creation and account deactivation.

Note the asymmetry: Digisme can deactivate, but the reverse coupling is
weaker. `new_employee.status` is set to 0 by the sync directly, without
touching `user.status` — unlike the resignation path, which sets both. The
login query catches this because it checks both columns, but any code that
only checks `user.status` (for example `getIpRestrictions`, which lists
"every active login" by `u.status = 1`) will still show a Digisme-terminated
employee as active.

---

## 5. Authorisation after login

**AUTHENTICATION** — proving who the user is — is §§1–4: username, SHA-1
password, `user.status`, `new_employee.status`, IP policy, JWT issue.
**Fully local. No Digisme call. One indirect data dependency
(`new_employee.status`).**

**AUTHORISATION** — deciding what they may access — is everything below.
**Fully local. No Digisme call. Two indirect data dependencies
(`designation_id` and `store_id`, both nightly-synced columns).**

### 5.1 Designation permissions — the real gate

`middlewares/permissions.js`, built once in `server.js:617` from the
designation usecase.

- Grants live in `permissions(permission_key, designation_id, is_active)`;
  the catalogue is `all_permissions(permission_id, permission_key, status)`.
- `require("key_a", "key_b")` is route middleware — 403 unless the caller
  holds one of the keys. `has(req, key)` is the in-handler form.
- The set is loaded by `designationUsecase.getPermissionById(designation_id, 1)`
  → `SELECT permission_key FROM permissions WHERE designation_id = ?`.
- Cached per designation for **60 seconds**.

Two things to know about this query:

- **`is_active` is never read.** The column exists and defaults to true, but
  the `SELECT` does not filter on it and nothing ever sets it to 0. Grants
  are managed as delete-all-then-reinsert
  (`repository/designation.js:242, :270`). Setting `is_active = 0` by hand
  would have no effect — a trap for anyone who assumes it works.
- **`invalidate()` is never called after a permission edit.** It is exported
  and used by the IP-restriction middleware, but no designation route calls
  it, so a permission change takes up to 60 seconds to apply.

### 5.2 Menu permissions

Presentation only. `constants/menus.js` gates each leaf on a permission key;
`customHooks/usePermissions.js` and `contexts/UserContext.js` check the set
fetched from `GET /designation/permissions`. Hiding a menu item hides nothing
on the server — `middlewares/permissions.js` is what actually stops a
request, and it only stops requests on routes that have the middleware
applied.

### 5.3 User-specific permissions

**None exist.** Authorisation is entirely by designation. The only
per-user setting is `user.ip_policy` / `user.allowed_ips`, which is a network
restriction, not a permission.

### 5.4 Outlet restrictions and admin privileges

- **Branch scoping** is by convention rather than by a middleware:
  `req.decoded.store_id` plus the `all_stores` permission key, applied per
  endpoint where someone remembered to. `contexts/UserContext.js` nulls
  `storeId` client-side when `all_stores` is held.
- **`user_type = 2` bypasses everything.** `loadPermissions` returns `null`
  for it, `has()` returns true unconditionally, and
  `designation.getQuery(2)` returns the entire `all_permissions` table. An
  admin holds every permission that exists and every one added in future.
- `getQuery(user_type)` returns `undefined` for any `user_type` other than 1
  or 2, which would make `db.query(undefined, …)` throw. Only 1 and 2 are
  ever written today.

### 5.5 The `unProtectedRoutes` hole

`middlewares/auth.js` carries **135 route entries** that skip authentication
entirely, including every `/employee`, `/salary`, `/designation`,
`/department`, `/shift`, `/outlet`, `/resignation`, `/family` and `/document`
endpoint. On those routes `req.decoded` is never populated, so
`middlewares/ip_restriction.js` returns `next()` immediately and
`middlewares/permissions.js` never runs.

That is unchanged by anything in this audit and is already Stage 0 item 3 in
the target architecture. It is repeated here because it is an
*authentication* defect, not merely an authorisation one, and because it is
what makes the weak default passwords (§2.3) less urgent than they look and
more urgent than they sound: an attacker does not need a password to read the
employee master today.

### 5.6 Dead flags

`designation.login_access` and `designation.online_portal` /
`new_employee.online_portal` are written by the create/update paths and by
the sync, and are **never read by any authentication or authorisation code**.
They look like login controls and are not. Anyone reasoning about access
should ignore them.

---

## 6. Digisme dependency map

| Component | Depends on Digisme? | How | What breaks if Digisme is removed |
| --- | --- | --- | --- |
| **Login** | **Indirectly — one column** | Nothing in the auth path calls Digisme. But the login query requires `ne.status = 1`, and the 07:00 sync writes `new_employee.status` from `IsTerminated`. | **Nothing breaks.** Access stops being controlled by Digisme and starts being controlled by whoever edits `new_employee.status` locally — which is what is wanted. Requires HR to own deactivation (§7.4). |
| **Employee master** | **Yes — nightly overwrite** | `syncDigismeEmployees()` upserts `new_employee` (name, designation_id, department_id, store_id, shift_code, status, resignation_date). | Joiners, leavers and transfers stop appearing automatically. HR must enter them. Covered by Stage A/B/C in the target architecture. |
| **Designation** | **Yes — auto-created** | Upsert on `designation_code` from `DesignationCode` / `DesignationName`. | New designations are no longer auto-created. Full CRUD already exists at `/designation`. Negligible. |
| **Department** | **Yes — auto-created** | Upsert on `department_code`. | Same. Negligible. |
| **Outlet** | **Yes — auto-created** | Upsert on `outlet_code` from Digisme's `CategoryCode` / `CategoryName`. | Same. Branches change perhaps annually. Negligible. |
| **Shift** | **Partially** | The sync writes `new_employee.shift_code` (a Digisme string). `shift_master` is local and is **never reconciled** with it; `new_employee.shift_id` is stale. | Nothing that works today stops working, because nothing consumes `shift_code`. The real work is building a local shift master — §4 of the target architecture. |
| **Permissions** | **No** | `permissions` / `all_permissions` are purely local, keyed by `designation_id`. | Nothing. The only exposure is that `designation_id` on the employee is a synced column, so a designation *reassignment* arrives via Digisme today. |
| **JWT** | **No** | RS256 with local keys; payload from local tables. | Nothing. |
| **Password reset / change** | **No** | `POST /user/change-password`, SHA-1 in SQL. | Nothing. But note there is **no reset flow at all** — only self-service change (§7.2). |
| **User creation** | **Yes — this is the one that bites** | `bulkCreate` calls `createLoginIfNeeded` for every synced employee with a mobile number, generating username and default password from the employee code. | **New employees stop getting logins automatically.** Nothing else creates a staff account except manual employee creation. This must be replaced before the sync is switched off — see §8 and §17. |
| **Employee deactivation / resignation** | **Yes** | `IsTerminated` → `new_employee.status = 0` → login refused at `ne.status = 1`. | **The automatic lock-out on termination disappears.** This is a security control that quietly goes away. HR must own exit deactivation, and it must be verifiable. §17. |

**Summary of the map.** Two components are genuinely at risk when Digisme is
switched off, and neither is the credential check:

1. **User creation** — no account provisioning for new hires.
2. **Employee deactivation** — no automatic lock-out for leavers.

Both are process gaps, not code failures. Both are addressed in §7.4–7.5.

---

## 7. Recommended local authentication design

Assume Digisme is gone entirely. The target flow is the one already in place,
with the credential handling repaired:

```
User enters credentials
  → dnds.co.in validates locally  (bcrypt, constant-time, rate-limited)
  → dnds.co.in issues its own JWT (RS256, unchanged)
  → the existing designation permission system continues unchanged
```

**`employee_id` does not change.** No renumbering, no new employee table, no
change to `user.employee_id`, no change to the JWT payload shape. Everything
below is additive.

Do **not** import or store Digisme passwords in any form. Digisme never held
credentials for this system, and nothing about the migration requires
touching Digisme credentials.

### 7.1 Password hashing

Replace unsalted SHA-1 with **bcrypt** (cost 12) or **argon2id**. bcrypt is
the pragmatic choice here: the `bcrypt` / `bcryptjs` packages are mature, the
hash is self-describing, and per-hash salting is automatic.

The change must move hashing **out of SQL and into the application**. Today
the comparison is `WHERE password = SHA1(?)`, which cannot express bcrypt
verification; the query must select the row by username and compare in Node
with `bcrypt.compare`. Compare in constant time, and always run a comparison
even when no row is found, so a missing username and a wrong password take
the same time.

Migrate without a mass reset, using a **hash-on-next-login** scheme:

```
user.password_hash   VARCHAR(255) NULL   -- bcrypt
user.password        TEXT                -- existing SHA-1, retained during migration
user.password_algo   ENUM('sha1','bcrypt') NOT NULL DEFAULT 'sha1'
```

On login: if `password_algo = 'bcrypt'`, verify with bcrypt. If `'sha1'`,
verify the legacy way and — on success — immediately write the bcrypt hash,
flip `password_algo` and null the old column. Every active user upgrades
silently the next time they sign in. After the cutover window, refuse
`sha1` outright and force those accounts through reset. `verifyPassword` and
`updatePassword` follow the same rule.

Add a real policy on write: minimum 10 characters (the current minimum is 6),
rejection of the known default patterns from §2.3, and rejection of the
username or employee code as a password.

### 7.2 Password reset

**None exists today** — there is no forgot-password route, no reset token, no
admin reset endpoint. Build two paths:

- **Admin-initiated reset** (`POST /user/:id/reset-password`, behind a new
  `manage_user_accounts` permission). Generates a single-use token, sets
  `must_change_password = 1`, and does **not** display or email a password.
  Given that every employee has a `telegram_username` and the app already has
  a Telegram service, delivering the reset link that way is the path of least
  friction; otherwise the admin reads a one-time code to the employee.
- **Self-service reset**, if wanted, via the employee's registered mobile and
  an OTP. This needs an SMS provider — there is a commented-out
  `services/sms` import in `usecase/user.js` and no implementation. Treat it
  as optional; the admin path covers the operational need.

Reset tokens: single use, hashed at rest, 30-minute expiry, invalidated on
use and on password change.

```
user_password_reset
  reset_id PK, user_id FK, token_hash VARCHAR(255), expires_at DATETIME,
  used_at DATETIME NULL, requested_by INT NULL, requested_ip VARCHAR(45),
  created_at
```

### 7.3 First-time password setup

Add `user.must_change_password TINYINT(1) NOT NULL DEFAULT 0`.

Set it on every account created by provisioning and by admin reset. When it
is set, login still issues a token — but a short-lived one, and the frontend
routes straight to the change-password screen. The cleanest server-side
enforcement is a claim in the JWT (`must_change_password: true`) that
`middlewares/auth.js` rejects for every route except
`POST /user/change-password` and `GET /user/my-ip`.

**Set it to 1 for every existing account during migration** (§8). That single
step retires all three default-password problems in §2.3 without a mass
lock-out.

### 7.4 Blocking inactive employees

Keep the two existing conditions — `u.status = 1` and `ne.status = 1` — and
make them locally owned:

- HR's exit process sets `new_employee.status = 0`, `last_working_date` and
  `exit_type` (the fields proposed in the target architecture), and the
  usecase sets `user.status = 0` in the same transaction — the coupling
  `usecase/resignation.js` already implements for the resignation path.
- Add a **daily reconciliation job** that reports any `user.status = 1`
  attached to a `new_employee.status = 0`, and any active employee past their
  `last_working_date`. This is what replaces the Digisme lock-out, and it
  must exist *before* the sync is switched off, not after.
- Because a token survives deactivation for up to 24 hours (§3.4), add a
  `user.token_valid_from DATETIME` column checked in `services/jwt.js`
  alongside the existing global `TOKEN_CUTOFF`. Deactivating an account, or
  changing its password, stamps it — which gives per-user revocation and
  makes logout-everywhere possible without a session table.

### 7.5 Account provisioning

The sync currently creates accounts. Replace it with an explicit step in the
HR joiner flow: creating an employee offers "create login", which generates
the username, sets `must_change_password = 1`, and issues a one-time setup
link. **No default password is ever generated.** An employee without a login
simply has no login, which is the correct default for the many retail staff
who never use the system.

Add the missing constraints while doing this:

```sql
ALTER TABLE `user` ADD UNIQUE KEY uq_user_username (username);
ALTER TABLE `user` ADD UNIQUE KEY uq_user_employee (employee_id);   -- see note
ALTER TABLE `user` ADD CONSTRAINT fk_user_employee
  FOREIGN KEY (employee_id) REFERENCES new_employee(employee_id);
```

Both unique keys require de-duplicating existing rows first (§8.1). The
`employee_id` unique key assumes one login per employee — confirm that
before applying it, and if break-glass accounts are wanted with
`employee_id IS NULL`, note that MySQL's unique index permits multiple NULLs,
so it does not block them. It would, however, mean **fixing the accidental
inner join in §4.1** so such an account can log in at all.

### 7.6 Failed-login protection

None exists. There is no rate limiting anywhere in the application — no
`express-rate-limit`, no `helmet`, nothing.

- Per-account counter: `user.failed_login_count`, `user.locked_until`.
  Lock for 15 minutes after 5 consecutive failures; clear on success.
- Per-IP throttle on `POST /user/login` regardless of username, to stop
  spraying one password across many accounts — the attack that unsalted SHA-1
  and derivable defaults make cheap.
- Keep the response identical for "no such user", "wrong password" and
  "locked", to avoid confirming which usernames exist. The current 400
  "Incorrect credentials" already does this correctly; do not regress it
  while adding lockout.

### 7.7 Audit logging

There is no authentication audit trail at all today.

```
user_auth_log
  log_id BIGINT PK, user_id INT NULL, username_attempted VARCHAR(100),
  event ENUM('login_success','login_failed','locked_out','logout',
             'password_changed','password_reset_requested',
             'password_reset_used','account_created','account_disabled',
             'account_enabled','ip_blocked'),
  ip VARCHAR(45), user_agent VARCHAR(255),
  detail VARCHAR(255) NULL, created_at TIMESTAMP
  INDEX (user_id, created_at), INDEX (event, created_at)
```

**Never log the password field, in any form** — not the plaintext, not the
hash, not a prefix. Log `username_attempted` for failures, since that is what
makes spraying visible.

This is also the table that answers "who was locked out when Digisme was
switched off", which is exactly the question §8 exists to prevent.

---

## 8. Migration plan — Digisme auth coupling to fully local

The migration is unusually low-risk **because there is no authentication
integration to unwind**. What is being migrated is (a) the credential
storage, and (b) the two process dependencies from §6: provisioning and
deactivation.

### Phase 0 — Preparation (no user-visible change)

1. **Create a break-glass admin account** that does not depend on the
   employee master, and verify it works — including whatever change §4.1
   requires to make an `employee_id IS NULL` account able to log in. **Do
   this first.** Everything else is safer once it exists.
2. Audit the live `user` table for what the code cannot tell you: how many
   rows, how many admins, how many with `employee_id IS NULL`, how many
   duplicate usernames, how many duplicate `employee_id`s, and how many still
   carry a default-pattern hash. The last is computable directly — for each
   employee, compare the stored hash against `SHA1()` of the documented
   default pattern. **The result of that count decides how urgent Phase 2
   is.**
3. Add the new columns (`password_hash`, `password_algo`,
   `must_change_password`, `failed_login_count`, `locked_until`,
   `token_valid_from`) and the two new tables (`user_password_reset`,
   `user_auth_log`). All nullable or defaulted; nothing reads them yet.
4. Add `user_auth_log` writing to the existing login path **before** changing
   any logic, so there is a baseline of who signs in, how often, and from
   where. Run it for at least two weeks — it is what tells you which accounts
   are actually in use before you touch them.

### Phase 1 — Credential hardening (no lock-outs)

5. Deploy bcrypt with the **hash-on-next-login** upgrade (§7.1). Both
   algorithms are accepted; nobody notices anything. Watch the
   `password_algo` distribution move.
6. Deploy failed-login protection and rate limiting (§7.6). Set thresholds
   generously at first and tighten once `user_auth_log` shows the real
   failure rate.
7. Deploy the admin reset flow (§7.2) and the `must_change_password`
   mechanism (§7.3) — **available but not yet enforced on anyone**.
8. Move credentials from the query string into the request body (§9). This
   requires a coordinated frontend and backend change; accept both forms for
   one release so a cached frontend bundle does not break login.

### Phase 2 — Retire the default passwords

9. Communicate first: a Telegram message to affected staff and a briefing to
   branch managers, a week ahead, explaining that they will be asked to set a
   new password at their next sign-in, and how to get help.
10. Set `must_change_password = 1` for every account still on a
    default-pattern hash, plus every `user_type = 2` account regardless. Do
    it **in branch-sized batches, not all at once**, with a day between
    batches, so a problem with the change-password flow affects one branch
    rather than the company.
11. Once the count from step 2 reaches zero, set `must_change_password = 1`
    for the remainder and retire SHA-1 acceptance entirely.

### Phase 3 — Own provisioning and deactivation

12. Build the HR joiner flow's "create login" step (§7.5) and use it for real
    while the sync is still running. New hires then get accounts from both
    paths; `createLoginIfNeeded` is idempotent on `employee_id`, so there is
    no conflict.
13. Build the daily reconciliation report (§7.4) and run it **while Digisme
    is still live**. Every discrepancy it finds is a gap in the local process
    that would have become a security hole after cutover. This is the
    parallel validation period, and it is the one that matters.
14. Remove `createLoginIfNeeded` from `bulkCreate`, so provisioning is
    local-only. This is the actual cutover for authentication, and it is one
    line.
15. Add the unique keys and the foreign key from §7.5, after de-duplication.

### Phase 4 — Cutover and rollback

16. Authentication cutover is complete at step 14. It coincides with **Sync
    Stage A** in the target architecture (`new_employee.status` becomes
    locally owned), which is when Digisme stops being able to lock anyone
    out.
17. **Rollback** at each phase:
    - Phases 1–2 roll back by reverting the deploy; the SHA-1 column is still
      populated until step 11, so the old code path still works. **Do not
      drop `user.password` until at least one full cycle after step 11.**
    - Step 10 rolls back with `UPDATE user SET must_change_password = 0`.
    - Step 14 rolls back by restoring one function call.
    - Phase 0's break-glass account is the rollback of last resort.

### How to avoid locking everyone out

The realistic lock-out scenarios, and the specific control for each:

| Scenario | Control |
| --- | --- |
| bcrypt migration bug rejects valid passwords | dual-algorithm acceptance; SHA-1 column retained; revert the deploy |
| `must_change_password` set for everyone at once and the change screen fails | batch by branch, a day apart |
| Rate limiting too aggressive on a shared branch IP | per-account lockout as the primary control, per-IP only as a loose backstop; branches NAT many users behind one address |
| Unique-key migration deletes the wrong duplicate row | de-duplicate as a reviewed data exercise before adding the constraint, never as part of it |
| The FK to `new_employee` rejects orphan `user` rows | list and resolve orphans first; add the constraint last |
| Admin locked out while fixing any of the above | the Phase 0 break-glass account, tested before Phase 1 |
| A Digisme sync error during the transition deactivates staff | Sync Stage A removes `status` from the Digisme field map — sequence it before or with step 14 |

Downtime: **none required.** Every phase is additive or dual-path.

---

## 9. Security review — findings

Documented, not fixed. Ordered by severity.

### Critical

**S1 — The JWT private key is committed to the repository.**
`keys/jwt/private.key` is tracked in git (`.gitignore` does not cover
`keys/`). Anyone with repository access — past or present — can sign a token
with any `user_type`, `designation_id` and `employee_id`, and it will verify.
This is total authentication bypass and privilege escalation to admin. Rotate
the keypair, load it from a path or secret given by environment, add `keys/`
to `.gitignore`, and purge it from history.

**S2 — Default passwords are derivable from public identifiers.**
`usecase/employee.js:255-265` provisions every synced employee with a
password computed from their own employee code, which is also their username.
`usecase/employee.js:236-241` uses a fixed literal for manually created
employees. Migration `20220106131113` seeds an admin (`user_type = 2`, which
bypasses every permission check) with a well-known weak literal. Nothing
forces a change. Any account still on its default is trivially accessible to
anyone who knows or can guess an employee code.

**S3 — Unsalted SHA-1 password hashing.**
`repository/user.js` stores and compares `SHA1(password)` with no salt and no
work factor, computed in SQL. Fast to attack offline at scale; identical
passwords produce identical hashes, revealing shared credentials without any
cracking. §7.1.

**S4 — 135 unauthenticated route entries, covering all HR data.**
`middlewares/auth.js#unProtectedRoutes` exempts every `/employee`,
`/salary`, `/designation`, `/department`, `/shift`, `/outlet`,
`/resignation`, `/family` and `/document` endpoint. Salary figures, bank
account numbers, PAN and Aadhaar (including `aadhaar_card_image`) are served
to unauthenticated callers, and `GET /employee/employee_id` returns
`SELECT *`. Because `req.decoded` is never set on these routes, the IP
restriction cannot apply to them either.

### High

**S5 — Credentials are sent in the URL query string.**
`helper/login.js` builds `POST /user/login?username=…&password=…` and
`routes/user.js` reads `req.query`. Query strings are recorded by reverse
proxies, load balancers, CDNs and PM2/stdout access logs in a way request
bodies are not, so plaintext passwords are likely sitting in log files today.
The change-password route's own comment acknowledges this contrast. The
values are also **not URL-encoded** by the frontend, so a password containing
`&`, `#` or `+` is silently corrupted. Move to the request body.

**S6 — No brute-force protection of any kind.**
No rate limiting, no account lockout, no failure counter, no CAPTCHA, no
alerting. Combined with S2 and S3, an attacker can enumerate employee codes
and try the derived default for each, unthrottled.

**S7 — No token revocation.**
Logout is `localStorage.clear()`. A token remains valid for its full 24 hours
after logout, after deactivation, after resignation and after a password
change. The only revocation is a hardcoded global `TOKEN_CUTOFF` requiring a
code change and deploy. §7.4 proposes `token_valid_from`.

**S8 — Hardcoded secrets in committed source.**
AWS access key id and secret in `services/s3.js`; Digisme API key and custom
key in `services/synker.js`; GST portal username and GSTIN in
`services/gst_authentication.js`. `config/delium.js` additionally establishes
a pattern of committing a **default** API key as a fallback, which is the
same exposure with an extra step. All should be environment-only, and all
should be treated as compromised and rotated.

**S9 — Command injection surface in the Digisme authenticator.**
`services/synker.js#_authenticateDigisme` builds a shell command string and
runs it through `child_process.exec`, interpolating credential constants.
Values are currently constants so it is not presently exploitable, but it
puts the credentials into the process table where any local user can read
them, and it is one refactor away from being injectable. Replace with axios.
Disappears entirely at Sync Stage C.

### Medium

**S10 — No unique constraint on `user.username` or `user.employee_id`, and no
FK to `new_employee`.** Duplicate usernames are possible and `login()` takes
`details[0]` — whichever row the optimiser returns first. With two username
conventions in use (§1.3), a collision between a mobile number and an
employee code is plausible, and would let one person's password authenticate
another person's session. §7.5.

**S11 — The JWT `algorithms` option is misspelled.**
`services/jwt.js` passes `{ algorithm: [algorithm] }` to `jwt.verify`; the
option is `algorithms` (plural), so it is silently ignored and no allowlist is
enforced. In practice this is **not currently exploitable**: jsonwebtoken
8.5.1 infers the permitted set from the key material, and the key file begins
`-----BEGIN PUBLIC KEY-----`, which yields asymmetric algorithms only — so the
classic HS256-signed-with-the-public-key confusion is rejected. It is
nonetheless one library upgrade or key-format change away from being a
critical bypass, and it should be corrected to `algorithms: ["RS256"]`
regardless.

**S12 — Token lifetime of 24 hours with no refresh and no idle timeout.**
A token stolen from `localStorage` is usable for up to a day from anywhere the
IP policy allows. Most accounts resolve to exempt from the IP policy.

**S13 — The token is stored in `localStorage`.**
Readable by any script running on the origin, so any XSS is a full session
compromise. A `Secure` `HttpOnly` `SameSite` cookie would not be, but that is
a larger change than this audit's scope; note it as the direction of travel.

**S14 — `permissions.is_active` is written by nobody and read by nobody.**
`SELECT permission_key FROM permissions WHERE designation_id = ?` ignores it.
An administrator who revokes a permission by setting `is_active = 0` — the
obvious reading of the schema — would believe access was removed when it was
not. Grants are actually managed by delete-and-reinsert.

**S15 — Permission cache is never invalidated on change.**
`middlewares/permissions.js` exports `invalidate()`, but no designation route
calls it. A revoked permission stays effective for up to 60 seconds.

### Low / informational

**S16 — Authentication failures return HTTP 200** with a `403` in the body,
so proxies, WAFs and log-based alerting cannot distinguish a failed
authentication from a successful request.

**S17 — Duplicate `"/user/login"` key in `unProtectedRoutes`**
(`middlewares/auth.js:7` and `:447`). The later literal wins, so the `GET`
exemption declared at line 7 is silently discarded. Harmless today — there is
no `GET /user/login` — but it is the kind of duplicate that makes the map
untrustworthy to read.

**S18 — Identity resolved by phone number in the login path.**
`getNameById(username)` matches on `primary_contact_number` (§1.5). Returns
the wrong person's name and photo if two employees share a number.

**S19 — Dead login flags.** `designation.login_access` and `online_portal`
are written but never read (§5.6). They read as access controls and are not.

**S20 — Sync errors are swallowed.** `syncDigismeEmployees()` catches
everything and only `console.error`s, so a partial run that deactivates
employees reports success. Relevant to authentication because
`new_employee.status` gates login.

**S21 — No `helmet`, no security headers, and `cors()` with no options** —
`server.js:57` allows every origin. Not directly exploitable given the
token is in a header rather than a cookie, but it removes a layer of defence
against S13.

**S22 — Passwords in logs.** No application code logs the password field. The
exposure is entirely S5's: whatever writes access logs in front of this
service is recording plaintext credentials in URLs today. **Those logs should
be treated as a credential store and purged** once S5 is fixed.

---

# Summary

## 1. Exact current login flow

`pages/login.js` → `helper/login.js` → **`POST /user/login` with username and
password in the query string** → `routes/user.js` (Joi on `req.query`) →
`usecase/user.js#login` → `repository/user.js#login`, which runs a single SQL
statement comparing `username` and `SHA1(password)` against the local `user`
table, joined to `new_employee` and `outlets`, requiring `u.status = 1` **and**
`ne.status = 1` → IP policy check → **RS256 JWT signed locally, 24-hour
expiry**, carrying `id`, `employee_id`, `user_type`, `designation_id`,
`store_id` and display fields → returned in the body → stored in
`localStorage` → sent on every subsequent request as `x-access-token` →
verified by `middlewares/auth.js` → authorised by `middlewares/permissions.js`
against `permissions` rows for the token's `designation_id`, with
`user_type = 2` bypassing all checks.

## 2. Exact Digisme dependency

**Authentication makes no call to Digisme.** There is no Digisme endpoint,
credential or token anywhere in the login path. Digisme code exists only in
`services/synker.js`.

The dependency is **three writes made by the nightly 07:00 sync**:

1. **`new_employee.status`** — mapped from Digisme's `IsTerminated`. The login
   query requires `ne.status = 1`, so **Digisme can lock a user out of
   dnds.co.in**, and does so within 24 hours of a termination.
2. **Account creation** — `bulkCreate` → `createLoginIfNeeded` provisions a
   `user` row, username and default password for every synced employee with a
   mobile number. **Digisme is currently the only automatic source of new
   logins.**
3. **`designation_id` and `store_id`** — synced columns copied into the JWT at
   login, which therefore determine the user's permission set and branch
   scope.

Everything else — passwords, hashing, JWT keys, token verification, the
permission tables, the IP policy — is already entirely local.

## 3. What breaks when Digisme is switched off

**Login itself does not break.** Nobody is signed out, no token is
invalidated, no credential stops working.

Two things stop happening, and both are process gaps rather than failures:

| | Impact | Replacement |
| --- | --- | --- |
| **New employees no longer get logins automatically** | New hires cannot sign in until someone creates an account | HR joiner flow with explicit "create login" (§7.5) |
| **Leavers are no longer locked out automatically** | A terminated employee keeps working access indefinitely — a **security regression**, and the more serious of the two | HR exit flow setting both `status` columns, plus a daily reconciliation report (§7.4) |

Also degraded, though not authentication: designations, departments and
outlets stop being auto-created (all have full local CRUD already), and
`new_employee.shift_code` stops being maintained (nothing reads it).

## 4. Recommended future login architecture

Unchanged in shape — the target is the flow that already exists, with the
credential layer repaired:

```
credentials in the request BODY
  → look up user by username (unique), single row
  → bcrypt.compare, constant time, always executed
  → check u.status, ne.status, locked_until, token_valid_from
  → check IP policy (unchanged)
  → issue RS256 JWT (unchanged payload, unchanged 24h or shorter)
  → must_change_password ⇒ restricted token, change-password only
  → existing designation permission system continues, unchanged
```

Additive schema only. **`employee_id` is not changed. The JWT payload shape is
not changed. The permission system is not changed.**

New columns on `user`: `password_hash`, `password_algo`,
`must_change_password`, `failed_login_count`, `locked_until`,
`token_valid_from`. New tables: `user_password_reset`, `user_auth_log`. New
constraints: unique `username`, unique `employee_id`, FK to `new_employee`.

## 5. Migration steps

**Phase 0 — Preparation.** Break-glass admin first. Audit the live `user`
table (duplicates, orphans, default-password count). Add columns and tables,
unused. Start `user_auth_log` and run it two weeks for a baseline.

**Phase 1 — Credential hardening.** bcrypt with hash-on-next-login, both
algorithms accepted. Rate limiting and lockout. Reset flow and
`must_change_password`, available but unenforced. Credentials moved to the
request body, accepting both forms for one release.

**Phase 2 — Retire default passwords.** Communicate a week ahead. Force
`must_change_password` **in branch-sized batches, a day apart**, defaults and
admins first. Retire SHA-1 acceptance when the count reaches zero.

**Phase 3 — Own provisioning and deactivation.** Build and use the HR joiner
"create login" step while the sync still runs. Run the deactivation
reconciliation report **while Digisme is still live** — this is the parallel
validation that matters. Then remove `createLoginIfNeeded` from `bulkCreate`
(one line: the authentication cutover). Add the unique keys and FK after
de-duplication.

**Phase 4 — Cutover.** Coincides with Sync Stage A, when
`new_employee.status` becomes locally owned. Rollback at every phase is a
deploy revert while the SHA-1 column survives; the break-glass account is the
last resort.

No downtime is required at any point.

## 6. Risks and blockers

| Risk | Severity | Mitigation |
| --- | --- | --- |
| **Committed JWT private key allows forging any session** | critical | rotate before anything else (S1) |
| **Accounts still on derivable default passwords** | critical | count them in Phase 0; that number sets the urgency of Phase 2 |
| **Break-glass admin may not exist** | high | §4.1 — an `employee_id IS NULL` account cannot log in as the query stands. Verify against production and create one **first**. This is the top blocker. |
| **Automatic lock-out of leavers disappears at cutover** | high | reconciliation report live before step 14, not after |
| **New hires cannot sign in after cutover** | high | HR joiner flow in use during Phase 3, while the sync still provisions as a backstop |
| Duplicate usernames resolve to the wrong account | medium | de-duplicate before adding the unique key (S10) |
| bcrypt migration rejects valid passwords | medium | dual-algorithm acceptance; keep the SHA-1 column one full cycle past step 11 |
| Mass `must_change_password` locks out a branch | medium | batch by branch, a day apart |
| Rate limiting blocks a whole branch behind one NAT address | medium | per-account lockout primary; per-IP loose |
| Plaintext passwords already in access logs | medium | fix S5, then purge historical logs as a credential store |
| Permission cache and `is_active` behave unlike the schema suggests | low | document; correct in Stage 0 (S14, S15) |

**Unknowns that need a database, not a repository, to resolve** — all in
Phase 0 step 2: how many admin accounts exist, whether any has
`employee_id IS NULL`, how many accounts still carry a default hash, and
whether any duplicate usernames or `employee_id`s already exist.

## 7. Changes to add to Stage 0

Stage 0 in the target architecture already covers key rotation, secrets, the
`unProtectedRoutes` removal, column allowlists and audit logging. This audit
adds the following, and **re-orders the first item to the front**:

| # | Item | Finding |
| --- | --- | --- |
| **0.0** | **Create and verify a break-glass admin account independent of `new_employee`** — including the §4.1 join fix it requires | §4.2 |
| 0.1 | Rotate the JWT keypair; `keys/` out of git and out of history | S1 |
| 0.2 | Audit the live `user` table; **count accounts still on default-pattern hashes** | S2 |
| 0.3 | Replace SHA-1 with bcrypt, hash-on-next-login, hashing moved out of SQL | S3 |
| 0.4 | Move login credentials from the query string to the request body; purge historical access logs afterwards | S5, S22 |
| 0.5 | Failed-login lockout and rate limiting on `POST /user/login` | S6 |
| 0.6 | `must_change_password` + admin reset flow; force it on defaults and all admins | S2, §7.2–7.3 |
| 0.7 | `user_auth_log` — every authentication event, never the password field | §7.7 |
| 0.8 | `token_valid_from` for per-user revocation; stamp on deactivate and on password change | S7 |
| 0.9 | Correct `algorithm` → `algorithms: ["RS256"]` in `services/jwt.js` | S11 |
| 0.10 | Unique keys on `user.username` and `user.employee_id`; FK to `new_employee` (after de-duplication) | S10 |
| 0.11 | Rotate AWS, Digisme and GST credentials; environment-only, no committed defaults | S8 |
| 0.12 | Replace the `exec("curl …")` Digisme authenticator with axios | S9 |
| 0.13 | Remove the HR endpoints from `unProtectedRoutes`; then apply permission middleware | S4 |
| 0.14 | Read `permissions.is_active`, or drop the column; call `invalidate()` after permission edits | S14, S15 |

Items 0.0 through 0.6 are the ones that would matter most on the day the
repository or a log archive is exposed; 0.13 is the one that matters most
today, because it needs no credential at all.

## 8. What must be completed before Digisme can be cancelled

Authentication-specific. These are in addition to the data-export list in
[payroll-target-architecture.md](payroll-target-architecture.md) §10.B —
**nothing needs to be exported from Digisme for authentication purposes,
because Digisme holds no credentials for this system.**

Complete, in order:

1. **Break-glass admin account exists and has been tested** (Stage 0.0).
2. **bcrypt migration complete** — `password_algo = 'sha1'` count is zero,
   SHA-1 acceptance retired.
3. **No account remains on a default-pattern password** — the Phase 0 count is
   zero.
4. **HR joiner flow provisions logins locally**, and has been used for real
   hires for at least one month while the sync was still running as a
   backstop.
5. **HR exit flow sets `new_employee.status` and `user.status` together**, and
   has been exercised on real leavers.
6. **The daily deactivation reconciliation report runs and is clean** — no
   active login attached to an inactive employee — for **at least two
   consecutive months while Digisme is still live**. This is the control that
   replaces Digisme's automatic lock-out, and it is the single item that must
   not be shortened: it is the only evidence that the local exit process
   actually works.
7. **`createLoginIfNeeded` removed from `bulkCreate`** and no automatic
   provisioning depends on the sync.
8. **Sync Stage A applied to `status`** — `new_employee.status` no longer in
   the Digisme field map, so a Digisme error can no longer lock anyone out.
9. **Failed-login protection and `user_auth_log` are live**, so an
   authentication problem after cutover is visible rather than inferred from
   support calls.
10. **Unique constraints and the FK on `user` are in place**, so a new local
    provisioning flow cannot create the duplicates the old one could.

Items 1–3 are about the credentials being sound. Items 4–8 are about the two
process dependencies in §6. Item 6 is the gate: **until the local exit process
has demonstrably worked for two months, switching Digisme off means leavers
keep their access.**
