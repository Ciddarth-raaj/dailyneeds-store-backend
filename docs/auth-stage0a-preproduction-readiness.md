# Stage 0A — pre-production readiness (HARD-GATE report)

Safety correction pass over the Stage 0A implementation. Nothing deployed.
Nothing merged to `main-autodeploy`. Work is on
`claude/dnds-payroll-integration-proposal-3p6hen` in both repositories.

Companion documents: `auth-stage0a-implementation.md` (what was built and
why, updated in this pass — see §7a, §17a, §18a, §20a, §20b there) and
`authentication-decoupling-audit.md` (the as-was inspection).

Vocabulary: **PASS** · **FAIL** · **NOT YET TESTED** · **WAITING FOR ADMINISTRATOR**.

---

## Verdict

# DEPLOYMENT A = NO-GO

**Update 06-09-2026 (later the same day):** `main-autodeploy` has moved under
the feature branch in both repositories — a Telegram password-reset feature
was deployed to production with its own migration — and the feature branch
now **conflicts** in six backend and one frontend file. Gate 3 is reset to
NOT YET VERIFIED; gates 1, 2, 7, 11, 20 and 22 reset the moment the merge
is performed. Details, the four security reconciliations the merge needs,
and the working ledger are in **`auth-stage0a-deployment-runbook.md` §0**.
The table below is the state at commit `859e519`, before that drift.

Nine of twenty gates are not PASS. None is FAIL. Every non-PASS gate needs
either production access this environment does not have (a database
snapshot, the server, the nginx configuration, BotFather) or an
administrator's confirmation of something outside the repositories. The
code-level gates all pass with raw evidence (§4).

---

## 1. Gate table

