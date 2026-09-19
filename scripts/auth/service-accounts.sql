-- ============================================================================
-- INTEGRATION / SERVICE ACCOUNTS - production runbook.
--
-- THIS FILE IS SAFE TO EXECUTE WHOLE. Everything it can run is a read.
-- Every statement that CHANGES data is commented out, and stays commented
-- out in the repository: the manual blocks below are copied into a session by
-- hand, one at a time, by a reviewer who has read the verification either
-- side of them. Running `mysql < service-accounts.sql` by accident prints
-- rows and changes nothing.
--
-- It is not a migration. Which production login is an integration, and what
-- network it may call from, are facts about this company's data.
--
-- The column these statements depend on ships in migration
-- 20261028120000-auth-service-account-flag, and the guarded code must be the
-- code running before the flag means anything.
-- ============================================================================


-- ############################################################################
-- PART A - AUDIT. READ-ONLY. Safe to run as-is.
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A1. Which logins are attached to an employee, and which of them look like a
-- machine rather than a person?
--
-- "Looks like a machine" is a judgement, not a query: the signal is an
-- account that has never completed an interactive login (`last_login_at IS
-- NULL`) while its token is plainly in use, or a username that names a system
-- rather than a person. Read this list; decide per row; flag nothing on a
-- guess.
--
-- `other_logins_on_this_employee` is the blast radius: how many OTHER logins
-- share this account's employee_id, i.e. how many accounts one employee-wide
-- revocation takes out together.
--
-- The `inherited_*` columns say what will CHANGE about the account's network
-- policy when it is flagged. Today it follows the employee's outlet. Once
-- flagged it follows nothing, and `branch` - the column default - resolves to
-- "no network allowed".
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
         WHERE s.employee_id = u.employee_id AND s.user_id <> u.user_id) AS other_logins_on_this_employee,
       u.ip_policy              AS ip_policy_today,
       u.allowed_ips            AS own_allow_list_today,
       ne.store_id              AS inherited_outlet_id,
       o.ip_restriction_enabled AS inherited_branch_switch,
       o.allowed_ips            AS inherited_branch_allow_list
  FROM `user` u
  LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
  LEFT JOIN outlets o ON o.outlet_id = ne.store_id
 WHERE u.employee_id IS NOT NULL
   AND u.status = 1
 ORDER BY other_logins_on_this_employee DESC, u.last_login_at IS NOT NULL, u.username;


-- ----------------------------------------------------------------------------
-- A2. THE CHECKLIST, per account, BEFORE setting is_service_account = 1.
--
--   1. Is this login really a machine? A human account flagged by mistake
--      stops being revoked when that person resigns. That is the one
--      direction of this change that WEAKENS security, and it is why no
--      query decides it.
--   2. Does anything else depend on its employee link? Its token does, if it
--      is a pre-Stage-0A token: the middleware checks the token's
--      employee_id claim against the row. Leave `employee_id` alone unless a
--      new credential is being issued at the same time.
--   3. WHAT NETWORK MAY IT CALL FROM? Read `ip_policy_today` first, then
--      `inherited_branch_switch`:
--        ip_policy_today = 'unrestricted'
--                   the account is ALREADY exempt on its own terms and never
--                   depended on the branch. Carry 'unrestricted' across
--                   unchanged. Do not "tighten" it as part of an
--                   authentication fix - that is a separate, deliberate
--                   change with its own verification.
--        ip_policy_today = 'branch', switch NULL or 0
--                   effectively unrestricted today by inheritance. Choose
--                   'unrestricted' to preserve exactly that, or 'custom'
--                   with the integration machine's fixed address.
--        ip_policy_today = 'branch', switch 1
--                   restricted to that outlet's list today. Copy the
--                   addresses the integration actually uses into 'custom';
--                   do not assume the whole branch list is still right.
--      There is no fourth option: leaving a FLAGGED account on 'branch' puts
--      it in "no network allowed". A1 shows what it is on now, so the manual
--      block sets both columns in one statement.
--   4. Where does it call from in practice? Confirm against the reverse
--      proxy's access log. Do not take an address from this file.
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- A3. PRE-CHANGE VERIFICATION for user 198. READ-ONLY.
-- Run this immediately before the manual block in Part B and keep the output.
-- Expected today (confirmed by the production read-only check, 2026-09-19):
--   employee_id 1, status 1, is_service_account 0,
--   ip_policy 'unrestricted', allowed_ips NULL,
--   token_valid_from 2026-09-17 14:04:26
-- ----------------------------------------------------------------------------
SELECT user_id, username, employee_id, status,
       is_system_account, is_service_account,
       ip_policy, allowed_ips, token_valid_from, last_login_at
  FROM `user`
 WHERE user_id = 198 AND username = 'purchase_api';


-- ############################################################################
-- PART B - THE DATA CHANGE. MANUAL. NOTHING HERE EXECUTES FROM THIS FILE.
--
-- Copy ONE block at a time into a session. Run A3 before it and B-VERIFY
-- after it, and record the affected-row count each statement reports.
-- ############################################################################

