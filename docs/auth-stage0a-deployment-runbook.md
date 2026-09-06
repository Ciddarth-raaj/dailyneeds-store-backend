# Stage 0A — Deployment A Production Runbook

Companion to `docs/auth-stage0a-preproduction-readiness.md`.
This file is the working record. Fill it in as you go; do not fill it in from memory afterwards.

> **§0 is RESOLVED (06-09-2026).** `main-autodeploy` was merged into the
> feature branch in both repositories, C1–C4 applied and tested, and the
> reset gates re-evaluated (readiness report §0). The ledger below is the
> post-merge state. **One item does not wait for Deployment A: the Telegram
> token rotation (Step 1) — readiness §0.6 answers "YES, the current token
> can influence a reset code".**

---

## 0. RESOLVED — upstream drift and merge (found and integrated 06-09-2026)

**What happened.** After the feature branch was cut (merge-base `974afda`
backend, `a8090e4` frontend), the Telegram password-reset feature landed on
`main-autodeploy` (`a98428a`, `9d92884` backend; `3f86694`, `b555de3`,
`16cd162` frontend), auto-deployed, with migration
`20260906070000-telegram-password-reset` already applied in production.

**What was done.** `origin/main-autodeploy` was merged **into** the feature
branch (`git merge --no-ff`, no rebase) in both repositories, from the
safety point `ca9c4b3` / `b9f8cd3` (local tags `stage0a-pre-merge-*`,
`stage0a-prod-baseline-*`). Six backend conflicts and one frontend
conflict were resolved semantically — the file-by-file record, the four
security reconciliations, the C4 answer, the outstanding-code analysis and
the two-reset-systems proposal are in **readiness report §0**. Nothing was
pushed to `main-autodeploy`; nothing was deployed.

| # | Reconciliation | Outcome on the branch |
| --- | --- | --- |
| C1 | Telegram reset wrote SHA-1 | now scrypt via `setModernPassword` + `clearMustChange`; no `updatePassword`/SHA-1 in the reset path |
| C2 | system-account exclusion was accidental | explicit SQL predicate + `isResettableAccount` + `rejectSystemAccounts` on `/telegram-link`; five named tests + HTTP-level tests |
| C3 | 6-char minimum, no identity checks | shared `utils/password_policy` first; `PASSWORD_POLICY` with reason, code kept, retry allowed |
| C4 | committed token fallback + per-minute poller | env-only token; poller no-ops when unconfigured; re-entrancy guard. **Production moved to a new bot on 06-09-2026 (readiness §0.6.1); old token still valid, not revocable by us** |

