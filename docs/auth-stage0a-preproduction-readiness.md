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

**Update 06-09-2026 (integration performed):** the current `main-autodeploy`
of both repositories (a Telegram password-reset feature, already in
production with its own migration) has been **merged into** the Stage 0A
feature branch — a merge commit, no rebase, nothing pushed to
`main-autodeploy`, nothing deployed. The seven conflicts were resolved
semantically and the four security reconciliations (C1–C4) applied with
tests. The full record is **§0** below. Gates 1, 2, 3, 7, 11, 20, 22 and 23
were reset by the merge and have been re-evaluated on the merged tree;
the table in §1 is the state at the merge commit.

Deployment A stays **NO-GO** for the same reason as before: the gates that
need production access, a restored snapshot, staging, the nginx
configuration, BotFather or your personal confirmation (4, 5, 6, 9, 10,
12–14, 17–19, 23) are still open. **One item in §0.6 is urgent and
independent of Deployment A:** the Telegram bot token. Rotation can and
should proceed now using production's existing environment support.

---

## 0. Integration of `main-autodeploy` into the Stage 0A branch (06-09-2026)

### 0.1 Safety point

Recorded before any merge command ran; both trees were clean.

| Repo | `origin/main-autodeploy` (production) | Feature branch before merge | Merge-base | Local tags |
| --- | --- | --- | --- | --- |
| backend | `9d92884dbca41612f8f4298b9097edf216df34a5` | `ca9c4b365740cdf06d7ddfb82396af2ea5a270eb` | `974afda` | `stage0a-prod-baseline-backend`, `stage0a-pre-merge-backend` |
| frontend | `16cd162ef5a5e82af2d8b4521a5ddabde90ff89a` | `b9f8cd38b11d31dca8af574f17e918db1a793d48` | `a8090e4` | `stage0a-prod-baseline-frontend`, `stage0a-pre-merge-frontend` |

Upstream commits absorbed: backend `a98428a` "reset a forgotten password
over Telegram", `9d92884` "let the bot name itself"; frontend `3f86694`,
`b555de3`, `16cd162` (the last is an unrelated mobile menu fix). Upstream
delta since the branch point: backend 12 files (+1153/−7), frontend 5 files
(+577/−3). Nothing in that delta touches payroll, attendance, shifts,
Digisme or `employee_id`.

Rollback of the integration itself, if ever wanted: `git reset --hard
stage0a-pre-merge-backend` / `stage0a-pre-merge-frontend` on the feature
branch (local tags; not pushed).

### 0.2 Conflict record

Command in both repos: `git merge --no-commit --no-ff origin/main-autodeploy`.
Every conflict was read on both sides and resolved by hand; no side was
taken wholesale.

