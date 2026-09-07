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
12–14, 17–19, 23) are still open. **Update 06-09-2026 (later):** the Telegram move is done in production
(§0.6.1) — new bot, `.env` token, old webhook gone — but the old token
remains valid because its BotFather account is not ours; gate 6 is
PARTIAL. The reset-architecture decision is recorded in §0.7. Next gate
to work: **5** (backup + isolated restore rehearsal), prepared in §5.

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

#### 0.6.1 Production outcome (06-09-2026, performed by the administrator, recorded here)

Facts as reported after the manual production work; nothing below was done
from this environment.

| # | Fact |
| --- | --- |
| 1 | Production `.env` and the PM2 environment had **no** `TELEGRAM_BOT_TOKEN`; the deployed backend was running on the **compiled fallback token**. |
| 2 | Old bot: `@dailyneeds_test_bot`. It had an active webhook at `https://bot.dnds.co.in/src/core/bot.php` (Hostinger, `46.17.172.95`), so production's `getUpdates` poller had been failing with 409 and `/start` link messages were going to the PHP application. |
| 3 | A **new bot** was created: `@DailyNeedsBot`. Token validated with `getMe`; `getWebhookInfo` shows no webhook. |
| 4 | New bot added to the live groups: DN Accounts, Dn Daily Sales, Dn Stock Check, Dn Offer. **Purchase Notification is intentionally not used** — `PURCHASE_TELEGRAM_CHAT_ID` in `constants/telegram.js` therefore points at a group the new bot is not in; purchase / purchase-order notifications will fail with a logged `SERVICE.TELEGRAM.SEND-MESSAGE` error until that constant is retired or the bot is added. Accepted, not a Stage 0A change. |
| 5 | The new token was written to the production Lightsail backend `.env` (previous `.env` backed up first); `pm2 reload 0` succeeded and the process stayed online. |
| 6 | `getUpdates` polling confirmed on the new bot: no webhook, pending updates 10 → 0, no 409 after the switch. |
| 7 | A test message through the production `.env` token was received in Dn Daily Sales from the new bot. |
| 8 | Old bot: webhook **deleted**, bot removed from every Daily Needs group, final `getWebhookInfo` = none. |
| 9 | **The old bot's BotFather account is not under our control.** The old token has **not** been revoked and the old bot has not been deleted. |

**Security consequence — recorded precisely.** The old token is *still
cryptographically valid*. It no longer reaches any of our groups and has no
webhook, but whoever holds it can still call the Bot API as
`@dailyneeds_test_bot` (including `sendMessage` to any chat id it once saw,
and `getUpdates` for anyone who still messages that bot). Two things
follow:

1. Stage 0A **must** ship with the compiled fallback removed and the
   service failing closed when `TELEGRAM_BOT_TOKEN` is absent — which the
   merged branch does (`services/telegram.js`: `BOT_TOKEN =
   process.env.TELEGRAM_BOT_TOKEN || null`, no literal, every call rejects
   with `NOT_CONFIGURED`, poller no-ops). Until Stage 0A deploys, the
   deployed source still *contains* the old literal; it is inert only
   because the `.env` value now takes precedence.
2. Gate 6 is **not** "token revoked". It is "production moved to a new bot;
   old token still valid, revocation blocked on BotFather ownership".

Outstanding on the old bot, for whoever gains BotFather access: `/revoke`
(or `/deletebot`). Until then, employees who still have a chat with
`@dailyneeds_test_bot` should be told it is retired.

**Not yet verified with the new bot:** employee `/start` linking end to end,
and a full forgot-password → code → reset cycle. Deferred to staging /
production verification (gates 9, 10, 19A).

### 0.7 Two reset systems — reconciliation PROPOSAL (not decided, not implemented)

The merged branch carries two mechanisms:

| | Stage 0A admin-issued token | Production Telegram self-service |
| --- | --- | --- |
| Trigger | admin `POST /user/:id/reset-password` or provisioning | employee `POST /user/forgot-password` |
| Proof | single-use hashed token (`user_password_reset`), delivered by the admin out of band | single-use hashed 6-digit code delivered to a Telegram chat the employee linked from a signed-in session |
| Redeem | `POST /user/setup-password` | `POST /user/reset-password` |
| Now shared (this merge) | policy, scrypt, `setModernPassword`, audit, system-account exclusion | same |

**Owner decision (06-09-2026) — recorded:**

- **Keep Telegram self-service reset** for employees.
- **Keep admin-issued secure reset / setup** as the fallback when Telegram
  is unavailable, changed, lost, or incorrectly mapped.
- **Both entry points must use the same Stage 0A password engine**: the
  shared policy (`utils/password_policy.js`), modern hashing
  (`services/password.js`, scrypt, via `setModernPassword`), expiry and
  single-use rules on their proof (setup token / reset code), audit in
  `user_auth_log`, and explicit system-account exclusion.

State on the merged branch: already true for policy, hashing, audit and
system-account exclusion (C1–C3). Expiry and single-use are enforced per
mechanism in their own tables (`user_password_reset` for setup tokens;
`password_reset_codes` for Telegram codes). No employee-facing workflow is
replaced.

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
| 23 | baseline moved | §0.10 — source unchanged; personal decode done 07-09-2026 | **PASS** |
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
| 6 | Telegram token rotated | **PARTIAL — WAITING FOR ADMINISTRATOR (BotFather owner)** | §0.6.1: production moved to a **new bot** (`@DailyNeedsBot`) via `.env` on 06-09-2026; sending and polling verified; old bot stripped of webhook and groups. **Old token NOT revoked** (BotFather account not under our control) — it remains cryptographically valid. Compiled fallback removal (fail closed) is on the branch and ships with Deployment A. Break-glass alert on the new bot still untested (gate 19). |
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
| 23 | Legacy token shape personally confirmed (local decode) | **PASS** 07-09-2026 — real production token: `alg=RS256`, fields `id,store_id,designation_id,employee_id,user_type,iat,exp`, no `sub`/`auth_ver`/`kid` | §0.10: source re-read from the new baseline, unchanged. |
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

## 5. Backup and isolated restore rehearsal (gate 5) — AWS RDS procedure

Revised 06-09-2026 after the production inspection. Nothing in this section
has been executed; every command below is for the administrator to run
from the Lightsail host.

### 5.1 The real production database (do not trust the config label)

| Fact | Value |
| --- | --- |
| Backend process | PM2 id 0, **`NODE_ENV` unset** → `server.js` selects `config.db.mysql["development"]` |
| What that block actually is | the **live production database**: `dnds_prod` on **AWS RDS**, MySQL **8.4.9**, port 3306, private address `172.26.6.56`, ≈723.6 MB |
| Lightsail host | ≈28 GB free disk; `/usr/bin/mysqldump` is **MariaDB 10.5.25**, not MySQL |
| Known backups | **none** in either repository; RDS automated backups / manual snapshots unknown — check the RDS console and record what exists |
| `.env` backup of 06-09-2026 | configuration only; not a database backup |

Every tool in `scripts/auth/` now reads the connection from that same
`config.json` block through `scripts/auth/db-defaults-file.js`, which prints
`env=development (NOTE: this block is the LIVE database …)` so the misleading
label is visible every time. The previous version of
`backup-user-tables.sh` assumed a local socket and would have failed
outright on this host.

### 5.2 Client compatibility decision

**Do not use the MariaDB 10.5 `mysqldump` for the artefact production will
be restored from.** Use the official **MySQL 8.4 client**, same major as
the server. Reasons, in order of weight:

