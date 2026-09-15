-- Telegram Group Registry - every Telegram group the Daily Needs bot posts to.
--
-- ADDITIVE ONLY. One new table and two new permission keys granted to
-- NOBODY. No existing table, column, row or grant is touched. In particular
-- `outlets` is READ BY FOREIGN KEY ONLY - no outlet data is copied here -
-- and the hardcoded destinations in `constants/telegram.js` are deliberately
-- left exactly as they are: this release records which groups exist, it does
-- not repoint any alert.
--
-- WHAT IT RECORDS. A group's name, its Telegram Chat ID, a category from the
-- fixed list in `constants/telegram_group_registry.js`, what that specific
-- group is used for, an OPTIONAL outlet, and whether the bot is an admin in
-- it.
--
-- THE CHAT ID IS UNIQUE AND THE DATABASE IS WHERE THAT IS TRUE. The usecase
-- checks for a duplicate first so the user sees a sentence rather than a
-- driver error, but two requests can pass that check at the same instant and
-- only this index decides. It is VARCHAR, not BIGINT: a Chat ID is an
-- identifier that is only ever compared and displayed, never summed or
-- ordered, and storing it as text keeps `-100…` exactly as Telegram gives it.
--
-- GROUP TYPE IS NOT A COLUMN. Supergroup vs Basic Group is a pure function of
-- the Chat ID (`-100…` or not), so a stored copy could only ever drift out of
-- agreement with the id sitting beside it. It is derived on read.
--
-- BOT_IS_ADMIN IS WHAT SOMEBODY TOLD US, not what Telegram confirmed. There
-- is no automated verification in this release; the column is an operator's
-- declaration and the screens warn when it is 0.

CREATE TABLE IF NOT EXISTS `telegram_group_registry` (
  `telegram_group_id` INT NOT NULL AUTO_INCREMENT,
  `group_name` VARCHAR(150) NOT NULL,
  `chat_id` VARCHAR(32) NOT NULL COMMENT 'Telegram group chat id as text, e.g. -1001234567890 - always negative, because a positive id is an individual user',
  `category` ENUM('Attendance','Maintenance','HR','Other') NOT NULL COMMENT 'fixed list - constants/telegram_group_registry.js',
  `used_for` VARCHAR(255) NOT NULL COMMENT 'what this specific group is for, e.g. Daily missing-punch alerts',
  `outlet_id` INT NULL COMMENT 'optional FK to outlets.outlet_id - a company-wide group has none',
  `bot_is_admin` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=the bot is an admin in this group, as declared by the operator',
  `created_by` INT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` INT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`telegram_group_id`),
  UNIQUE KEY `uq_tgr_chat_id` (`chat_id`),
  KEY `idx_tgr_category` (`category`),
  KEY `idx_tgr_outlet` (`outlet_id`),
  CONSTRAINT `fk_tgr_outlet` FOREIGN KEY (`outlet_id`) REFERENCES `outlets` (`outlet_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========================================================== permissions ====
--   view_telegram_groups     open the registry and read a group   NOBODY
--   manage_telegram_groups   add, edit and delete a group         NOBODY
--
-- Granted to no designation on purpose: administrators reach the screen
-- through the middleware's user_type 2 bypass, and anybody else is given the
-- keys deliberately on the designation rights screen. No key's existing
-- holders are read to derive these - that is how two separate decisions get
-- welded together.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_telegram_groups' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_telegram_groups');

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'manage_telegram_groups' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'manage_telegram_groups');
