-- Reverse of the Global Dashboard scope declaration.
--
-- It removes the five keys this migration declared, and any designation grant
-- of them, so a rollback leaves the rights table as it found it. Deleting the
-- grants matters: a key row removed from `all_permissions` while a `permissions`
-- row still names it would leave an orphan that the rights screen cannot show
-- and nobody can revoke.
--
-- `view_attendance_dashboard` is NOT removed here - it belongs to the earlier
-- migration and that one owns its own rollback.

DELETE FROM `permissions` WHERE `permission_key` IN (
  'view_hr_dashboard', 'view_sales_dashboard', 'view_my_dashboard',
  'dashboard_scope_own_store', 'dashboard_scope_all_stores' );

DELETE FROM `all_permissions` WHERE `permission_key` IN (
  'view_hr_dashboard', 'view_sales_dashboard', 'view_my_dashboard',
  'dashboard_scope_own_store', 'dashboard_scope_all_stores' );
