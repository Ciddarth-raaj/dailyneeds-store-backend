ALTER TABLE `purchase_tally_response` CHANGE `CostCentre` `CostCentre` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL;
ALTER TABLE `purchase_tally_response` ADD UNIQUE(`VoucherNo`, `CostCentre`);
ALTER TABLE `purchase_tally_response` DROP PRIMARY KEY;