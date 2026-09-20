-- Reverses 20261029120000-shift-change-request-up.sql.
--
-- The permission rows are deleted only where nothing has been granted them;
-- a key a designation holds is left in place rather than silently revoked.

DELETE FROM `all_permissions`
 WHERE `permission_key` IN (
   'edit_shift_assignment_effective_dated',
   'raise_shift_change_request',
   'approve_shift_change_request',
   'view_shift_change_requests'
 )
   AND NOT EXISTS (
     SELECT 1 FROM `permissions` `p`
      WHERE `p`.`permission_key` = `all_permissions`.`permission_key`
   );

ALTER TABLE `attendance_date_shift_override`
  DROP INDEX `idx_adso_request`,
  DROP COLUMN `reason`,
  DROP COLUMN `source`,
  DROP COLUMN `attendance_approval_request_id`;

ALTER TABLE `attendance_approval_step`
  DROP COLUMN `decision_source`;

ALTER TABLE `attendance_approval_request`
  DROP INDEX `uq_aareq_open_per_employee_date`,
  DROP COLUMN `open_request_group`,
  ADD UNIQUE KEY `uq_aareq_open_per_employee_date`
    (`requested_for_employee_id`, `open_attendance_date`);

ALTER TABLE `attendance_approval_request`
  DROP INDEX `idx_aareq_requested_shift`,
  DROP COLUMN `telegram_message_id`,
  DROP COLUMN `telegram_chat_id`,
  DROP COLUMN `base_work_shift_id`,
  DROP COLUMN `requested_work_shift_id`,
  MODIFY COLUMN `request_type`
    ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT') NOT NULL;

ALTER TABLE `employee_work_shift_assignment`
  MODIFY COLUMN `note` VARCHAR(255) NULL,
  MODIFY COLUMN `source`
    ENUM('MIGRATION_BACKFILL','ASSIGNMENT','BULK_ASSIGNMENT','CORRECTION') NOT NULL;

ALTER TABLE `attendance_day_calculation`
  DROP COLUMN `regular_minutes`,
  DROP COLUMN `base_work_shift_id`,
  DROP COLUMN `base_nrm_minutes`;
