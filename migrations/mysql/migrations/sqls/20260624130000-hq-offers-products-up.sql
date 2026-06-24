CREATE TABLE `offer_products` (
  `mosp_offer_id` BIGINT NOT NULL,
  `mosp_sub_id` BIGINT NOT NULL DEFAULT 0,
  `mosp_category_id` BIGINT NULL DEFAULT NULL,
  `mosp_item_code` INT(11) NOT NULL,
  `ts` DATE NULL DEFAULT NULL,
  `tsid` BIGINT NULL DEFAULT NULL,
  `retail_outlet_id` INT(11) NOT NULL,
  `timestamp` VARCHAR(30) NULL DEFAULT NULL,
  `hq_timestamp_id` BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (`mosp_offer_id`, `mosp_sub_id`, `mosp_item_code`, `retail_outlet_id`),
  CONSTRAINT `fk_offer_products_offer_hdr` FOREIGN KEY (`mosp_offer_id`, `retail_outlet_id`) REFERENCES `offer_hdr` (`moh_offer_id`, `retail_outlet_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_offer_products_outlet` FOREIGN KEY (`retail_outlet_id`) REFERENCES `outlets` (`outlet_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_offer_products_product` FOREIGN KEY (`mosp_item_code`) REFERENCES `product_table` (`product_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
