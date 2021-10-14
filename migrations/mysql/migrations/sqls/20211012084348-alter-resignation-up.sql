ALTER TABLE `resignation` CHANGE COLUMN `reason` `reason_type` VARCHAR(45) NOT NULL ;
ALTER TABLE `resignation` ADD COLUMN `reason` LONGTEXT NOT NULL AFTER `resignation_date`;