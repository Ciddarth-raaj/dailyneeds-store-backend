DROP TABLE IF EXISTS `product_offers`;

DELETE FROM `all_permissions`
WHERE `permission_key` IN ('view_product_offers', 'add_product_offers');
