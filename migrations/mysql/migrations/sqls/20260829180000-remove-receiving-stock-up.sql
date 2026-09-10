DROP TABLE IF EXISTS `stock_received`;

DELETE FROM `all_permissions`
WHERE `permission_key` IN ('view_stock_received', 'add_stock_received', 'delete_stock_received');
