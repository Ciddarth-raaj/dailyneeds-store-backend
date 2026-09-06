# Stage 0A — securing the existing authentication system

Implementation record for Stage 0A. Companion to
[authentication-decoupling-audit.md](authentication-decoupling-audit.md),
which is the as-was inspection; this document is what changed, what did not,
and what the operator must do.

**Status: implemented on branch `claude/dnds-payroll-integration-proposal-3p6hen`
in both repositories. Not deployed. Not merged to `main-autodeploy`.**

Hard rules honoured throughout: no payroll, attendance or shift code; Digisme
untouched; `new_employee` ownership unchanged; `employee_id` unchanged in
value and meaning everywhere; no `employee_code`; every existing user keeps
signing in; every change behind a flag so no release is a big-bang rewrite;
every migration additive and reversible; nothing pushed to an auto-deploy
branch.

---

## 1. Read-only findings before implementation — things that make the plan unsafe

Found by inspection before any code was written. Each changed the approach.

| # | Finding | Effect on the plan |
| --- | --- | --- |
| F1 | **A push to `main-autodeploy` runs `db-migrate up` and `pm2 reload` unattended** (`.github/workflows/deploy-backend.yml`). A migration committed there is a production schema change with no manual gate. | Nothing in this work is pushed to `main-autodeploy`. Every migration is additive, and the operator runs the backup (§5) *before* merging, because the deploy will not wait. |
| F2 | **The deploy runs `npm i` on the EC2 box.** A native module (`bcrypt`, `argon2`) would compile there during deploy; a compile failure under `set -euo pipefail` leaves the checkout updated and the process not reloaded. The team has already fought lockfile drift from this step. | Hashing uses `crypto.scrypt` from Node itself. **Zero new dependencies.** `package.json` and `package-lock.json` are untouched. |
| F3 | **Existing tokens carry `id`, not `sub`, and no `kid`.** Twenty-four hours of them are live at any moment. | The verifier accepts kid-less tokens under the legacy key while `JWT_REQUIRE_KID=false`, and the middleware reads `sub` with `id` as fallback. Nobody is signed out by the deploy. |
| F4 | **`user.password` is `TEXT NOT NULL`.** A modern-hash-only account has no SHA-1 value. | The migration makes it nullable. The down migration writes `''` before restoring NOT NULL (see §5 for what that means). |
| F5 | **The login `LEFT JOIN` is an inner join in effect** (`WHERE ne.status = 1`), so an account with no employee cannot sign in. The seeded admin has `employee_id IS NULL`. | The predicate moved out of SQL into the usecase, where it applies to employee accounts only. The seeded admin still cannot sign in: a *non-system* account without an employee row is refused explicitly (`login_inactive`/`no_employee_row`). Nothing widened. |
| F6 | **`errorHandler.js` logs `req.originalUrl`** on parse failures and aborted requests, and nginx access logs record request lines. | Query-string credentials were in logs already. Confirms A7 as urgent and A7's log-purge guidance (§18). |
| F7 | **The JWT private key is tracked in git.** `git rm --cached` would delete it from the server's working tree on the next `git pull`, breaking the app if the key had not first been moved. | `.gitignore` gains `keys/` but the file is **not untracked in this change**. Untracking is a documented follow-up after the operator has externalised the key (§14). |
| F8 | **`/product` and 134 other route entries are in `unProtectedRoutes`.** Unchanged in scope (Stage 0B), but it means the employee master is readable without any credential today. | Called out, deferred (§25). The weak-password fixes here do not reduce that exposure. |
| F9 | **Five committed secrets, not four**: JWT private key, AWS key pair (`services/s3.js`), Digisme keys (`services/synker.js`), GST portal identity (`services/gst_authentication.js`) — and the **Telegram bot token** in `services/telegram.js`, which the break-glass alert now depends on. | Telegram token made environment-first with a logged fallback. The rest are the rotation checklist (§21). None rotated by this change. |
| F10 | **nginx configuration is not in the repository.** TLS termination, HSTS and `X-Forwarded-Proto` cannot be confirmed from code. The team previously had to patch nginx to forward `X-Forwarded-For` at all (`scripts/patch_nginx_forwarded.py`), so `X-Forwarded-Proto` is likely absent too. | `AUTH_REQUIRE_HTTPS` defaults **off**. Enabling it before the proxy forwards the protocol would lock everyone out. `/user/my-ip` now reports what the app sees so this is verified before the flag is turned on (§17). |
| F11 | **Two username conventions coexist** (mobile number from manual creation, employee code from the sync) with **no unique index**. `login()` took `details[0]`. | `findByUsername` orders `status DESC, user_id ASC` so an active row wins deterministically; the integrity audit (§16) lists duplicates; no constraint added until reviewed. |
| F12 | **`node --test` exists but `npm test` is a stub and CI runs no tests.** | Tests written for `node --test`; results in §23. Verification is local. |

None of these blocked implementation; F1, F2, F7 and F10 changed it materially.

---

## 2. Exact files changed

### Backend (`dailyneeds-store-backend`)

