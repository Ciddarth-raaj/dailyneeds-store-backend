-- Reverses the Payrun Adjustments migration.
--
-- The three tables all have foreign keys onto `payrun_employee`; none has one
-- onto another of the three, so the order below is only for readability.
--
-- NO PERMISSION KEY IS DELETED because the up-migration declares none - see
-- the note at the end of it. The stage reuses `process_payroll`, which the
-- initialization stage already claimed, and deleting that here would take the
-- Initialize button away from everyone who has it.
DROP TABLE IF EXISTS `payrun_employee_adjustment_audit`;
DROP TABLE IF EXISTS `payrun_employee_adjustment_state`;
DROP TABLE IF EXISTS `payrun_employee_adjustment`;
