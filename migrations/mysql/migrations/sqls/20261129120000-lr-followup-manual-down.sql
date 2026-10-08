-- Restores NOT NULL. Manual LR Follow-ups created since the up migration
-- carry no bill, amount or bill date; they are given placeholder values
-- first (the bill reference is unique per supplier, so it is made from the
-- row's own id), otherwise the columns could not be made mandatory again.

UPDATE credit_purchases
   SET bill_reference     = COALESCE(bill_reference, CONCAT('MANUAL-', credit_purchase_id)),
       bill_reference_key = COALESCE(bill_reference_key, CONCAT('MANUAL', credit_purchase_id)),
       amount             = COALESCE(amount, 0),
       bill_date          = COALESCE(bill_date, DATE(created_at))
 WHERE bill_reference IS NULL OR bill_reference_key IS NULL
    OR amount IS NULL OR bill_date IS NULL;

UPDATE lr_followup SET amount = 0 WHERE amount IS NULL;

ALTER TABLE lr_followup
    MODIFY amount DECIMAL(12,2) NOT NULL;

ALTER TABLE credit_purchases
    MODIFY bill_reference     VARCHAR(100)  NOT NULL COMMENT 'Bill / invoice reference as entered (trimmed)',
    MODIFY bill_reference_key VARCHAR(100)  NOT NULL,
    MODIFY amount             DECIMAL(12,2) NOT NULL,
    MODIFY bill_date          DATE          NOT NULL COMMENT 'Invoice / bill date; the follow-up ages from here';
