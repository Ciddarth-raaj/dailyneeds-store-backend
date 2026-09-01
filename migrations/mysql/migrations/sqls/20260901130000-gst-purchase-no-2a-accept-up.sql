-- A purchase whose supplier will never file it in GSTR-2A (nil-rated, exempt or
-- composition) has no 2A document to match against, so it would sit unmatched
-- forever. Accepting one records that absence as expected rather than missing.
CREATE TABLE IF NOT EXISTS gst_purchase_no_2a_accept (
    gst_purchase_no_2a_accept_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    gst_tally_purchase_id BIGINT UNSIGNED NOT NULL,
    accepted_by INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (gst_purchase_no_2a_accept_id),
    UNIQUE KEY uq_gst_purchase_no_2a_accept_purchase (gst_tally_purchase_id),
    KEY idx_gst_purchase_no_2a_accept_by (accepted_by),
    CONSTRAINT fk_gst_purchase_no_2a_accept_purchase
        FOREIGN KEY (gst_tally_purchase_id)
        REFERENCES gst_tally_purchase (gst_tally_purchase_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_gst_purchase_no_2a_accept_employee
        FOREIGN KEY (accepted_by)
        REFERENCES new_employee (employee_id)
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
