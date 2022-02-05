ALTER TABLE `dndscoin_acs`.`user` 
ADD COLUMN `status` TINYINT NOT NULL DEFAULT 1 AFTER `updated_at`;