| # | Gate | Status | Evidence / what is missing |
| --- | --- | --- | --- |
| 1 | Legacy JWT compatibility | **PASS** | `middlewares/auth.compat.test.js` tests 1–6; `middlewares/legacy_transition.test.js` (token minted by the actual `origin/main-autodeploy` code). Design in implementation doc §7a. |
| 2 | Legacy token cannot resolve system account | **PASS** | `auth.compat.test.js` test 7 (shape, claim and database refusals, with and without the DB check); `legacy_transition.test.js` case 9. |
| 3 | Stage-0A-only branch diff | **NOT YET VERIFIED** (was PASS at `859e519`; reset by upstream drift — runbook §0) | Backend: 58 files vs `origin/main-autodeploy`; **zero** payroll/HR/attendance/shift/Digisme *code*. Four documentation-only files are not Stage 0A (`docs/hr-schema.md`, `docs/payroll-target-architecture.md`, `docs/payroll-integration-proposal.md`, `docs/authentication-decoupling-audit.md`). Frontend: 9 files, all Stage 0A. Classification and isolation proposal in §2. |
| 4 | Deployment workflow / failure semantics reviewed | **WAITING FOR ADMINISTRATOR** | The GitHub Actions workflows in both repositories are fully analysed (§3). Not verifiable from a checkout: whether anything *outside* the repositories also reacts to `main-autodeploy` (GitHub repository webhooks, self-hosted runners, a second CI). Absence in the checkout is not evidence. **Plus a separate HARD GATE**: a migration failure leaves the old process running on a partially migrated schema; a later manual `pm2 reload` would start new code against it. Safer sequence proposed in §3.4 — must be adopted before GO. |
| 5 | End-to-end restore rehearsal, recent snapshot | **NOT YET TESTED** | No database exists in this environment (no MySQL, no Docker daemon). Runbook and recording template in §5. |
| 6 | Telegram token rotated | **WAITING FOR ADMINISTRATOR** | Code side done: the committed token is **removed from source**; `services/telegram.js` reads `TELEGRAM_BOT_TOKEN` only and disables itself with a logged error when absent. Revocation via BotFather, the new token in `.env`, a normal-notification receipt and the break-glass alert test are administrator actions (§6). |
| 7 | Break-glass route-level protection | **PASS** | `routes/user.protection.test.js`: real Express, real auth + permissions middleware, authenticated as a normal `user_type 2` admin; every existing mutation refused with `403 SYSTEM_ACCOUNT`; every mutation the brief lists that does not exist proven to have no route; router surface enumerated exactly; system row byte-for-byte unchanged. |
| 8 | Frontend production build | **PASS** | `npm install --force` (as the workflow does) then `next build` with `--openssl-legacy-provider`: exit 0, "Compiled successfully", 153 pages, `/login`, `/change-password`, `/setup-password` present. Warnings: pre-existing `moment` deprecation notices during static generation, none from the auth pages. Built bundle: **zero** occurrences of `user/login?username`; `post("/user/login",{username,password})` present. |
| 9 | Frontend/backend staging login | **NOT YET TESTED** | No staging backend with a database can run here. HTTP-level equivalents pass (`routes/user.login.test.js`, in-memory repository), which is not the same thing. |
| 10 | Legacy-token staging transition | **NOT YET TESTED (staging)** — isolated equivalent **PASS** | `legacy_transition.test.js` executes the real old `usecase/user.js` + `services/jwt.js` from `origin/main-autodeploy` to mint the token, then the real new middleware in Express, with the A.employee_id = B.user_id fixture and a system account. All nine steps of item 6 covered at code level. A run against a real staging database with a real browser has not happened. |
| 11 | NULL-password fail-closed | **PASS** | `services/password.nullable.test.js`: every listed input against `password NULL + hash NULL` (sha1 and scrypt algo, and empty string), end to end through `login`, and hash-only accounts accepting only the exact password. |
| 12 | trust proxy / spoofing validation | **PASS (code)** — nginx overwrite confirmation carried into gate 17 | `trust proxy` changed from blanket `true` to `loopback` default, `true` refused; `transportSecure` reads `req.secure` only. `routes/proxy.test.js`: forged `X-Forwarded-For` and `X-Forwarded-Proto` from an untrusted peer ignored, HTTPS gate not bypassable, IP allow-list not satisfiable by a forged header, multi-hop resolves to the proxy-added address. The live nginx vhost must be confirmed to *overwrite* both headers (§7). |
| 13 | Default-password scan on restored snapshot | **NOT YET TESTED** | Requires gate 5's restored database. Script ready (`scripts/auth/default-password-scan.sql`), read-only, outputs categories only. |
| 14 | Account-integrity scan on restored snapshot | **NOT YET TESTED** | Requires gate 5. Script ready (`scripts/auth/account-integrity-audit.sql`). |
| 15 | Feature flags startup-stable | **PASS** | All flags read once in `config/auth.js` at module load; `TRUST_PROXY` once in `server.js`; `TELEGRAM_BOT_TOKEN` once in `services/telegram.js`. No per-request `process.env` read in the auth path (grep-verified). Table in implementation doc §20b. |
| 16 | Absent-flag defaults reviewed | **PASS** | Every default is the Deployment A posture and is intentional; two are called out: absent `AUTH_LEGACY_QUERY_LOGIN` **keeps the fallback ON**; absent `AUTH_TOKEN_VALID_FROM_ENABLED` means **revocation is INACTIVE**. Implementation doc §20b. |
| 17 | External JWT loading verified using CURRENT key | **WAITING FOR ADMINISTRATOR** | Mechanism proven in tests via env-pointed files (`middlewares/auth.test.js`, `auth.compat.test.js` set `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEYS`). Not run on the server with the production key material. Procedure: implementation doc §22 step 1. |
| 18 | Break-glass login verified | **NOT YET TESTED** | Needs a database. Script ready (`scripts/auth/break-glass.js`). Usecase/route behaviour covered by tests 24–29 and gate 7. |
| 19 | Break-glass Telegram alert verified | **NOT YET TESTED** | Depends on gates 6 and 18. Alert path covered by test 45 with a fake transport. |
| 20 | All required auth tests: raw green evidence + named mappings | **PASS** | §4 below. |

---

## 2. Branch audit (gate 3)

### Backend — `dailyneeds-store-backend`, 58 files vs `origin/main-autodeploy`

