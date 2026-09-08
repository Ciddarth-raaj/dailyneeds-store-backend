-- Stage 0C / C3 — reverse of the HR employee-history schema.
--
-- REVERSIBLE ONLY BEFORE ACTIVATION. This drops the history tables, and with
-- them every Assignment, Default Shift and Salary row they hold. Before
-- HISTORY_ACTIVE that is exactly right: nothing authoritative lives there yet
-- and the projections on `new_employee` are still the operating truth.
--
-- AFTER HISTORY_ACTIVE IT IS NOT A ROLLBACK. Once history is authoritative,
-- running this destroys the only record of who was transferred, promoted or
-- given a rise, and leaves the projections behind with no explanation of how
-- they got their values. The runbook says so plainly: rollback after
-- activation is a restore from the pre-activation backup, not a down
-- migration.
--
-- Nothing here touches `new_employee`, its employee IDs, the C1 lifecycle
-- periods and events, Aadhaar or bank data. The projection columns are left
-- exactly as they are - they were never this migration's to create.

-- Order matters: children before parents.
DROP TABLE IF EXISTS `employee_assignment_batch_item`;
DROP TABLE IF EXISTS `employee_assignment_batch`;
DROP TABLE IF EXISTS `hr_baseline_row`;
DROP TABLE IF EXISTS `hr_baseline_batch`;
DROP TABLE IF EXISTS `hr_governed_shadow_violation`;

DROP TABLE IF EXISTS `employee_salary_history`;
DROP TABLE IF EXISTS `employee_default_shift_history`;
DROP TABLE IF EXISTS `employee_assignment`;

DROP TABLE IF EXISTS `department_designation_map`;
DROP TABLE IF EXISTS `hr_cutover_state`;

-- ---------------------------------------------------- the added columns --
-- Guarded, so the file can be re-run.
SET @drop_lock = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_employment_period'
      AND `COLUMN_NAME` = 'history_locked_through') = 1,
  'ALTER TABLE `employee_employment_period` DROP COLUMN `history_locked_through`',
  'DO 0');
PREPARE s FROM @drop_lock; EXECUTE s; DEALLOCATE PREPARE s;

SET @drop_dept_idx = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'department'
      AND `INDEX_NAME` = 'idx_department_parent') > 0,
  'ALTER TABLE `department` DROP INDEX `idx_department_parent`',
  'DO 0');
PREPARE s FROM @drop_dept_idx; EXECUTE s; DEALLOCATE PREPARE s;

SET @drop_dept_parent = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'department'
      AND `COLUMN_NAME` = 'parent_department_id') = 1,
  'ALTER TABLE `department` DROP COLUMN `parent_department_id`',
  'DO 0');
PREPARE s FROM @drop_dept_parent; EXECUTE s; DEALLOCATE PREPARE s;

SET @drop_desig_idx = IF(
  (SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'designation'
      AND `INDEX_NAME` = 'idx_designation_parent') > 0,
  'ALTER TABLE `designation` DROP INDEX `idx_designation_parent`',
  'DO 0');
PREPARE s FROM @drop_desig_idx; EXECUTE s; DEALLOCATE PREPARE s;

SET @drop_desig_parent = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'designation'
      AND `COLUMN_NAME` = 'parent_designation_id') = 1,
  'ALTER TABLE `designation` DROP COLUMN `parent_designation_id`',
  'DO 0');
PREPARE s FROM @drop_desig_parent; EXECUTE s; DEALLOCATE PREPARE s;

-- ------------------------------------------------------- the permissions --
-- Only the keys this migration declared, and only where no designation was
-- ever granted one. A grant somebody made deliberately is not this file's to
-- remove.
DELETE FROM `all_permissions`
 WHERE `permission_key` IN (
   'manage_employee_assignment','correct_employee_assignment','manage_employee_shift',
   'manage_employee_salary','correct_employee_salary','manage_department_tree',
   'manage_designation_tree','manage_designation_mapping','hr_baseline_review',
   'hr_activate_history'
 )
   AND NOT EXISTS (
     SELECT 1 FROM `permissions` p WHERE p.`permission_key` = `all_permissions`.`permission_key`
   );
