DROP TABLE IF EXISTS `products_changes`;

DELETE FROM `all_permissions`
WHERE `permission_key` = 'view_product_changes';