| Classification | Files |
| --- | --- |
| **Stage 0A required — code** | `config/auth.js`, `services/password.js`, `services/jwt.js`, `services/telegram.js`, `repository/user.js`, `repository/auth_log.js`, `usecase/user.js`, `usecase/employee.js`, `middlewares/auth.js`, `routes/user.js`, `routes/material_request.js`, `routes/eb_consumption.js`, `routes/advance_request.js`, `routes/employee.js`, `routes/ticket.js`, `utils/actor.js`, `utils/password_policy.js`, `utils/http.js`, `server.js`, `.gitignore`, `.env-sample` |
| **Stage 0A required — migrations** | the four `20260906120000`–`120300-auth-stage0a-*` pairs (`.js` + `-up.sql` + `-down.sql`) |
| **Stage 0A required — scripts** | `scripts/auth/break-glass.js`, `default-password-scan.sql`, `flag-default-passwords.sql`, `account-integrity-audit.sql`, `backup-user-tables.sh` |
| **Stage 0A required — tests** | `test_support/auth_fixtures.js`; `services/password.test.js`, `services/password.nullable.test.js`, `services/jwt.test.js`; `utils/actor.test.js`, `utils/password_policy.test.js`; `usecase/user.test.js`, `usecase/user.changePassword.test.js`, `usecase/user.login.test.js`; `middlewares/auth.test.js`, `middlewares/auth.compat.test.js`, `middlewares/legacy_transition.test.js`; `routes/user.login.test.js`, `routes/user.protection.test.js`, `routes/proxy.test.js`; `repository/user.test.js` |
| **Documentation only — Stage 0A** | `docs/auth-stage0a-implementation.md`, this file |
| **Documentation only — NOT Stage 0A** (must not be confused with shipping work; contains no code) | `docs/hr-schema.md`, `docs/payroll-target-architecture.md`, `docs/payroll-integration-proposal.md`, `docs/authentication-decoupling-audit.md` |
| **Unrelated / payroll / HR / attendance / shift / Digisme-removal code** | **none** |

`employee_id` is not renumbered, regenerated or reinterpreted anywhere.
`new_employee` is not touched by any migration. `services/synker.js` (the
Digisme sync) is not in the diff.

### Frontend — `dailyneeds-store`, 9 files vs `origin/main-autodeploy`

All **Stage 0A required**: `helper/login.js`, `helper/user.js`,
`pages/login.js`, `pages/change-password.js`, `pages/setup-password.js`,
`util/api.js`, `components/header/header.js`,
`components/ChangePassword/index.jsx`, `pages/_app.js`. No documentation, no
unrelated work.

### Isolation proposal (not executed — the instruction was to work only on the existing feature branches)

The branch history is already cleanly separable: commits `c4f243d`,
`fd5ca88`, `666a0ce`, `5e6f943` are documentation-only; `2e68bc1` and the
correction-pass commit are Stage 0A. The safest isolation, when you choose
to do it:

```
git fetch origin
git checkout -b feat/auth-stage0a origin/main-autodeploy
git cherry-pick 2e68bc1 <correction-pass-commit>
git diff --name-status origin/main-autodeploy   # expect 54 files, no payroll docs
```

That yields a branch that differs from production by Stage 0A only. The
four non-Stage-0A documents stay on the current branch for a later
docs-only merge. It is unambiguous, but it is a decision about which branch
becomes the merge candidate, so it is proposed rather than done.

---

## 3. Deployment mechanism (gate 4)

### 3.1 What triggers what

| | Backend | Frontend |
| --- | --- | --- |
| Trigger branch | `main-autodeploy` | `main-autodeploy` (its own repository) |
| Definition | `.github/workflows/deploy-backend.yml` | `.github/workflows/deploy.yml` |
| Also | `workflow_dispatch` (manual) | `workflow_dispatch`; `deploy.sh` for manual local deploys |
| Runs on | GitHub Actions → SSH to the EC2 host | GitHub Actions (build) → rsync to the EC2 host |
| Deploys | separately | separately — a push to one repository deploys only that repository |

**Searched for and not found in either checkout:** server-side git hooks
(only the `.git/hooks/*.sample` defaults), other CI definitions, CodeDeploy,
Procfile, control-panel or webhook configuration. `ecosystem.config.js`
contains a PM2 deploy stanza with placeholder values (`SSH_USERNAME`,
`GIT_REPOSITORY`) that cannot be in use.

