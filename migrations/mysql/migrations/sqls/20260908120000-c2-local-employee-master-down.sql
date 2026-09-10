-- Reverses C2's grants and key declarations. The AUTO_INCREMENT seed is NOT
-- reversed: lowering the counter would risk handing out an id that has
-- already been used, and leaving it high costs nothing.
--
-- Only the five C2 keys are removed, and only from designations. Nothing
-- else in `permissions` is touched, and `add_employees` is left exactly as
-- it was.
DELETE FROM `permissions`
 WHERE `permission_key` IN ('employee_create','employee_edit','employee_resign','employee_rejoin','view_employee_lifecycle');
DELETE FROM `all_permissions`
 WHERE `permission_key` IN ('employee_create','employee_edit','employee_resign','employee_rejoin','view_employee_lifecycle');
