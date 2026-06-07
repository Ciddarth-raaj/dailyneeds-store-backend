ALTER TABLE `dead_stock_items`
  ADD COLUMN `de_name` VARCHAR(500) NULL AFTER `type`,
  ADD COLUMN `de_distributor` VARCHAR(255) NULL AFTER `de_name`,
  ADD COLUMN `buyer_name` VARCHAR(255) NULL AFTER `de_distributor`,
  ADD COLUMN `outlet_name` VARCHAR(255) NULL AFTER `buyer_name`,
  ADD COLUMN `department_id` INT NULL AFTER `outlet_name`,
  ADD COLUMN `department_name` VARCHAR(255) NULL AFTER `department_id`;

UPDATE `dead_stock_items` dsi
INNER JOIN `product_table` pt ON dsi.product_id = pt.product_id
LEFT JOIN `outlets` o ON dsi.outlet_id = o.outlet_id
LEFT JOIN `product_distributor_master` pdm ON pt.distributor_id = pdm.cid
LEFT JOIN `product_distributor` pd_map ON pd_map.cid = pt.distributor_id
LEFT JOIN `new_employee` ne ON ne.employee_id = pd_map.buyer_id
LEFT JOIN `product_department` d ON pt.department_id = d.department_id
SET
  dsi.de_name = pt.de_name,
  dsi.de_distributor = pdm.mdm_dist_name,
  dsi.buyer_name = ne.employee_name,
  dsi.outlet_name = o.outlet_name,
  dsi.department_id = pt.department_id,
  dsi.department_name = d.department_name
WHERE dsi.de_name IS NULL;
