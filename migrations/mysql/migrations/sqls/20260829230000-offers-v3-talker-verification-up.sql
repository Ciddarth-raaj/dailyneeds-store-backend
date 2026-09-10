INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_offers_v3_talker_proofs');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_offers_v3_talker_proofs');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('verify_offers_v3_talker_proofs');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('manage_offers_v3_talker_groups');

-- A talker group is one physical sign. ~1000 offer articles collapse to 300-400
-- groups because a brand offer covers ~20 articles with a single sign.
-- Auto-derived groups (supplier + markdown %) land in `draft`; nothing reaches an
-- outlet queue until `published`. `ended` groups freeze - membership becomes
-- immutable so historical proofs stay interpretable.
CREATE TABLE `offers_v3_talker_groups` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `label` VARCHAR(255) NOT NULL COMMENT 'what staff read in the queue, e.g. "Cadbury - 22% off"',
  `group_type` ENUM('brand', 'individual') NOT NULL DEFAULT 'brand',
  `origin` ENUM('auto', 'manual') NOT NULL DEFAULT 'auto',
  `status` ENUM('draft', 'published', 'ended') NOT NULL DEFAULT 'draft',
  `supplier` VARCHAR(255) NULL DEFAULT NULL COMMENT 'set on auto-derived groups',
  `markdown_pct` DECIMAL(6,2) NULL DEFAULT NULL COMMENT 'set on auto-derived groups',
  `talker_text` TEXT NULL DEFAULT NULL COMMENT 'expected text on the sign - fed to the AI check',
  `expected_price` DECIMAL(12,2) NULL DEFAULT NULL,
  `expected_pct_off` DECIMAL(6,2) NULL DEFAULT NULL,
  `active_from` DATE NULL DEFAULT NULL,
  `active_to` DATE NULL DEFAULT NULL,
  `created_by` INT(11) NULL DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_offers_v3_talker_groups_status` (`status`),
  KEY `idx_offers_v3_talker_groups_supplier` (`supplier`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Article codes covered by a group. An article belongs to at most one group.
CREATE TABLE `offers_v3_talker_group_items` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `group_id` INT(11) NOT NULL,
  `item_code` INT(11) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_offers_v3_talker_group_item` (`item_code`),
  KEY `idx_offers_v3_talker_group_items_group` (`group_id`),
  CONSTRAINT `fk_offers_v3_talker_group_items_group` FOREIGN KEY (`group_id`) REFERENCES `offers_v3_talker_groups` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_offers_v3_talker_group_items_product` FOREIGN KEY (`item_code`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- New articles matching a published group's supplier + markdown land here rather
-- than being added silently, so manual membership edits survive a data refresh.
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

-- Where a group's stock physically sits, per outlet. Created by outlet staff
-- during discovery, not by HQ - ECR having 3 Cadbury spots doesn't mean
-- Muthialpet does. Proof attaches to a location, not to a group.
-- The queue columns carry per-location scheduling state: pending_tier is the tier
-- this location is currently owed at (NULL = not owed), pending_since ages an
-- unphotographed flag so misses don't vanish, and last_accepted_at drives the
-- tier-2 rotation cycle.
CREATE TABLE `offers_v3_talker_group_locations` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `group_id` INT(11) NOT NULL,
  `outlet_id` INT(11) NOT NULL,
  `label` VARCHAR(255) NOT NULL COMMENT 'e.g. "Aisle 3", "Endcap near billing"',
  `active` TINYINT(1) NOT NULL DEFAULT 1,
  `pending_tier` TINYINT(1) NULL DEFAULT NULL COMMENT '1|2|3, NULL when not owed',
  `pending_since` DATETIME NULL DEFAULT NULL,
  `last_accepted_at` DATETIME NULL DEFAULT NULL,
  `first_seen` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_seen` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_offers_v3_talker_locations_queue` (`outlet_id`, `active`, `pending_tier`),
  KEY `idx_offers_v3_talker_locations_group` (`group_id`),
  CONSTRAINT `fk_offers_v3_talker_locations_group` FOREIGN KEY (`group_id`) REFERENCES `offers_v3_talker_groups` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_offers_v3_talker_locations_outlet` FOREIGN KEY (`outlet_id`) REFERENCES `outlets` (`outlet_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One proof per location per round. A retake overwrites the verdict on the same
-- row and adds another image, rather than creating a duplicate proof.
-- ai_verdict is derived in code from the model's booleans (auditable, tunable);
-- ai_model is stamped per row so accuracy shifts after a version change are
-- traceable. status is the human layer: `submitted` is terminal (review is
-- exception-based), `overridden` records an HQ override of an AI reject.
CREATE TABLE `offers_v3_talker_proofs` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `location_id` INT(11) NOT NULL,
  `round_date` DATE NOT NULL,
  `tier` TINYINT(1) NOT NULL DEFAULT 2,
  `uploaded_by` INT(11) NULL DEFAULT NULL,
  `uploaded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `note` TEXT NULL DEFAULT NULL,
  `ai_verdict` ENUM('accept', 'retake', 'reject') NULL DEFAULT NULL,
  `ai_response_json` TEXT NULL DEFAULT NULL,
  `ai_model` VARCHAR(100) NULL DEFAULT NULL,
  `status` ENUM('submitted', 'rejected', 'overridden') NOT NULL DEFAULT 'submitted',
  `reviewed_by` INT(11) NULL DEFAULT NULL,
  `reviewed_at` DATETIME NULL DEFAULT NULL,
  `review_note` TEXT NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_offers_v3_talker_proof_round` (`location_id`, `round_date`),
  KEY `idx_offers_v3_talker_proofs_round` (`round_date`, `status`),
  KEY `idx_offers_v3_talker_proofs_verdict` (`ai_verdict`),
  CONSTRAINT `fk_offers_v3_talker_proofs_location` FOREIGN KEY (`location_id`) REFERENCES `offers_v3_talker_group_locations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Kept as a child table even at one photo per proof, so a retake lands under the
-- same proof row instead of creating a duplicate.
CREATE TABLE `offers_v3_talker_proof_images` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `proof_id` INT(11) NOT NULL,
  `s3_url` VARCHAR(1000) NOT NULL,
  `uploaded_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_offers_v3_talker_proof_images_proof` (`proof_id`),
  CONSTRAINT `fk_offers_v3_talker_proof_images_proof` FOREIGN KEY (`proof_id`) REFERENCES `offers_v3_talker_proofs` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Every group edit is logged: membership changes re-flag locations to tier 1,
-- label/talker-text changes deliberately do not.
CREATE TABLE `offers_v3_talker_group_edit_log` (
  `id` INT(11) NOT NULL AUTO_INCREMENT,
  `group_id` INT(11) NOT NULL,
  `changed_by` INT(11) NULL DEFAULT NULL,
  `changed_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `change_type` VARCHAR(50) NOT NULL COMMENT 'create|publish|end|label|talker_text|items_added|items_removed|merge|split|location_added|location_removed',
  `detail_json` TEXT NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_offers_v3_talker_group_edit_log_group` (`group_id`, `changed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
