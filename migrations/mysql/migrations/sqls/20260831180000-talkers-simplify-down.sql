DELETE FROM `all_permissions` WHERE `permission_key` = 'print_offers_v3_talkers';

ALTER TABLE `offers_v3_talker_groups`
  MODIFY COLUMN `group_type` ENUM('brand', 'individual', 'group') NOT NULL DEFAULT 'brand';
UPDATE `offers_v3_talker_groups` SET `group_type` = 'brand' WHERE `group_type` = 'group';
ALTER TABLE `offers_v3_talker_groups`
  MODIFY COLUMN `group_type` ENUM('brand', 'individual') NOT NULL DEFAULT 'brand';

ALTER TABLE `offers_v3_talker_group_locations` DROP COLUMN `location_type`;

ALTER TABLE `offers_v3_talker_groups`
  MODIFY COLUMN `origin` ENUM('auto', 'manual') NOT NULL DEFAULT 'auto';
ALTER TABLE `offers_v3_talker_groups`
  MODIFY COLUMN `status` ENUM('draft', 'published', 'ended') NOT NULL DEFAULT 'draft';

CREATE TABLE `offers_v3_talker_group_suggested_items` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `group_id` INT(11) NOT NULL,
  `item_code` INT(11) NOT NULL,
  `status` ENUM('pending', 'accepted', 'rejected') NOT NULL DEFAULT 'pending',
  `suggested_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_by` INT(11) NULL DEFAULT NULL,
  `resolved_at` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_offers_v3_talker_group_suggested` (`group_id`, `item_code`),
  KEY `idx_offers_v3_talker_group_suggested_status` (`status`),
  CONSTRAINT `fk_offers_v3_talker_group_suggested_group` FOREIGN KEY (`group_id`) REFERENCES `offers_v3_talker_groups` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
