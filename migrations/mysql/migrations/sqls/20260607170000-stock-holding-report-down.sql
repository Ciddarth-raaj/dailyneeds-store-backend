DROP TABLE IF EXISTS `stock_holding_items`;
DROP TABLE IF EXISTS `stock_holding_report`;

DELETE FROM `all_permissions`
WHERE `permission_key` IN (
  'view_stock_holding_report',
  'add_stock_holding_report',
  'delete_stock_holding_report'
);