1. The dump is the only rollback for Deployment A. A cross-vendor client
   against a newer server is an untested combination for exactly the file
   we cannot afford to find broken at 02:00.
2. MariaDB 10.5's `mysqldump` predates MySQL 8 features it may encounter
   via `SHOW CREATE TABLE` (expression defaults, functional indexes,
   invisible columns, `utf8mb4_0900_*` collations, `CHECK` syntax
   differences). It passes DDL through verbatim, so most of it *probably*
   restores on the same 8.4 server, but "probably" is not a gate.
3. It has no `--set-gtid-purged`, wraps output in MariaDB-specific
   `/*M!…*/` conditionals, and authenticates to MySQL 8.4's default
   `caching_sha2_password` only via its own connector path — each a
   place to fail silently or partially.
4. The MySQL 8.4 client is a 30 MB tarball into the home directory; no
   system package changes, no conflict with the MariaDB package.

The scripts refuse a MariaDB client unless `ALLOW_MARIADB_CLIENT=1` is set
explicitly; that escape hatch exists only for a diagnostic dump, never for
the deployment-night backup.

**Installing the MySQL 8.4 client (home directory, no root):**

```bash
ldd --version | head -1                      # glibc ≥ 2.28 → glibc2.28 build; 2.17–2.27 → glibc2.17 build
cd ~ && mkdir -p mysql84-dl && cd mysql84-dl
# Download "mysql-8.4.<x>-linux-glibc2.28-x86_64-minimal.tar.xz" (Linux - Generic, "minimal") from
# https://dev.mysql.com/downloads/mysql/8.4.html and the SHA-256 shown on that page, then:
sha256sum mysql-8.4.*-linux-glibc2.28-x86_64-minimal.tar.xz     # must equal the published checksum
tar -xJf mysql-8.4.*-linux-glibc2.28-x86_64-minimal.tar.xz
mv mysql-8.4.*-linux-glibc2.28-x86_64-minimal ~/mysql84
~/mysql84/bin/mysql --version && ~/mysql84/bin/mysqldump --version   # both "Ver 8.4.x"
```

(If the RDS parameter group forces TLS, add `ssl-mode=REQUIRED` under
`[client]` in the defaults file; RDS' CA bundle is only needed for
`VERIFY_CA`, which is not required for this rehearsal.)

### 5.3 Isolated restore target

**A scratch schema `dnds_rehearsal` on the same RDS instance.** Same
server version, dump never leaves the VPC, and the application can be
pointed at it by changing only the database name. The scripts refuse any
scratch name that equals the live name, contains `prod`, or lacks
`rehearsal`/`scratch`/`restore_test`; the dump is taken without
`--databases`, so it carries no `USE dnds_prod` and cannot select the live
schema by itself.

**Privilege check (requirement 13):** the app user may lack global
`CREATE`. `restore-rehearsal.sh` checks `SHOW GRANTS`; if `CREATE ON *.*` is
absent it requires a second defaults file for an admin identity (the RDS
master user or a dedicated rehearsal role), uses it **only** to `CREATE
DATABASE dnds_rehearsal` and `GRANT ALL ON dnds_rehearsal.*` to the app
user, and does everything else as the app user. Nothing about the live
schema's grants changes.

Restore-time obstacles handled by the script: `DEFINER=` clauses are
stripped (RDS refuses foreign definers without SUPER); the events section
is dropped by default so a restored copy never schedules work on the shared
instance; `log_bin_trust_function_creators=0` with binlog on is detected
and reported (it blocks `CREATE FUNCTION`/`TRIGGER` and needs a parameter
group change by the administrator if it bites).

### 5.4 Operator sequence (Lightsail, as `ec2-user`) — ONE script, tested end to end

The whole rehearsal is `scripts/auth/gate5-rehearsal.sh`, which runs the
four tools in order and stops on the first failure. It was executed
end-to-end in the development environment against a real MySQL 8 server
(binary logging on, `log_bin_trust_function_creators=0`, a least-privilege
app user without `CREATE DATABASE`, `caching_sha2`/native auth, routines,
triggers, an event, a view, 20 000 rows with blobs and quotes): every step
passed, the refusal guards refused, a tampered manifest was caught, the
binlog showed **zero write events on the source schema** across eight runs,
and no credential string appeared in any log or artefact. Findings from
those runs (`--no-tablespaces`, routine visibility, `ERROR 1419`, driver
auth plugin, exact pending-set assertion) are built into the scripts.

```bash
# on Lightsail
cd ~/stage0a-rehearsal
git pull --ff-only origin claude/dnds-payroll-integration-proposal-3p6hen   # picks up the gate 5 tooling

# admin identity for the two things a least-privilege app user cannot do
# (CREATE DATABASE dnds_rehearsal; SHOW CREATE FUNCTION/PROCEDURE for the dump).
# Password at a hidden prompt; written to ~/.stage0a/admin.cnf (600). Never an argument.
node scripts/auth/db-defaults-file.js admin --host <rds-endpoint> --port 3306 --user <rds-master-user>

# the rehearsal (defaults: ~/mysql84/bin client, ~/db-backups output, scratch schema dnds_rehearsal)
STAGE0A_ADMIN_DEFAULTS=~/.stage0a/admin.cnf scripts/auth/gate5-rehearsal.sh
```

**Resuming after the 06-09-2026 false failure:** the dumps stamped
`20260906-174727` are valid; do not start over. That run died before the
manifest was written, so `--skip-backup` now handles a **missing
manifest**: it takes the artefact set from the newest full dump's stamp
(auth, full and counts of the *same* stamp, never mixed; filenames are not
trusted), and rebuilds the manifest only after independent re-verification
— gzip integrity of both archives, the `Dump completed` trailer on both,
all six auth tables present, the full dump's `CREATE TABLE` count equal to
the live schema's base-table count (read-only `information_schema` query),
no `USE`/`CREATE DATABASE`, the counts file structurally valid (two
tab-separated fields per row, non-empty name, unsigned-integer count, no
duplicates — **no identifier regex**: production has names like
`purchase-2024-2025`) and naming exactly the live base-table set, then
SHA-256 of all three files recorded. Any check
failing stops the run with nothing written. Reproduced locally (manifest
deleted → rebuilt → run completed; truncated archive, foreign table in the
counts file, and a stamp with a missing sibling all refused).

That is all. If the app user turns out to hold global `CREATE` and can
read every routine, the admin file is simply not used. If you have no
admin identity at all, run without `STAGE0A_ADMIN_DEFAULTS`: the script
stops at the exact point one is required and says why.

What the one command does, in order (each step is also runnable alone):

