-- =====================================================================
-- Stage 0A / B2 — mark accounts found by default-password-scan.sql
--
-- WRITES to `user`. Run per branch, one batch at a time, after the scan has
-- been reviewed. Replace 'DN1' with the batch's outlet_code. Never run
-- without the WHERE clause on outlet.
--
-- Flagging does not change anyone's password and does not sign anyone out.
-- It makes the next login present the change-password screen once
-- AUTH_ENFORCE_PASSWORD_CHANGE=true (Deployment B).
--
-- Rollback for one batch:
--   UPDATE `user` SET must_change_password = 0, password_flag_reason = NULL
--   WHERE password_flag_reason = 'default_scan' AND user_id IN (...);
-- =====================================================================

SET @batch_outlet_code = 'DN1';

UPDATE `user` u
LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
LEFT JOIN outlets o       ON o.outlet_id = ne.store_id
SET u.must_change_password = 1,
    u.password_flag_reason = 'default_scan'
WHERE u.password_algo = 'sha1'
  AND u.password IS NOT NULL
  AND u.is_system_account = 0
  AND u.must_change_password = 0
  AND o.outlet_code = @batch_outlet_code
  AND (
       u.password = SHA1(CONCAT(u.employee_id, '@123'))
    OR u.password = SHA1('password')
    OR u.password = SHA1(CAST(u.employee_id AS CHAR))
    OR u.password = SHA1(u.username)
    OR (ne.primary_contact_number IS NOT NULL AND u.password = SHA1(ne.primary_contact_number))
  );

-- Admin accounts are flagged regardless of branch, in the first batch:
-- UPDATE `user` SET must_change_password = 1, password_flag_reason = 'admin_policy'
-- WHERE user_type = 2 AND is_system_account = 0 AND must_change_password = 0;

-- Progress tracking for the report:
SELECT
  COALESCE(o.outlet_code, '(no branch)') AS outlet_code,
  SUM(u.must_change_password = 1)                                        AS flagged_pending,
  SUM(u.password_flag_reason IS NOT NULL AND u.must_change_password = 0) AS flagged_completed,
  SUM(u.password_algo = 'scrypt')                                        AS on_modern_hash,
  SUM(u.password_algo = 'sha1')                                          AS still_sha1,
  COUNT(*)                                                               AS accounts
FROM `user` u
LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id
LEFT JOIN outlets o       ON o.outlet_id = ne.store_id
WHERE u.status = 1 AND u.is_system_account = 0
GROUP BY o.outlet_code WITH ROLLUP;
