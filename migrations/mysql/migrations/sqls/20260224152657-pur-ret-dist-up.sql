ALTER TABLE purchase_return_extra
  DROP COLUMN distributor_id;

INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_product_distributors');

ALTER TABLE purchase_return_extra
  ADD COLUMN created_by INT NULL COMMENT 'employee_id from new_employee' AFTER status,
  ADD CONSTRAINT fk_purchase_return_extra_created_by
    FOREIGN KEY (created_by) REFERENCES new_employee(employee_id) ON DELETE SET NULL;