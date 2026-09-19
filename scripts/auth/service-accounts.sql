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
         WHERE s.employee_id = u.employee_id AND s.user_id <> u.user_id) AS other_logins_on_this_employee,
       -- WHAT FLAGGING THIS ACCOUNT WILL CHANGE ABOUT ITS NETWORK POLICY.
       -- Today it follows the employee's outlet. Once flagged it follows
       -- NOTHING, and `branch` - the column default - resolves to "no
       -- network is allowed". These four columns are the whole decision:
       -- read them before step 1, and carry the answer into step 1's
       -- `ip_policy`.
       u.ip_policy            AS ip_policy_today,
       u.allowed_ips          AS own_allow_list_today,
       ne.store_id            AS inherited_outlet_id,
       o.ip_restriction_enabled AS inherited_branch_switch,
       o.allowed_ips          AS inherited_branch_allow_list
  FROM `user` u
  LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
  LEFT JOIN outlets o ON o.outlet_id = ne.store_id
 WHERE u.employee_id IS NOT NULL
   AND u.status = 1
 ORDER BY other_logins_on_this_employee DESC, u.last_login_at IS NOT NULL, u.username;

-- ----------------------------------------------------------------------------
-- STEP 0b. THE CHECKLIST, per account, BEFORE setting is_service_account = 1.
--
--   1. Is this login really a machine? A human account flagged by mistake
--      stops being revoked when that person resigns. That is the one
--      direction of this change that WEAKENS security, and it is why no
--      query decides it.
--   2. Does anything else depend on its employee link? Its token does, if it
--      is a pre-Stage-0A token: the middleware checks the token's
--      employee_id claim against the row. Leave `employee_id` alone unless a
--      new credential is being issued at the same time.
--   3. WHAT NETWORK MAY IT CALL FROM? Read `inherited_branch_switch` above.
--        NULL or 0  the account is effectively unrestricted today. Choose
--                   'unrestricted' to preserve exactly that, or - better -
--                   'custom' with the integration machine's fixed public
--                   address, which is strictly tighter than today.
--        1          it is already restricted to that outlet's list. Copy the
--                   addresses the integration actually uses into 'custom';
--                   do not assume the whole branch list is still right.
--      There is no third option: leaving `ip_policy` at 'branch' flags the
--      account into "no network allowed" and the integration stops at the
--      IP check instead of the token check. Step 1 therefore sets both
--      columns in ONE statement.
--   4. Where does it call from in practice? Confirm against the reverse
--      proxy's access log before choosing the list. Do not take the address
--      from this file.
-- ----------------------------------------------------------------------------

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
-- THE FLAG AND THE POLICY ARE SET TOGETHER. A service account does not
-- follow a branch any more, and `branch` (the column default) resolves to
-- "no network allowed" for one - so flagging without deciding the policy
-- would trade a token outage for an IP outage.
--
-- <<REVIEWER: replace the placeholder below using step 0/0b.>>
--   'unrestricted'  preserves today's behaviour EXACTLY when
--                   inherited_branch_switch is NULL or 0. Choose it only if
--                   the integration's address is genuinely not fixed.
--   'custom'        preferred. Put the integration machine's public address
--                   (or its /32, or the office's fixed range) in
--                   `allowed_ips`, comma-separated. Tighter than today.
--
-- START TRANSACTION;
UPDATE `user`
   SET `is_service_account` = 1,
       `ip_policy` = 'custom',               -- or 'unrestricted', decided above
       `allowed_ips` = '<<TALLY_EGRESS_IP>>' -- NULL when ip_policy = 'unrestricted'
 WHERE `user_id` = 198
   AND `username` = 'purchase_api'
   AND `is_service_account` = 0;
-- Expect: 1 row on the first run, 0 on every run after.
--
-- VERIFY BEFORE COMMIT - `effective_ip_source` must NOT be
-- 'service-unconfigured':
SELECT user_id, username, is_service_account, ip_policy, allowed_ips,
       CASE
         WHEN is_service_account = 1 AND ip_policy = 'unrestricted' THEN 'service-unrestricted'
         WHEN is_service_account = 1 AND ip_policy = 'custom'
              AND allowed_ips IS NOT NULL AND allowed_ips <> ''       THEN 'service-custom'
         WHEN is_service_account = 1                                  THEN 'service-unconfigured'
         ELSE 'human - follows branch'
       END AS effective_ip_source
  FROM `user` WHERE user_id = 198;
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
--
-- WHAT THIS DOES NOT DO - read this before running it.
--
--   * It does NOT disable JWT expiry. `exp` is verified by the JWT layer
--     before any of this is consulted, and an expired token is refused
--     whatever `token_valid_from` holds. NULL means "no revocation cut-off
--     recorded", not "no expiry". See the regression test
--     `an expired JWT is still refused when token_valid_from is NULL`.
--   * It does NOT make the account permanently unrevocable: naming it
--     explicitly (`bumpTokenValidFrom(user_id)`) still revokes it, and
--     `status = 0` still switches it off.
--   * It is TEMPORARY. It keeps ONE already-installed legacy token working
--     until that credential is replaced through the approved rotation
--     process. It is not the end state - see the migration plan in the
--     change's description.
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
       is_service_account, ip_policy, allowed_ips, token_valid_from
  FROM `user`
 WHERE username IN ('purchase_api');
