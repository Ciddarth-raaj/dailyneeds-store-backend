# Stage 0A — Deployment A Production Runbook

Companion to `docs/auth-stage0a-preproduction-readiness.md`.
This file is the working record. Fill it in as you go; do not fill it in from memory afterwards.

> **Read §0 first.** Between the readiness report and this runbook,
> `main-autodeploy` moved under the feature branch in **both** repositories.
> The feature branch no longer merges cleanly. Nothing below can be executed
> until §0 is resolved, and several gates that were PASS are reset by it.

---

## 0. BLOCKING — upstream drift and merge conflicts (found 06-09-2026)

**What happened.** After the feature branch was cut (merge-base `974afda`),
two commits landed on the backend's `main-autodeploy` and three on the
frontend's, all part of one feature: **"reset a forgotten password over
Telegram"** (`a98428a`, `9d92884` backend; `3f86694`, `b555de3`, `16cd162`
frontend). It is **already deployed to production** (auto-deploy) and it
includes a migration, `20260906070000-telegram-password-reset`, which is
therefore already applied to the production database.

**What it touches.** Backend: `middlewares/auth.js`, `repository/user.js`,
`routes/user.js`, `server.js`, `services/telegram.js`, `.env-sample`, plus
new `repository/passwordReset.js`, `usecase/passwordReset.js` (+ test) and
the migration. Frontend: `helper/user.js`, `pages/login.js`,
`components/header/header.js`, plus new `components/ForgotPassword`,
`components/TelegramLink`.

**Trial merge result** (scratch worktree, discarded):

| Repo | Conflicting files |
| --- | --- |
| backend | `.env-sample`, `middlewares/auth.js`, `repository/user.js`, `routes/user.js`, `server.js`, `services/telegram.js` |
| frontend | `helper/user.js` |

Per `AGENTS.md` ("On merge conflicts: stop and report") the merge has
**not** been performed. It must be done deliberately, because the upstream
feature and Stage 0A disagree on four security-relevant points:

| # | Upstream (now in production) | Stage 0A | Resolution required |
| --- | --- | --- | --- |
| C1 | `usecase/passwordReset.js#resetPassword` writes the new password via `userRepo.updatePassword(user_id, plaintext)` → **`SET password = SHA1(?)`** | new credentials are scrypt only; `updatePassword` no longer exists | route the Telegram reset through `setModernPassword` + `password_policy.check` + `clearMustChange`; never SHA-1 |
| C2 | `getByUsername` excludes system accounts only by accident (`ne.status = 1` inner-join effect on `employee_id NULL`) | every mutation carries `AND is_system_account = 0`, and refusal must not rely on NULL failing to match | add `AND u.is_system_account = 0` to `getByUsername`; add a usecase-level refusal; extend `routes/user.protection.test.js` with `forgot-password` / `reset-password` against the break-glass username |
| C3 | `MIN_PASSWORD_LENGTH = 6`, no identity/default-pattern checks | policy: 8 minimum, refuses username / employee code / mobile / historical defaults | apply `utils/password_policy.js` in `resetPassword` |
| C4 | `services/telegram.js` keeps the **committed token as a fallback** and adds a **per-minute `getUpdates` poller** | token removed from source; service disables itself when `TELEGRAM_BOT_TOKEN` is absent | keep Stage 0A's env-only token; make `pollTelegramUpdates` a logged no-op when the client is not configured, so a missing variable does not throw sixty times an hour |

Also to reconcile: the two new unprotected routes upstream added
(`/user/forgot-password`, `/user/reset-password`) belong in the
`unProtectedRoutes` map alongside Stage 0A's `/user/setup-password`; the
`routes/user.js` router-surface test must be updated to list the five
upstream routes (`GET/POST/DELETE /telegram-link`, `POST /forgot-password`,
`POST /reset-password`) — and **`DELETE /telegram-link` breaks the current
"no DELETE on /user" assertion**, which must be narrowed to "no DELETE that
touches an account"; the upstream `telegram_link_poll` cron must tolerate an
unconfigured client; and the frontend `helper/user.js` conflict is purely
additive on both sides (Stage 0A's `setupPassword`/`logout` beside upstream's
Telegram helpers).

