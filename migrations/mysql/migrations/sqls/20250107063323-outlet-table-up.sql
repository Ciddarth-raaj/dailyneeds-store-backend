ALTER TABLE `outlets` ADD `telegram_username` VARCHAR(100) NULL DEFAULT NULL AFTER `outlet_nickname`;
ALTER TABLE `outlets` ADD `opening_cash` FLOAT NOT NULL AFTER `telegram_username`;