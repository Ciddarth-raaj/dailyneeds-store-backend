TRUNCATE TABLE `brands`
ALTER TABLE `brands` ADD PRIMARY KEY(`brand_id`);

ALTER TABLE `product_images` CHANGE `image_id` `image_id` INT NOT NULL AUTO_INCREMENT;