| File | Change |
| --- | --- |
| `config/auth.js` | **new** — every Stage 0A flag and parameter, read once from the environment; no committed secret defaults |
| `services/password.js` | **new** — scrypt hashing, legacy SHA-1 verification in Node, `verifyUser` routing, `dummyVerify` |
| `services/jwt.js` | **rewritten** — `algorithms: ['RS256']` pinned, explicit `alg` check, fixed `kid` map, multi-key verification, external key paths, `createJwtService` factory; same static call surface |
| `utils/actor.js` | **new** — `actorUserId`, `requireEmployee`, `employeeIdOrNull`, `rejectSystemAccounts`, typed errors |
| `utils/password_policy.js` | **new** — B3 policy |
| `utils/http.js` | `respondError` handles `SystemAccountError` / `UnauthenticatedError` |
| `repository/user.js` | **rewritten** — no password in SQL; `findByUsername`; system-account guard on every mutation; reset-token methods |
| `repository/auth_log.js` | **new** — `user_auth_log` writer with a fixed event list; `auth_metric` counters; rotation-due query |
| `usecase/user.js` | **rewritten** — login pipeline (§7), change-password, reset issue/redeem, unlock, logout, alerts, audit |
| `usecase/employee.js` | provisioning: scrypt only, flagged `must_change_password`; secure-provisioning mode (B4) |
| `middlewares/auth.js` | verification block replaced by a factory: `sub`/`id`, `req.auth`, `token_valid_from` check, `pwc` confinement; `/user/setup-password` added to `unProtectedRoutes` |
| `routes/user.js` | **rewritten** — body login with counted query fallback, HTTPS gate, `my-ip` transport report, change-password, setup-password, logout, admin reset, unlock, account view, auth log/metrics |
| `routes/material_request.js`, `routes/eb_consumption.js`, `routes/advance_request.js`, `routes/employee.js`, `routes/ticket.js` | `requireEmployee()` at the sites that wrote `req.decoded.employee_id` unguarded into employee columns; `fail()` handlers accept the typed error |
| `services/telegram.js` | bot token environment-first with a logged fallback |
| `server.js` | wires `authLogRepo`, injects deps into the user usecase and router, builds the auth middleware with `create()`, registers the daily `break_glass_rotation_check` cron |
| `scripts/auth/break-glass.js` | **new** — the only path that creates/rotates/disables a system account |
| `scripts/auth/default-password-scan.sql` | **new** — A6, read-only |
| `scripts/auth/flag-default-passwords.sql` | **new** — B2, per-branch batch flagging with progress query |
| `scripts/auth/account-integrity-audit.sql` | **new** — C1/B9, read-only |
| `scripts/auth/backup-user-tables.sh` | **new** — A1 backup with verification |
| `migrations/mysql/migrations/20260906120000-…120300-auth-stage0a-*` | **new** — four migration pairs (§3) |
| `.gitignore` | `keys/`, `*.key`, `*.pem` |
| `.env-sample` | all Stage 0A variables, commented, no values |
| `test_support/auth_fixtures.js` and 8 `*.test.js` files | tests (§23) |

### Frontend (`dailyneeds-store`)

| File | Change |
| --- | --- |
| `helper/login.js` | `POST /user/login` with a JSON body; nothing in the URL |
| `helper/user.js` | `setupPassword`, `logout` |
| `pages/login.js` | routes a `must_change_password` account to `/change-password?required=1` |
| `pages/change-password.js` | **new** — standalone forced-change screen |
| `pages/setup-password.js` | **new** — token redemption |
| `util/api.js` | `PASSWORD_CHANGE_REQUIRED` → change screen; `EMPLOYEE_REQUIRED` passed to the caller |
| `components/header/header.js` | logout calls `POST /user/logout` before clearing storage |
| `components/ChangePassword/index.jsx` | minimum length 6 → 8 to match the API |
| `pages/_app.js` | `/setup-password` is a public path |

---

## 3. Migrations created

All `db-migrate` pairs in `migrations/mysql/migrations/` with SQL in `sqls/`.
All additive. Run order is the timestamp order.

| Migration | Up | Down | Reversibility |
| --- | --- | --- | --- |
| `20260906120000-auth-stage0a-user-columns` | `user` gains `password_hash`, `password_algo` (default `'sha1'`), `password_migrated_at`, `must_change_password`, `password_flag_reason`, `failed_login_count`, `locked_until`, `last_failed_login_at`, `last_login_at`, `token_valid_from`, `is_system_account`, `credential_rotated_at`; `password` becomes nullable; indexes on `username` and `employee_id` | drops the columns and indexes; sets `password=''` where NULL, restores NOT NULL | **Trivially reversible before any modern hash exists.** Once accounts hold only a modern hash, the down migration leaves those accounts with `''` and they cannot sign in on the old code — correct, but it means the rollback of a *populated* system is "restore the backup", not "run down" (§5). |
| `20260906120100-auth-stage0a-auth-log` | `user_auth_log`, `auth_metric` | drops both | Trivially reversible; only audit data is lost. |
| `20260906120200-auth-stage0a-password-reset` | `user_password_reset` | drops it | Trivially reversible; outstanding tokens are lost. |
| `20260906120300-auth-stage0a-permissions` | inserts `manage_user_accounts`, `unlock_user_accounts`, `view_auth_log` into `all_permissions` | deletes them and any grants | Trivially reversible. |

**Not trivially reversible:** only the first, and only after Deployment B has
migrated hashes or a system account exists. That is why §5 requires the backup
to be taken *and restore-tested* before the first migration runs, and kept
until Stage 0A is complete.

No migration touches `new_employee`. No migration touches `employee_id`.

---

## 4. Database engine and version — to confirm

Not confirmable from the repository: the driver is `mysql@2` and the
migrations use MySQL syntax (`ON DUPLICATE KEY UPDATE`, backtick quoting,
`ENGINE=InnoDB`), so the engine is MySQL or MariaDB. **The version must be read
from production** — the first statement in
`scripts/auth/account-integrity-audit.sql` does it.

Why it matters (C1): the design keeps `employee_id NULL` on the system account
alongside a future `UNIQUE (employee_id)`. InnoDB on MySQL and MariaDB permits
multiple NULLs in a unique index, so that works. If production is anything else,
the constraint plan in §16 changes. Confirm before Deployment C.

---

## 5. Database backup and restore procedure (A1)

The database is `localhost` on the same EC2 host as the app
(`config.json`, `migrations/mysql/database.json` — both server-only, never in
git). So the backup is a local `mysqldump`.

**Before the first Stage 0A migration runs, on the server:**

```bash
cd ~/dailyneeds-store-backend
scripts/auth/backup-user-tables.sh <database_name> ~/db-backups
```

The script produces two gzipped dumps — the authentication-related tables
(`user`, `new_employee`, `permissions`, `all_permissions`, `designation`,
`outlets`) and the full database — verifies each archive ends with
`Dump completed`, and prints row counts to record beside the files. It reads
credentials from `~/.my.cnf`; never pass them as arguments.

**Restore test — mandatory, into a scratch schema, before proceeding:**

