-- =====================================================================
-- Account Sheet: Wallet Transactions.
--
-- Two optional amounts per Account Sheet, recording money received into
-- and paid out of the store's digital wallet. They are a simple movement
-- record (Net = receipt - payment): they take no part in Total Sales,
-- Cash Sales, Cash Handover or the Total Difference, and there is no
-- wallet ledger, opening or closing balance.
--
-- Additive only. Existing sheets read 0.00 for both through the default;
-- no existing column or row is changed.
-- =====================================================================

ALTER TABLE accounts
    ADD COLUMN wallet_receipt DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Amount received into the store digital wallet' AFTER sales_return,
    ADD COLUMN wallet_payment DECIMAL(12,2) NOT NULL DEFAULT 0.00 COMMENT 'Amount paid out from the store digital wallet' AFTER wallet_receipt;
