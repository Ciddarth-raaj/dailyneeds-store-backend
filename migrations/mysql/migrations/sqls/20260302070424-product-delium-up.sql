ALTER TABLE `product_table` ADD `de_is_online_allowed` BOOLEAN NULL DEFAULT FALSE AFTER `de_combo_name`;

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_purchase_return_dashboard');