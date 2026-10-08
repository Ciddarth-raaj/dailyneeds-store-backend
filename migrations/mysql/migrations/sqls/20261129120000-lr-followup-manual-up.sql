-- =====================================================================
-- LR Follow-up: manual entry replaces the Credit Purchase entry.
--
-- A user now creates an LR Follow-up directly ("Create LR Follow-up") with
-- just the supplier and the transporter, plus optional LR No., dispatch
-- date, expected delivery date and remarks. No bill / invoice reference,
-- amount, bill date or receiving outlet is asked for: every such delivery
-- goes to the Warehouse, and the application records that outlet itself.
--
-- The internal names stay as they are. `credit_purchases` and the
-- 'CREDIT_PURCHASE' source type shipped in 20261109120000-lr-followup and
-- are live, so renaming them would be a risky table / enum migration for
-- no behavioural gain. The API and every screen call them "manual" LR
-- Follow-ups; only the database keeps the old words.
--
-- The four columns become optional. Rows already entered keep their
-- values, and the duplicate key on (distributor_code, bill_reference_key)
-- still protects them - NULL keys never collide, so manual follow-ups,
-- which carry no bill, are never refused by it.
--
-- lr_followup.amount becomes optional for the same reason: a manual
-- follow-up has no amount, and 0 would read as a real figure on the
-- dashboard's outstanding total.
--
-- Nothing else changes: no status, no closing rule, no permission key.
-- =====================================================================

ALTER TABLE credit_purchases
    MODIFY bill_reference     VARCHAR(100)  NULL COMMENT 'Bill / invoice reference as entered (trimmed); NULL on a manual LR Follow-up',
    MODIFY bill_reference_key VARCHAR(100)  NULL,
    MODIFY amount             DECIMAL(12,2) NULL,
    MODIFY bill_date          DATE          NULL COMMENT 'Invoice / bill date; NULL on a manual LR Follow-up';

ALTER TABLE lr_followup
    MODIFY amount DECIMAL(12,2) NULL COMMENT 'NULL on a manual LR Follow-up, which carries no amount';