| Step | Script | Writes to |
| --- | --- | --- |
| 1 | `db-defaults-file.js app` — reads `config.db.mysql["development"]` (the live block), writes `~/.stage0a/app.cnf` (600) | home dir only |
| 2 | `backup-user-tables.sh` — preflight (versions, grants, routine readability, server settings, counts of tables/views/routines/triggers/events, disk), exact row count of every base table, auth-table dump, full dump (`--single-transaction --quick --no-tablespaces --set-gtid-purged=OFF`, no `--databases`), verification (gzip, `Dump completed` trailer, `CREATE TABLE` count = base tables, routine count, no `USE`), sha256 manifest | `~/db-backups` only; **reads** the live schema |
| 3 | `sha256sum -c --strict` of every artefact against the manifest | nothing |
| 4 | `restore-rehearsal.sh` — refuses any non-scratch name; creates `dnds_rehearsal` (admin identity only if needed, then `GRANT ALL ON dnds_rehearsal.*` to the app user); strips `DEFINER`; drops the events section; if binlog is on and `log_bin_trust_function_creators=0` restores tables+data only and says so; timed restore; every table's count compared to step 2 (0 mismatches or FAIL); schema/migration-head/Telegram-table/`user`-shape/orphan/duplicate queries; `CHECK TABLE` | `dnds_rehearsal` only |
| 5 | `migration-rehearsal.sh` — writes a 600 `database.rehearsal.json` (deleted on exit), proves the `mysql` driver connects, asserts the **pending set is exactly the four Stage 0A migrations**, `up` (timed) → columns/tables present, row counts unchanged, `all_permissions` +3 exactly → second `up` is a no-op → `down ×4` (timed) → `user` columns, types, nullability, defaults and indexes byte-for-byte as before, Stage 0A tables gone, counts as before → `up` again | `dnds_rehearsal` only |

Everything is tee'd to `~/db-backups/gate5-<stamp>.log` (600).

### 5.5 What successful output looks like

Abridged from the tested run; your numbers will differ (≈724 MB: expect
the full dump and the restore to take minutes each, not seconds).

```
==================== GATE 5 REHEARSAL 2026…  (checkout <sha>, log /home/ec2-user/db-backups/gate5-….log) ====
client: mysqldump  Ver 8.4.11 for Linux on x86_64 (MySQL Community Server - GPL)

==================== 1/5 defaults file … ====================
env=development (NOTE: this block is the LIVE database in this deployment — NODE_ENV is unset on the server)
host=<rds endpoint>   port=3306   user=<app user>   database=dnds_prod
defaults file written: /home/ec2-user/.stage0a/app.cnf (mode 600; password not shown)

==================== 2/5 backup … ====================
server: 8.4.9   client: mysqldump  Ver 8.4.11 …
GRANT … ON `dnds_prod`.* TO `<app user>`@`%`
dump identity: <master user>@% (admin defaults)
tables=N views=… routines=… triggers=… events=… size_mb=723.6 last_migration=/20260906070000-telegram-password-reset
routines: all R readable by the dump identity
disk: free 28xxxMB, need ~2683MB
== exact row counts -> …/dnds_prod-counts-<stamp>.tsv ==
migrations  <n>   new_employee  <n>   permissions  <n>   user  <n>
full dump took <seconds>s
  ok: …-auth-<stamp>.sql.gz (…) ends cleanly
  ok: …-full-<stamp>.sql.gz (…) ends cleanly
  ok: N CREATE TABLE statements = N base tables
  ok: R routine definitions present
  ok: auth dump has all 6 tables
== manifest == … sha256 lines …   routines_included=yes

==================== 3/5 checksum re-verification … ====================
…-auth-<stamp>.sql.gz: OK     …-full-<stamp>.sql.gz: OK     …-counts-<stamp>.tsv: OK

==================== 4/5 isolated restore into 'dnds_rehearsal' … ====================
== target: scratch schema 'dnds_rehearsal' on <host> 8.4.9 (live schema is 'dnds_prod', untouched) ==
app user <app user>@% has NO global CREATE (expected on a least-privilege RDS user)
created dnds_rehearsal with admin; granted ALL on dnds_rehearsal.* to <app user>@%
WARNING: log_bin=1 and log_bin_trust_function_creators=0 — … routine/trigger/event blocks are skipped and this is recorded …   ← expected on RDS defaults
restore took <seconds>s
checked N tables, 0 mismatches
base_tables N / views … / routines 0 / triggers 0 / events 0        ← 0s only because of the WARNING above
/20260906070000-telegram-password-reset  <run_on>
password_reset_codes  telegram_link_tokens  telegram_links
user_id username employee_id password user_type status allowed_ips ip_policy      ← no Stage 0A columns yet
users_total <n> / users_with_password <n> / users_active <n> / logins_without_employee_row <n> / duplicate_usernames <n> / duplicate_employee_ids <n>
dnds_rehearsal.user check status OK   (×4)
RESTORE OK: schema=dnds_rehearsal seconds=<s> tables_checked=N mismatches=0 routines_triggers_restored=NO (log_bin_trust_function_creators=0)

==================== 5/5 Stage 0A migrations on 'dnds_rehearsal' only … ====================
db-migrate: /usr/…/db-migrate (0.11.x)
driver connect ok, database=dnds_rehearsal
== before: user=<n> new_employee=<n> permissions=<n> all_permissions=<a> migrations=<m>
user.password before: text NOT NULL   (migration assumes TEXT NOT NULL)
-- pending migrations … must be exactly the four Stage 0A ones:
   20260906120000-auth-stage0a-user-columns
   20260906120100-auth-stage0a-auth-log
   20260906120200-auth-stage0a-password-reset
   20260906120300-auth-stage0a-permissions
== UP (timed) ==  …  up took <s>s
all four Stage 0A migrations recorded
user columns after up: …,password,password_hash,password_algo,…,is_system_account,credential_rotated_at,…
auth_metric  user_auth_log  user_password_reset
after up: user=<n> new_employee=<n> permissions=<n> all_permissions=<a+3> migrations=<m+4>
users_with_legacy_password <n>   password_algo_sha1 <n>       ← equal to each other and to users_with_password
== idempotency … ==  [INFO] No migrations to run
== DOWN x4 (timed) ==  …  down took <s>s
user table restored to its original column set, definitions and indexes
after down: user=<n> new_employee=<n> permissions=<n> all_permissions=<a> migrations=<m>
Stage 0A tables removed by down
== UP again … ==
MIGRATION REHEARSAL OK on dnds_rehearsal. …

==================== GATE 5 REHEARSAL COMPLETE in <s>s ====================
```

Any line beginning `FAIL:` ends the run with a non-zero exit; nothing
after it ran. The three most likely on RDS and what they mean:

| Line | Meaning / action |
| --- | --- |
| `FAIL: … stored routines cannot be read by the dump identity` | run with `STAGE0A_ADMIN_DEFAULTS` (master user), or `SKIP_ROUTINES=1` to accept a dump without them (recorded) |
| `FAIL: set STAGE0A_ADMIN_DEFAULTS … so the scratch schema can be created` | app user lacks `CREATE`; provide the admin file |
| `WARNING: log_bin=1 and log_bin_trust_function_creators=0` (not a FAIL) | RDS default. Tables + data rehearsed; to rehearse routines/triggers too, set that parameter to 1 in the RDS parameter group (dynamic) and re-run with `REQUIRE_ROUTINES=1 … --skip-backup` |

**Routines / triggers on RDS:** the deployed application's own behaviour
does not depend on any stored routine being restorable (the Stage 0A
migrations create none), so the WARNING path still satisfies gate 5 for
Deployment A. It is recorded in the manifest and the log.

### 5.6 Rollback / cleanup

The rehearsal changes nothing live (binlog-verified in test: zero write
events on the source schema). Afterwards:

```bash
~/mysql84/bin/mysql --defaults-extra-file=~/.stage0a/app.cnf -e 'DROP DATABASE `dnds_rehearsal`'   # when gates 13/14 and staging are done with it
rm -f ~/.stage0a/admin.cnf                                                                     # admin credential gone
# keep ~/db-backups/* (600) and ~/.stage0a/app.cnf until Deployment A + 7 days, then: shred -u ~/db-backups/* ~/.stage0a/app.cnf
```

