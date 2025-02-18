CREATE TABLE purchase (
    purchase_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    retail_outlet_id INT,
    supplier_id VARCHAR(20),
    supplier_name VARCHAR(100),
    supplier_gstn VARCHAR(20),
    mmh_mrc_no INT,
    mmh_mrc_dt DATE,
    mmh_mrc_amt DECIMAL(10,2),
    mmh_dist_bill_dt DATE,
    mmh_dist_bill_no VARCHAR(50),
    mmh_mrc_refno VARCHAR(20),
    mmh_manual_disc DECIMAL(10,2),
    tot_sgst_amt DECIMAL(10,2),
    tot_cgst_amt DECIMAL(10,2),
    tot_igst_amt DECIMAL(10,2),
    tot_gst_cess_amt DECIMAL(10,2),
    mmd_goods_tcs_amt DECIMAL(10,2),
    ts BIGINT,
    sgst JSON,
    cgst JSON,
    igst JSON,
    cess JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE `purchase` ADD `has_updated` BOOLEAN NOT NULL DEFAULT FALSE AFTER `cess`;