| File | Upstream side (production) | Stage 0A side | Resolution | Why |
| --- | --- | --- | --- | --- |
| `middlewares/auth.js` | adds `/user/forgot-password`, `/user/reset-password` to `unProtectedRoutes` | adds `/user/setup-password` | **union** — all three unprotected | Signed-out flows by definition; everything else on `/user` stays behind the middleware. |
| `.env-sample` | documents `TELEGRAM_BOT_TOKEN` (optional, with compiled fallback) and optional `TELEGRAM_BOT_USERNAME` | Stage 0A block: `TELEGRAM_BOT_TOKEN` **required**, no fallback | Stage 0A block kept; upstream's `TELEGRAM_BOT_USERNAME` note folded in | The fallback is the compromised literal (C4). |
| `server.js` | constructs `passwordResetRepo`, `passwordResetUsecase`, registers `telegram_link_poll` cron, passes the usecase to the user router | constructs `authLogRepo`, passes `authLogRepo` + `authMiddleware` to the user router | **both wired**; `passwordResetUsecase` is built with `{ authLogRepo }` so resets are audited; router deps carry all three | Additive on both sides. |
| `repository/user.js` | adds `getByUsername` (`LEFT JOIN new_employee … WHERE ne.status = 1`) | Stage 0A rewrite (scrypt columns, `setModernPassword`, system-account guards on every mutation) | Stage 0A file kept; `getByUsername` **added with explicit predicates** `u.status = 1 AND u.is_system_account = 0 AND u.employee_id IS NOT NULL AND ne.status = 1`, returning `is_system_account`, `employee_status`, `primary_contact_number` | C2: exclusion must not rely on the accidental inner-join effect. |
| `routes/user.js` | Telegram-link routes reading `req.decoded.id`; forgot/reset routes | `actorUserId`/`rejectSystemAccounts`, `/setup-password`, `/logout`, admin reset/unlock, auth-log routes | Stage 0A file kept; upstream routes **re-added on `req.auth`** via `actorUserId`, `rejectSystemAccounts("Linking Telegram")` on all three `/telegram-link` methods; forgot/reset pass `{ ip, userAgent }` for audit; `reset-password` non-200 → HTTP 400 | Caller identity must come from the resolved account, not the raw claim (§0.11). |
| `services/telegram.js` | `process.env.TELEGRAM_BOT_TOKEN || "<literal>"`, adds `getBotUsername()` (cached `getMe`) and `getUpdates(offset)` | env-only token, disabled-with-error when absent, no message body in logs | env-only kept; `getBotUsername` returns `""` and `getUpdates` throws `NOT_CONFIGURED` when no client; `isConfigured()` added; `sendMessage` still never logs `msg` | C4. |
| frontend `helper/user.js` | adds `getTelegramLink`, `startTelegramLink`, `unlinkTelegram`, `forgotPassword`, `resetPassword` | adds `setupPassword`, `logout` | **union** | Purely additive on both sides. |

Auto-merged without conflict but reviewed: backend `usecase/passwordReset.js`
(then rewritten, §0.3–0.6), `usecase/passwordReset.test.js` (adapted),
`repository/passwordReset.js` (unchanged), the upstream migration
(unchanged); frontend `pages/login.js`, `components/header/header.js`,
`components/ForgotPassword/index.jsx`, `components/TelegramLink/index.jsx`
(all unchanged from upstream).

One resolution error was caught before commit: a duplicated
`/ip-restrictions` route block in `routes/user.js` (syntax error) —
removed; the file parses and its route surface is asserted exactly by
`routes/user.protection.test.js`.

### 0.3 C1 — no SHA-1 for the Telegram reset

Upstream `resetPassword` ended in `userRepo.updatePassword(user_id,
plaintext)` → `SET password = SHA1(?)`. On the merged branch that method
no longer exists. `usecase/passwordReset.js#resetPassword` now calls
`passwords.hash(next)` (scrypt) → `userRepo.setModernPassword(user_id,
hash, { clearMustChange: true })`, which writes `password_hash`,
`password_algo = 'scrypt'`, nulls the legacy `password` column and clears
`must_change_password`. Evidence: `usecase/passwordReset.stage0a.test.js`
"C1" — the stored hash matches `^\$scrypt\$`, the source contains no
`updatePassword` / `SHA1` / `MIN_PASSWORD_LENGTH`, and no audit row
carries the plaintext or the code.

### 0.4 C2 — explicit system-account exclusion

Two independent layers, each tested on its own:

1. **SQL** — `getByUsername` carries `AND u.is_system_account = 0 AND
   u.employee_id IS NOT NULL` explicitly (§0.2).
2. **Usecase** — `isResettableAccount(user)` (exported) refuses
   `is_system_account = 1`, `employee_id NULL`, `status ≠ 1`,
   `employee_status ≠ 1`. `requestReset` answers neutrally and audits
   `reset_requested` with `refused_protected_or_inactive`; `resetPassword`
   answers `INVALID` without touching the row.
3. **Route** — the three `/telegram-link` routes are behind
   `rejectSystemAccounts` (`403 EMPLOYEE_REQUIRED`), so a break-glass
   session can never acquire a Telegram-delivered reset path.

The five named tests (`usecase/passwordReset.stage0a.test.js`, "C2"):