A failed run needs no repair: re-run the same command (or with
`--skip-backup` to reuse a verified dump). `~/stage0a-rehearsal` can be
deleted at any time; the deployment clone was never touched.

**Deployment night, separately:** take a manual RDS snapshot immediately
before `db-migrate up` (fastest physical rollback); the logical dump from
this gate is what allows the auth tables to be restored *in place*.

### 5.7 Gate 5 PASS criteria

1. `GATE 5 REHEARSAL COMPLETE` with no `FAIL:` line; log and manifest kept.
2. Client `8.4.x` against server `8.4.9`; dump identity and `routines_included` recorded in the manifest.
3. Backup stamp recorded; at deployment ≤ 24 h old (else re-run step 2 only) and `last_migration=/20260906070000-telegram-password-reset`.
4. `checked N tables, 0 mismatches`; `CHECK TABLE` OK; Telegram tables present; `user` without Stage 0A columns before migration.
5. `restore took <s>` recorded — this is the rollback budget on the night.
6. Pending set exactly the four Stage 0A migrations; `up` clean; second `up` "No migrations to run"; `down ×4` restores the `user` definition and indexes exactly and removes the three tables; counts unchanged.
7. Live schema untouched: `SHOW GRANTS` and the `migrations` head on `dnds_prod` identical before and after.
8. No credential printed or on a command line; only `~/.stage0a/*.cnf` (600) hold them; `database.rehearsal.json` removed by the script.

### 5.9 Gates 13 and 14 on the rehearsal copy (procedure and reading guide)

**Result of gate 5 on production data (06-09-2026):** restore 143 s, 144
tables, 0 mismatches, four migrations up / no-op / down×4 / up clean, 184 s
total — **PASS**. `dnds_rehearsal` is left in the post-Stage-0A state.

**One command** (from `~/stage0a-rehearsal`, after `git pull --ff-only`):

```bash
MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/gate13-14-scans.sh dnds_rehearsal
```

It refuses any non-scratch name and the live schema, checks the copy is
post-Stage-0A, statically verifies each SQL file neither selects a password
column nor contains a write statement, then runs read-only:
`default-password-scan.sql` (gate 13), `account-integrity-audit.sql` and
`duplicate-employee-diagnosis.sql` (gate 14), plus one headline line per
gate. The report goes to `~/db-backups/gate13-14-<stamp>.txt` (600); it
holds account identifiers and categories only, never a password or hash
(tested locally: zero 40-hex or scrypt strings in the report). Destroy it
once the gate is recorded.

**What to send back:** the two `headline` lines, the gate-13 per-branch
summary table, and the duplicate-diagnosis rows (sections A–D). The full
per-account list stays on the host.

**Reading the duplicate `employee_id` (gate 14).** Facts established from
the code, before the data is seen:

- Authentication identity is the **`user_id`** (`sub` on v2 tokens, `id`
  on legacy tokens); `employee_id` is cross-checked against *that* user row
  (`middlewares/auth.js#resolveIdentity`). Two login rows on one employee
  therefore cannot resolve to the wrong account and cannot cross into
  another employee's session. **It is not a token-identity risk.**
- Permissions are keyed by the employee's `designation_id`, so both rows
  hold exactly the same permission set; the only privilege difference
  possible is `user_type` (2 = bypasses permission checks) — section D
  shows the highest `user_type` among the rows.
- The Digisme sync cannot have created it: `createLoginIfNeeded` guards on
  `WHERE NOT EXISTS (… employee_id = ?)`. It came from the manual
  `POST /employee` path (`createLogin`, unguarded) or a direct database
  edit — i.e. a second credential was deliberately or accidentally issued
  for one person.
- Stage 0A adds only non-unique indexes on `user.employee_id`; the UNIQUE
  key planned for later (Stage 0.10) would be blocked by this row until
  it is resolved.

Classification from section B, one row per login:

| Pattern seen | Reading | Action (after Deployment A, via the admin reset flow — never by editing production data now) |
| --- | --- | --- |
| both rows `status = 1`, different `username_convention` (one `employee_id_style`, one `mobile_style` / `text`) | the person was re-provisioned under a second username; both doors work | disable the row not in use (the one without `telegram_linked`, or the older `user_id` if neither), keep one |
| one row on `provisioning_default_employee_id_suffix`, `siblings_with_identical_password = 0` | the unused door is still on the default password — this is the actual exposure | that row goes into the first forced-reset batch or is disabled |
| `siblings_with_identical_password = 1` | same person, same password set twice | disable one |
| section C non-empty | a username of this employee equals another employee's code or mobile | **cross-identity** — treat as a real risk, resolve before Deployment A |
| `highest_user_type_among_rows = 2` while the other row is `1` | a duplicate carries admin bypass | disable the `user_type 2` duplicate first |
| one row `status = 0` | historical, already closed | no action; note for the UNIQUE-key cleanup |

Verdict rule: **legitimate historical condition** if section C is empty,
`highest_user_type_among_rows` matches the employee's normal role, and at
most one row is active or in use; **authentication identity risk** only if
section C is non-empty or a `user_type 2` duplicate exists on a non-admin
employee. Either way it must be resolved before the UNIQUE key, not before
Deployment A.

### 5.10 Gates 13 and 14 — production results, code investigation, verdicts (06-09-2026)

**Gate 13 result (production data, `dnds_rehearsal`):** 471 active SHA-1
accounts; **468 on the provisioning default `<employee_id>@123`**; 0
`user_type 2` accounts on any known default.

*How Stage 0A handles them.* Until this change, Stage 0A upgraded a proven
legacy password to scrypt on login (`AUTH_HASH_ON_LOGIN`, Deployment B)
but deliberately did **not** judge it; the plan relied on running
`flag-default-passwords.sql` per branch by hand. That would have meant
flagging 468 accounts through manual batches. Replaced by **login-time
detection** (`usecase/user.js`, `AUTH_FLAG_WEAK_ON_LOGIN`, default on):
after the password is verified, and only then, it is run through the
shared policy (`<employee_id>@123`, username, mobile, historical defaults,
too short, too common). A failing verdict sets
`must_change_password = 1, password_flag_reason = 'weak_at_login'` and
audits `password_flagged` with a category only. Nothing is reset, nothing
is stored or logged, a flagging failure cannot fail a correct login, an
already-flagged account is left alone, the system account is exempt, and a
*wrong* password is never evaluated. Effect per deployment:

| Deployment | What the 468 experience |
| --- | --- |
| A (flag on, enforcement off) | log in as today; the row is flagged silently; `must_change_password: true` is returned in the login response (frontend already shows the forced-change screen when it is set — `pages/_app.js`); token carries no `pwc`, nothing is confined |
| B (`AUTH_ENFORCE_PASSWORD_CHANGE=true`) | next login confined to change-password until a policy-compliant password is set; the new password is scrypt |
| Also with `AUTH_HASH_ON_LOGIN` | the default is re-hashed to scrypt *and* flagged in the same login |

Tests: `usecase/user.login.test.js` "gate 13" (12 cases: five categories
flagged with login still 200, strong not flagged, idempotent, `pwc` only
with enforcement, flag+hash together, flagging failure harmless, wrong
password never judged, system account exempt, flag off = no-op).
`flag-default-passwords.sql` stays as an optional accelerator for accounts
that never log in.

**Gate 14 result:** one duplicated `employee_id` (1: `user_id 1`
`9943800000` and `user_id 198` `purchase_api`, both `user_type 2`, both
active); `active login on inactive employee = 249`; no duplicate
usernames; no orphans reported.