**Not verifiable here, so not proven:** the GitHub repository settings
(Webhooks, Actions → Runners, branch protection). → WAITING FOR
ADMINISTRATOR, §7.

### 3.2 Backend command order

```
set -euo pipefail
cd ~/dailyneeds-store-backend
git checkout -- package-lock.json || true      # discard local lockfile drift
git checkout main-autodeploy
git pull origin main-autodeploy
npm i
cd migrations/mysql
db-migrate up                                   # (4) BEFORE reload
cd ../..
pm2 reload 0                                    # (5)
```

- `db-migrate up` runs **before** `pm2 reload`.
- On migration failure: `set -e` aborts; **`pm2 reload` does not run**; the
  old process keeps serving; the working tree is already at the new commit
  and `node_modules` already updated.
- `db-migrate` records a migration only on success, so a failed one is
  re-attempted on the next run.

### 3.3 Transactionality

Not transactional. `db-migrate` executes each SQL file via `runSql` with
`multipleStatements: true`; MySQL DDL cannot be rolled back (MySQL 8 makes a
*single* DDL statement atomic; 5.7 does not). A multi-statement file can
half-apply.

**Corrected in this pass:** the `user` column migration is now **one
`ALTER TABLE`** (indexes folded in) — all-or-nothing on 5.7 and 8; both
`CREATE TABLE` files use `IF NOT EXISTS`; the permission inserts are
`WHERE NOT EXISTS`. Every Stage 0A migration is idempotent on re-run.

**Residual HARD GATE:** with the deploy as written, a failure in file 2, 3 or
4 leaves file 1 applied and the *old* process running — which is safe,
because the old code never reads the new columns. But a **manual
`pm2 reload` before the migration is repaired would start the new code
against the partial schema** (first audit write would fail on the missing
table). That is a human-sequencing hazard, not a code one, and the sequence
below removes it.

### 3.4 Safer deployment sequence (required before GO)

1. Gate 5: backup + restore rehearsal passed.
2. Apply the four migrations **deliberately, with the old code still
   running**, from a scratch clone of the feature branch on the server:
   `cd migrations/mysql && db-migrate up`. Every migration is additive and
   the old code ignores the new columns and tables — that is the point of
   doing it first.
3. `db-migrate` status shows all four applied; sign in on the **old** code;
   confirm nothing changed.
4. Only now merge to `main-autodeploy`. The workflow's `db-migrate up` is a
   no-op and `pm2 reload` starts code whose schema already exists.
5. Rollback of step 2 alone: `db-migrate down` ×4 (safe until the
   break-glass account or any password change creates a modern hash), else
   the gate-5 backup.

### 3.5 Frontend

Build on the runner (Node 16, `npm install --force`, `.env.production` from
the `NEXT_PUBLIC_API_URL` secret, `next build`), rsync `.next/` and `public/`
to `~/dnds-store-build`, `npm install --omit=dev --force` on the server,
`pm2 reload fe`. No migrations, no interaction with the backend deploy.

---

## 4. Raw test evidence and named mappings (gate 20)

### 4.1 Raw summary

```
$ cd dailyneeds-store-backend && IS_TEST=true node --test
# tests 349
# suites 63
# pass 348
# fail 0
# cancelled 0
# skipped 1
# todo 0
```

The single skip is the pre-existing `priceCheckerConflicts golden regression`
("Golden input/output files not available"), unrelated to authentication.

### 4.2 Section 1 — legacy / v2 identity (tests 1–7)

