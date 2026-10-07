-- Reverses 20261126120000.
--
-- WARNING: the old groups admit ONE pending 'ATT' request a date. If a date
-- has BOTH a pending system OT and a pending regularization (which this
-- migration allows), restoring them violates `uq_aareq_open_per_employee_date`
-- and this down STOPS with a duplicate-key error: decide or withdraw one of
-- the two first. Nothing is rewritten to force it.
--
-- THE GROUPS ARE RESTORED FIRST, IN ONE STATEMENT, so a refusal changes
-- nothing at all (a single ALTER either completes or leaves the table as it
-- was); only then are the OT key and the deferred tables removed.
ALTER TABLE `attendance_approval_request`
  MODIFY COLUMN `open_request_group` ENUM('ATT','SHIFT','PERM') GENERATED ALWAYS AS
    (CASE WHEN `status` = 'PENDING'
          THEN (CASE WHEN `request_type` = 'SHIFT_CHANGE' THEN 'SHIFT'
                     WHEN `request_type` = 'PERMISSION' THEN 'PERM'
                     ELSE 'ATT' END)
          ELSE NULL END) STORED;

ALTER TABLE `attendance_approval_request`
  DROP INDEX `uq_aareq_open_ot_per_employee_date`,
  DROP COLUMN `open_ot_attendance_date`;

DROP TABLE IF EXISTS `attendance_ot_deferred_sync_log`;
DROP TABLE IF EXISTS `attendance_ot_deferred_sync`;
