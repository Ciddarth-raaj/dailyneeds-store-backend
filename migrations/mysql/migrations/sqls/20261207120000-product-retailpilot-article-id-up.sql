-- =====================================================================
-- RetailPilot article id on product_table, next to the old product_id the
-- rest of the app is keyed on. Filled by the daily RetailPilot stock sync
-- from masterhub.articles (slug = article id, external_id = product_id).
-- The hierarchy itself needs no schema change: RetailPilot's department,
-- category, subcategory and brand ids are written into product_department,
-- categories, subcategories and brands as they are.
-- Not unique: it is a lookup, and an article re-pointed in RetailPilot
-- must not fail the whole sync on a transient duplicate.
--
-- sync_retailpilot_stock: POST /offers-v3/retailpilot-sync (run the sync
-- by hand, or a dry run). Declared and granted to nobody, like
-- sync_retailpilot_purchases; the scheduled sync does not need it.
-- =====================================================================
ALTER TABLE `product_table`
  ADD COLUMN `retailpilot_article_id` INT NULL DEFAULT NULL,
  ADD KEY `idx_product_retailpilot_article_id` (`retailpilot_article_id`);

INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'sync_retailpilot_stock' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'sync_retailpilot_stock');
