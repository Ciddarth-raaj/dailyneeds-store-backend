ALTER TABLE `purchase_internal` 
ADD `invoice_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00 
AFTER `total_amount`;