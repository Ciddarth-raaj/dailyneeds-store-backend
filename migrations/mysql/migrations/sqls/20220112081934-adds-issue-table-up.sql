CREATE TABLE `issue` (
  `issue_id` int NOT NULL AUTO_INCREMENT,
  `indent_id` varchar(45) DEFAULT NULL,
  `product_id` varchar(45) DEFAULT NULL,
  `sent` varchar(45) DEFAULT NULL,
  `received` varchar(45) DEFAULT NULL,
  `difference` varchar(45) DEFAULT NULL,
  `status` tinyint DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`issue_id`));