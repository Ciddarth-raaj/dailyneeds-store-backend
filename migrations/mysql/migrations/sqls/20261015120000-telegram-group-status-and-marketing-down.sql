-- Reverses 20261015120000.
--
-- The category ENUM is narrowed back to the original four, which REFUSES or
-- blanks any row stored as 'Marketing' while the feature was live. That is
-- unavoidable when removing an allowed value, so the rollback moves those
-- rows to 'Other' first rather than letting MySQL decide.
UPDATE `telegram_group_registry` SET `category` = 'Other' WHERE `category` = 'Marketing';

ALTER TABLE `telegram_group_registry` DROP INDEX `idx_tgr_is_active`;

ALTER TABLE `telegram_group_registry`
  MODIFY COLUMN `category` ENUM('Attendance','Maintenance','HR','Other') NOT NULL
    COMMENT 'fixed list - constants/telegram_group_registry.js';

ALTER TABLE `telegram_group_registry` DROP COLUMN `is_active`;
