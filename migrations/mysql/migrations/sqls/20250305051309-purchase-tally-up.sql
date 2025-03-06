ALTER TABLE `purchase_tally_response` CHANGE `CostCentre` `CostCentre` VARCHAR(100) CHARACTER SET utf8mb4 NOT NULL;
ALTER TABLE `purchase_tally_response` ADD UNIQUE(`VoucherNo`, `CostCentre`);
ALTER TABLE `purchase_tally_response` DROP PRIMARY KEY;