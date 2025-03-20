CREATE TABLE `debit_note` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `store_id` int(11) NOT NULL,
  `mprh_pr_no` varchar(20) NOT NULL,
  `mprh_pr_refno` varchar(20) NOT NULL,
  `mprh_pr_dt` date NOT NULL,
  `mprh_dist_code` varchar(20) NOT NULL,
  `supplier_id` varchar(20) NOT NULL,
  `supplier_name` varchar(100) NOT NULL,
  `supplier_gstn` varchar(20) NOT NULL,
  `tot_sgst_amt` decimal(10,2) NOT NULL DEFAULT 0.00,
  `tot_cgst_amt` decimal(10,2) NOT NULL DEFAULT 0.00,
  `tot_igst_amt` decimal(10,2) NOT NULL DEFAULT 0.00,
  `tot_gst_cess_amt` decimal(10,2) NOT NULL DEFAULT 0.00,
  `tot_item_qty` decimal(10,2) NOT NULL DEFAULT 0.00,
  `tot_item_value` decimal(10,2) NOT NULL DEFAULT 0.00,
  `ts` bigint(20) NOT NULL,
  `sgst` json NOT NULL,
  `cgst` json NOT NULL,
  `igst` json NOT NULL,
  `cess` json NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `mprh_pr_refno` (`mprh_pr_refno`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `debit_note_tally_response` (
  `MasterID` varchar(200) NOT NULL,
  `VoucherNo` varchar(100) NOT NULL,
  `InvoiceValue` float NOT NULL,
  `SupplierName` text NOT NULL,
  `CostCentre` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `debit_note` ADD `has_updated` BOOLEAN NOT NULL AFTER `cess`, ADD `is_approved` BOOLEAN NOT NULL AFTER `has_updated`;

CREATE TABLE `debit_note_internal` (
  `purchase_id` bigint NOT NULL,
  `scheme_difference` decimal(10,2) DEFAULT '0.00',
  `narration` text,
  `tcs_value` decimal(10,2) NOT NULL DEFAULT '0.00',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `debit_note_internal` CHANGE `purchase_id` `debit_note_id` BIGINT NOT NULL AUTO_INCREMENT, add PRIMARY KEY (`debit_note_id`);

ALTER TABLE `debit_note_internal` ADD `total_amount` DECIMAL NOT NULL AFTER `tcs_value`;
ALTER TABLE `debit_note_internal` CHANGE `total_amount` `total_amount` DECIMAL(10,2) NOT NULL;

ALTER TABLE `debit_note_internal` ADD `mmh_mrc_refno` VARCHAR(100) NOT NULL AFTER `total_amount`;

INSERT INTO `all_permissions` (`permission_id`, `permission_key`, `status`) VALUES (NULL, 'view_debit_note', '1');