```bash
mysql -e 'CREATE DATABASE dnds_restore_test'
zcat ~/db-backups/<db>-auth-<stamp>.sql.gz | mysql dnds_restore_test
mysql dnds_restore_test -e 'SELECT COUNT(*) FROM `user`'   # must equal the recorded count
mysql -e 'DROP DATABASE dnds_restore_test'
```

**Rollback of Stage 0A schema, if needed:**

- Before any modern hash exists (that is, Deployment A deployed but nobody has
  changed a password and no break-glass account created): `db-migrate down`
  four times reverses cleanly.
- After that: stop the app (`pm2 stop 0`), restore the auth-table dump over the
  live schema (`zcat … | mysql <db>`), check out the previous release,
  `pm2 reload 0`. Any password changed after the backup reverts to its
  pre-backup value — tell those users.

Retain the backup until Stage 0A is closed out. The backup contains SHA-1
hashes and PII: it goes under `chmod 600` in a directory with `chmod 700`, and
nowhere else.

**Not verified here:** none of the above has been run against production. The
operator runs it; §24 lists it.

---

## 6. Authentication flow — before and after

**Before** (see the audit, §1): credentials in the query string → Joi on
`req.query` → `SELECT … WHERE username=? AND password=SHA1(?) AND u.status=1
AND ne.status=1` → IP check → RS256 JWT with `id`, verified with the
misspelled `algorithm` option and no `kid`.

**After:**

```
POST /user/login  { username, password }      body; query only while AUTH_LEGACY_QUERY_LOGIN
  routes/user.js
    pick transport, count it (auth_metric), never log values
    AUTH_REQUIRE_HTTPS → refuse unless req.secure / X-Forwarded-Proto: https
  usecase/user.js#login
    per-IP throttle (B7 secondary) ─ blocked → dummy verify → BAD_CREDENTIALS
    findByUsername ─ none → dummy verify → BAD_CREDENTIALS           (B8)
    AUTH_REJECT_LEGACY_SHA1 && sha1 → dummy verify → BAD_CREDENTIALS
    verifyUser(row, password)         modern → scrypt only; legacy → SHA-1 only  (A2)
    locked?  → BAD_CREDENTIALS (after the verification, so timing is flat)
    wrong?   → failed_login_count++, lock at threshold, audit → BAD_CREDENTIALS
    u.status != 1 → BAD_CREDENTIALS
    employee account: employee row required and ne.status == 1        (C2)
    system  account: judged by its own status only                    (A4)
    IP policy (unchanged)
    AUTH_HASH_ON_LOGIN && sha1 → re-hash with scrypt, keep must_change_password (B1)
    recordSuccessfulLogin; audit login_success (+transport)
    system account → audit break_glass_login + Telegram alert        (A5)
  _issueSession
    claims from the DB row only: sub=user_id, id, user_type, designation_id,
    store_id, name, designation, employee_image, employee_id (employee accounts),
    sys:true (system accounts), pwc:true (must change, when enforced)
    jwt.sign RS256, header.kid = JWT_ACTIVE_KID, 1d                    (A9–A12)
```

Every subsequent request: `middlewares/auth.js` → `jwt.verify` (explicit
`alg==='RS256'`, exact `kid` lookup, `algorithms:['RS256']`) → `req.auth`
and `req.decoded` → `token_valid_from` check when enabled (C4) → `pwc`
confinement when enabled (B2) → `ip_restriction` → `permissions` (unchanged).

---

## 7. User table PK and the JWT subject (A3, C3)

**Primary key of `user`: `user_id INT AUTO_INCREMENT`** (migration
`20211227151705`). Confirmed from the migration; the only candidate key.

- `sub` = `String(user.user_id)` on every token issued from now on.
- `id` = `user.user_id` is still written, because `routes/gst.js`,
  `routes/accounts.js` and the IP-restriction middleware read
  `req.decoded.id`, and because tokens issued before this release have only
  `id`. The middleware reads `sub`, falling back to `id`. After 24 hours every
  live token has `sub`.
- `employee_id` is present **only** on an employee account's token, and is the
  unchanged `new_employee.employee_id`. A system account's token has `sys:true`
  and no `employee_id` claim. The middleware sets `req.auth.employeeId` and
  `req.decoded.employee_id` to **`null`** for it — never `undefined`, never a
  fake value.
- All claims are built from the database row in `_issueSession`. Nothing the
  client sent contributes.

---

## 8. Audit of every caller-resolution path (A3, C3)

Census: 42 reads of `req.decoded.employee_id`, 11 of `.id`, 6 of `.store_id`,
5 of `.user_type`, 3 of `.designation_id` across `routes/` and `middlewares/`.
Classification per the brief: **A** user-account identity, **B** employee
identity, **C** audit actor, **D** business employee reference.

