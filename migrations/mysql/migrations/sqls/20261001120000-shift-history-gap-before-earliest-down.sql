-- The rows this appended are payroll-consumed history by the time anybody
-- rolls back: attendance for the repaired dates will have been calculated
-- against them, and deleting them would move settled figures back to
-- NO_SHIFT. They are left in place deliberately, exactly as the previous
-- repair's rows are. There is no schema change to reverse.
SELECT 'No structural change to reverse; appended assignment history is retained on purpose.' AS `NOTE`;
