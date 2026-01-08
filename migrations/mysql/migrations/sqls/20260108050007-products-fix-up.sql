TRUNCATE TABLE `brands`
ALTER TABLE `brands` ADD PRIMARY KEY(`brand_id`);

INSERT INTO `all_permissions` (`permission_key`) VALUES ('edit_products');