| Site | Reads | Class | Before | After |
| --- | --- | --- | --- | --- |
| `middlewares/ip_restriction.js` | `id` | A | user_id | unchanged — correct already |
| `middlewares/permissions.js` | `designation_id`, `user_type` | A | from token | unchanged; system token has `designation_id:null`, `user_type:2` → admin bypass as before |
| `routes/user.js` change-password | `id` | A | user_id | `actorUserId(req)` |
| `routes/accounts.js:156` | `id` → `accounts.user_id` | A | user_id | unchanged (it is the account, correctly) |
| `routes/gst.js:247` | `id` (nullable) | C | user_id or null | unchanged |
| `routes/designation.js:69` `/permissions` | `designation_id`, `user_type` | A | | unchanged; a system account gets the full catalogue (admin) |
| `routes/material_request.js:33,97` | `employee_id` → `created_by` **NOT NULL FK** | **B** | unguarded; a system account → SQL NULL → FK error 500 | `requireEmployee(req, …)` → 403 `EMPLOYEE_REQUIRED` |
| `routes/eb_consumption.js:39,134,175` | `employee_id` → `created_by` **FK** | **B** | unguarded | `requireEmployee` |
| `routes/advance_request.js` (7 sites) | `employee_id` → `created_by`, `balance_checked_by`, `balance_action_by`, `approved_by`, `paid_by`, `uploaded_by`, activity `employee_id` | **B/C** — all mean "which employee acted" on money | unguarded | `requireEmployee` on all seven; a system account cannot raise, decide or pay an advance |
| `routes/employee.js:349` `/get-details` | `employee_id` → `WHERE employee_id=?` | **B** | Joi `number().required()` → 422 on undefined | `requireEmployee` → 403 with a clear message; the frontend shell tolerates it |
| `routes/ticket.js:299` create | `employee_id` → `created_by` (joins `new_employee`) | **B** | `if (…)` guard, silently no creator | `requireEmployee` — a ticket always has a real creator |
| `routes/ticket.js:83,394,441,465,572` | `employee_id` for "is this my ticket" and actor args | **C/D** | `Number(undefined)` → NaN → no match; actor null | unchanged: with `null` the comparison is false and the actor is null, both already tolerated; the `has("edit_tickets")` path still grants admins |
| `routes/grn.js:182` | `employee_id ?? null` → `ignored_by` | C | null-tolerant | unchanged |
| `routes/grn.js:164,196` | `user_type !== 2` | A | | unchanged; system account passes as admin |
| `routes/product.js:21,127`, `offers_v3.js:10`, `offers_v3_talker.js:6`, `stock_checker.js:71,96`, `products_expiry_checker.js:60`, `purchase_acknowledgement.js:24,83`, `purchase_return.js:69` | `employee_id ? … : null` → `created_by` (SET NULL FKs) | C | null-tolerant | unchanged; a system account's action lands with `created_by NULL`, which those columns accept. Recorded here as accepted behaviour, not silent coercion: the column semantics are "who, if anyone". |
| `routes/material_request.js:34,98`, `ticket.js:307`, `advance_request.js:205` | `store_id` as default outlet | D | | unchanged; system token `store_id:null` → the body must supply it, which those routes already handle (`body.outlet_id || …`) |

**Rule applied:** where the value feeds a column that means *a person who
works here* and is NOT NULL or a required actor on money, a system account
is refused with a typed 403. Where the column already means "who, if anyone",
NULL is the honest value and stands. No `undefined` reaches SQL from any site.

Typed errors are handled in `utils/http.js#respondError`,
`routes/advance_request.js#fail`, `routes/ticket.js#fail` and the
`/get-details` catch. The frontend (`util/api.js`) passes `EMPLOYEE_REQUIRED`
back to the caller instead of treating the 403 as a dead session.

---

## 9. Break-glass design (A4)

A **system account** is a row in `user` with:

| Column | Value | Why |
| --- | --- | --- |
| `is_system_account` | 1 | the explicit marker; nothing else distinguishes it |
| `employee_id` | **NULL** | it is not a person on the payroll and must never pretend to be; `employee_id` keeps meaning "a real employee code" only |
| `user_type` | 2 | it is an administrator |
| `password` / `password_algo` | NULL / `'scrypt'` | never SHA-1 (A2) |
| `ip_policy` | `'unrestricted'` | an emergency credential must work from wherever the emergency is |
| `credential_rotated_at` | set on create and rotate | drives the rotation reminder |

**Why `employee_id` is NULL:** the alternative — a placeholder employee — would
put a fake person into `new_employee`, where it would be counted in headcount,
synced against Digisme, and eventually paid. NULL is the truth, and §8 makes
every employee-requiring path refuse it explicitly.

**Login independence** (C2): `usecase/user.js#login` applies the
`new_employee.status` test only when `is_system_account = 0`. The system
account is judged by `user.status` alone. Nothing Digisme writes can affect it.

**Cannot be created, converted, modified or elevated through any API:**

- No route accepts `is_system_account`. `createLogin` / `createLoginIfNeeded`
  do not have the parameter; the column takes its default 0 (`repository/user.test.js`
  test 28 proves the SQL never mentions the column).
- Every mutating statement in `repository/user.js` — `setModernPassword`,
  `migrateLegacyPassword`, `unlock`, `setMustChangePassword`, `updateStatus`,
  `updateIpPolicy` — carries `AND is_system_account = 0` (test 29 proves all
  six). A caller that forgets the check still cannot touch the row.
- The usecase refuses earlier with `SYSTEM_ACCOUNT` on `changePassword`,
  `issueReset`, `unlock`; the IP-restrictions route refuses before calling the
  usecase (`usecase/user.login.test.js` 27/29).
- The only writer is `scripts/auth/break-glass.js`, which requires
  `BREAK_GLASS_CONFIRM=yes`, a TTY, a hidden double-entry prompt, a 20-character
  minimum, and writes an audit row with `detail='break-glass-script'`.

---

## 10. Break-glass custody and lifecycle policy (A5)

**Alert on every login.** A successful system-account login writes
`break_glass_login` to `user_auth_log` and sends a Telegram message to
`AUTH_SECURITY_ALERT_CHAT_ID` (default: the existing alerts chat) with
`disableNotification: false`, naming the account, the source address and the
time, and stating that rotation is now due. A failed attempt writes
`break_glass_login_failed` and alerts too.

**Rotation after use** is mandatory and is a human action:
`BREAK_GLASS_CONFIRM=yes node scripts/auth/break-glass.js rotate --username <name>`.
It stamps `credential_rotated_at` and `token_valid_from`, so any session from
the used credential is dead once C4 is enabled.

**Scheduled rotation even if unused.** The `break_glass_rotation_check` cron
(08:00 daily, `server.js#initServices`) writes `break_glass_rotation_due` and
alerts when `credential_rotated_at` is older than
`AUTH_BREAK_GLASS_ROTATION_DAYS` (90) **or** `last_login_at` is later than
`credential_rotated_at`. It never rotates anything itself.

**Usage review.** Monthly, someone with `view_auth_log` runs
`GET /user/auth-log?event=break_glass_login` (or the SQL equivalent) and
reconciles every entry against the custody log below. An entry with no
matching custody record is an incident.

**Custody.** The credential must not be committed, stored in plaintext in the
database (only the scrypt hash is), placed in a shared staff password list,
sent in chat or email, or available to outlet staff. Recommended process for a
business of this size:

1. The credential is generated inside a password manager by the **owner** or
   one named director — not by the developer — and typed at the script's
   hidden prompt on the server.
