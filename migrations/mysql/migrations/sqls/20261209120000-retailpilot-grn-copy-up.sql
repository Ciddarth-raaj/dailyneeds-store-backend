-- =====================================================================
-- Local copy of the warehouse's RetailPilot purchase invoices (GRNs), kept
-- by the RetailPilot GRN sync every 15 minutes, so the GRN pages read our
-- own database instead of calling RetailPilot on every page load.
--
-- refno is RetailPilot's GRN No (seq; it continues GoFrugal's numbering).
-- grn_date is the day it was entered, in India time. line_id is
-- RetailPilot's invoice_details slug - the GRN line's stable id (GRN issue
-- ignores key on it); line_no is its position. Prices are as the GRN pages
-- show them: pur_price is the landing cost, sale_rate the batch's in-store
-- retail (else default) selling price.
-- =====================================================================
CREATE TABLE IF NOT EXISTS `retailpilot_grn_headers` (
  `invoice_slug` VARCHAR(64) NOT NULL,
  `refno` VARCHAR(30) NOT NULL,
  `fy` INT NULL,
  `store_id` VARCHAR(20) NOT NULL,
  `grn_date` DATE NOT NULL,
  `entered_at` DATETIME NOT NULL,
  `supplier_id` VARCHAR(30) NULL,
  `supplier_name` VARCHAR(255) NULL,
  `amount` DECIMAL(15,2) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`invoice_slug`),
  KEY `idx_rp_grn_refno` (`refno`),
  KEY `idx_rp_grn_date` (`grn_date`),
  KEY `idx_rp_grn_entered` (`entered_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `retailpilot_grn_lines` (
  `line_id` VARCHAR(64) NOT NULL,
  `invoice_slug` VARCHAR(64) NOT NULL,
  `line_no` INT NOT NULL,
  `product_id` INT NOT NULL,
  `recd_qty` DECIMAL(15,3) NULL,
  `free_qty` DECIMAL(15,3) NULL,
  `mrp` DECIMAL(15,2) NULL,
  `pur_rate` DECIMAL(15,4) NULL,
  `tax_per` DECIMAL(6,2) NULL,
  `tax_amt` DECIMAL(15,4) NULL,
  `pur_price` DECIMAL(15,4) NULL,
  `sale_rate` DECIMAL(15,4) NULL,
  `pur_amount` DECIMAL(15,4) NULL,
  `disc_per` DECIMAL(9,4) NULL,
  `disc_amt` DECIMAL(15,4) NULL,
  `synced_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`line_id`),
  KEY `idx_rp_grn_lines_invoice` (`invoice_slug`, `line_no`),
  KEY `idx_rp_grn_lines_product` (`product_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
