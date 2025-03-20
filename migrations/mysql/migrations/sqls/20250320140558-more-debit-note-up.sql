CREATE TABLE `debit_note_tally_response` (
  `MasterID` varchar(200) NOT NULL,
  `VoucherNo` varchar(100) NOT NULL,
  `InvoiceValue` float NOT NULL,
  `SupplierName` text NOT NULL,
  `CostCentre` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `debit_note` ADD `has_updated` BOOLEAN NOT NULL AFTER `cess`, ADD `is_approved` BOOLEAN NOT NULL AFTER `has_updated`;

CREATE TABLE `debit_note_internal` (
  `purchase_id` bigint NOT NULL,
  `scheme_difference` decimal(10,2) DEFAULT '0.00',
  `narration` text,
  `tcs_value` decimal(10,2) NOT NULL DEFAULT '0.00',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `debit_note_internal` CHANGE `purchase_id` `debit_note_id` BIGINT NOT NULL AUTO_INCREMENT, add PRIMARY KEY (`debit_note_id`);

ALTER TABLE `debit_note_internal` ADD `total_amount` DECIMAL NOT NULL AFTER `tcs_value`;
ALTER TABLE `debit_note_internal` CHANGE `total_amount` `total_amount` DECIMAL(10,2) NOT NULL;

ALTER TABLE `debit_note_internal` ADD `mmh_mrc_refno` VARCHAR(100) NOT NULL AFTER `total_amount`;

INSERT INTO `all_permissions` (`permission_id`, `permission_key`, `status`) VALUES (NULL, 'view_debit_note', '1');