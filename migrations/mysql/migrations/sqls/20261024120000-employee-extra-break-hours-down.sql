-- Drops the column. Attendance falls back to the shift's own break allowance
-- for everybody, which is what it did before this feature; any recorded
-- values are lost, the honest cost of reversing an additive column.
ALTER TABLE `new_employee`
  DROP COLUMN `extra_break_hours`;
