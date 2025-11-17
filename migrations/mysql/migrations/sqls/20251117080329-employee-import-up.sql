START TRANSACTION;

TRUNCATE TABLE `designation`;
-- ALTER TABLE `designation` ADD `designation_code` VARCHAR(20) NULL DEFAULT NULL AFTER `designation_id`;
-- ALTER TABLE `designation` ADD UNIQUE(`designation_code`);

TRUNCATE TABLE `department`;
-- ALTER TABLE `department` ADD `department_code` VARCHAR(20) NULL DEFAULT NULL AFTER `department_id`;
-- ALTER TABLE `department` ADD UNIQUE(`department_code`);

-- ALTER TABLE `outlets` ADD `outlet_code` VARCHAR(20) NOT NULL AFTER `outlet_id`;
ALTER TABLE `outlets` ADD UNIQUE(`outlet_code`);
ALTER TABLE `outlets` CHANGE `opening_cash` `opening_cash` FLOAT NULL DEFAULT NULL;

UPDATE `outlets` SET `outlet_code` = 'DNHO' WHERE `outlets`.`outlet_id` = 2;
UPDATE `outlets` SET `outlet_code` = 'DN2' WHERE `outlets`.`outlet_id` = 3;
UPDATE `outlets` SET `outlet_code` = 'DN1' WHERE `outlets`.`outlet_id` = 4;
UPDATE `outlets` SET `outlet_code` = 'DN3' WHERE `outlets`.`outlet_id` = 5;
UPDATE `outlets` SET `outlet_code` = 'DN4' WHERE `outlets`.`outlet_id` = 6;
UPDATE `outlets` SET `outlet_code` = 'DN5' WHERE `outlets`.`outlet_id` = 7;

UPDATE `new_employee` SET status = 0;

DELETE FROM `user` WHERE `user_type` = 1;

ALTER TABLE `new_employee` ADD `updated_at` TIMESTAMP on update CURRENT_TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER `created_at`;

COMMIT;