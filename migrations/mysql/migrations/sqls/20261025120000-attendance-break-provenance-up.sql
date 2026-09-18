-- WHICH EMPLOYEE-SPECIFIC BREAK SETTINGS A CALCULATION ACTUALLY APPLIED.
--
-- `attendance_day_calculation` already stores the TOTAL allowance
-- (`break_allowance_minutes`), whether it was the employee's or the shift's
-- (`break_allowance_source`) and the shift configuration it read
-- (`shift_snapshot`). What it cannot do is SPLIT an employee-specific
-- allowance into the two settings that can produce one: a Special Break
-- Duration Override, which REPLACES the shift's break, and Extra Break Hours,
-- which are ADDED on top of whatever was resolved. With both in play the
-- total is one number and the snapshot's own break is no longer a subtrahend
-- that means anything, so "why was this date's NRM 630" could not be answered
-- from the row.
--
-- Neither setting has any change history - both are single current values on
-- `new_employee` - so once somebody edits one, the value in force when a
-- historical date was calculated is unrecoverable unless the calculation
-- recorded it. These two columns record it.
--
-- WHAT THEY MEAN: what was APPLIED on that date, not what was configured.
--
--   shift break only        override = NULL, extra = 0
--   shift + extra 30        override = NULL, extra = 30
--   override 90             override = 90,   extra = 0
--   override 90 + extra 30  override = 90,   extra = 30
--   two punches             extra = 0 (an unpunched break is never credited)
--   five punches            extra = 0 (an incomplete sequence, likewise)
--
-- NULL means "not applied" for the override, which is a real and different
-- state from an applied override of 0 ("charge this employee no break at
-- all"). For the extra break 0 and NULL both mean nothing extra, so a
-- calculation writes 0 and NULL is reserved for the rows below.
--
-- NO BACKFILL. Every row written before this migration keeps NULL in both,
-- because what those calculations applied cannot be proven after the fact -
-- the settings they read may have been edited since. A guess dressed as
-- provenance is worse than an honest blank. The columns fill in as dates are
-- recalculated.
ALTER TABLE `attendance_day_calculation`
  ADD COLUMN `break_override_minutes_applied` INT NULL DEFAULT NULL
    COMMENT 'the Special Break Duration Override actually applied on this date. NULL = none applied (or written before this column existed)',
  ADD COLUMN `extra_break_minutes_applied` INT NULL DEFAULT NULL
    COMMENT 'the Extra Break Hours actually applied on this date, in minutes. 0 = none credited. NULL = written before this column existed';
