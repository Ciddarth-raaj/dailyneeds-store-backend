-- RetailPilot purchases.
--   mmh_mrc_no    holds RetailPilot's invoice slug (e.g. INV-0EevA9mzmHYx),
--                 which is text. Existing GoFrugal numbers (e.g. 122486)
--                 convert to their text form unchanged.
--   mmh_mrc_refno RetailPilot's seq (the Tally voucher number) - and
--   supplier_id   RetailPilot's vendor id - may exceed GoFrugal's 20
--                 characters. 50 matches grn_verifications.mmh_mrc_refno.
-- gst_tally_purchase copies all three from purchase, so it widens too.
ALTER TABLE `purchase`
  MODIFY `mmh_mrc_no` VARCHAR(50) NULL,
  MODIFY `mmh_mrc_refno` VARCHAR(50) NULL,
  MODIFY `supplier_id` VARCHAR(50) NULL;

ALTER TABLE `gst_tally_purchase`
  MODIFY `mmh_mrc_no` VARCHAR(50) NULL,
  MODIFY `mmh_mrc_refno` VARCHAR(50) NOT NULL,
  MODIFY `supplier_id` VARCHAR(50) NULL;
