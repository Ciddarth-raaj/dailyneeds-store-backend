ALTER TABLE `product_sales`
  ADD INDEX `idx_product_sales_tran_date_product` (`tran_date`, `product_id`, `tran_qty`);