-- ----------------------------------------------------------------------------
-- B1. Mark the Tally/purchase integration as a service account.
--
-- `ip_policy` and `allowed_ips` are RESTATED, not changed: production already
-- holds 'unrestricted' / NULL, so the account never depended on the Warehouse
-- outlet's IP rule (outlet 2, switch on, 103.213.194.119) and does not begin
-- depending on anything now. They are in the statement so the flag can never
-- be set while the policy column says 'branch', which for a flagged account
-- means "no network allowed".
--
-- Idempotent: `AND is_service_account = 0` makes a second run report 0 rows.
-- Narrow: it names the account by user_id AND username, so a copy of this
-- file run against the wrong database updates nothing.
--
-- `employee_id` IS DELIBERATELY LEFT AT 1. The integration is using a token
-- issued before the Stage 0A auth versioning, and the middleware refuses such
-- a token unless the account is still a non-system, employee-linked row whose
-- employee_id matches the token's claim. Detaching the employee here - or
-- setting is_system_account - would invalidate the live token, and issuing a
-- new one is out of scope for this change.
--
-- ---- COPY FROM HERE ----
--   START TRANSACTION;
--
--   UPDATE `user`
--      SET `is_service_account` = 1,
--          `ip_policy`   = 'unrestricted',
--          `allowed_ips` = NULL
--    WHERE `user_id` = 198
--      AND `username` = 'purchase_api'
--      AND `is_service_account` = 0;
--   -- EXPECT: 1 row affected on the first run, 0 on every run after.
--   -- Anything else: ROLLBACK and stop.
--
--   SELECT ROW_COUNT() AS rows_changed;
--
--   -- B-VERIFY. `effective_ip_source` must read 'service-unrestricted'.
--   -- 'service-unconfigured' means the policy column was not carried across
--   -- and the account would be refused at the IP check: ROLLBACK.
--   SELECT user_id, username, employee_id, is_service_account,
--          ip_policy, allowed_ips,
--          CASE
--            WHEN is_service_account = 1 AND ip_policy = 'unrestricted' THEN 'service-unrestricted'
--            WHEN is_service_account = 1 AND ip_policy = 'custom'
--                 AND allowed_ips IS NOT NULL AND allowed_ips <> ''      THEN 'service-custom'
--            WHEN is_service_account = 1                                 THEN 'service-unconfigured'
--            ELSE 'human - follows branch'
--          END AS effective_ip_source
--     FROM `user` WHERE user_id = 198;
--
--   COMMIT;   -- only after both checks above read as expected
-- ---- COPY TO HERE ----
-- ----------------------------------------------------------------------------


-- ----------------------------------------------------------------------------
-- B2. RECOVERY - let the integration's EXISTING token verify again.
--
-- SEPARATE, EXPLICIT, AND DISABLED BY DEFAULT. Run it only after B1 has
-- committed and been verified: clearing the cut-off before the account is
-- flagged just leaves it to be revoked again by the next HR action on
-- employee 1.
--
-- The account was revoked on 2026-09-17 14:04:26 UTC by an employee-wide
-- revocation it should never have been in scope for. A `token_valid_from` in
-- the future of the token's `iat` is what returns TOKEN_REVOKED; clearing it
-- restores the token that is already installed on the Tally machine. NO NEW
-- CREDENTIAL IS CREATED, NOTHING IS PRINTED, AND NO SECRET LEAVES THE
-- DATABASE. The Tally machine is not touched.
--
-- WHAT THIS DOES NOT DO - read before running it.
--   * It does NOT disable JWT expiry. `exp` is verified by the JWT layer
--     before any of this is consulted, and an expired token is refused
--     whatever `token_valid_from` holds. NULL means "no revocation cut-off
--     recorded", not "no expiry". Asserted by the regression test
--     `an expired JWT is still refused when token_valid_from is NULL`.
--   * It does NOT make the account unrevocable: naming it explicitly
--     (`bumpTokenValidFrom(user_id)`) still revokes it, and `status = 0`
--     still switches it off.
--   * It is TEMPORARY. It keeps ONE already-installed legacy token working
--     until that credential is replaced through the approved rotation
--     process, after which `employee_id` is detached and this step is
--     deleted.
--
-- The auth middleware caches session state for `tokenValidFromCacheMs`, so
-- the effect appears within that window. Nothing needs reloading.
--
-- ---- COPY FROM HERE ----
--   -- PRE-VERIFY: expect is_service_account 1, token_valid_from
--   -- '2026-09-17 14:04:26'. If is_service_account is still 0, STOP - B1
--   -- has not been applied.
--   SELECT user_id, username, is_service_account, token_valid_from
--     FROM `user` WHERE user_id = 198 AND username = 'purchase_api';
--
--   START TRANSACTION;
--
--   UPDATE `user`
--      SET `token_valid_from` = NULL
--    WHERE `user_id` = 198
--      AND `username` = 'purchase_api'
--      AND `is_service_account` = 1;
--   -- EXPECT: 1 row affected. 0 means the account is not flagged: ROLLBACK
--   -- and go back to B1.
--
--   SELECT ROW_COUNT() AS rows_changed;
--
--   -- POST-VERIFY: token_valid_from must read NULL.
--   SELECT user_id, username, is_service_account, ip_policy, allowed_ips,
--          token_valid_from
--     FROM `user` WHERE user_id = 198;
--
--   COMMIT;   -- only after both checks above read as expected
-- ---- COPY TO HERE ----
-- ----------------------------------------------------------------------------


-- ############################################################################
-- PART C - CONFIRMATION. READ-ONLY. Safe to run as-is, before and after.
-- ############################################################################

SELECT user_id, username, employee_id, status,
       is_system_account, is_service_account,
       ip_policy, allowed_ips, token_valid_from
  FROM `user`
 WHERE username IN ('purchase_api');