| # | Test | Result |
| --- | --- | --- |
| 1 | a normal employee can use the reset flow end to end (scrypt written, audited) | pass |
| 2 | `requestReset` for the break-glass username: neutral answer, nothing sent, no code row, audit `refused_protected_or_inactive` or `unknown_user` | pass |
| 3 | `resetPassword` for the break-glass username with a planted valid code: refused, code untouched, row unchanged | pass |
| 4 | an admin session cannot link Telegram for, or request a reset on behalf of, the system account (no `:id` form exists) | pass |
| 5 | the usecase refuses on its own even if the repository lookup were to return the system row (guard not dependent on SQL) | pass |

Plus at HTTP level in `routes/user.protection.test.js` (real Express, real
middleware): forgot-password for the break-glass username is neutral and
sends nothing; reset-password with a planted code is refused (400) and
`setModernPassword` is never called for the system id; a normal admin has
no `/user/:id/forgot-password` or `/user/:id/telegram-link` (404); a
system-account token gets `403 EMPLOYEE_REQUIRED` on GET/POST/DELETE
`/telegram-link` and no link token is created; a normal employee CAN start
a link (the guard is specific).

### 0.5 C3 — unified password policy and the employee-facing failure

`resetPassword` runs `utils/password_policy.check(next, { username,
employeeId, mobile })` **before** verifying the code. A policy failure
returns `{ code: 400, error: "PASSWORD_POLICY", msg: "<reason>. Your code
is still valid — choose a different password and try again." }` and does
**not** consume the code or count an attempt. The same `check` function
serves change-password, setup-password and admin reset. The frontend
`components/ForgotPassword` already displays the server `msg` inline, so
the employee sees the exact reason (too short, equals username / employee
code / mobile, a known default, too common) and can retry with the same
code. Evidence: "C3" in `passwordReset.stage0a.test.js` — six rejection
cases, each followed by a successful retry with the same code; and a test
that the policy object is the shared module.

### 0.6 C4 — the Telegram bot token (URGENT)

**Question:** can possession of the CURRENT Telegram bot token allow
someone to obtain, intercept, observe or influence an employee
password-reset code?

**Answer: YES.**

*Cannot:* read outbound messages after the fact — the Bot API has no
"sent messages" endpoint, and codes are stored only as sha256 hashes.

*Can:*

- **Impersonate the bot** — `sendMessage` to any `chat_id` the bot has
  seen (the `telegram_links` chat ids are the same ids the bot uses).
- **Read everything sent *to* the bot** via `getUpdates`: every `/start
  <link_token>` (the one-time linking token, 24-hour TTL) and any reply an
  employee types, including a code they are tricked into repeating.
- **Race or advance the update offset**, starving the production poller
  of updates, or **`setWebhook`** so production's `getUpdates` fails with
  409 and every update is delivered to the attacker instead.
- **Influence** a reset outright: request a reset for a victim through the
  public `/user/forgot-password` (no token needed) → the *real* bot sends
  the code to the victim → the attacker, as the *same* bot, messages the
  victim "reply with the code to confirm" → reads the reply via
  `getUpdates` → calls `/user/reset-password`. The message text now
  states the code should never be replied to, which reduces but does not
  remove this.

Code path (merged branch): `routes/user.js` `POST /forgot-password` →
`usecase/passwordReset.js#requestReset` → `telegram.sendMessage(chat_id,
"…*<code>*…")` (`services/telegram.js`, single client built once from
`TELEGRAM_BOT_TOKEN`); `server.js` cron `telegram_link_poll` (every
minute) → `pollTelegramUpdates` → `telegram.getUpdates(offset)`.

**Immediate standalone action, independent of Deployment A** (production
already reads the variable — deployed `services/telegram.js` is
`process.env.TELEGRAM_BOT_TOKEN || "<literal>"`):

1. Create the new token in BotFather (`/revoke` issues a new one and kills
   the old; if you prefer an overlap, `/token` on a *new* bot is not an
   option here because links and chat ids belong to this bot — use
   `/revoke` and move fast).
2. Put `TELEGRAM_BOT_TOKEN=<new>` in the server `.env` (mode 600), `pm2
   reload 0`.
