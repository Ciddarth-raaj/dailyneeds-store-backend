START TRANSACTION;

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_eb_consumption');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_eb_consumption');

CREATE TABLE `eb_consumption` (
  `consumption_id` int NOT NULL AUTO_INCREMENT,
  `date` date NOT NULL,
  `branch_id` int NOT NULL,
  `opening_units` decimal(10,2) DEFAULT NULL,
  `closing_units` decimal(10,2) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_by` int NOT NULL,
  PRIMARY KEY (`consumption_id`),
  KEY `fk_eb_consumption_branch` (`branch_id`),
  KEY `fk_eb_consumption_user` (`created_by`),
  CONSTRAINT `fk_eb_consumption_branch` FOREIGN KEY (`branch_id`) REFERENCES `outlets` (`outlet_id`),
  CONSTRAINT `fk_eb_consumption_user` FOREIGN KEY (`created_by`) REFERENCES `new_employee` (`employee_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

COMMIT;