*`purchase_api`.* The string appears **nowhere** in either repository —
code, docs, migrations, any branch, any commit. What the code does show:
`POST /tally/gst-purchase` is a token-protected endpoint documented for an
external Tally integration (`docs/gst-tally-purchase-api.md`:
"DailyNeeds will issue a dedicated token … does not expire"), and the
application's own login issues 1-day tokens. So `purchase_api` is the
account that non-expiring integration token was minted from (with a
private key that was, until Stage 0A, committed to git) — a **service
account** created by hand, attached to employee 1 because `user.employee_id`
had to point somewhere. Nothing logs in as it; the integration presents
the pre-minted legacy token. Consequences:

- Through Deployment A it keeps working: the legacy path resolves
  `id=198`, checks the row is active, employee-linked (1) and, now, that
  employee 1 is active. `user_type 2` bypasses permission checks.
- Reclassifying it as a Stage 0A *system* account (`employee_id NULL`,
  `is_system_account = 1`) would **break the integration**: legacy tokens
  are refused for system accounts by design, and system-account logins
  raise break-glass alerts. Do not do that.
- The right separation, **without touching `employee_id`**, is a distinct
  service-account kind (Stage 0B): a row with its own long-lived token
  (issued by a script under `scripts/auth/`, `sub = 198`, no
  `employee_id` claim), no login, no permission bypass beyond the tally
  route, and `user.employee_id` set NULL only once the integration holds
  the new token. Until then: leave the row as is; after Deployment A,
  re-mint its token under the externalised key and retire the old one
  (`token_valid_from` on user 198 once `AUTH_TOKEN_VALID_FROM_ENABLED`).
- Its password is not a known default (gate 13 headline). Its risk today
  is the non-expiring token minted with a key that was in git — which is
  the JWT-rotation item already on the ledger, not a data change.

*249 active logins on inactive employees.* Can they authenticate today?
**No.** The deployed login query is `WHERE u.status = 1 AND ne.status = 1
…`, so an inactive employee cannot obtain a token; Stage 0A's usecase
refuses the same case explicitly (`login_inactive;employee_inactive`).
What neither did: refuse a token that was **already issued** before the
employee was deactivated (up to 1 day), and Digisme's nightly sync flips
`new_employee.status` without touching `user.status`, which is why the
249 rows exist. Smallest fix, now on the branch
(`middlewares/auth.js`, `AUTH_EMPLOYEE_STATUS_CHECK`, default on): every
request from an employee-linked account is checked against
`new_employee.status` through the existing cached session-state lookup
(`getSessionState` now joins the employee; cache = `tokenValidFromCacheMs`,
60 s); a departed employee's live session is refused with
`EMPLOYEE_INACTIVE`; system accounts are judged by `user.status` only;
the check fails closed. **Reactivation:** because `user.status` is never
touched, HR setting the employee active again reinstates login and
sessions with no user-row change (tested). The 249 rows therefore need
**no production cleanup for security**; disabling them would in fact
break reactivation. They are listed for the later UNIQUE/hygiene pass.
Tests: `middlewares/auth.test.js` "gate 14" (8 cases).

**Verdicts**

| Gate | Verdict | Basis |
| --- | --- | --- |
| 13 | **PASS (code) — no manual reset required** | 468 defaults are detected and flagged at their next login; enforcement is Deployment B's switch. Production data unchanged. |
| 14 | **PASS (code) — cleanup deferred, not blocking** | inactive employees cannot log in and, with this change, cannot keep a session; the duplicate is a hand-made service account whose only real risk is its legacy non-expiring token (already a ledger item); `purchase_api` must not be reclassified before Stage 0B; no data change before Deployment A. |

### 5.11 Gates 4 and 12 — repository analysis and the one host check

**Gates 13 and 14 recorded PASS at commit `880f4f7`** (no production data
change for the 468 default-password accounts, the 249 inactive-employee
rows, or `purchase_api`).

#### Gate 4 — deployment path (from `.github/workflows/deploy-backend.yml`, identical on `main-autodeploy` and the feature branch)

| Item | Fact from the repository |
| --- | --- |
| Trigger | `push` to `main-autodeploy`, plus manual `workflow_dispatch` |
| Runner → target | GitHub-hosted `ubuntu-latest` → `ssh -i <deploy key> ${SSH_USER}@${SSH_HOST}` (secrets; comments say `ec2-user@3.109.76.230`) |
| Working directory | `~/dailyneeds-store-backend` on the host |
| Sequence (one remote shell, `set -euo pipefail`) | `git fetch origin` → `git checkout -- package-lock.json` → `git checkout main-autodeploy` → `git pull origin main-autodeploy` → `npm i` → `cd migrations/mysql` → **`db-migrate up`** (bare: no `-e`, no `--config`) → `cd ../..` → `pm2 reload 0` |
| Migration failure stops the deploy before reload? | **Yes.** `set -e` in that shell: a non-zero `db-migrate up` ends the SSH session before `pm2 reload 0`. The consequence is the one already recorded as a hard gate: the **old process keeps running on a partially migrated schema** (the Stage 0A `user` migration is one `ALTER TABLE`, so it cannot half-apply; the three `CREATE TABLE IF NOT EXISTS` are each atomic). |
| Which `database.json` env a bare `db-migrate up` uses | db-migrate 0.11: `--config`/`-e` if given; else the file's `default` key; else `defaultEnv`; else the first of `dev`, `development` that exists. `NODE_ENV` is **not** consulted by this version's config loader. The host's `database.json` is git-ignored, so **which key exists is a host fact** — the host script prints the keys (no credentials) and states the resolved env and whether it points at the same host/database as the app's live block. |
| Pending migrations at Deployment A | From the gate 5 rehearsal on production data: the pending set for the feature checkout was **exactly the four Stage 0A migrations**; for the deploy clone it is none. The host script re-derives both from the live `migrations` table (read-only `SELECT`). |
| PM2 target | `pm2 reload 0`: process id 0. Fork mode, single instance (no `instances` in `ecosystem.config.js`), so reload = restart. **Hazard:** `ecosystem.config.js` sets `NODE_ENV=production`, but the running process has it unset; anyone who ever starts the app with `pm2 start ecosystem.config.js` switches it to the `config.json` "production" block, which may still be the stale sample. The host script compares the two blocks' host/database. |
| Server-side hooks | `.git/hooks` in the deploy clone; the script lists any non-sample hook. |
| Outside the repository | GitHub → Settings → Webhooks and Actions → Runners for both repos remain **yours** to confirm (screenshot or "empty"). |

#### Gate 12 — proxy topology (from the code)

- Deployed production: `app.set("trust proxy", true)` — Express believes
  `X-Forwarded-*` from **any** peer. Safe only while the Node port is not
  reachable except through nginx, and nginx **overwrites** the headers.
- Stage 0A: default `loopback` (`TRUST_PROXY=true` refused), so only a
  proxy on the same host is believed; `transportSecure` is `req.secure`
  only; `getClientIp` reads `req.ip` first (the header is a fallback only
  when `req.ip` is empty).
- The upstream `fix-proxy-headers.yml` / `scripts/patch_nginx_forwarded.py`
  sets `X-Real-IP $remote_addr`, `X-Forwarded-For $remote_addr`
  (**overwrite, not append**) and `X-Forwarded-Proto $scheme` in the
  `proxy_pass` location. If that ran, a forged `X-Forwarded-For` from the
  internet is replaced by nginx before the app sees it.
