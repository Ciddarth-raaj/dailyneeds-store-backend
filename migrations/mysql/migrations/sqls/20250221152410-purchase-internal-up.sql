CREATE TABLE purchase_internal (
    purchase_id BIGINT PRIMARY KEY,
    cash_discount DECIMAL(10,2) DEFAULT 0.00,
    scheme_difference DECIMAL(10,2) DEFAULT 0.00,
    cost_difference DECIMAL(10,2) DEFAULT 0.00,
    due DECIMAL(10,2) DEFAULT 0.00,
    freight_charges DECIMAL(10,2) DEFAULT 0.00,
    round_off DECIMAL(10,2) DEFAULT 0.00,
    jv_ledger DECIMAL(10,2) DEFAULT 0.00,
    narration TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (purchase_id) REFERENCES purchase(purchase_id)
);

ALTER TABLE `purchase` ADD `updated_at` TIMESTAMP on update CURRENT_TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `has_updated`;
ALTER TABLE `purchase` ADD `is_approved` BOOLEAN NOT NULL DEFAULT FALSE AFTER `has_updated`;
ALTER TABLE `purchase_internal` ADD `supplier_credit_note` DECIMAL(10, 2) NOT NULL AFTER `narration`, ADD `total_amount` DECIMAL(10, 2) NOT NULL AFTER `supplier_credit_note`;