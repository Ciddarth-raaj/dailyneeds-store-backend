-- Reverses 20261031130000-staff-budget-permissions-up.sql.
--
-- The up migration writes no grants, but a person may have granted these keys
-- on the permissions screen since it ran; those rows go too, or the keys would
-- be undeclared and still held. No other permission is touched, and no table,
-- column or budget row is.
DELETE FROM `permissions`
 WHERE `permission_key` IN ('view_staff_budget', 'edit_staff_budget');
DELETE FROM `all_permissions`
 WHERE `permission_key` IN ('view_staff_budget', 'edit_staff_budget');
