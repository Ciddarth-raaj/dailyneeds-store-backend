-- Reverses the Employee -> Work Shift mapping column.
--
-- The constraint goes first: MySQL will not drop a column that a foreign key
-- still sits on.
--
-- Only what the up migration created is removed. `shift_id`, `shift_code` and
-- `shift_master` were never touched on the way up, so there is nothing to
-- restore on the way down - the legacy shift system is unaffected by both
-- directions of this migration.
--
-- Dropping the column discards the manual assignments HR has entered. That is
-- the correct reversal of "add the column", but it is not recoverable from
-- anywhere else, because nothing derives these values.

ALTER TABLE `new_employee`
  DROP FOREIGN KEY `fk_new_employee_default_work_shift_id`;

ALTER TABLE `new_employee`
  DROP COLUMN `default_work_shift_id`;
