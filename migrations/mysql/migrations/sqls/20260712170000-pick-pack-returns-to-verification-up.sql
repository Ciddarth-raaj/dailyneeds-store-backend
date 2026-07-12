RENAME TABLE pick_pack_return_remarks TO pick_pack_verification_remarks;
RENAME TABLE pick_pack_returns TO pick_pack_verifications;

ALTER TABLE pick_pack_verifications
  CHANGE pick_pack_return_id pick_pack_verification_id INT AUTO_INCREMENT;

ALTER TABLE pick_pack_verifications
  DROP FOREIGN KEY fk_pick_pack_returns_product_id,
  DROP FOREIGN KEY fk_pick_pack_returns_remark_id;

ALTER TABLE pick_pack_verifications
  ADD CONSTRAINT fk_pick_pack_verifications_product_id
    FOREIGN KEY (product_id) REFERENCES product_table(product_id),
  ADD CONSTRAINT fk_pick_pack_verifications_remark_id
    FOREIGN KEY (remark_id) REFERENCES pick_pack_verification_remarks(remark_id) ON DELETE SET NULL;

ALTER TABLE pick_pack_verifications
  RENAME INDEX idx_pick_pack_returns_date TO idx_pick_pack_verifications_date,
  RENAME INDEX idx_pick_pack_returns_product_id TO idx_pick_pack_verifications_product_id,
  RENAME INDEX idx_pick_pack_returns_remark_id TO idx_pick_pack_verifications_remark_id,
  RENAME INDEX idx_pick_pack_returns_job_type TO idx_pick_pack_verifications_job_type,
  RENAME INDEX idx_pick_pack_returns_job_type_date TO idx_pick_pack_verifications_job_type_date,
  RENAME INDEX idx_pick_pack_returns_is_verified TO idx_pick_pack_verifications_is_verified;

ALTER TABLE pick_pack_verification_remarks
  RENAME INDEX idx_pick_pack_return_remarks_is_active TO idx_pick_pack_verification_remarks_is_active;

UPDATE `all_permissions` SET `permission_key` = 'view_pick_pack_verification_remarks' WHERE `permission_key` = 'view_pick_pack_return_remarks';
UPDATE `all_permissions` SET `permission_key` = 'add_pick_pack_verification_remarks' WHERE `permission_key` = 'add_pick_pack_return_remarks';
UPDATE `all_permissions` SET `permission_key` = 'view_pick_pack_verifications' WHERE `permission_key` = 'view_pick_pack_returns';
UPDATE `all_permissions` SET `permission_key` = 'add_pick_pack_verifications' WHERE `permission_key` = 'add_pick_pack_returns';

UPDATE `permissions` SET `permission_key` = 'view_pick_pack_verification_remarks' WHERE `permission_key` = 'view_pick_pack_return_remarks';
UPDATE `permissions` SET `permission_key` = 'add_pick_pack_verification_remarks' WHERE `permission_key` = 'add_pick_pack_return_remarks';
UPDATE `permissions` SET `permission_key` = 'view_pick_pack_verifications' WHERE `permission_key` = 'view_pick_pack_returns';
UPDATE `permissions` SET `permission_key` = 'add_pick_pack_verifications' WHERE `permission_key` = 'add_pick_pack_returns';