- Rate limiting / IP policy (`utils/ip.js` `isAccessAllowed`, lockout's
  per-IP throttle) key on `getClientIp` → `req.ip`, i.e. the real client
  **iff** nginx sets the header and the trusted-hop rule matches nginx's
  address (loopback). If nginx forwarded from a non-loopback address the
  app would see the proxy's IP for everyone — the host script's probe
  shows which.

#### The one read-only host command

```bash
cd ~/stage0a-rehearsal && git pull --ff-only origin claude/dnds-payroll-integration-proposal-3p6hen && \
MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/gate4-12-host-check.sh
```

Optional: prefix `PROBE_TOKEN=<your own session token>` so the three
`/user/my-ip` probes answer (the deployed route needs a token; Stage 0A
makes it public). The token is sent as a header and never printed. Send
back the whole report (`~/db-backups/gate4-12-<stamp>.txt`); it contains
no secrets.

**Expected / acceptable output**

| Section | PASS looks like |
| --- | --- |
| 4/A | remote is the backend repo, branch `main-autodeploy`, HEAD `9d92884`, `dirty files: 0` (or only `package-lock.json`), `active hooks:` empty, "files only in this checkout" = the four `20260906120000…120300` names |
| 4/B | `db-migrate` on PATH with a version; node/npm present |
| 4/C | `bare db-migrate up resolves to: <env>` and that env line ends `== app 'development' block (the live DB)`; app config `production` block either same as development or flagged DIFFERENT (then: never start via `ecosystem.config.js` until fixed) |
| 4/D | head `/20260906070000-telegram-password-reset`; pending for deploy clone: **empty**; pending for this checkout: **the four Stage 0A migrations** |
| 4/E | one process, `pm_id=0`, `exec_mode=fork_mode`, `instances=1`, `cwd=/home/ec2-user/dailyneeds-store-backend`, `NODE_ENV=(unset)`, `PORT` unset or 8080, `TRUST_PROXY=(unset -> loopback)` |
| 12/A | a `listen 443 ssl` server for `api.dnds.co.in` with `ssl_certificate`, a `listen 80` server that `return 301 https://…`, and inside the API location: `proxy_pass http://127.0.0.1:8080` (or `localhost`), `proxy_set_header X-Forwarded-For $remote_addr`, `X-Forwarded-Proto $scheme`, `X-Real-IP $remote_addr`; `nginx -t` syntax ok |
| 12/B | `:80` and `:443` bound by nginx; `:8080` bound by node — if it shows `0.0.0.0:8080`/`*:8080` the **external probe** below must show it unreachable |
| 12/C | `http://127.0.0.1/` → `HTTP 301 redirect=https://api.dnds.co.in/`; via nginx with forged headers → `"ip":"127.0.0.1"` and `"has_forwarded_header":true` (nginx overwrote); direct to the app with forged headers → `"ip":"203.0.113.9"` (loopback is the trusted hop — by design); direct, no headers → `"ip":"127.0.0.1"` or `::1` |

**External probe (from your laptop, not the host):**

```bash
curl -sI http://api.dnds.co.in/ | head -n 3                                  # expect 301 → https://
curl -s -m 5 http://3.109.76.230:8080/user/my-ip || echo "8080 NOT reachable from the internet (good)"
curl -s https://api.dnds.co.in/user/my-ip -H "x-access-token: <your token>" -H 'X-Forwarded-For: 203.0.113.9'
#   expect "ip" = YOUR public IP, never 203.0.113.9; "has_forwarded_header": true
```

**Port 80 fix (found by the external probe: `http://api.dnds.co.in/` answers 200).**
`scripts/patch_nginx_http_redirect.py` edits only the server block that
serves the API name on :80 (plain `return 301 https://$host$request_uri;`
for an :80-only block; `if ($scheme = http) { return 301 … }` for a
combined :80/:443 block; a new listen-80 file when only a catch-all
answers; no-op when a redirect already exists). The :443 configuration is
never touched. It backs up every edited file, runs `nginx -t`, reloads,
verifies over loopback that :80 answers 301 to the https URL and :443
still answers, and restores + reloads the previous configuration on any
failure. Exercised locally on four nginx layouts (separate blocks,
combined block, Certbot-style already redirecting, catch-all). Run:

```bash
cd ~/stage0a-rehearsal && git pull --ff-only origin claude/dnds-payroll-integration-proposal-3p6hen && \
sudo python3 scripts/patch_nginx_http_redirect.py --dry-run && \
sudo python3 scripts/patch_nginx_http_redirect.py
```

Then from the laptop: `curl -sI http://api.dnds.co.in/ | head -n 3` → `301` with `Location: https://api.dnds.co.in/`.

Gate 12 is PASS when: 443 serves TLS, 80 redirects, nginx overwrites both
headers, 8080 is unreachable from outside, the via-nginx probe shows your
real IP under a forged header, and (after Deployment A) `trust proxy` is
loopback. Gate 4 is PASS when 4/A–4/E match the table and you have
confirmed the GitHub webhook/runner pages.

### 5.12 Remaining pre-deployment gates — what was done (06/07-09-2026)

**Gate 12 recorded PASS** (external check: `http://api.dnds.co.in/` → 301 to https; 8080 unreachable from the internet).

#### Gate 4 — what remains manual, and what the API already proved

| Item | Evidence | Status |
| --- | --- | --- |
| Deployment trigger | `deploy-backend.yml`: push to `main-autodeploy` + manual dispatch (repo, identical on both branches). Run #101 for `9d92884` executed the four expected steps and succeeded. | **PASS** (repository + Actions API) |
| Runners | Every run of the deploy workflow executed on `runner_group_name: GitHub Actions`, labels `ubuntu-latest` (job 101441751149 inspected); all four workflow files in both repos declare `runs-on: ubuntu-latest`. A self-hosted runner, if any is registered, is therefore never used by a deploy. | **PASS** (Actions API) |
| A third backend workflow | The repo's **default branch `master`** carries an older `.github/workflows/deploy.yml` ("Deploy", also `push: branches: [main-autodeploy]`). It is inert for pushes to `main-autodeploy` because GitHub runs the workflow file from the pushed commit, which no longer contains it (its last run was #3 in August; every deploy since is "Deploy Backend" only). It can still be started **manually** from `master` and would run the older deploy script. | **accepted exception** — recommend deleting it from `master` (or disabling it under Actions → Deploy) at any convenient time; not a Deployment A blocker |
| Repository webhooks | Re-checked 07-09-2026 by a read-only `GET /repos/{owner}/{repo}/hooks` for **both** repositories with the same API access that answered the Actions/runner questions: HTTP 403, "Access to this GitHub API path is not permitted through this proxy". The GitHub tool set available here has no webhook operation either. Your own account shows "You don't have access to repository options", so the Settings page is closed to both of us until the repository owner is back. Note: the repository facts already proven bound the risk — the only thing a webhook can *cause* on the deploy path is another run of the workflow file already reviewed; it cannot change what that workflow does or where it runs. | **PASS except Webhooks verification pending repository-admin access** — not a blocker for the remaining work; the owner confirms Settings → Webhooks is empty on both repositories (screenshot or "empty") before deployment night. |
| Host side | `gate4-12-host-check.sh` run by you: deploy clone, toolchain, `database.json` env resolution, pending set, PM2 process 0 | **complete** (your report) |

#### Gates 15 and 16 — feature flags