| Requirement | File | Test name | Result |
| --- | --- | --- | --- |
| 1. legacy token resolves using employee_id (and id) | `middlewares/auth.compat.test.js` | "1. legacy token resolves using id (user_id) and employee_id, and is marked legacy" | PASS |
| 2. auth_ver=2 token resolves using user_id | `middlewares/auth.compat.test.js` | "2. new auth_ver=2 token resolves using sub (user_id)" | PASS |
| 3. overlapping user_id/employee_id cannot cross-authenticate | `middlewares/auth.compat.test.js` | "3. overlapping user_id / employee_id values cannot cross-authenticate" | PASS |
| 4. legacy employee A cannot resolve to user B when B.user_id = A.employee_id | `middlewares/auth.compat.test.js` | "4. legacy employee A cannot resolve to user B when B.user_id equals A.employee_id" | PASS |
| 5. break-glass v2 token resolves by user_id with employee_id NULL | `middlewares/auth.compat.test.js` | "5. break-glass v2 token resolves by user_id with employee_id NULL" | PASS |
| 6. unknown/malformed auth_ver rejected safely | `middlewares/auth.compat.test.js` | "6. unknown or malformed auth_ver is rejected safely" | PASS |
| 7. legacy token can NEVER resolve to a system/break-glass account | `middlewares/auth.compat.test.js` | "7. a legacy token can NEVER resolve to a system / break-glass account" | PASS |

### 4.3 Section 14 — regression categories A–G

| Cat. | Requirement | File | Test name | Result |
| --- | --- | --- | --- | --- |
| A | legacy token resolves by employee_id | `middlewares/auth.compat.test.js` | "1. legacy token resolves using id (user_id) and employee_id, and is marked legacy" | PASS |
| A | v2 token resolves by user_id | `middlewares/auth.compat.test.js` | "2. new auth_ver=2 token resolves using sub (user_id)" | PASS |
| A | colliding numeric ID spaces cannot impersonate | `middlewares/auth.compat.test.js` | "3. overlapping user_id / employee_id values cannot cross-authenticate" | PASS |
| A | legacy token cannot resolve to system account | `middlewares/auth.compat.test.js` | "7. a legacy token can NEVER resolve to a system / break-glass account" | PASS |
| A | legacy DB check fails closed | `middlewares/auth.compat.test.js` | "the legacy database check fails closed" | PASS |
| B | password NULL + password_hash NULL always fails (sha1 algo) | `services/password.nullable.test.js` | "verifyUser refuses every input for a row with no credential at all (sha1 algo)" | PASS |
| B | … (scrypt algo) | `services/password.nullable.test.js` | "verifyUser refuses every input for a row with no credential at all (scrypt algo)" | PASS |
| B | … end to end through login | `services/password.nullable.test.js` | "login refuses every input for such an account end to end, with the standard response" | PASS |
| B | hash-only account accepts only the right password | `services/password.nullable.test.js` | "password NULL + valid modern hash authenticates only with the correct modern password" | PASS |
| C | unknown kid rejected | `services/jwt.test.js` | "35. an unknown kid is rejected" | PASS |
| C | traversal/path-shaped kid rejected | `services/jwt.test.js` | "36. traversal-shaped kid is rejected" | PASS |
| C | URL-looking kid rejected | `services/jwt.test.js` | "37. URL- and path-like kids are rejected" | PASS |
| C | prototype-named kid rejected | `services/jwt.test.js` | "prototype names are not keys" | PASS |
| D | token issued before cutoff rejected | `middlewares/auth.test.js` | "41. a token issued before token_valid_from is rejected" | PASS |
| D | token issued after cutoff accepted | `middlewares/auth.test.js` | "42. a token issued after token_valid_from succeeds" | PASS |
| E | normal admin cannot create system account | `routes/user.protection.test.js` | "cannot create a break-glass account: no route accepts is_system_account, and no user-creation route exists" | PASS |
| E | cannot modify system flag / convert employee | `routes/user.protection.test.js` | "cannot convert an employee account into a system account, change its username, user_type, employee link, or delete it: no such routes" | PASS |
| E | cannot reset break-glass account | `routes/user.protection.test.js` | "cannot reset break-glass credentials" | PASS |
| E | cannot unlock / modify system-account status | `routes/user.protection.test.js` | "cannot unlock (modify status) of the system account" | PASS |
| E | cannot modify system account via IP policy | `routes/user.protection.test.js` | "cannot change the system account's IP policy (generic user modification)" | PASS |
| E | cannot change break-glass password via normal API | `routes/user.protection.test.js` | "cannot change the system account's password even when holding its own session" | PASS |
| E | cannot assign employee_id NULL to manufacture one | `routes/user.protection.test.js` | "cannot convert an employee account … employee link … no such routes" (`PATCH /user/:id {employee_id:null}` → 404) | PASS |
| E | router mutation surface enumerated exactly | `routes/user.protection.test.js` | "the /user router exposes no PUT/PATCH/DELETE at all - the mutations that exist are enumerable" | PASS |
| E | SQL layer: creation never sets the flag | `repository/user.test.js` | "28. account creation never sets is_system_account and never writes SHA-1" | PASS |
| E | SQL layer: every mutation excludes system accounts | `repository/user.test.js` | "29. every mutation that could touch a credential or policy excludes system accounts" | PASS |
| F | forged X-Forwarded-For cannot alter trusted identity | `routes/proxy.test.js` | "with the default loopback trust, a NON-loopback peer's forged headers are ignored (direct exposure)" | PASS |
| F | forged X-Forwarded-For cannot satisfy an IP allow-list | `routes/proxy.test.js` | "IP-restriction decisions use the trusted address, so a forged header cannot satisfy a branch allow-list" | PASS |
| F | forged X-Forwarded-Proto cannot bypass HTTPS enforcement | `routes/proxy.test.js` | "forged X-Forwarded-Proto: https cannot bypass HTTPS enforcement from an untrusted peer" | PASS |
| F | trusted proxy's proto honoured (nginx case) | `routes/proxy.test.js` | "the trusted proxy's X-Forwarded-Proto (loopback peer) is honoured - the nginx case" | PASS |
| F | multi-hop resolves to proxy-added address | `routes/proxy.test.js` | "with loopback trust, a multi-hop X-Forwarded-For yields the address the proxy added, not a client-prepended one" | PASS |
| F | TRUST_PROXY=true refused in server.js | `routes/proxy.test.js` | "server.js never accepts TRUST_PROXY=true" | PASS |
| G | old token has the production shape | `middlewares/legacy_transition.test.js` | "the old token has the production shape: id + employee_id, no sub, no kid, no auth_ver" | PASS |
| G | old-backend token keeps the same identity on the new backend, with designation/store/permissions | `middlewares/legacy_transition.test.js` | "5/6. the old token still resolves to employee A on the new backend, with A's designation, store and permissions" | PASS |
| G | A.employee_id = B.user_id fixture; legacy session does not become B | `middlewares/legacy_transition.test.js` | "7/8. A.employee_id equals B.user_id, and the legacy session does NOT become user B" | PASS |
| G | same legacy token cannot resolve to system account | `middlewares/legacy_transition.test.js` | "9. the same legacy token cannot resolve to the system / break-glass account, and no legacy token can" | PASS |
| G | fresh v2 login for B is B, not A | `middlewares/legacy_transition.test.js` | "a fresh v2 login on the new backend for B is user 42 with employee 9001 - the overlap does not leak either way" | PASS |