3. Verify: a normal notification arrives; `curl
   "https://api.telegram.org/bot<new>/getWebhookInfo"` shows no webhook
   (if one is set, `deleteWebhook`); a `/start` link completes.
4. Record the revocation time. The literal in the deployed source is then
   dead; the merged branch has no literal at all.

**Poller / PM2 review:** `ecosystem.config.js` runs the backend in fork
mode as a single process (no `instances`), so exactly one poller exists;
`pm2 reload 0` in fork mode is a restart, so two pollers never overlap.
The update offset is held in memory: a restart replays only updates
Telegram has not yet had acknowledged, and link tokens are consumed
atomically (`consumeLinkToken` = single-row update), so a replay cannot
link twice. Added on the branch: a re-entrancy guard (`this.polling`) so
a slow tick cannot overlap the next one, and a logged no-op when no token
is configured (`{ code: 503, skipped: "not_configured" }`) instead of
sixty thrown errors an hour. Tests: "C4" in
`passwordReset.stage0a.test.js`.

### 0.7 Two reset systems — reconciliation PROPOSAL (not decided, not implemented)

The merged branch carries two mechanisms:

| | Stage 0A admin-issued token | Production Telegram self-service |
| --- | --- | --- |
| Trigger | admin `POST /user/:id/reset-password` or provisioning | employee `POST /user/forgot-password` |
| Proof | single-use hashed token (`user_password_reset`), delivered by the admin out of band | single-use hashed 6-digit code delivered to a Telegram chat the employee linked from a signed-in session |
| Redeem | `POST /user/setup-password` | `POST /user/reset-password` |
| Now shared (this merge) | policy, scrypt, `setModernPassword`, audit, system-account exclusion | same |

**Recommendation (for your decision):** keep both, with distinct roles.
Telegram self-service remains the *employee-facing* path (it is live, it
needs no admin, and the linking step from a signed-in session is a real
possession proof). The admin-issued token remains the *provisioning and
fallback* path: first login for a new account, an employee with no
Telegram link, a lost phone, and every break-glass / admin-driven case. A
single "which do I use" rule in the UI: *Forgot password → Telegram if
linked, otherwise "ask your manager for a setup link"*. No employee-facing
workflow is replaced by this merge. **STOP point:** replacing or removing
either workflow is a product decision and has not been made here.

### 0.8 Outstanding reset codes across Deployment A

`password_reset_codes` rows are shared by old and new code; format
(sha256 of the code, `expires_at`, `attempts`, `consumed_at`) is unchanged.
Tested in `passwordReset.stage0a.test.js` "outstanding codes":

| Case | Behaviour after Deployment A |
| --- | --- |
| 1. Code issued by the old backend, redeemed on the new one within TTL | works; password stored as **scrypt** |
| 2. Code issued by the old backend, expired | rejected as expired (expiry lives in the row, unchanged) |
| 3. Old-backend code, new password fails the new policy | `PASSWORD_POLICY` with reason; code **kept**; retry succeeds |
| 4. Old-backend code already consumed or at 5 attempts | rejected |
| 5. Two codes issued (old then new backend) | only the newest live row is honoured; the earlier one is superseded |

There is no SHA-1 write path left after Deployment A, and no way for an
old code to bypass the policy.

### 0.9 Migration reconciliation (gate 22 re-earned)

Upstream `20260906070000-telegram-password-reset`: three `CREATE TABLE IF
NOT EXISTS` (`telegram_links`, `telegram_link_tokens`,
`password_reset_codes`), no `user` columns, already applied in production.
Stage 0A `20260906120000`–`120300`: sort strictly after it; no table or
column overlaps (`user_password_reset` ≠ `password_reset_codes`); no
duplicate `user` columns. On the night, `db-migrate up` sees the upstream
migration as applied and runs only the four Stage 0A ones.
`migrations/auth_stage0a_migrations.test.js`: 7/7 on the merged tree.

### 0.10 Production JWT claims, re-read from the NEW baseline (gate 23)