**Ledger consequence.** Gates 1, 2, 3, 7, 11, 20, 21, 22, 24 re-earned on
the merged tree (evidence in the rows). Gate 23 stays yours. Gate 5's
snapshot must post-date the upstream migration.

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
| 1 | Legacy JWT compatibility (versioned identity resolution) | PASS *(merged tree)* | Claude / automated tests | 06-09-2026 | `middlewares/auth.compat.test.js` 10/10, `legacy_transition.test.js` 5/5 after the merge; baseline `usecase/user.js` + `services/jwt.js` byte-identical at `9d92884` (readiness §0.10). |
| 2 | Legacy token cannot resolve to a system account | PASS *(merged tree)* | Claude / automated tests | 06-09-2026 | `auth.compat.test.js` 7; transition test 9; re-run after the merge. |
| 3 | Stage-0A-only branch diff | PASS *(post-merge)* | Claude / `git diff` | 06-09-2026 | Backend 65 files vs `origin/main-autodeploy` (45 A, 20 M), frontend 9: all Stage 0A, merge resolution of upstream files, or the 4 accepted docs-only files. Zero payroll/attendance/shift/Digisme/`employee_id` changes (readiness §0.14). |
| 4 | Deployment trigger fully mapped (webhooks, runners, server hooks) | WAITING FOR ADMIN | | | Both workflows mapped (readiness §3). GitHub Settings → Webhooks / Runners and the host's `.git/hooks` are yours to confirm. |
| 5 | End-to-end restore rehearsal, snapshot ≤24 h | NOT YET VERIFIED | | | Snapshot must post-date the upstream migration (already applied in production) so the rehearsal schema includes `telegram_links`, `telegram_link_tokens`, `password_reset_codes`. Unchanged by the merge. |
| 6 | Telegram token rotated, new token live, normal alert received | **PARTIAL — WAITING FOR ADMIN (BotFather owner)** | Administrator (production) / Claude (record) | 06-09-2026 | Done: new bot `@DailyNeedsBot`, token in production `.env` (previous `.env` backed up), `pm2 reload 0` online, `getMe` ok, no webhook, pending updates 10→0, no 409, test message received in Dn Daily Sales, old bot webhook deleted and removed from all groups. **Not done and not possible by us: revocation of the old token** (`@dailyneeds_test_bot`, BotFather account not ours) — it remains cryptographically valid. Mitigation: the compiled fallback is removed on the branch (fail closed) and ships with Deployment A. Readiness §0.6.1. |
| 7 | Break-glass route-level protection | PASS *(merged tree)* | Claude / automated tests | 06-09-2026 | `routes/user.protection.test.js` 14/14: route surface enumerated incl. the five upstream routes; forgot/reset-password against the break-glass username refused with the row unchanged; system session refused `403 EMPLOYEE_REQUIRED` on all `/telegram-link` methods; no `:id` form of either reset route. |
| 8 | Frontend production build succeeds | PASS *(merged tree)* | Claude | 06-09-2026 | Rebuilt after the merge from a clean `node_modules` / `.next`: `npm ci --legacy-peer-deps` + `next build` (`--openssl-legacy-provider`) exit 0, "Compiled successfully", `/login` and `/setup-password` present, zero `user/login?username` in the bundle. |
| 9 | Frontend + backend staging login (normal, failed, logout, navigation) | NOT YET VERIFIED | | | |
| 10 | Legacy-token staging transition, including ID-collision fixture | NOT YET VERIFIED | | | Isolated equivalent PASS (`legacy_transition.test.js`); staging with a DB and a browser not done. |
| 11 | NULL-password fail-closed | PASS *(merged tree)* | Claude / automated tests | 06-09-2026 | `services/password.nullable.test.js` 6/6 after the merge. |
| 12 | trust proxy / forwarded-header spoofing, verified against real nginx | NOT YET VERIFIED | | | Code-level PASS (`routes/proxy.test.js`; `trust proxy` = loopback, `true` refused). Real nginx not verified. |
| 13 | Default-password scan on restored snapshot | NOT YET VERIFIED | | | Snapshot only. Never on production. |
| 14 | Account-integrity scan on restored snapshot | NOT YET VERIFIED | | | |
| 15 | Feature flags startup-stable | PASS | Claude / code audit | 06-09-2026 | commit `859e519`; implementation doc §20b |
| 16 | Absent-flag defaults reviewed and intentional | PASS | Claude / code audit | 06-09-2026 | commit `859e519`; implementation doc §20b |
| 17A | External JWT key loading proven **in staging** using the CURRENT key | NOT YET VERIFIED | | | Mechanism proven in tests via env-pointed files. Production equivalent is P3. |
| 18A | Break-glass login verified **in staging** | NOT YET VERIFIED | | | Production equivalent is P1 |
| 19A | Break-glass Telegram alert verified **in staging** | NOT YET VERIFIED | | | Now unblocked on the bot side (new bot live). Production equivalent is P2. |
| 20 | All required tests green with named case mapping | PASS *(merged tree)* | Claude / `node --test` | 06-09-2026 | `IS_TEST=true node --test`: **407 tests / 406 pass / 0 fail / 1 skip** (the skip is the unrelated `priceCheckerConflicts` golden test). New: `usecase/passwordReset.stage0a.test.js` 27, adapted upstream `usecase/passwordReset.test.js` 19, `routes/user.protection.test.js` +5. Mapping in readiness §0.4–0.8, §0.12. |
| 21 | Frontend reproducible build — `npm ci` outcome understood | **PASS** | Claude | 06-09-2026 | **Cause:** `formik-error-focus@1.1.0` declares peer `formik@^1`; project has `formik@2.4.9` (root `^2.2.9`). A stale peer range on a package unrelated to the auth pages. **Fix, reproducible from the lockfile:** `npm ci --legacy-peer-deps` → exit 0, 1008 packages, **`package-lock.json` unchanged** (re-verified after the merge against both parents). The workflow's `npm install --force` also resolves it but may rewrite the lockfile; prefer `npm ci --legacy-peer-deps` in the workflow when it is next touched. No dependency upgrade performed. Bundle sends credentials in the POST body (gate 8 evidence). |
| 22 | Migration plan reviewed; all migrations proven additive and idempotent | **PASS (post-merge)** | Claude / `node --test` | 06-09-2026 | `migrations/auth_stage0a_migrations.test.js` (7 cases): the `user` migration is exactly one `ALTER TABLE` with only `ADD COLUMN` / `ADD INDEX` / the widening `MODIFY password NULL`, every column NULL-or-DEFAULT, no `new_employee`; both `CREATE TABLE`s are `IF NOT EXISTS`; all three inserts `WHERE NOT EXISTS`; no standalone `CREATE INDEX`; every down restores exactly; Stage 0A timestamps sort after the upstream `20260906070000` migration. **Upstream migration reviewed too:** three `CREATE TABLE IF NOT EXISTS`, additive, already applied in production — it must be *present on the branch* after the merge so `db-migrate` on the night sees it as applied, not pending. |
| 23 | Legacy token shape personally confirmed — decoded **locally** | NOT YET VERIFIED | | | Yours. Re-read from the NEW baseline `9d92884`: `id` + `employee_id` + `store_id` + `designation_id` + `user_type`, no `sub`, no `auth_ver`, no `kid` (readiness §0.10). The personal decode is the gate. |
| 24 | Telegram dependency inventory complete; every live consumer accepts a new token **without unreleased Stage 0A code** | **PASS — confirmed in production** (deployed code took the `.env` token with no code change) | Claude / deployed-source audit | 06-09-2026 | See §3 Step 1a/1b below. On the merged branch every consumer, the poller included, still goes through the single env-configured client; the poller is a logged no-op when the variable is absent. |

