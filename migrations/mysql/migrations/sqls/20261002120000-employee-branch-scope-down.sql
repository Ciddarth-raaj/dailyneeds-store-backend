-- Reverses the employee branch scope key.
--
-- Only the one key this migration introduced, by name. Every other grant is
-- untouched.
--
-- ROLLING BACK THE SQL ALONE WOULD FAIL CLOSED, NOT OPEN: with the key gone
-- but the code still deployed, only administrators resolve to company-wide
-- employee access and HR is confined to its own branch. Restoring the previous
-- behaviour means deploying the previous code too, which is what a rollback is.
DELETE FROM `permissions` WHERE `permission_key` IN (
  'employee_scope_all_branches'
);
DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'employee_scope_all_branches'
);
