-- RetailPilot invoice slugs and supplier IDs can be longer than the
-- 20 characters GoFrugal used. 50 matches grn_verifications.mmh_mrc_refno.
ALTER TABLE `purchase`
  MODIFY `mmh_mrc_refno` VARCHAR(50) NULL,
  MODIFY `supplier_id` VARCHAR(50) NULL;

ALTER TABLE `gst_tally_purchase`
  MODIFY `mmh_mrc_refno` VARCHAR(50) NOT NULL,
  MODIFY `supplier_id` VARCHAR(50) NULL;