Category G is the isolated equivalent of a staging run (real old source,
real new middleware, real HTTP), **not** a staging run with a database and a
browser — gate 10 stays NOT YET TESTED for that reason.

---

## 5. Restore rehearsal runbook and recording template (gate 5)

Run on the database host. Do not run the scan on production (item 9).

```bash
# 1. snapshot (record the timestamp)
scripts/auth/backup-user-tables.sh <db> ~/db-backups        # auth tables + full dump, verified
# 2. isolated restore
mysql -e 'CREATE DATABASE dnds_rehearsal'
time zcat ~/db-backups/<db>-full-<stamp>.sql.gz | mysql dnds_rehearsal
# 3. validation
mysql dnds_rehearsal -e "SELECT VERSION(); SELECT COUNT(*) FROM \`user\`; SELECT COUNT(*) FROM new_employee;
  SELECT COUNT(*) FROM \`user\` WHERE password IS NOT NULL; SHOW CREATE TABLE \`user\`\\G"
mysql dnds_rehearsal -e "SELECT * FROM migrations ORDER BY run_on DESC LIMIT 3"   # restored schema version
# 4. connect a client: point a scratch config.json at dnds_rehearsal and start the OLD code on another port;
#    sign in as a test employee. Then run gates 13 and 14 against dnds_rehearsal, retain only IDs + categories.
# 5. tear down
mysql -e 'DROP DATABASE dnds_rehearsal'
```

