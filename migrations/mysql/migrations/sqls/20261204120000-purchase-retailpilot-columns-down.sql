-- Fails (strict mode) once a RetailPilot slug is stored in mmh_mrc_no or a
-- reference / supplier id is longer than 20 characters.
ALTER TABLE `purchase`
  MODIFY `mmh_mrc_no` INT NULL,
  MODIFY `mmh_mrc_refno` VARCHAR(20) NULL,
  MODIFY `supplier_id` VARCHAR(20) NULL;

ALTER TABLE `gst_tally_purchase`
  MODIFY `mmh_mrc_no` INT NULL,
  MODIFY `mmh_mrc_refno` VARCHAR(20) NOT NULL,
  MODIFY `supplier_id` VARCHAR(20) NULL;
