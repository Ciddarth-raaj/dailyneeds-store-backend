-- Reverses Work Shift Phase 1.
--
-- Only the two tables this migration created are dropped. `shift_master` was
-- never touched on the way up, so there is nothing to restore on the way
-- down: the live shift system and `new_employee.shift_id` are unaffected by
-- both directions of this migration.
--
-- The schedule table goes first: it holds the FK onto `work_shift`.

DROP TABLE IF EXISTS `work_shift_weekly_schedule`;
DROP TABLE IF EXISTS `work_shift`;