2. It is written by hand on a single card, sealed in a tamper-evident envelope
   signed across the flap, dated, and kept in the company safe. A second
   sealed copy goes with the company's statutory records off-site.
3. **Authorised to open it:** the owner, and one named deputy for when the
   owner is unreachable. Nobody else. Names are recorded on the envelope.
4. **Opening it is recorded** on a custody log kept beside the safe: date,
   time, who, why, which system was affected. The Telegram alert and the audit
   row must match this entry.
5. After use the credential is rotated (above), the old envelope destroyed,
   and a new one sealed the same day.
6. The developer who runs the rotation script never sees the value: the person
   holding the credential types it.

**No production credential is generated or printed by any code or document in
this change.**

---

## 11. Modern hashing — choice and reason (A2)

**`crypto.scrypt` from `node:crypto`**, parameters `ln=15` (N=32768), `r=8`,
`p=3`, 64-byte key, 16-byte random salt, stored as
`$scrypt$ln=15,r=8,p=3$<salt>$<hash>`.

Why not the first two preferences: Argon2id and bcrypt are native modules,
and finding F2 (`npm i` compiling on the production host during an unattended
deploy) makes a native build a genuine outage risk — one the team has already
been bitten by through lockfile drift. scrypt is in Node itself, needs no
install step, and is explicitly allowed as the third option. Its parameters
are recorded in every hash, so raising them later (or switching to Argon2id
once a native build is acceptable) verifies every existing hash unchanged;
`password_algo` is a `VARCHAR(16)` so a fourth algorithm is a one-file change.

Cost: ~32 MiB and roughly 100–200 ms per hash on a small instance —
deliberate, and the reason the per-IP throttle (B7) matters. `maxmem` is set
to twice the requirement so a raised parameter does not silently fail.

**Verifier routing** (`services/password.js#verifyUser`): `password_algo ==
'scrypt'` → compare `password_hash` only, the legacy column is not read;
`'sha1'` → compare `password` only. A modern account can never be opened with
its old SHA-1 password even if the column is stale (test 4). Comparison is
`crypto.timingSafeEqual`. `dummyVerify` runs a real scrypt against a random
hash for the unknown-user path (test 7).

---

## 12. Legacy migration behaviour (B1)

Off in Deployment A (`AUTH_HASH_ON_LOGIN=false`). When on:

```
legacy row + correct password
  → login succeeds
  → hash = scrypt(password)
  → UPDATE user SET password_hash=?, password_algo='scrypt', password=NULL,
                    password_migrated_at=NOW()
     WHERE user_id=? AND password_algo='sha1' AND is_system_account=0
  → audit password_migrated
  → must_change_password is NOT touched
```

A failed upgrade does not fail the login; it retries next time. After
migration the account verifies with scrypt only. New passwords and new accounts
never use SHA-1 (tests 2, 3, 4, 16). Once `password_algo='sha1'` count reaches
zero, `AUTH_REJECT_LEGACY_SHA1=true` refuses any straggler and the legacy
column can be dropped in a later migration.

---

## 13. Default-password audit (A6) — results and counts

**Not run.** It requires production data, which this environment does not
have. The scan is `scripts/auth/default-password-scan.sql`, read-only,
against a snapshot or with a read-only user, **before** `AUTH_HASH_ON_LOGIN` is
enabled (a salted hash cannot be scanned this way).

Patterns tested, derived from the provisioning code as it stood
(`usecase/employee.js`) and from identity data: the employee-code-with-suffix
default from `bulkCreate`, the fixed literal from `create`, the employee code
itself, the username, the mobile number, five date-of-birth formats, and a
short common list. Output is user id, username, employee id, branch, account
and employee status, and a **pattern category** — never a password.

The second statement gives per-branch counts with rollup, which is the
number that sets Deployment B's urgency. Record both result sets in the
migration dataset (a spreadsheet kept with the backup, same access controls)
— they are the input to §14.

**Expected result, per the audit:** every account the sync provisioned that
has never changed its password will match `provisioning_default_employee_id_suffix`;
every manually created one, `provisioning_default_literal`; the seeded admin
row, the literal too. Plan for that being most of them.

---

## 14. How flagged accounts flow into `must_change_password` (B2) and the staggered reset

`scripts/auth/flag-default-passwords.sql` sets `must_change_password=1,
password_flag_reason='default_scan'` **for one branch per run**
(`@batch_outlet_code`), and only on SHA-1 rows that match a pattern. It is
idempotent and its rollback is a one-line `UPDATE` on `password_flag_reason`.

The flag survives everything except the user choosing a new password: a
successful legacy login with `AUTH_HASH_ON_LOGIN` migrates the hash **and
leaves the flag set** (test 18). Only `changePassword` and `redeemSetupToken`
clear it, and both run the B3 policy, which refuses the defaults. So a
predictable password cannot survive into scrypt and be considered solved.

**Staggered plan:**

| Batch | Who | When |
| --- | --- | --- |
| 0 | every `user_type = 2` account, whatever the branch (the commented statement in the script) | first, before enforcement is switched on for anyone else |
| 1 | the smallest branch by headcount | day 1 |
| 2 … n | one branch per day, in ascending size | days 2 … n, only if the previous batch's support calls were manageable |
| final | anyone left unflagged but still SHA-1 (per the progress query) | after the last branch |

Enforcement (`AUTH_ENFORCE_PASSWORD_CHANGE=true`) is switched on once batch 0
is flagged; from then a flagged account's session is confined to
`/user/change-password`, `/user/logout`, `/user/my-ip`,
`/employee/get-details` and `/designation/permissions` (the two the frontend
shell needs), and the frontend routes it to `/change-password?required=1`.

Communicate a week before batch 1: a Telegram message to the department chats
and a briefing for branch managers with the unlock procedure (§20).

**Tracking** (progress query at the end of the flagging script): per branch —
flagged pending, flagged completed, on modern hash, still SHA-1, total.
`user_auth_log` events `password_changed` and `password_setup_completed` give
the per-account timeline. The previous password is never exposed anywhere.

---

## 15. Password policy (B3)

Enforced in `utils/password_policy.js`, server-side only; the frontend mirrors
the length for convenience.

