ALTER TABLE purchase_tally_response
  DROP FOREIGN KEY fk_purchase_tally_response_purchase;

ALTER TABLE purchase_tally_response
  DROP PRIMARY KEY,
  DROP INDEX uq_purchase_tally_response_master_id;

ALTER TABLE purchase_tally_response
  DROP COLUMN purchase_id;

ALTER TABLE purchase_tally_response
  ADD UNIQUE KEY VoucherNo (VoucherNo, CostCentre);
