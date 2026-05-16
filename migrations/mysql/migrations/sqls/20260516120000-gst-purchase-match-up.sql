CREATE TABLE IF NOT EXISTS gst_purchase_match (
    gst_purchase_match_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    gst_tally_purchase_id BIGINT UNSIGNED NULL,
    purchase_id BIGINT NULL,
    matched_by INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (gst_purchase_match_id),
    KEY idx_gst_purchase_match_gst (gst_tally_purchase_id),
    KEY idx_gst_purchase_match_purchase (purchase_id),
    KEY idx_gst_purchase_match_matched_by (matched_by),
    CONSTRAINT fk_gst_purchase_match_gst
        FOREIGN KEY (gst_tally_purchase_id)
        REFERENCES gst_tally_purchase (gst_tally_purchase_id)
        ON DELETE SET NULL,
    CONSTRAINT fk_gst_purchase_match_purchase
        FOREIGN KEY (purchase_id)
        REFERENCES purchase (purchase_id)
        ON DELETE SET NULL,
    CONSTRAINT fk_gst_purchase_match_employee
        FOREIGN KEY (matched_by)
        REFERENCES new_employee (employee_id)
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
