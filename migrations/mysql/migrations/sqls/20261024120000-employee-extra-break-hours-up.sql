-- EXTRA BREAK HOURS ON THE EMPLOYEE MASTER.
--
-- One employee-specific duration, in HOURS, that is ADDED to the break the
-- day's shift already allows:
--
--     employeeAllowedBreak = shiftAllowedBreak + extra_break_hours
--
-- It does not replace the shift's break and it never touches the Shift
-- Master: the shift keeps its own allowance for everybody, and this is an
-- adjustment the attendance engine applies per employee, per date.
--
-- HOURS AND NOT MINUTES, because that is the unit the field is stated and
-- labelled in - half an hour is 0.50 - and DECIMAL and not FLOAT because
-- 0.5 of an hour must come back as 0.5 and not as 0.49999. Two decimals is
-- 36-second granularity, well past anything a break is ever set to, and the
-- application rounds to whole minutes before the engine sees it.
--
-- ADDITIVE AND BACKWARD-COMPATIBLE. NULLable with no default and no backfill,
-- so every existing employee keeps a row that calculates exactly as it does
-- today: NULL and 0 both mean "nothing extra" and the engine adds nothing.
-- The setting is only ever credited on a date with four or more valid
-- punches; a two-punch day is charged the shift's break under the unchanged
-- phased rule.
ALTER TABLE `new_employee`
  ADD COLUMN `extra_break_hours` DECIMAL(4,2) NULL DEFAULT NULL
    COMMENT 'employee-specific break hours ADDED to the shift allowed break, credited only on a day with four or more punches';