- Minimum 8 characters (`AUTH_PASSWORD_MIN_LENGTH`), maximum 128; no leading
  or trailing space.
- Break-glass minimum 20 (`AUTH_BREAK_GLASS_MIN_LENGTH`).
- Rejected: the username, the employee code, the mobile number (digits
  compared), the current password, one repeated character, a short embedded
  list of the most-tried passwords (including business-flavoured ones), and
  **the historical provisioning defaults** — the literal and the
  employee-code-with-suffix pattern.
- No composition rules (uppercase/symbol/digit). They push retail staff to
  write passwords down; length and the deny-list do more.

---

## 16. Username / shared-account audit (C1, B9) — results

**Not run** — production data. `scripts/auth/account-integrity-audit.sql`
reports, read-only: engine and version; duplicate usernames; NULL/empty
usernames; several accounts per employee; accounts with no employee (expected:
only system accounts); orphans whose `employee_id` is not in `new_employee`;
the username convention split (mobile-style vs employee-code-style); cross
collisions where a username equals *another* employee's code or mobile;
active accounts on inactive employees; suspected shared logins by distinct
IP/user-agent counts over 30 days of `user_auth_log`; and till/counter-looking
usernames.

Shared logins are **reported, not disabled**. Where one exists, per-account
lockout can take a counter down when one cashier mistypes; the manager unlock
(§20) is the mitigation, and the recommendation is individual identities for
every person who bills.

**Constraints deferred to Deployment C** and only after review of the report:
`UNIQUE (username)`; and `UNIQUE (employee_id)` if the rule is one employee →
one login. Neither is in a migration here. The system account's NULL
`employee_id` is compatible with the latter on InnoDB (§4).

---

## 17. TLS / HTTPS topology (A8) — finding

**What is known from the repository:** the API is served by nginx as vhost
`api.dnds.co.in` on the EC2 host (`fix-proxy-headers.yml`), proxying to the
Node process; `trust proxy` is on in `server.js`; the frontend is built with
`NEXT_PUBLIC_API_URL` (its `.env.production` decides whether that is
`https://`). The nginx configuration is not in git.

**What is not known and must be confirmed on the server:**

1. that nginx terminates TLS for `api.dnds.co.in` (`sudo nginx -T | grep -A20 'server_name api.dnds.co.in'` → `listen 443 ssl`);
2. that port 80 for that vhost redirects to 443 rather than proxying;
3. that nginx sets `proxy_set_header X-Forwarded-Proto $scheme;` — **likely
   missing**, given `X-Forwarded-For` had to be patched in by script;
4. whether HSTS is sent (`add_header Strict-Transport-Security …`);
5. that the Node port (8080) is not reachable from outside (security group).

**What this change does:** `POST /user/login` refuses credentials when
`AUTH_REQUIRE_HTTPS=true` and neither `req.secure` nor
`X-Forwarded-Proto: https` is present — but the flag ships **off**, because
turning it on before item 3 is true locks everyone out. `/user/my-ip` now
returns `protocol`, `secure`, `has_forwarded_proto`, `require_https`; the
enable procedure is: sign in, call `/user/my-ip` through the public URL,
confirm `secure: true` and `has_forwarded_proto: true`, then set the flag and
reload.

Proxy-to-app traffic is loopback on the same host; that is adequate for this
deployment model, and it is why item 5 matters.

---

## 18. Query-string fallback — metric and removal procedure (A7)

The route counts, per day, `login_body`, `login_query_string` and
`login_missing_credentials` in `auth_metric`, and audits each success with
`detail='body'` or `'legacy_query_string'`. **No value is ever recorded.**
`GET /user/auth-metrics` (permission `view_auth_log` or `manage_user_accounts`)
returns the last 30 days.

Removal: after the frontend is deployed, watch the metric. Once
`login_query_string` is **zero for seven consecutive days** (long enough to
cover a cached bundle and a week of shifts), set `AUTH_LEGACY_QUERY_LOGIN=false`
and reload — that is the standalone hotfix, and test 13 proves it is
independent of everything else. Do not wait for Deployment C.

**Historical logs may contain credentials.** Sources: nginx access logs on the
host (request lines with the query string), PM2 logs (`errorHandler` writes
`req.originalUrl` on parse failures and aborted requests; the dev request
logger prints `baseUrl` only), any CloudWatch or log shipping, and browser
devtools exports anyone saved. Restrict them now (`chmod 600`, owner only),
and once the fallback is removed, purge every access-log line matching
`/user/login?` back to the earliest retained file. Treat the archive as a
credential store until it is purged, and expect the B2 reset to have changed
every password that appears in it.

---

## 19. Lockout and unlock (B7, B10)

Off in Deployment A (`AUTH_LOCKOUT_ENABLED=false`). When on: 5 consecutive
failures (`AUTH_LOCKOUT_THRESHOLD`) set `locked_until` 15 minutes ahead
(`AUTH_LOCKOUT_MINUTES`); a success clears the counter; a locked account still
pays for a full verification and gets the same `BAD_CREDENTIALS` (test 8).

Secondary, in-process, per client IP: 60 failures in 15 minutes
(`AUTH_LOCKOUT_IP_*`) block that address for 5 minutes, and only when lockout is
enabled. The thresholds are deliberately loose because every branch NATs
everyone behind one address (test 10 proves one user's failures do not lock a
colleague). Single PM2 instance, so in-process state is correct today; if the
app is ever clustered this map must move to the database.

Unlock: `POST /user/:id/unlock`, permission `unlock_user_accounts` or
`manage_user_accounts`, audited as `account_unlocked` with the acting
`user_id`, clears the counter and `locked_until`, touches nothing else, refuses
system accounts (test 9). Grant `unlock_user_accounts` to branch managers'
designation so a locked till does not wait on head office.

---

## 20. Timing and enumeration (B8)

Unknown username, wrong password, disabled account, inactive employee and a
locked account all return `{code: 204}` from the usecase and `400 Incorrect
credentials` over HTTP (tests 6). The unknown-user path runs `dummyVerify` — a
real scrypt over a random hash — so it costs what a wrong password costs
(test 7). The lock check happens *after* verification for the same reason.
Login validation errors return the same 400 without naming the field.