`origin/main-autodeploy` at `9d92884`: `usecase/user.js` and
`services/jwt.js` are byte-identical to the previous baseline — the token
payload is `id` (= `user_id`), `employee_id`, `store_id`,
`designation_id`, `user_type`; **no `sub`, no `auth_ver`, no `kid`**,
`algorithm: "RS256"`. The Stage 0A legacy resolution premise is unchanged.
Gate 23 remains **yours**: decode your own production token locally and
record field names only.

### 0.11 Caller-identity audit of the new upstream code

| Upstream route | Identity source upstream | On the merged branch |
| --- | --- | --- |
| `GET/POST/DELETE /user/telegram-link` | `req.decoded.id` (raw JWT claim) | `actorUserId(req)` from `req.auth` (resolved account, `auth_ver` aware, strict legacy resolution); `rejectSystemAccounts` first |
| `POST /user/forgot-password`, `POST /user/reset-password` | none (signed out; `username` from body) | unchanged by design; `ip` + `user-agent` recorded in `user_auth_log`; account eligibility enforced in SQL and usecase (C2) |
| `telegram_link_poll` → `consumeLinkToken` | the `/start` token proves the link | unchanged; only the token hash is matched, single-use |

`req.decoded` is still populated by the middleware for other routes; the
merged `routes/user.js` has zero uses of it.

### 0.12 Tests on the merged tree (raw)

```
IS_TEST=true node --test
# tests 407  # suites 76  # pass 406  # fail 0  # cancelled 0  # skipped 1
```

(The one skip is the pre-existing `priceCheckerConflicts` golden-file test,
unrelated to auth.) Per file: `usecase/passwordReset.test.js` 19/19
(upstream, adapted to scrypt + policy), `usecase/passwordReset.stage0a.test.js`
27/27 (new), `routes/user.protection.test.js` 14/14 (extended),
`middlewares/auth.compat.test.js` 10/10, `middlewares/legacy_transition.test.js`
5/5, `services/password.nullable.test.js` 6/6, `routes/user.login.test.js`
8/8, `migrations/auth_stage0a_migrations.test.js` 7/7.

Frontend: `rm -rf node_modules .next && npm ci --legacy-peer-deps` → exit 0,
1008 packages, **`package-lock.json` unchanged** against both parents;
`NODE_OPTIONS=--openssl-legacy-provider npm run build` → exit 0, "Compiled
successfully", `/login` and `/setup-password` present; built bundle has
**zero** occurrences of `user/login?username`.

### 0.13 Gate resets and re-evaluation

| Gate | Reset by | Re-evaluated | Status |
| --- | --- | --- | --- |
| 1, 2 | auth code changed | `auth.compat.test.js` 10/10, `legacy_transition.test.js` 5/5 on the merged tree; baseline claims re-read (§0.10) | **PASS** |
| 3 | branch base moved | re-diffed vs `origin/main-autodeploy` (§0.14) | **PASS** (same docs-only exception) |
| 7 | new routes | `routes/user.protection.test.js` 14/14 incl. the five Telegram routes | **PASS** |
| 11 | auth code changed | `password.nullable.test.js` 6/6 | **PASS** |
| 20 | tests changed | 407 / 406 / 0 / 1 skip | **PASS** |
| 21 | lockfile could have moved | unchanged vs both parents | **PASS** |
| 22 | migration added to branch | §0.9, 7/7 | **PASS** |
| 23 | baseline moved | §0.10 — source unchanged; personal decode still required | **NOT YET VERIFIED** (yours) |
| 24 | upstream added a consumer (poller) | all consumers go through the one env-configured client; poller no-ops when unconfigured | **PASS** |
| 5 | migration set on branch changed | snapshot must post-date `20260906070000` | **NOT YET TESTED** (unchanged) |

### 0.14 Final branch diff vs `origin/main-autodeploy` (post-merge)

