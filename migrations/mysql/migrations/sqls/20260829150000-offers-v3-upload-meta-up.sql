-- One row per upload type (stock/price/import), overwritten on every upload
-- so the Offers V3 UI can show "X rows · Y products total · uploaded
-- <date/time>" without recomputing from the bulk data tables.
CREATE TABLE `offers_v3_upload_meta` (
  `upload_type` ENUM('stock', 'price', 'import') NOT NULL,
  `total_rows` INT(11) NOT NULL DEFAULT 0,
  `total_products` INT(11) NOT NULL DEFAULT 0,
  `uploaded_at` DATETIME NOT NULL,
  `uploaded_by` INT(11) NULL DEFAULT NULL,
  PRIMARY KEY (`upload_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