**Consequence for the ledger.** Gate 3 is **reset to NOT YET VERIFIED**
(the branch base is no longer production). When the merge is done, the
invalidation rules in §1 reset gates 1, 2, 7, 11, 20 (auth code changed) and
5, 22 (a migration is now on the branch that was not before, and the
production schema has a table set the rehearsal snapshot must include).
The named-test evidence in the readiness report stays valid for the code it
was run against, but must be **re-run on the merged branch** before any
gate is re-marked.

**Recommended order:** resolve the merge on the feature branch (a merge
commit, never a rebase — the branch is pushed), apply C1–C4 with tests,
re-run `node --test`, re-run gate 3's diff, then continue from §3.

---

## 1. Rules

**Status values**

| Status | Meaning |
|---|---|
| `PASS` | Verified by a named person, on a stated date, against evidence recorded below |
| `NOT YET VERIFIED` | Not yet done, or previously PASS but invalidated by a change |
| `FAIL` | Checked and found unsafe |
| `WAITING FOR ADMIN` | Blocked on an action only the owner can perform |

**GO rule** — Deployment A is GO only when every gate in §2 is `PASS`.
Any gate at `FAIL`, `NOT YET VERIFIED` or `WAITING FOR ADMIN` means NO-GO. This is not negotiable on the night.

P1 and P2 in §4 are **not** pre-deployment gates — they are deployment-night checks that can only be run after Deployment A is live. Their failure triggers rollback, not a NO-GO.

**Gate invalidation** — a gate marked `PASS` returns to `NOT YET VERIFIED` automatically if any of the following change after it was verified:

| If this changes | These gates reset |
|---|---|
| nginx / proxy configuration | 12, 9, 10 |
| environment variables on the server | 15, 16, 17A, 6 |
| JWT key paths or key files | 17A, 1, 2 |
| frontend lockfile or dependencies | 8, 9, 21 |
| deployment workflow, webhooks, runners, server hooks | 4, 22 |
| any migration file | 5, 22 |
| any auth code on the feature branch | 1, 2, 7, 11, 20 |
| **`main-autodeploy` moves under the feature branch** | **3**, and after the merge everything the merge touches per the rows above |

Record the change and the reset in §7 (Change log) when it happens.

---

## 2. Gate ledger

Status carried over from the readiness report, then corrected for §0. Every row needs a verifier and a date before it counts as PASS.