Backend: 65 files (45 added, 20 modified). Every modified file is Stage 0A
or the merge resolution of an upstream file; every added file is Stage 0A
code / migration / script / test, the new `usecase/passwordReset.stage0a.test.js`,
or one of the four documentation-only files that predate Stage 0A. **Zero**
payroll, attendance, shift, Digisme-removal or `employee_id` changes;
`new_employee` untouched; `services/synker.js` not in the diff.
Frontend: 9 files, all Stage 0A (`helper/login.js`, `helper/user.js`,
`pages/login.js`, `pages/change-password.js`, `pages/setup-password.js`,
`util/api.js`, `components/header/header.js`,
`components/ChangePassword/index.jsx`, `pages/_app.js`); upstream's
`ForgotPassword` / `TelegramLink` components are identical to production.

---

## 1. Gate table

| # | Gate | Status | Evidence / what is missing |
| --- | --- | --- | --- |
| 1 | Legacy JWT compatibility | **PASS** (re-earned post-merge, §0.13) | `middlewares/auth.compat.test.js` tests 1–6; `middlewares/legacy_transition.test.js` (token minted by the actual `origin/main-autodeploy` code). Design in implementation doc §7a. |
| 2 | Legacy token cannot resolve system account | **PASS** (re-earned post-merge) | `auth.compat.test.js` test 7 (shape, claim and database refusals, with and without the DB check); `legacy_transition.test.js` case 9. |
| 3 | Stage-0A-only branch diff | **PASS** (re-diffed after the merge, §0.14) | Backend: 65 files vs `origin/main-autodeploy`; **zero** payroll/HR/attendance/shift/Digisme *code*. The four documentation-only files (`docs/hr-schema.md`, `docs/payroll-target-architecture.md`, `docs/payroll-integration-proposal.md`, `docs/authentication-decoupling-audit.md`) remain the accepted exception. Frontend: 9 files, all Stage 0A. |
| 4 | Deployment workflow / failure semantics reviewed | **WAITING FOR ADMINISTRATOR** | The GitHub Actions workflows in both repositories are fully analysed (§3). Not verifiable from a checkout: whether anything *outside* the repositories also reacts to `main-autodeploy` (GitHub repository webhooks, self-hosted runners, a second CI). Absence in the checkout is not evidence. **Plus a separate HARD GATE**: a migration failure leaves the old process running on a partially migrated schema; a later manual `pm2 reload` would start new code against it. Safer sequence proposed in §3.4 — must be adopted before GO. |
| 5 | End-to-end restore rehearsal, recent snapshot | **NOT YET TESTED** | No database exists in this environment (no MySQL, no Docker daemon). Runbook and recording template in §5. |
| 6 | Telegram token rotated | **WAITING FOR ADMINISTRATOR** | Code side done: the committed token is **removed from source**; `services/telegram.js` reads `TELEGRAM_BOT_TOKEN` only and disables itself with a logged error when absent. Revocation via BotFather, the new token in `.env`, a normal-notification receipt and the break-glass alert test are administrator actions (§6). |
| 7 | Break-glass route-level protection | **PASS** (re-earned post-merge; now covers `forgot-password`, `reset-password`, `telegram-link`) | `routes/user.protection.test.js`: real Express, real auth + permissions middleware, authenticated as a normal `user_type 2` admin; every existing mutation refused with `403 SYSTEM_ACCOUNT`; every mutation the brief lists that does not exist proven to have no route; router surface enumerated exactly; system row byte-for-byte unchanged. |
| 8 | Frontend production build | **PASS** | `npm install --force` (as the workflow does) then `next build` with `--openssl-legacy-provider`: exit 0, "Compiled successfully", 153 pages, `/login`, `/change-password`, `/setup-password` present. Warnings: pre-existing `moment` deprecation notices during static generation, none from the auth pages. Built bundle: **zero** occurrences of `user/login?username`; `post("/user/login",{username,password})` present. |
| 9 | Frontend/backend staging login | **NOT YET TESTED** | No staging backend with a database can run here. HTTP-level equivalents pass (`routes/user.login.test.js`, in-memory repository), which is not the same thing. |
| 10 | Legacy-token staging transition | **NOT YET TESTED (staging)** — isolated equivalent **PASS** | `legacy_transition.test.js` executes the real old `usecase/user.js` + `services/jwt.js` from `origin/main-autodeploy` to mint the token, then the real new middleware in Express, with the A.employee_id = B.user_id fixture and a system account. All nine steps of item 6 covered at code level. A run against a real staging database with a real browser has not happened. |
| 11 | NULL-password fail-closed | **PASS** (re-earned post-merge) | `services/password.nullable.test.js`: every listed input against `password NULL + hash NULL` (sha1 and scrypt algo, and empty string), end to end through `login`, and hash-only accounts accepting only the exact password. |
| 12 | trust proxy / spoofing validation | **PASS (code)** — nginx overwrite confirmation carried into gate 17 | `trust proxy` changed from blanket `true` to `loopback` default, `true` refused; `transportSecure` reads `req.secure` only. `routes/proxy.test.js`: forged `X-Forwarded-For` and `X-Forwarded-Proto` from an untrusted peer ignored, HTTPS gate not bypassable, IP allow-list not satisfiable by a forged header, multi-hop resolves to the proxy-added address. The live nginx vhost must be confirmed to *overwrite* both headers (§7). |
| 13 | Default-password scan on restored snapshot | **NOT YET TESTED** | Requires gate 5's restored database. Script ready (`scripts/auth/default-password-scan.sql`), read-only, outputs categories only. |
| 14 | Account-integrity scan on restored snapshot | **NOT YET TESTED** | Requires gate 5. Script ready (`scripts/auth/account-integrity-audit.sql`). |
| 15 | Feature flags startup-stable | **PASS** | All flags read once in `config/auth.js` at module load; `TRUST_PROXY` once in `server.js`; `TELEGRAM_BOT_TOKEN` once in `services/telegram.js`. No per-request `process.env` read in the auth path (grep-verified). Table in implementation doc §20b. |
| 16 | Absent-flag defaults reviewed | **PASS** | Every default is the Deployment A posture and is intentional; two are called out: absent `AUTH_LEGACY_QUERY_LOGIN` **keeps the fallback ON**; absent `AUTH_TOKEN_VALID_FROM_ENABLED` means **revocation is INACTIVE**. Implementation doc §20b. |
| 17 | External JWT loading verified using CURRENT key | **WAITING FOR ADMINISTRATOR** | Mechanism proven in tests via env-pointed files (`middlewares/auth.test.js`, `auth.compat.test.js` set `JWT_PRIVATE_KEY_PATH`/`JWT_PUBLIC_KEYS`). Not run on the server with the production key material. Procedure: implementation doc §22 step 1. |
| 18 | Break-glass login verified | **NOT YET TESTED** | Needs a database. Script ready (`scripts/auth/break-glass.js`). Usecase/route behaviour covered by tests 24–29 and gate 7. |
| 19 | Break-glass Telegram alert verified | **NOT YET TESTED** | Depends on gates 6 and 18. Alert path covered by test 45 with a fake transport. |
| 20 | All required auth tests: raw green evidence + named mappings | **PASS** (re-earned post-merge) | §0.12: 407 tests / 406 pass / 0 fail / 1 unrelated skip. Named mappings in §4 remain valid; the reset-flow additions are named in §0.4–0.8. |
| 21 | Frontend reproducible build (`npm ci`) | **PASS** | §0.12: `npm ci --legacy-peer-deps` exit 0, lockfile unchanged vs both parents. |
| 22 | Migrations additive, idempotent, reconciled with upstream | **PASS** (re-earned post-merge) | §0.9. |
| 23 | Legacy token shape personally confirmed (local decode) | **NOT YET VERIFIED** — yours | §0.10: source re-read from the new baseline, unchanged. |
| 24 | Telegram consumers all via the env-configured client | **PASS** | §0.6, §0.13. |

---

## 2. Branch audit (gate 3)

### Backend — `dailyneeds-store-backend`, 58 files vs `origin/main-autodeploy` *(pre-merge; post-merge classification in §0.14)*

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

### Frontend — `dailyneeds-store`, 9 files vs `origin/main-autodeploy` *(unchanged by the merge)*

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
