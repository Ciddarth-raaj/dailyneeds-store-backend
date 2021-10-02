ALTER TABLE `new_employee_documents` DROP COLUMN `is_verified`;
ALTER TABLE `new_employee_documents` ADD COLUMN `is_verified` TINYINT NULL DEFAULT '0' AFTER `expiry_date`;