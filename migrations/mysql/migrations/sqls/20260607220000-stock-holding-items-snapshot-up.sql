ALTER TABLE `stock_holding_items`
  ADD COLUMN `product_name` VARCHAR(500) NULL AFTER `status`,
  ADD COLUMN `purchase_type` VARCHAR(50) NULL AFTER `product_name`,
  ADD COLUMN `department_id` INT NULL AFTER `purchase_type`,
  ADD COLUMN `category_id` INT NULL AFTER `department_id`,
  ADD COLUMN `subcategory_id` INT NULL AFTER `category_id`,
  ADD COLUMN `department_name` VARCHAR(255) NULL AFTER `subcategory_id`,
  ADD COLUMN `category_name` VARCHAR(255) NULL AFTER `department_name`,
  ADD COLUMN `subcategory_name` VARCHAR(255) NULL AFTER `category_name`,
  ADD COLUMN `supplier_name` VARCHAR(255) NULL AFTER `subcategory_name`,
  ADD COLUMN `distributor_id` VARCHAR(64) NULL AFTER `supplier_name`,
  ADD COLUMN `distributor_name` VARCHAR(255) NULL AFTER `distributor_id`,
  ADD COLUMN `buyer_id` INT NULL AFTER `distributor_name`,
  ADD COLUMN `buyer_name` VARCHAR(255) NULL AFTER `buyer_id`,
  ADD COLUMN `chain_bill_count_level` VARCHAR(20) NULL AFTER `buyer_name`,
  ADD COLUMN `holding_days` INT NULL AFTER `chain_bill_count_level`,
  ADD COLUMN `outlet_name` VARCHAR(255) NULL AFTER `holding_days`,
  ADD COLUMN `product_image` VARCHAR(1024) NULL AFTER `outlet_name`;

UPDATE `stock_holding_items` shi
INNER JOIN `product_table` p ON shi.product_id = p.product_id
LEFT JOIN `product_department` pd_dept ON p.department_id = pd_dept.department_id
LEFT JOIN `categories` cat ON p.category_id = cat.category_id
LEFT JOIN `subcategories` sub ON p.subcategory_id = sub.category_id
LEFT JOIN `outlets` o ON shi.outlet_id = o.outlet_id
LEFT JOIN `product_distributor_master` pdm ON p.distributor_id = pdm.cid
LEFT JOIN `product_distributor` pd_map ON pd_map.cid = p.distributor_id
LEFT JOIN `new_employee` ne ON ne.employee_id = pd_map.buyer_id
LEFT JOIN (
  SELECT pi.product_id, pi.image_url
  FROM product_images pi
  INNER JOIN (
    SELECT product_id, MIN(priority) AS min_priority
    FROM product_images
    WHERE product_id IN (
      SELECT product_id FROM (
        SELECT DISTINCT product_id
        FROM stock_holding_items
        WHERE product_name IS NULL
      ) pending_products
    )
    GROUP BY product_id
  ) mp ON mp.product_id = pi.product_id AND pi.priority = mp.min_priority
  INNER JOIN (
    SELECT product_id, priority, MIN(image_id) AS min_image_id
    FROM product_images
    WHERE product_id IN (
      SELECT product_id FROM (
        SELECT DISTINCT product_id
        FROM stock_holding_items
        WHERE product_name IS NULL
      ) pending_products
    )
    GROUP BY product_id, priority
  ) mi ON mi.product_id = pi.product_id
    AND mi.priority = pi.priority
    AND pi.image_id = mi.min_image_id
) img ON img.product_id = p.product_id
SET
  shi.product_name = p.de_name,
  shi.purchase_type = p.repln_mode,
  shi.department_id = p.department_id,
  shi.category_id = p.category_id,
  shi.subcategory_id = p.subcategory_id,
  shi.department_name = pd_dept.department_name,
  shi.category_name = cat.category_name,
  shi.subcategory_name = sub.subcategory_name,
  shi.supplier_name = p.de_manufacturer_name,
  shi.distributor_id = p.distributor_id,
  shi.distributor_name = COALESCE(pdm.mdm_dist_name, p.de_distributor),
  shi.buyer_id = pd_map.buyer_id,
  shi.buyer_name = ne.employee_name,
  shi.chain_bill_count_level = p.de_bill_count_level,
  shi.holding_days = pdm.holding_days,
  shi.outlet_name = o.outlet_name,
  shi.product_image = img.image_url
WHERE shi.product_name IS NULL;
