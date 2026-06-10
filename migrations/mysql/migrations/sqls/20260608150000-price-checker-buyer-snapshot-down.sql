ALTER TABLE `price_checker_items`
  DROP COLUMN `buyer_name`,
  DROP COLUMN `buyer_id`,
  MODIFY COLUMN `distributor_id` INT(11) NULL;
