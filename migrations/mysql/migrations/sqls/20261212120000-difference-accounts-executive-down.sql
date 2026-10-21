-- Nothing to undo safely: Accounts Executive may have held
-- `view_reconciliation_difference` before this migration, and the key
-- itself predates it. Remove the grant on the Designation rights screen.
SELECT 1;
