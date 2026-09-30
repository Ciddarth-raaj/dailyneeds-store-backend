-- Reverses 20261107120000-attendance-permission-up.sql.
--
-- REFUSES TO LOSE DATA SILENTLY: a PERMISSION request cannot survive the
-- request_type ENUM shrinking, so the down migration deletes nothing and
-- fails on the ENUM change while any PERMISSION request exists. Whoever rolls
-- back decides what happens to them first.
--
-- The permission keys are deleted only where nothing has been granted them.

DELETE FROM `all_permissions`
 WHERE `permission_key` IN (
   'view_attendance_permissions',
   'raise_attendance_permission_request',
   'raise_attendance_permission_for_others',
   'approve_attendance_permission',
   'grant_attendance_permission',
   'grant_attendance_permission_bulk',
   'revoke_attendance_permission'
 )
   AND NOT EXISTS (
     SELECT 1 FROM `permissions` `p`
      WHERE `p`.`permission_key` = `all_permissions`.`permission_key`
   );

ALTER TABLE `attendance_monthly_payroll`
  DROP COLUMN `permission_minutes`;

ALTER TABLE `attendance_day_calculation`
  DROP COLUMN `payable_minutes`,
  DROP COLUMN `shortage_before_permission_minutes`,
  DROP COLUMN `permission_away_minutes`,
  DROP COLUMN `permission_early_minutes`,
  DROP COLUMN `permission_late_minutes`,
  DROP COLUMN `permission_minutes`,
  DROP COLUMN `permission_window_minutes`,
  DROP COLUMN `permission_ids`;

DROP TABLE IF EXISTS `attendance_permission_bulk_item`;
DROP TABLE IF EXISTS `attendance_permission`;
DROP TABLE IF EXISTS `attendance_permission_bulk_operation`;

ALTER TABLE `attendance_approval_request`
  DROP INDEX `uq_aareq_open_per_employee_date`,
  DROP COLUMN `open_request_group`;
ALTER TABLE `attendance_approval_request`
  ADD COLUMN `open_request_group` ENUM('ATT','SHIFT') GENERATED ALWAYS AS
    (CASE WHEN `status` = 'PENDING'
          THEN (CASE WHEN `request_type` = 'SHIFT_CHANGE' THEN 'SHIFT' ELSE 'ATT' END)
          ELSE NULL END) STORED,
  ADD UNIQUE KEY `uq_aareq_open_per_employee_date`
    (`requested_for_employee_id`, `open_attendance_date`, `open_request_group`);

ALTER TABLE `attendance_approval_request`
  MODIFY COLUMN `request_type`
    ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE') NOT NULL;