| # | Gate | Status | Verified by | Date / time | Evidence |
|---|---|---|---|---|---|
| 1 | Legacy JWT compatibility (versioned identity resolution) | PASS *(pre-merge code)* | Claude / automated tests | 06-09-2026 | commit `859e519`; `middlewares/auth.compat.test.js` 1–6. **Resets on merge (§0).** |
| 2 | Legacy token cannot resolve to a system account | PASS *(pre-merge code)* | Claude / automated tests | 06-09-2026 | commit `859e519`; `auth.compat.test.js` 7; transition test 9. **Resets on merge.** |
| 3 | Stage-0A-only branch diff | **NOT YET VERIFIED** | — | 06-09-2026 | Was PASS at `859e519`; **reset** — production moved (§0). Re-diff after the merge. 4 docs-only files remain the accepted exception. |
| 4 | Deployment trigger fully mapped (webhooks, runners, server hooks) | WAITING FOR ADMIN | | | Both workflows mapped (readiness §3). GitHub Settings → Webhooks / Runners and the host's `.git/hooks` are yours to confirm. |
| 5 | End-to-end restore rehearsal, snapshot ≤24 h | NOT YET VERIFIED | | | Snapshot must post-date the upstream migration (already applied in production) so the rehearsal schema includes `telegram_links`, `telegram_link_tokens`, `password_reset_codes`. |
| 6 | Telegram token rotated, new token live, normal alert received | WAITING FOR ADMIN | | | See §3 Step 1 — **1a is answered: no hotfix needed.** |
| 7 | Break-glass route-level protection | PASS *(pre-merge code)* | Claude / automated tests | 06-09-2026 | `routes/user.protection.test.js`. **Resets on merge**: upstream adds `forgot-password` / `reset-password` / `telegram-link`, which must be added to this suite (§0 C2). |
| 8 | Frontend production build succeeds | PASS | Claude | 06-09-2026 | Built from `b9f8cd3` via `npm install --force` — exit 0, 153 pages, auth pages present, zero `user/login?username` in the bundle. Gate 21 now understood. |
| 9 | Frontend + backend staging login (normal, failed, logout, navigation) | NOT YET VERIFIED | | | |
| 10 | Legacy-token staging transition, including ID-collision fixture | NOT YET VERIFIED | | | Isolated equivalent PASS (`legacy_transition.test.js`); staging with a DB and a browser not done. |
| 11 | NULL-password fail-closed | PASS *(pre-merge code)* | Claude / automated tests | 06-09-2026 | `services/password.nullable.test.js`. **Resets on merge.** |
| 12 | trust proxy / forwarded-header spoofing, verified against real nginx | NOT YET VERIFIED | | | Code-level PASS (`routes/proxy.test.js`; `trust proxy` = loopback, `true` refused). Real nginx not verified. |
| 13 | Default-password scan on restored snapshot | NOT YET VERIFIED | | | Snapshot only. Never on production. |
| 14 | Account-integrity scan on restored snapshot | NOT YET VERIFIED | | | |
| 15 | Feature flags startup-stable | PASS | Claude / code audit | 06-09-2026 | commit `859e519`; implementation doc §20b |
| 16 | Absent-flag defaults reviewed and intentional | PASS | Claude / code audit | 06-09-2026 | commit `859e519`; implementation doc §20b |
| 17A | External JWT key loading proven **in staging** using the CURRENT key | NOT YET VERIFIED | | | Mechanism proven in tests via env-pointed files. Production equivalent is P3. |
| 18A | Break-glass login verified **in staging** | NOT YET VERIFIED | | | Production equivalent is P1 |
| 19A | Break-glass Telegram alert verified **in staging** | NOT YET VERIFIED | | | Depends on gate 6. Production equivalent is P2. |
| 20 | All required tests green with named case mapping | PASS *(pre-merge code)* | Claude / `node --test` | 06-09-2026 | 356 tests / 355 pass / 0 fail / 1 skip at this commit (349 + 7 migration-proof cases). **Resets on merge.** |
| 21 | Frontend reproducible build — `npm ci` outcome understood | **PASS** | Claude | 06-09-2026 | **Cause:** `formik-error-focus@1.1.0` declares peer `formik@^1`; project has `formik@2.4.9` (root `^2.2.9`). A stale peer range on a package unrelated to the auth pages. **Fix, reproducible from the lockfile:** `npm ci --legacy-peer-deps` → exit 0, 1008 packages, **`package-lock.json` unchanged**. The workflow's `npm install --force` also resolves it but may rewrite the lockfile; prefer `npm ci --legacy-peer-deps` in the workflow when it is next touched. No dependency upgrade performed. Bundle sends credentials in the POST body (gate 8 evidence). |
| 22 | Migration plan reviewed; all migrations proven additive and idempotent | **PASS (plan) — resets on merge** | Claude / `node --test` | 06-09-2026 | `migrations/auth_stage0a_migrations.test.js` (7 cases): the `user` migration is exactly one `ALTER TABLE` with only `ADD COLUMN` / `ADD INDEX` / the widening `MODIFY password NULL`, every column NULL-or-DEFAULT, no `new_employee`; both `CREATE TABLE`s are `IF NOT EXISTS`; all three inserts `WHERE NOT EXISTS`; no standalone `CREATE INDEX`; every down restores exactly; Stage 0A timestamps sort after the upstream `20260906070000` migration. **Upstream migration reviewed too:** three `CREATE TABLE IF NOT EXISTS`, additive, already applied in production — it must be *present on the branch* after the merge so `db-migrate` on the night sees it as applied, not pending. |
| 23 | Legacy token shape personally confirmed — decoded **locally** | NOT YET VERIFIED | | | Yours. `id` + `employee_id`, no `sub`, no `auth_ver`. What the source says is in implementation doc §7a; the personal confirmation is the gate. |
| 24 | Telegram dependency inventory complete; every live consumer accepts a new token **without unreleased Stage 0A code** | **PASS** | Claude / deployed-source audit | 06-09-2026 | See §3 Step 1a/1b below. |

