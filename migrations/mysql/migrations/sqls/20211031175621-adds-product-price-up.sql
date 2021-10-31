CREATE TABLE `product_prices` ( `product_id` int(11) NOT NULL, `outlet_id` int(11) NOT NULL, `cost_price` float(11,2) NOT NULL, `selling_price` float(11,2) NOT NULL, `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (`product_id`,`outlet_id`));