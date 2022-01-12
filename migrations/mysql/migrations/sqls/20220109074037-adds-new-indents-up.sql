CREATE TABLE `new_indents` (
  `indent_id` bigint NOT NULL AUTO_INCREMENT,
  `indent_number` varchar(45) DEFAULT NULL,
  `store_id` bigint DEFAULT NULL,
  `store_to` bigint DEFAULT NULL,
  `bags` int DEFAULT '0',
  `boxes` int DEFAULT '0',
  `crates` int DEFAULT '0',
  `taken_by` varchar(45) DEFAULT NULL,
  `checked_by` varchar(45) DEFAULT NULL,
  `delivery_status` tinyint DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`indent_id`));