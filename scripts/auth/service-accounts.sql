-- ============================================================================
-- INTEGRATION / SERVICE ACCOUNTS - reviewed production data change.
--
-- NOTHING HERE RUNS AUTOMATICALLY. It is not a migration: which production
-- login is an integration is a fact about this company's data, not about the
-- schema, and it is applied by hand after review, inside a transaction, with
-- the SELECTs below read first and after.
--
-- Run order relative to the deploy is in the change's description: the column
-- (migration 20261028120000) must exist, and the guarded code must be the
-- code running, before step 2 means anything.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 0. AUDIT (read-only). Which logins are attached to an employee, and
-- which of them look like a machine rather than a person?
--
-- "Looks like a machine" is a judgement, not a query: the signal is an
-- account that has never completed an interactive login (`last_login_at IS
-- NULL`) while its token is plainly in use, or a username that names a system
-- rather than a person. Read this list; decide per row; flag nothing on a
-- guess.
--
-- The second column is the blast radius: how many OTHER logins share this
-- account's employee_id, i.e. how many accounts one employee-wide revocation
-- takes out together.
-- ----------------------------------------------------------------------------
SELECT u.user_id,
       u.username,
       u.employee_id,
       u.status,
       u.is_system_account,
       u.is_service_account,
       u.last_login_at,
       u.token_valid_from,
       ne.employee_name,
       (SELECT COUNT(*) FROM `user` s
         WHERE s.employee_id = u.employee_id AND s.user_id <> u.user_id) AS other_logins_on_this_employee
  FROM `user` u
  LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
 WHERE u.employee_id IS NOT NULL
   AND u.status = 1
 ORDER BY other_logins_on_this_employee DESC, u.last_login_at IS NOT NULL, u.username;

-- ----------------------------------------------------------------------------
-- STEP 1. MARK the Tally/purchase integration as a service account.
--
-- Idempotent: re-running it changes zero rows. Narrow on purpose - it names
-- the account by username AND by the user_id production actually holds, so a
-- copy of this file run against the wrong database updates nothing.
--
-- `employee_id` IS DELIBERATELY LEFT AT 1. The integration is using a token
-- that was issued before the Stage 0A auth versioning, and the middleware
-- refuses such a token unless the account is still a non-system,
-- employee-linked row whose employee_id matches the token's claim. Detaching
-- the employee here - or setting is_system_account - would invalidate the
-- live token, and issuing a new one is explicitly out of scope for this
-- change. The flag removes the DAMAGE of the coupling (employee-wide
-- revocation) without touching what the token depends on.
-- ----------------------------------------------------------------------------
-- START TRANSACTION;
UPDATE `user`
   SET `is_service_account` = 1
 WHERE `user_id` = 198
   AND `username` = 'purchase_api'
   AND `is_service_account` = 0;
-- Expect: 1 row on the first run, 0 on every run after.
-- COMMIT;

-- ----------------------------------------------------------------------------
-- STEP 2. RECOVERY - let the integration's EXISTING token verify again.
--
-- The account was revoked on 2026-09-17 14:04:26 UTC by an employee-wide
-- revocation it should never have been in scope for. `token_valid_from` in
-- the future of the token's `iat` is what returns TOKEN_REVOKED; clearing it
-- restores the token that is already installed on the Tally machine. NO NEW
-- CREDENTIAL IS CREATED, NOTHING IS PRINTED, AND NO SECRET LEAVES THE
-- DATABASE.
--
-- NULL means "no session cut-off recorded", which is the state this account
-- was in before the incident and the state every account was in before Stage
-- 0A. Run it ONLY after step 1, so the account cannot simply be revoked
-- again by the next HR edit to employee 1.
--
-- The auth middleware caches session state for `tokenValidFromCacheMs`, so
-- the effect is visible within that window; nothing needs reloading.
-- ----------------------------------------------------------------------------
-- START TRANSACTION;
UPDATE `user`
   SET `token_valid_from` = NULL
 WHERE `user_id` = 198
   AND `username` = 'purchase_api'
   AND `is_service_account` = 1;
-- Expect: 1 row.
-- COMMIT;

-- ----------------------------------------------------------------------------
-- STEP 3. VERIFY.
-- ----------------------------------------------------------------------------
SELECT user_id, username, employee_id, status, is_system_account,
       is_service_account, token_valid_from
  FROM `user`
 WHERE username IN ('purchase_api');