Record: snapshot timestamp · age at rehearsal (≤ 24 h, else why and
confirmation no auth/schema migration ran since) · backup method
(`mysqldump --single-transaction`) · restore process · restore duration ·
validation queries and results · restored schema version (last row of
`migrations`) · whether `user.password` and the joined `new_employee` data
were readable · any manual intervention.

---

## 6. Telegram rotation procedure (gate 6)

In this order, none of it done here:

1. In BotFather: `/revoke` the existing bot token (this invalidates the value
   that was in git history). Record the time — that is the revocation
   confirmation.
2. Set `TELEGRAM_BOT_TOKEN=<new>` in the server's `.env` (`chmod 600`).
   **Before** deploying this code: the code no longer has a fallback.
3. `pm2 reload 0`; confirm the startup log does **not** show
   `SERVICE.TELEGRAM.TOKEN-MISSING`.
4. Trigger a normal notification (any existing alert path) and confirm
   receipt in the alerts chat.
5. Gate 18, then sign in with the break-glass account once and confirm the
   `🚨 BREAK-GLASS LOGIN` message arrives with notification sound
   (`disableNotification: false`).
6. Rotate the break-glass credential (it has now been used).

Until step 5 is observed, break-glass readiness = NOT TESTED.

---

## 7. What the administrator must provide or perform

Infrastructure facts needed (gate 4):

- Screenshots or confirmation that **GitHub → Settings → Webhooks** is empty
  (or lists only what is expected) in **both** repositories.
- Confirmation that no self-hosted runner, no second CI, and no server-side
  git hook exists on the EC2 host (`ls ~/dailyneeds-store-backend/.git/hooks`
  shows only `*.sample`; `ls ~/dnds-store-build/.git 2>/dev/null` absent).
- Whether branch protection exists on `main-autodeploy`.

Actions, in order:

1. Gate 4 confirmations above; adopt the safer sequence (§3.4).
2. Gate 6: Telegram rotation (§6 steps 1–4).
3. Gate 5: backup + restore rehearsal (§5), record the template.
4. Gates 13, 14: run both scans **against the restored database only**;
   retain IDs + categories; discard everything else.
5. Gate 17: externalise the JWT keys under the **current** material
   (implementation doc §22 step 1); confirm logins verify on the old code.
6. nginx (gate 12 residual / §17): `sudo nginx -T` for `api.dnds.co.in` —
   confirm `listen 443 ssl`, port-80 redirect, and that the vhost location
   **sets** `X-Forwarded-For $remote_addr` and `X-Forwarded-Proto $scheme`
   (overwrite). Confirm port 8080 is not reachable from outside.
7. Gate 9: a staging backend against the rehearsal database, the built
   frontend pointed at it: login, failed login, logout, navigation.
8. Gate 10: on that staging pair, run item 6 steps 1–9 with a real browser
   and the A.employee_id = B.user_id fixture.
9. Gate 18/19: create the break-glass account on staging, sign in, observe
   the alert, rotate.
10. Then re-run this gate table.

---

## 8. Deployment A window (item 13)

Do not deploy during this task. When the table is all PASS:

- Lowest-traffic window; no other deployment; owner/admin present; rollback
  operator present; gate-5 rehearsal within 24 h; production commit recorded
  (`git rev-parse origin/main-autodeploy` in both repositories); previous
  built frontend artifacts kept on the runner.
- Someone at every outlet ready to sign in immediately.
- Post-deploy checks, each recorded with time and result: break-glass admin;
  normal admin; normal employee; cashier/store user; **inactive employee →
  must fail**; a **pre-deployment legacy token → same employee, same
  designation/store/permissions**; a fresh v2 login (decode: `auth_ver: 2`,
  `sub`); `/user/my-ip` → `secure: true`, `has_forwarded_proto: true`;
  `auth_metric` shows `login_body` climbing.
- Record the deploy time: legacy resolution may be retired **36 h** later
  (implementation doc §7a).
