-- Drops both provenance columns. Nothing calculates from them - they explain
-- a stored figure, they do not produce one - so no number changes; what is
-- lost is the ability to say which of the two employee settings produced a
-- historical allowance.
ALTER TABLE `attendance_day_calculation`
  DROP COLUMN `break_override_minutes_applied`,
  DROP COLUMN `extra_break_minutes_applied`;
