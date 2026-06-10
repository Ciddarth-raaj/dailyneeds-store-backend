ALTER TABLE `price_checker_items`
  MODIFY COLUMN `distributor_id` VARCHAR(64) NULL,
  ADD COLUMN `buyer_id` INT(11) NULL AFTER `distributor_id`,
  ADD COLUMN `buyer_name` VARCHAR(255) NULL AFTER `buyer_id`;

UPDATE `price_checker_items` pci
INNER JOIN `product_table` pt ON pci.product_id = pt.product_id
LEFT JOIN `product_distributor_master` pdm ON pt.distributor_id = pdm.cid
LEFT JOIN `product_distributor` pd_map ON pd_map.cid = pdm.cid
LEFT JOIN `new_employee` ne ON ne.employee_id = pd_map.buyer_id
SET
  pci.distributor_id = pdm.cid,
  pci.de_distributor = pdm.mdm_dist_name,
  pci.buyer_id = pd_map.buyer_id,
  pci.buyer_name = ne.employee_name;
