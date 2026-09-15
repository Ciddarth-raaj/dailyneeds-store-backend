-- Telegram Group Registry - an Active/Inactive status, and the Marketing
-- category.
--
-- ADDITIVE ONLY. One new column with a default, and one value APPENDED to an
-- existing ENUM. No row is rewritten, no column is dropped or narrowed, no
-- permission or grant is touched, and no other table is referenced.
--
-- STATUS. `is_active` records whether a registered group is still in use.
-- It DEFAULTS TO 1, so every row that exists before this migration stays
-- active and nothing a user registered silently disappears from the list.
-- It is NOT the bot-admin flag and not a warning: a group can be Active with
-- the bot as a non-admin, which is exactly the row the registry exists to
-- make visible.
--
-- MARKETING. Appended to the category ENUM rather than inserted in the
-- middle. Appending is a metadata-only change that rewrites no row; changing
-- the ORDER of existing ENUM members would renumber them and rewrite every
-- row's stored ordinal, which is a data migration pretending to be a display
-- tweak. Display order lives in `constants/telegram_group_registry.js`, so
-- Marketing can be shown wherever it reads best without the schema caring.

ALTER TABLE `telegram_group_registry`
  ADD COLUMN `is_active` TINYINT(1) NOT NULL DEFAULT 1
    COMMENT '1=this group is still in use, 0=retired. Existing rows default to active';

ALTER TABLE `telegram_group_registry`
  MODIFY COLUMN `category` ENUM('Attendance','Maintenance','HR','Other','Marketing') NOT NULL
    COMMENT 'fixed list - constants/telegram_group_registry.js';

ALTER TABLE `telegram_group_registry`
  ADD INDEX `idx_tgr_is_active` (`is_active`);