`config/auth.flags.test.js` loads `config/auth.js` in a child process per
scenario: every flag has its documented default with an empty
environment; the Deployment A posture is exactly {`allowQueryString`
on, `rejectLegacy` off, `enforcePasswordChange` off, lockout off,
`tokenValidFrom` off, `requireKid` off, `requireHttps` off,
`flagWeakOnLogin` on, `employeeStatusCheck` on}; the parser accepts only
the literal strings `true` / `1` as true and treats any other non-empty
value as false (so a typo can only ever turn a flag off — record flags
as the literal `true`/`false`); integers fall back on garbage; values are
read once at load and later environment changes do nothing; a malformed
`JWT_PUBLIC_KEYS` fails startup loudly. `usecase/user.flags.test.js`
then logs a legacy SHA-1 employee on the provisioning default in under
**all 128 combinations** of the seven Deployment-A-legal boolean flags
and proves the only flag that refuses such a login is
`AUTH_REJECT_LEGACY_SHA1` (Deployment B, off), that lockout bites only
after real failures, and that the system account logs in under every
combination. 150 cases, all pass. **Gates 15 and 16: PASS.**

#### Gate 17A — external JWT key (staging)

`scripts/auth/jwt-keys-setup.sh` copies (never moves or rotates) the
current pair from the deploy clone to `~/.stage0a/jwt/` (700/600),
writes `~/.stage0a/jwt.env` (`JWT_PRIVATE_KEY_PATH`, `JWT_PUBLIC_KEYS`,
`JWT_ACTIVE_KID=legacy`), prints only the public key's fingerprint, and
proves: external private → tracked public verifies; tracked private
(legacy-shaped token, no kid) → external public verifies; optionally a
real `PROBE_TOKEN` of your own session verifies with the external public
key (proving production signs with this key — the token is never
printed). The staging instance below runs entirely on the external key
(no "tracked key fallback" warning). Locally verified; on Lightsail it
runs as step 1 of the staging harness. **Gate 17A: PASS in staging once
the harness has run on Lightsail.** Production still uses the tracked
file until Deployment A's environment carries `jwt.env` — no key is
replaced.

#### Gates 9, 10, 18A, 19A — the staging harness

`scripts/auth/staging-rehearsal.sh` (one command) starts the Stage 0A
application **from the rehearsal checkout** on `127.0.0.1:18080` with
`CRON_DISABLED=true` (no Digisme sync, no Telegram poller, no GST or
purchase jobs — every registered job is listed but none scheduled; a
new, production-inert switch in `services/cron_service.js`), the
external key, Deployment A flags, and a `config.json` that is the
production copy with only the main database name replaced by
`dnds_rehearsal` (the original is kept as `config.prod.json` and restored
on exit, also on a crash). It prepares, on the scratch schema only, one
outlet user already on the provisioning default, one admin with a
generated staging password, one inactive-employee login, and the
break-glass account `stage0a_breakglass` (via `break-glass.js` with a
600 password file — a staging-only option; production stays
interactive). Then `staging-checks.js` runs 42 checks over HTTP and the
database, a second instance with `AUTH_ENFORCE_PASSWORD_CHANGE=true`
covers confinement, and everything is torn down (instances identified by
exact process identity: `node`, argv `server.js`, cwd = this checkout —
the production process can never match). No credential or token is
printed; reports are 600.

Verified locally against a MySQL 8 copy shaped like production
(42/42 after the gate 19A fix; 41/41 before). What it proves, per gate:

| Gate | Checks |
| --- | --- |
| 9 | outlet user on the default: 200 + token, `must_change_password:true`, row flagged `weak_at_login`, audit category only, token `auth_ver=2`/`sub`/`employee_id`/no `pwc`; admin strong password: 200, not flagged; wrong password: HTTP 400 "Incorrect credentials" (production shape), audited; inactive employee with the right password: 400, audited `employee_inactive`; protected route with the v2 token: 200 and the audit names the same `user_id` |
| 10 | legacy token `{id, employee_id}` (no sub/kid/auth_ver, signed with the current key): accepted and resolves to the **same user_id**; mismatched `employee_id`: 403; inactive employee, legacy and v2: `EMPLOYEE_INACTIVE`; legacy token naming the break-glass id, with null or a borrowed employee_id: 403; fresh v2 token: `sub` = user_id, `id` agrees, `kid` header present |
| 18A | row `employee_id NULL`, `is_system_account=1`, `password NULL`, scrypt hash; login 200 with `is_system_account:true`, token `sys=true`, no `employee_id` claim, audited; wrong password refused and audited; Telegram forgot-password neutral with **no code row**; Telegram reset refused; admin reset → `403 SYSTEM_ACCOUNT`; admin unlock 403; all three `/telegram-link` methods → `403 EMPLOYEE_REQUIRED`; row unchanged |
| forced change (Deployment B posture) | login still 200; token `pwc=true`; ordinary route → `PASSWORD_CHANGE_REQUIRED`; allow-listed routes answer; change-password reachable and still policy-checked; an unflagged admin is not confined |
| 19A | with the bot token taken from the deploy clone's `.env` (never printed) the break-glass login sends the real `🚨 BREAK-GLASS LOGIN` alert through `services/telegram` (the new bot); the check confirms no send error and no parse-mode rejection was logged and asks you to confirm receipt in Telegram |

**Lightsail result, 07-09-2026 (commit `da4445e`):** gates 9, 10, 17A,
18A PASS and the forced-change checks 6/6. **Gate 19A failed**: the bot
reached Telegram, but Telegram rejected the alert with
`400 Bad Request: can't parse entities: Can't find end of the entity`.
Cause: `services/telegram.js#sendMessage` forced `parseMode: "Markdown"`
after the caller's options, so no caller could opt out, and the alert
body interpolated database text into Markdown. Telegram's legacy Markdown
treats a lone `_` as the start of an italic entity; the literal `user_id`
in the template (outside any code span) and the username
`stage0a_breakglass` both qualify, so the message would have failed for
any break-glass name. The alert was silently lost — the login itself
succeeded, which is the correct precedence, but the one alert the
break-glass design depends on never arrived.

**Fix (smallest safe change):**

- `services/telegram.js`: `parseMode` now defaults to Markdown but an
  explicit `parseMode: null` sends plain text with no parse mode at all.
  No existing caller passes `parseMode`, so every other consumer
  (purchase, stock checker, offers, tickets, password-reset codes) is
  byte-for-byte unchanged.
- `usecase/user.js`: both break-glass alerts (login, failed attempt) are
  plain text, no formatting characters, `parseMode: null`; `username`,
  `user_id` and IP go through `alertField()` (control characters and
  newlines collapsed, 120 chars max) so a hostile username cannot forge
  extra alert lines. Body carries no password, token or key.
- `server.js`: the daily rotation-due alert is plain text the same way.
- `services/telegram.security_alerts.test.js` (9 cases): drives the real
  service with a fake client that applies Telegram's legacy-Markdown
  entity rule; the pre-fix message for `stage0a_breakglass` fails with the
  exact production error, the new alert goes out with no `parse_mode`
  key, a username of `evil_*\`[x](y)<b>_\n...` still delivers on one
  line, the failed-attempt alert is plain, and Markdown is still the
  default for everyone else.
- `staging-checks.js` gate 19A additionally asserts no
  `can't parse entities` line in the instance log.

Rerun on Lightsail (the harness re-proves 9/10/17A/18A in the same
minute; nothing production-side changes):

