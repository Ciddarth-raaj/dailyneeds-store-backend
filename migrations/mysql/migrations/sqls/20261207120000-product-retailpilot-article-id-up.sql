-- =====================================================================
-- RetailPilot article id on product_table, next to the old product_id the
-- rest of the app is keyed on. Filled by the daily RetailPilot stock sync
-- from masterhub.articles (slug = article id, external_id = product_id).
-- Not unique: it is a lookup, and an article re-pointed in RetailPilot
-- must not fail the whole sync on a transient duplicate.
--
-- retailpilot_hierarchy_map: which of our department / category /
-- subcategory / brand rows each RetailPilot hierarchy node is. Set once per
-- node (to a row with the same name, else a new row) and reused, so a rename
-- in RetailPilot renames our row.
--
-- sync_retailpilot_stock: POST /offers-v3/retailpilot-sync (run the sync
-- by hand, or a dry run). Declared and granted to nobody, like
-- sync_retailpilot_purchases; the scheduled sync does not need it.
-- =====================================================================
ALTER TABLE `product_table`
  ADD COLUMN `retailpilot_article_id` INT NULL DEFAULT NULL,
  ADD KEY `idx_product_retailpilot_article_id` (`retailpilot_article_id`);

CREATE TABLE IF NOT EXISTS `retailpilot_hierarchy_map` (
  `level` VARCHAR(20) NOT NULL,
  `retailpilot_id` INT NOT NULL,
  `local_id` INT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`level`, `retailpilot_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'sync_retailpilot_stock' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'sync_retailpilot_stock');
