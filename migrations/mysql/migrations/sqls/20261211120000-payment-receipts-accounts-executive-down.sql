-- Nothing to undo safely: Accounts Executive may have held
-- `view_payment_receipts_reconciliation` before this migration, and the key
-- itself predates it. Remove the grant on the Designation rights screen.
SELECT 1;