```bash
cd ~/stage0a-rehearsal && git pull --ff-only origin claude/dnds-payroll-integration-proposal-3p6hen && MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/staging-rehearsal.sh dnds_rehearsal
```

**Gate 19A: PASS, 07-09-2026.** Rerun at `7a77b52`: 37/37 + 6/6,
`STAGING REHEARSAL: ALL CHECKS PASSED`; the administrator received both
the `🚨 BREAK-GLASS LOGIN` alert and the failed-attempt alert in DN
Accounts from `@DailyNeedsBot`.

**Two defects found by the local run and fixed:** `password_flagged`
was missing from the audit repository's event allow-list, so production
would have flagged the row but silently dropped the audit (the test
fixture now enforces the same allow-list); and `break-glass.js` forced
`NODE_ENV=production`, which on the host would have pointed it at the
stale "production" config block.

**Lightsail commands (in this order, from `~/stage0a-rehearsal`):**

```bash
git pull --ff-only origin claude/dnds-payroll-integration-proposal-3p6hen
MYSQL_BIN_DIR="$HOME/mysql84/bin" scripts/auth/staging-rehearsal.sh dnds_rehearsal
```

Optional: `ALERT_CHAT_ID=<chat id>` to direct the alert to a specific
group the new bot is in; `SKIP_TELEGRAM=1` to run without the token.
Expected: `STAGING REHEARSAL: ALL CHECKS PASSED` with `36 passed` and
`6 passed`, `instances` stopped, `config.json restored`, and one
plain-text `🚨 BREAK-GLASS LOGIN` message for `stage0a_breakglass` in
the alerts chat. Send back the report (`~/db-backups/staging-<stamp>.txt`, no
secrets) and whether the alert arrived.

#### Gate 23 — personal legacy-token decode (no token leaves your machine)

On your own PC with node installed, with your **current production**
session token in an environment variable (never on the command line):

```powershell
$env:T = "<paste your token here>"; node -e "const [h,p]=process.env.T.split('.');const d=s=>JSON.parse(Buffer.from(s,'base64url').toString());console.log('header:',JSON.stringify(d(h)));console.log('payload fields:',Object.keys(d(p)).join(','));console.log('has sub:',('sub' in d(p)),' has auth_ver:',('auth_ver' in d(p)),' has kid:',('kid' in d(h)))"; Remove-Item Env:T
```

Report back only the three printed lines. Expected for a token issued by
today's production: header `{"alg":"RS256","typ":"JWT"}`, fields
`id,user_type,store_id,designation_id,name,designation,employee_image,employee_id,iat,exp` (order may differ), `has sub: false  has auth_ver: false  has kid: false`.

### 5.8 Other findings from this review (recorded, not all fixed)

| Finding | Status |
| --- | --- |
| `scripts/auth/backup-user-tables.sh` assumed a local socket, had no host/port/user, no client-version check, no disk check, no table-count or checksum verification, an `--add-drop-table` dump with no guard against being replayed on the live schema, and a `zcat | tail | grep -q` under `pipefail` that could fail spuriously | **rewritten** (this commit) |
| `scripts/auth/break-glass.js` set `global.env = process.env.NODE_ENV` with no default → on the production host (NODE_ENV unset) it crashed with `config.db.mysql[undefined]` before doing anything | **fixed** to mirror `server.js` |
| `NODE_ENV` unset in production means `global.isDev()` is **true** in production: `middlewares/errorHandler.js` and `utils/http.js` return raw `err.message`/`err.toString()` to clients, and every request is console-logged. Not in the auth path (`config/auth.js`, `middlewares/auth.js`, `services/jwt.js` do not consult it). | **recorded**, out of Stage 0A scope; set `NODE_ENV=production` in `ecosystem.config.js` in a separate change *after* confirming `config.db.mysql["production"]` holds the same RDS values (today "production" may still be the stale sample) |
| The deploy workflow's `db-migrate up` runs with no `-e`; which `database.json` environment it selects on the server is not visible from the repo | **to confirm** on the host (`cat migrations/mysql/database.json` keys only) — gate 4 |
| `PURCHASE_TELEGRAM_CHAT_ID` now targets a group the new bot is not in | recorded in §0.6.1 |
| Found by the end-to-end test of the gate 5 tooling: `mysqldump` 8 needs `PROCESS` for tablespaces (→ `--no-tablespaces`); a least-privilege user cannot `SHOW CREATE FUNCTION` and `mysqldump` silently omits routines (→ preflight + admin dump identity or explicit `SKIP_ROUTINES=1`); `CREATE FUNCTION/TRIGGER` fails with `ERROR 1419` when binlog is on without `log_bin_trust_function_creators` (→ handled, recorded); the `mysql` v2 driver db-migrate uses cannot authenticate `caching_sha2_password` users (→ preflight); db-migrate would run *every* unrecorded migration file (→ exact pending-set assertion before `up`); `GRANT … TO user@host` needs quoting | **all built into the scripts** |
| Second production resume (`8199079`) rejected 12 legitimate rows of the counts file because the validator imposed `[A-Za-z0-9_]+` on table names; production has hyphenated names (`debit_note-2024-2025`, `purchase-2025-2026`, …). The same review found the backup script's row-count loop word-split table names (`for t in $TABLES`), which would have mis-counted a name containing spaces. | **fixed**: structural checks + exact set equality against live `information_schema` only; the loop reads one name per line and backtick-quotes it; reproduced with hyphenated, spaced and `$` names — full run and manifest-less resume pass; six malformed-file cases refused |
| `scripts/auth/db-defaults-file.js admin` gained `--password-from-stdin` for non-interactive use (still never an argument) | done |
| **First production run (06-09-2026, commit `a4a79ed`) stopped with `FAIL: auth dump missing table user` after both dumps had been created and the full dump had verified (144 `CREATE TABLE` = 144 base tables).** Root cause: the auth-dump table check was `zcat … \| grep -q`; `grep -q` exits on its first match, `zcat` is killed by SIGPIPE, and under `set -o pipefail` the pipeline reports status 141 — a false failure that always lands on the *first* table in the dump (`user`) once the dump is larger than the pipe buffer (production's is 48 K; reproduced locally on a 36 K dump, exit 141 every time). The dump itself was fine. | **fixed properly** (`scripts/auth/stream.sh`): every compressed-stream check now goes through `gz_count` / `gz_matches` / `gz_tail_count`, whose consumers read the whole stream and whose stages are checked individually via `PIPESTATUS` — a `zcat` error (corrupt/truncated archive) or a `grep` error (bad pattern) is a hard `FAIL`, zero matches is a count of 0, and SIGPIPE cannot occur; no `\|\| true`, no global 141 suppression. Proven: old check exits 141 on a 2.4 MB dump every time; new helpers pass on it; a truncated gzip and a bad pattern both fail with the right message; a dump genuinely lacking `user` is still reported. Also: `--skip-backup` now fully re-verifies an existing artefact set (checksums, trailer, auth-dump table list, full-dump `CREATE TABLE` count) before restoring; `migration-rehearsal.sh` no longer pulls its own checkout mid-run (the operator pulls first) |

---

## 6. Telegram rotation procedure (gate 6)

> **Superseded 06-09-2026** by what was actually done — see §0.6.1. The
> old token could not be revoked (step 1 below) because the BotFather
> account is not ours; production was moved to a new bot instead. Steps
> 2–4 are done; 5–6 remain (gates 18, 19).

Original plan, in this order:

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