---

## 3. Execution sequence

Cheap checks before expensive ones. Each step lists what to record.

**Step 0 — §0 resolved.** The branch is merged with production and green; proceed.

**Step 1 — Telegram.** Gates 24, 6. **Done in production on 06-09-2026, with
one residual** — full record in readiness §0.6.1. Outcome: production runs
on a new bot (`@DailyNeedsBot`) from `.env`; sending and `getUpdates`
verified; the old bot (`@dailyneeds_test_bot`) has no webhook and is in no
group, but its token **cannot be revoked by us** (BotFather account not
ours) and therefore stays valid. Residual actions: obtain BotFather control
of the old bot and `/revoke` it (owner task, no date); tell staff the old
bot is retired; retire or re-point `PURCHASE_TELEGRAM_CHAT_ID` (purchase
notifications now fail by decision). Deployment A removes the compiled
literal from the running code.

**Step 2 — Backup and restore rehearsal.** Gate 5. **← NEXT — ready to run.**
One command from `~/stage0a-rehearsal` (readiness **§5.4**):
`STAGE0A_ADMIN_DEFAULTS=~/.stage0a/admin.cnf scripts/auth/gate5-rehearsal.sh`,
after `node scripts/auth/db-defaults-file.js admin --host <rds> --user <master>`
has written the admin identity (hidden prompt). The orchestrator runs
defaults → backup (auth + full, verified, manifest) → checksum check →
isolated restore into `dnds_rehearsal` with 0-mismatch count comparison →
Stage 0A up / idempotent up / down×4 / up, and stops on the first `FAIL:`.
Tested end to end against a real MySQL 8 server with RDS-like restrictions
(no `CREATE DATABASE`, binlog on without `log_bin_trust_function_creators`,
routines/triggers/events present): pass; zero writes to the source schema
in the binlog; no credential in any artefact. Expected output and the
three RDS-specific messages: readiness **§5.5**. PASS criteria: **§5.7**.
Record: the `gate5-<stamp>.log` and manifest paths, the restore seconds.

