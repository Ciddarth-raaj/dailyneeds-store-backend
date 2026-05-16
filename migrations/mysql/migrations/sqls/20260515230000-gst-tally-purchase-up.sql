CREATE TABLE IF NOT EXISTS gst_tally_purchase (
    gst_tally_purchase_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    master_id VARCHAR(255) NOT NULL,
    retail_outlet_id INT NULL,
    supplier_id VARCHAR(20) NULL,
    supplier_name VARCHAR(100) NULL,
    supplier_gstn VARCHAR(20) NULL,
    mmh_mrc_no INT NULL,
    mmh_mrc_dt DATE NULL,
    mmh_mrc_amt DECIMAL(10, 2) NULL,
    mmh_dist_bill_dt DATE NULL,
    mmh_dist_bill_no VARCHAR(50) NULL,
    mmh_mrc_refno VARCHAR(20) NOT NULL,
    mmh_manual_disc DECIMAL(10, 2) NULL DEFAULT 0.00,
    tot_sgst_amt DECIMAL(10, 2) NULL DEFAULT 0.00,
    tot_cgst_amt DECIMAL(10, 2) NULL DEFAULT 0.00,
    tot_igst_amt DECIMAL(10, 2) NULL DEFAULT 0.00,
    tot_gst_cess_amt DECIMAL(10, 2) NULL DEFAULT 0.00,
    mmd_goods_tcs_amt DECIMAL(10, 2) NULL DEFAULT 0.00,
    ts BIGINT NULL,
    sgst JSON NULL,
    cgst JSON NULL,
    igst JSON NULL,
    cess JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (gst_tally_purchase_id),
    UNIQUE KEY uq_gst_tally_purchase_master_id (master_id),
    KEY idx_gst_tally_purchase_refno (mmh_mrc_refno)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gst_tally_purchase_internal (
    gst_tally_purchase_id BIGINT UNSIGNED NOT NULL,
    cash_discount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    scheme_difference DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    cost_difference DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    due DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    freight_charges DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    round_off DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    jv_ledger INT NULL DEFAULT NULL,
    narration TEXT NULL,
    supplier_credit_note DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    total_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    invoice_amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (gst_tally_purchase_id),
    CONSTRAINT fk_gst_tally_purchase_internal
        FOREIGN KEY (gst_tally_purchase_id)
        REFERENCES gst_tally_purchase (gst_tally_purchase_id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