---

## 3. Execution sequence

Cheap checks before expensive ones. Each step lists what to record.

**Step 0 — Resolve §0 first.** Nothing else proceeds on an unmergeable branch.

**Step 1 — Telegram: check first, revoke second.** Gates 24, 6.

**1a — answered from the deployed source (`origin/main-autodeploy`, commit `9d92884`):**
the currently deployed production backend **does** read the token from the
environment: `services/telegram.js` line 10–12 is
`process.env.TELEGRAM_BOT_TOKEN || "<compiled literal>"`, and
`.env-sample` documents `TELEGRAM_BOT_TOKEN`. **No hotfix is required.**
Setting `TELEGRAM_BOT_TOKEN` in the server's `.env` and reloading moves
production onto the new token *before* the old one is revoked; the
compiled literal is then dead.

**1b — inventory (gate 24), from the deployed source.** Every consumer goes
through the single `services/telegram.js` client, so one environment
variable covers all of them:

| Consumer (deployed) | What it sends |
| --- | --- |
| `server.js` (alerts, cron failures, **the new per-minute `telegram_link_poll` → `getUpdates`**) | operational alerts; polls the bot for `/start` messages |
| `usecase/accounts.js` | accounts-sheet notifications |
| `usecase/debit_note.js` | debit-note notifications |
| `usecase/offers_v3.js` | offers / talker checks |
| `usecase/purchase.js`, `usecase/purchase_order.js` | purchase notifications |
| `usecase/stock_checker.js` | stock-checker alerts |
| `usecase/ticket.js` | ticket notifications |
| `usecase/passwordReset.js` (**new upstream**) | reset codes to linked chats; `getMe` for the bot username |

No consumer holds its own copy of the token. No consumer calls
`api.telegram.org` directly. **The poller matters:** after revocation, an
un-rotated process would fail `getUpdates` every minute and the Telegram
password-reset feature would silently stop delivering codes — a second
reason the env var goes in *before* the revoke.

**Rotation order:** set `TELEGRAM_BOT_TOKEN=<new>` in `.env` (600) → `pm2
reload 0` → confirm a normal notification arrives on the new token → confirm
the poller is healthy (a `/start` link completes) → **then** `/revoke` the old
token in BotFather → record the time as the revocation confirmation.
Record: 1a required no hotfix; the table above; revocation time; new token in
env (never in source); a normal notification received.

**Step 2 — Backup and restore rehearsal.** Gate 5.
Snapshot ≤24 h old **and taken after the upstream migration ran** (it is in
production already; confirm `SELECT name FROM migrations ORDER BY run_on DESC
LIMIT 1` shows `20260906070000-telegram-password-reset` or later). Restore
into an isolated non-production database. Connect a test client where
practical. Script: `scripts/auth/backup-user-tables.sh`; procedure and
recording template: readiness §5.
Record: snapshot timestamp, backup method, restore command, **restore
duration**, validation queries, schema version, whether auth tables are
readable, any manual steps.

**Step 3 — Scans on the restored copy only.** Gates 13, 14.
`scripts/auth/default-password-scan.sql`, `scripts/auth/account-integrity-audit.sql`.
Never against the production DB server. Retain account identifiers and
pattern categories only.
Record: snapshot age, counts by pattern category, duplicate/shared-login
findings, where the output is stored and when it was destroyed.

**Step 4 — Frontend reproducibility.** Gate 21 — **done, see ledger.**
Re-run after the frontend merge (§0): `rm -rf node_modules && npm ci
--legacy-peer-deps` must still exit 0 with the lockfile unchanged, and the
built bundle must still contain no `user/login?username`.

**Step 5 — Deployment infrastructure.** Gates 4, 22.
Workflows are mapped in readiness §3. Confirm GitHub webhooks and runners in
both repos and the host's `.git/hooks`. Gate 22's proof is the migration
test; re-run it after the merge. **Nothing is run against production at this
step.**

