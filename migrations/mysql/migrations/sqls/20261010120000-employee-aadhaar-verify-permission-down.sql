-- Reverses the existing-employee Aadhaar verification permission.
--
-- Only the one key this migration introduced. Every other grant -
-- `view_employee_aadhaar`, `employee_create`, `employee_edit`,
-- `edit_employee_sensitive`, `view_aadhaar_full` and anything an administrator
-- granted by hand - is untouched.
--
-- ROLLING BACK THE SQL ALONE FAILS CLOSED: with the key gone and the code
-- still deployed, only administrators can verify an existing employee's
-- Aadhaar. New-employee onboarding is unaffected - it never used this key.
DELETE FROM `permissions` WHERE `permission_key` IN (
  'verify_employee_aadhaar'
);
DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'verify_employee_aadhaar'
);