Not defended: the IP-block response is also 204, but the alerts and audit rows
distinguish it server-side, which is what matters.

---

## 21. Secret-rotation checklist (administrator actions)

None rotated by this change. All five below are in git history and must be
treated as compromised.

| Secret | Where | Action |
| --- | --- | --- |
| JWT private key | `keys/jwt/private.key` (tracked) | §22 rotation procedure; then untrack (§14 of the audit's F7 note): `git rm --cached keys/jwt/*.key` **only after** the server reads from the external path |
| AWS access key + secret | `services/s3.js` | rotate in IAM; move to env or an instance role; out of Stage 0A scope to refactor, in scope to rotate |
| Digisme API key + custom key | `services/synker.js` | rotate with the vendor; move to env (planned with Sync Stage A) |
| GST portal username + GSTIN | `services/gst_authentication.js` | identity rather than secret; move to env |
| **Telegram bot token** | `services/telegram.js` | regenerate via BotFather; set `TELEGRAM_BOT_TOKEN`; then delete the fallback constant — the break-glass alert depends on this token, so do it early |

Also on the server: `.env` is `chmod 600` (the deploy workflow does this); put
`~/db-backups` at `700`.

---

## 22. JWT: algorithm pinning, `kid` allow-list, multi-key rotation (A9–A12)

**Pinning.** `jwt.verify(token, key, { algorithms: ['RS256'] })` — the plural
option jsonwebtoken 8.5.1 honours. Before that, the header's `alg` is checked
to be exactly `RS256`, so `none`, `HS256`, `RS512` and the
public-key-as-HMAC-secret confusion are all refused before any key is used
(tests 30–33). The previous code passed `algorithm` (singular), which the
library ignored; it was saved only by the library's inference from the PEM
header. That inference is no longer relied on.

**`kid`.** `JWT_PUBLIC_KEYS` is a JSON object `{ kid: path }` read once at
startup into a `null`-prototype, frozen map. Verification takes `kid` from the
unverified header, checks it is a string of 1–64 characters, and does
`hasOwnProperty` lookup — nothing else. It is never joined to a path, fetched,
or executed. Unknown, empty, traversal-shaped, path-like, URL-like and
prototype-named kids are all rejected (tests 34–37). A token with **no** kid
verifies with `JWT_LEGACY_KID` while `JWT_REQUIRE_KID=false`; with it true,
rejected.

**External keys** (A10). `JWT_PRIVATE_KEY_PATH` and `JWT_PUBLIC_KEYS` point at
files outside the checkout. When unset, the tracked files are used under kid
`legacy` and a warning is logged at startup. **First deploy uses the current
key material** through the new loader, so configuration is proven before any
rotation:

```
# /etc/dnds/jwt/ owned by ec2-user, 700; files 600
cp keys/jwt/private.key /etc/dnds/jwt/legacy.key
cp keys/jwt/public.key  /etc/dnds/jwt/legacy.pub
# .env
JWT_PRIVATE_KEY_PATH=/etc/dnds/jwt/legacy.key
JWT_PUBLIC_KEYS={"legacy":"/etc/dnds/jwt/legacy.pub"}
JWT_ACTIVE_KID=legacy
JWT_LEGACY_KID=legacy
```

**Rotation procedure** (A12) — only after Deployment A is stable, never
automatic, each step a `.env` edit and `pm2 reload 0`, each reversible by
undoing the edit:

| Step | `.env` | State | Rollback |
| --- | --- | --- | --- |
| 1 | as above | old signing, old verification, multi-key loader live | unset the variables (tracked-key fallback) |
| 2 | verify stability for a day: logins work, no `Unknown token kid` in logs | | — |
| 3 | generate: `openssl genrsa -out /etc/dnds/jwt/key-2026-09.key 2048 && openssl rsa -in … -pubout -out /etc/dnds/jwt/key-2026-09.pub` | | delete the files |
| 4 | `JWT_PUBLIC_KEYS={"legacy":"…legacy.pub","key-2026-09":"…key-2026-09.pub"}` | old signing; **old + new verification** | remove the new entry |
| 5 | `JWT_PRIVATE_KEY_PATH=…key-2026-09.key`, `JWT_ACTIVE_KID=key-2026-09` | **new signing**; old + new verification (test 38, 39) | revert both lines — tokens signed meanwhile still verify because the new key stays in the map |
| 6 | wait **> 24 h** (the token lifetime) — 36 h to be safe | old key verification-only | — |
| 7 | `JWT_PUBLIC_KEYS={"key-2026-09":"…"}`, `JWT_LEGACY_KID=key-2026-09`, `JWT_REQUIRE_KID=true` | new only (test 40) | re-add the legacy entry for one more day |
| 8 | shred `legacy.key`; `git rm --cached keys/jwt/*.key`, commit; the file in history is dead | | — |

Setting `JWT_REQUIRE_KID=true` before step 7 would reject every token issued
before Stage 0A that was still live; hence its place at the end.

---

## 23. Tests run and results

```
cd dailyneeds-store-backend && IS_TEST=true node --test
# tests 313   suites 58   pass 312   fail 0   skipped 1 (pre-existing golden-file test)
```

New files: `services/password.test.js`, `services/jwt.test.js`,
`utils/password_policy.test.js`, `utils/actor.test.js`,
`usecase/user.login.test.js`, `usecase/user.changePassword.test.js`
(rewritten), `usecase/user.test.js` (rewritten onto the new repository
surface; same IP-gate behaviours), `middlewares/auth.test.js`,
`routes/user.login.test.js` (real Express on a loopback port),
`repository/user.test.js` (SQL contract). Fixtures in
`test_support/auth_fixtures.js`.

Coverage of the 46 required cases (numbers as in the brief):

| Cases | Where |
| --- | --- |
| 1–5, 18 | `usecase/user.login.test.js` legacy/modern |
| 6, 7 | `usecase/user.login.test.js` enumeration; 6 again over HTTP in `routes/user.login.test.js` |
| 8, 9, 10 | `usecase/user.login.test.js` lockout |
| 11, 12, 13, 14, 15 | `routes/user.login.test.js` |
| 16, 17, 19, 20, 21 | `usecase/user.login.test.js` change/setup; 17 also `utils/password_policy.test.js` |
| 22 | authorisation is route middleware (`needs("manage_user_accounts")`); the usecase-level guarantee that a reset can only target the id given, and refuses system accounts, is 27/29. A route-level permission test is **not** included — `permissions.require` is existing, separately tested code. |
| 23, 24, 25, 26, 27, 28, 29 | `usecase/user.login.test.js` break-glass; 28/29 at SQL level in `repository/user.test.js` |
| 30–40 | `services/jwt.test.js` |
| 41, 42 | `middlewares/auth.test.js` |
| 43 | `middlewares/auth.test.js` (permissions middleware against the new token) |
| 44 | `utils/actor.test.js` and `middlewares/auth.test.js` |
| 45, 46 | `usecase/user.login.test.js` |

Frontend: no test runner exists in that repository; `next lint` needs
`node_modules`, which are not installed here. The five changed files and two
new pages were reviewed by hand and follow the patterns of the files beside
them. **They have not been built.** §24.

---

## 24. Production verification still required

Nothing below has been done; none of it can be done from this environment.

1. Backup taken and restore-tested (§5).
2. Read `SELECT VERSION()` and the engine (§4).
3. Run `default-password-scan.sql` and `account-integrity-audit.sql` on a
   snapshot; record results in the migration dataset (§13, §16).
4. `npm run build` the frontend on the build host; deploy it with
   `deploy.sh`; sign in through the real proxy and confirm `auth_metric`
   counts `login_body`.
5. Confirm the nginx TLS items in §17; only then `AUTH_REQUIRE_HTTPS=true`.
6. Create the break-glass account with the script; sign in with it once from
   a known address; confirm the Telegram alert and the audit row; rotate;
   seal (§10).
7. Externalise the JWT keys under the **current** material (§22 step 1) and
   confirm logins still verify — before any rotation.
8. Watch `login_query_string` to zero for seven days; remove the fallback.
9. Grant `manage_user_accounts` / `unlock_user_accounts` / `view_auth_log` to
   the right designations in the app.
10. Disable or delete the seeded admin row from migration `20220106131113`
    once the break-glass account exists — it still holds a known weak literal.

---

## 25. Deployment and rollback sequence

Each deployment is a `.env` change plus a reload, on top of a single code
release. The code is the same in all three; the flags differ.

### Deployment A — safety foundation

Code release of this branch. `.env` **unchanged** except, optionally, the
external JWT paths under the current key material. Every Deployment B/C flag
stays at its default (off).

Behaviour change users can see: none. Logins work identically; credentials
now travel in the body once the frontend is deployed, in the query string
until then (counted).

Behaviour change users cannot see: SHA-1 compared in Node not SQL; JWTs carry
`sub` and `kid`; the verifier pins RS256; `user_auth_log` starts filling;
new accounts get scrypt and are flagged; a system account can exist.

Rollback: revert the code release and `pm2 reload`. Tokens issued by the new
code carry `kid` and `sub`, which the old verifier ignores and the old
middleware reads as `id` — so **old code accepts new tokens**. The schema is
additive; the old code never reads the new columns. Only accounts that changed
their password under the new code (scrypt only, `password=NULL`) cannot sign
in on the old code — tell them, or restore the backup.

### Deployment B — password security and account protection

After A is stable and the A6 scan is recorded:

```
AUTH_HASH_ON_LOGIN=true
AUTH_LOCKOUT_ENABLED=true
AUTH_ENFORCE_PASSWORD_CHANGE=true      # once batch 0 is flagged
AUTH_SECURE_PROVISIONING=true          # once the joiner flow can hand out setup links
```

then the flagging batches (§14). Rollback: flip the flags back and reload —
hash-on-login migrations already done are permanent but harmless (those
accounts verify with scrypt either way); un-flag a batch with the documented
`UPDATE`.

### Deployment C — account integrity and token lifecycle

After B coverage is verified (`password_algo='sha1'` count → 0):

```
AUTH_TOKEN_VALID_FROM_ENABLED=true
AUTH_REJECT_LEGACY_SHA1=true
```

then, after review of §16, a new migration for the unique constraints (not
written here). Rollback: flags off; drop the constraints.

### Query-string fallback removal — standalone

`AUTH_LEGACY_QUERY_LOGIN=false` as soon as §18's metric allows. Independent of
B and C.

### JWT key rotation — standalone

§22, after A is stable. Independent of B and C.

---

## 26. Everything deliberately deferred

Documented so it does not disappear. None is in this change.

- **JWT in `localStorage`** is readable by any XSS. The right direction is an
  `HttpOnly; Secure; SameSite=Strict` cookie, which brings **CSRF** back into
  scope (a token in a header is CSRF-immune; a cookie is not) and needs a
  CSRF token or origin check. Larger than Stage 0A.
- **Content Security Policy** and general **security headers** (`helmet`);
  `cors()` currently allows every origin.
- **Session and device management**: listing and revoking individual sessions
  would need a session table; `token_valid_from` is the deliberately
  lightweight alternative.
- **Broader authorisation review**: the 135 `unProtectedRoutes` entries,
  `permissions.is_active` being dead, `invalidate()` never called after a
  permission edit. **Stage 0B — HR data security.**
- **Dependency vulnerability review** (`npm audit`; `jsonwebtoken` 8.5.1 has
  known advisories in later versions' changelogs; `@hapi/joi` 15 is EOL).
- **Removing the `id` claim and the `req.decoded` shape** once every reader
  uses `req.auth` — after the 24-hour overlap and a sweep of `routes/`.
- **Dropping the legacy `password` column** after `AUTH_REJECT_LEGACY_SHA1`.
- **Unique constraints on `user`** — Deployment C, after §16.
- **Stage 0C — local employee lifecycle and Digisme decoupling**, per
  `payroll-target-architecture.md`.
- **Payroll, attendance, shifts.**
- Per-request `SELECT *` on the employee master and field masking — Stage 0B.
- The token lifetime stays 24 hours as instructed.
