-- Remove the Admin "Revoke Approval" audit table.
--
-- THE TABLE IS DROPPED BECAUSE THIS MIGRATION CREATED IT and nothing else
-- depends on it. Every revocation record goes with it - the known cost of
-- reversing this feature, and why a down migration is a deliberate act.
--
-- NO REQUEST, STEP, PUNCH, ATTENDANCE OR PAYROLL ROW IS TOUCHED. A request an
-- administrator reopened stays exactly as it is now (reopened, or decided
-- again since); rolling back the feature does not re-decide anything.
DROP TABLE IF EXISTS `attendance_approval_revocation`;