**Step 6 — nginx / proxy.** Gate 12.
`sudo nginx -T`. Confirm: TLS on 443; HTTP redirects to HTTPS; the vhost
**overwrites** `X-Forwarded-For` and `X-Forwarded-Proto`; the Node port is
not publicly reachable. Then from outside: a forged `X-Forwarded-For` must
not change `/user/my-ip`; a forged `X-Forwarded-Proto: https` must not
bypass HTTP rejection (only meaningful once `AUTH_REQUIRE_HTTPS=true` on
staging).
Record: the real hop path, which hop sets each header, both spoofing results.

**Step 7 — Externalise the CURRENT JWT key, proven in staging.** Gate 17A.
Implementation doc §22 step 1. Copy, `600`, app user, directory `700`. Do
not rotate.
Record: path, ownership, permissions, that Stage 0A code starts and signs
with the external key, and that tokens issued by the old code still verify.

**Step 8 — Staging.** Gates 9, 10, 23.
Stand up staging against the restored DB with the built frontend. Normal
login, failed login, logout, authenticated navigation.
*Shape check (gate 23, production, local only)* — decode your own production
token on your own machine; record only field names.
*Transition test (gates 9, 10, staging only)* — old backend, log in as A,
keep the **staging** token, point at the new backend; same employee,
designation, store, permissions. Then the collision fixture (A.employee_id =
another account's user_id): legacy session does not become the other user,
cannot resolve to a system account.
Record each result individually.

**Step 9 — Break-glass on staging.** Gates 18A, 19A.
`BREAK_GLASS_CONFIRM=yes node scripts/auth/break-glass.js create --username <name>`
(password at the hidden prompt). Sign in once. Confirm `employee_id IS NULL`,
`sub` = `user_id`, alert received, and that a normal `user_type 2` admin
cannot modify, reset, disable or recreate it through any API — **including
the upstream `forgot-password` / `reset-password` routes** (§0 C2).
Record each result. Rotate the staging credential afterwards.

**Step 10 — Re-run the gate ledger.** Every row PASS, with verifier and date, or NO-GO.

---

## 4. Deployment night

**Window:** lowest-traffic hour. Trading is roughly 09:00–22:00, so plan around close.
**Do not** run any unrelated deployment the same night.

Before starting:
- [ ] Every gate `PASS` in §2, with dates
- [ ] Fresh backup taken tonight, restore duration known
- [ ] Current production commit/tag recorded here — backend `________________` frontend `________________`
- [ ] Previous working frontend/backend artifacts available
- [ ] Owner available
- [ ] Rollback operator available and knows the procedure
- [ ] One person at each of the 5 outlets able to test a real login immediately
- [ ] `TELEGRAM_BOT_TOKEN`, `JWT_PRIVATE_KEY_PATH`, `JWT_PUBLIC_KEYS`, `JWT_ACTIVE_KID`, `JWT_LEGACY_KID` present in the server `.env` (the Stage 0A code has no fallback for the first)

**Execution M1 — migrations first, application second.**
1. Run the four Stage 0A migrations deliberately using the **normal `db-migrate` command**, not by executing the SQL files by hand, while the old application remains running. Hand-run SQL leaves the tracking table unaware they ran, and the workflow will try them again.
2. Verify the tracking table records all four as applied, and that the old application is still serving normal logins at every outlet.
3. Only then deploy the application. The workflow's subsequent `db-migrate up` should report no pending Stage 0A migrations.
If step 2 fails, stop here — the application has not been changed yet, so this is the cheapest possible abort point.

Post-deployment checks — all must pass:
- [ ] **P3 — production external JWT key loading verified**: application starts, an existing token still works, a fresh login works, still on the current key with no rotation
- [ ] **P1 — production break-glass login verified**
- [ ] **P2 — production break-glass Telegram alert received**
- [ ] Normal admin
- [ ] Normal employee
- [ ] Cashier / store user at each outlet
- [ ] Inactive employee — **must fail**
- [ ] Legacy pre-deployment token — resolves to the same employee
- [ ] Fresh login issues an `auth_ver: 2` token
- [ ] Store and designation permissions unchanged
- [ ] Telegram password reset (upstream feature) still delivers a code and sets a **scrypt** hash (§0 C1)
- [ ] Deployment time recorded here `________________` — legacy resolution may be retired 36 h later

---

## 5. Rollback

### Triggers — roll back immediately, do not debug live

- Any outlet cannot log in
- Break-glass login fails
- A legacy token resolves to the wrong user
- Permissions differ unexpectedly after login
- A migration leaves schema and application inconsistent
- Frontend login fails in production despite staging passing
- The break-glass Telegram alert does not arrive
- The application cannot load the external JWT key, or existing tokens stop verifying
- Telegram password reset stops delivering codes (the poller is now on the same token)

The rule is roll back first, investigate afterwards.

### Procedure

1. Announce the rollback — one person calls it, no committee.
2. Revert the code deployment to the recorded commit/tag; reload.
3. Restore the frontend artifact.
4. **Code rollback first. Database restore only if required.**
   During Deployment A, `AUTH_HASH_ON_LOGIN` is OFF, so no normal employee password has been converted. A modern hash existing on the single break-glass account means at worst that the old code cannot use that one account. **One more case since §0:** anyone who used the upstream Telegram reset *after* Deployment A holds a scrypt hash the old code cannot read — record their usernames from `user_auth_log` (`reset_completed`) before rolling back, and reset them again on the old code.
   Restore the database **only** if one of these is true:
   - a migration made the old application incompatible with the current schema or data;
   - normal employee passwords have already been migrated to a modern hash;
   - the rollback depends on restoring authentication data the old code cannot read;
   - testing shows the old application cannot operate safely against the post-migration database.
   Expected restore duration: `________` (from gate 5).
5. Confirm logins at every outlet before standing down.
6. Write down what happened the same night, while it's fresh.

---

## 6. Dated tasks

| Task | Owner | Due | Done |
|---|---|---|---|
| **Resolve §0: merge `main-autodeploy` into the feature branch, apply C1–C4, re-run tests, re-diff** | | before any other step | |
| Disable the seeded weak admin account | | Deployment date `______`, and only after **all four**: P1 PASS, P2 PASS, normal owner/admin login PASS, rollback access confirmed | |
| Remove query-string login fallback (own GO/NO-GO) | | After 2 full operating days at zero query-string logins, including a shift changeover | |
| Retire legacy-token resolution + enable `JWT_REQUIRE_KID` | | 36 h after Deployment A, separate change | |
| Rotate JWT signing key (with kid overlap) | | After Deployment A is proven stable | |
| Switch the frontend workflow from `npm install --force` to `npm ci --legacy-peer-deps` | | next time the workflow is touched; not before Deployment A | |

The seeded admin is the largest live exposure right now: `user_type 2` with a known weak literal password. It stays only because break-glass does not exist yet. It goes the day break-glass is proven in production.

---

## 7. Change log

| Date | What changed | Gates reset | Rechecked on |
|---|---|---|---|
| 06-09-2026 | `main-autodeploy` (both repos) moved: Telegram password-reset feature deployed to production, incl. migration `20260906070000`. Feature branch conflicts in 6 backend + 1 frontend files. | 3 now; 1, 2, 5, 7, 11, 20, 22 on merge | |
| 06-09-2026 | Gate 21 investigated: `formik-error-focus` peer range; `npm ci --legacy-peer-deps` reproducible, lockfile unchanged | — (21 → PASS) | |
| 06-09-2026 | Gate 22 proof added as `migrations/auth_stage0a_migrations.test.js`; upstream migration reviewed | — (22 plan → PASS) | |

---

## 8. Deliberately out of scope

Not touched in Stage 0A. Do not start these until authentication is finished and stable.

- Stage 0B — HR data access controls, the 135 unprotected routes, `SELECT *` on the employee master
- Stage 0C — employee lifecycle / Digisme decoupling
- Payroll, attendance, shifts
- JWT in localStorage vs HttpOnly cookies; CSRF implications
- CSP and security headers
- Session / device management
- Dependency vulnerability review; Node 16 on the frontend deploy host; the `formik-error-focus` peer range
- The four remaining hardcoded secrets — documented for rotation, not yet rotated
- The upstream Telegram password-reset feature's own design (out of Stage 0A scope except where it intersects C1–C4)
