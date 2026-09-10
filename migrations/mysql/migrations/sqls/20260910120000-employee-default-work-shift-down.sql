-- Reverses the employee -> work shift mapping column.
--
-- Only what the up added, in the order MySQL requires: the constraint first,
-- then the index it was using, then the column. `shift_id` and `shift_code`
-- were never touched on the way up and are not touched here either, so both
-- directions of this migration leave the legacy shift system alone.
--
-- Dropping the column discards the manual assignments HR has made. That is
-- the honest consequence of reversing the feature, and there is nowhere else
-- to put them: nothing else in the schema holds this mapping.
ALTER TABLE `new_employee`
  DROP FOREIGN KEY `fk_new_employee_default_work_shift`;

ALTER TABLE `new_employee`
  DROP INDEX `idx_new_employee_default_work_shift`,
  DROP COLUMN `default_work_shift_id`;
