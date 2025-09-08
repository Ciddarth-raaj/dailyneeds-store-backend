ALTER TABLE `invoice` 
ADD COLUMN `supplier_id` INT NULL 
AFTER `invoice_id`,
ADD FOREIGN KEY (`supplier_id`) REFERENCES `people_list`(`person_id`) ON DELETE SET NULL;