**Step 3 — Scans on the restored copy only.** Gates 13, 14.
`scripts/auth/default-password-scan.sql`, `scripts/auth/account-integrity-audit.sql`.
Never against the production DB server. Retain account identifiers and
pattern categories only.
Record: snapshot age, counts by pattern category, duplicate/shared-login
findings, where the output is stored and when it was destroyed.

**Step 4 — Frontend reproducibility.** Gate 21 — **done and re-run after
the merge, see ledger** (clean `npm ci --legacy-peer-deps`, lockfile
unchanged, bundle free of `user/login?username`).

**Step 5 — Deployment infrastructure.** Gates 4, 22.
Workflows are mapped in readiness §3. Confirm GitHub webhooks and runners in
both repos and the host's `.git/hooks`. Gate 22's proof is the migration
test (re-run after the merge: 7/7). **Nothing is run against production at
this step.**

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
| ~~Resolve §0: merge `main-autodeploy` into the feature branch, apply C1–C4, re-run tests, re-diff~~ | Claude | before any other step | 06-09-2026 |
| ~~Rotate the Telegram bot token (§3 Step 1)~~ moved production to a new bot | Administrator | now | 06-09-2026 (partial: old token not revoked) |
| Obtain BotFather control of `@dailyneeds_test_bot` and `/revoke` (or delete) it | Owner | as soon as possible; not a Deployment A blocker | |
| ~~Decide the two-reset-systems reconciliation~~ | Owner | | 06-09-2026 — both kept, one engine (readiness §0.7) |
| ~~Gate 5: install MySQL 8.4 client~~ (done: 8.4.11 in `~/mysql84`) → run `scripts/auth/gate5-rehearsal.sh` per readiness §5.4 and record §5.7 | Administrator | next | |
| Confirm which `database.json` environment the deploy's bare `db-migrate up` selects on the host (keys only) | Administrator | before deployment night (gate 4) | |
| Set `NODE_ENV=production` in PM2 after verifying the "production" config block — separate change, not Stage 0A | Owner | after Deployment A | |
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
| 06-09-2026 | First gate 5 run on Lightsail (`a4a79ed`): both dumps created and full dump verified (144 tables, 22 s), then a false `FAIL: auth dump missing table user` from a `grep -q`/SIGPIPE/pipefail verifier bug; no restore ran. Verifier fixed and re-tested; the `20260906-174727` artefacts are reusable with `--skip-backup`. | — | |
| 06-09-2026 | Gate 5 tooling finalised as one orchestrator (`gate5-rehearsal.sh`) and tested end to end against MySQL 8 with RDS-like restrictions; six real-world failure modes found and handled; MySQL 8.4.11 client confirmed installed on Lightsail | — (5 unchanged until run on Lightsail) | |
| 06-09-2026 | Gate 5 tooling rewritten for RDS (defaults-file credentials, MySQL 8.4 client, verified dump, isolated restore, migration rehearsal); `break-glass.js` NODE_ENV crash fixed; `isDev()`-in-production finding recorded | — (5 unchanged: NOT YET VERIFIED) | |
| 06-09-2026 | Production Telegram moved to new bot `@DailyNeedsBot` via `.env`; old bot webhook deleted, removed from groups; old token NOT revoked (BotFather not ours). Owner decision on reset architecture recorded. | 6 → PARTIAL; 24 confirmed; 19A unblocked | 06-09-2026 |
| 06-09-2026 | **Merged `origin/main-autodeploy` into the feature branch (both repos)**; C1–C4 applied; `passwordReset.stage0a.test.js` added; protection suite extended; frontend rebuilt | 1, 2, 3, 7, 8, 11, 20, 21, 22, 24 re-evaluated → PASS; 23 stays yours; 6 marked URGENT | 06-09-2026 |

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
- The upstream Telegram password-reset feature's own design (out of Stage 0A scope except where it intersects C1–C4); whether it and the admin-issued setup token are kept side by side is proposed in readiness §0.7 and **not decided here**
