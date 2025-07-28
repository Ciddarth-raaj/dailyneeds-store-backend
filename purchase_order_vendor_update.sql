-- Add vendor_id column to purchase_order table
ALTER TABLE `purchase_order` ADD `vendor_id` INT NOT NULL AFTER `purchase_order_ref`;

-- Add foreign key constraint to link with people_list table
ALTER TABLE `purchase_order` 
ADD CONSTRAINT `fk_purchase_order_vendor` 
FOREIGN KEY (`vendor_id`) REFERENCES `people_list`(`person_id`) ON DELETE RESTRICT;

-- Add index for better performance
CREATE INDEX `idx_purchase_order_vendor_id` ON `purchase_order`(`vendor_id`); 