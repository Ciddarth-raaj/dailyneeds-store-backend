ALTER TABLE `dead_stock_items`
  ADD COLUMN `category_id` INT NULL AFTER `department_name`,
  ADD COLUMN `category_name` VARCHAR(255) NULL AFTER `category_id`,
  ADD COLUMN `subcategory_id` INT NULL AFTER `category_name`,
  ADD COLUMN `subcategory_name` VARCHAR(255) NULL AFTER `subcategory_id`;

UPDATE `dead_stock_items` dsi
INNER JOIN `product_table` pt ON dsi.product_id = pt.product_id
LEFT JOIN `categories` cat ON pt.category_id = cat.category_id
LEFT JOIN `subcategories` sub ON pt.subcategory_id = sub.category_id
SET
  dsi.category_id = pt.category_id,
  dsi.category_name = cat.category_name,
  dsi.subcategory_id = pt.subcategory_id,
  dsi.subcategory_name = sub.subcategory_name;
