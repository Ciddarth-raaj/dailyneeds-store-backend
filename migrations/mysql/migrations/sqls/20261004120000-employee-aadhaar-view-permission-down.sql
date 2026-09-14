-- Reverses the Aadhaar status permission.
--
-- Only the one key this migration introduced. Every other grant -
-- `view_employee_lifecycle`, `employee_create`, `employee_edit`,
-- `view_aadhaar_full` and anything an administrator granted by hand - is
-- untouched.
--
-- ROLLING BACK THE SQL ALONE FAILS CLOSED: with the key gone and the code
-- still deployed, only administrators can read Aadhaar status. Restoring the
-- previous behaviour means deploying the previous code too, which is what a
-- rollback is.
DELETE FROM `permissions` WHERE `permission_key` IN (
  'view_employee_aadhaar'
);
DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'view_employee_aadhaar'
);
