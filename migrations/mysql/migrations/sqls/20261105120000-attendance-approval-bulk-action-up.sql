-- =====================================================================
-- Unified Approval Centre BULK actions: the per-record CORRELATION log.
--
-- A bulk Approve / Reject / Revoke is NOT a second workflow. The bulk
-- endpoint calls the SAME `decide` / `revokeDecision` the single-record
-- endpoints call, once per selected request, and each of those writes the
-- request's own history exactly as before - the decided step row (who, when,
-- remarks, source) for an approval or rejection, and an
-- `attendance_approval_revocation` row for a revocation.
--
-- THIS TABLE ADDS WHAT THOSE ROWS DO NOT CARRY: which bulk operation a
-- decision belonged to, the status before and after, and - for a record that
-- was skipped or failed - why nothing happened. One row PER SELECTED REQUEST,
-- never one row for the batch. Append-only: the application never updates or
-- deletes it.
--
-- ADDITIVE ONLY. No existing table or column is altered, no permission key
-- is inserted, and no row of any existing table is written.
-- =====================================================================
CREATE TABLE IF NOT EXISTS `attendance_approval_bulk_action_item` (
  `attendance_approval_bulk_action_item_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bulk_operation_id` CHAR(36) NOT NULL COMMENT 'one id per bulk request; every record it touched carries it',
  `action` ENUM('APPROVE','REJECT','REVOKE') NOT NULL,
  `attendance_approval_request_id` BIGINT UNSIGNED NOT NULL,
  `request_type` VARCHAR(32) NULL COMMENT 'as stored on the request; NULL when the id did not exist',
  `requested_for_employee_id` INT NULL,
  `attendance_date` DATE NULL,
  `previous_status` VARCHAR(16) NULL,
  `new_status` VARCHAR(16) NULL,
  `outcome` ENUM('SUCCEEDED','SKIPPED','FAILED') NOT NULL,
  `outcome_reason` VARCHAR(500) NULL COMMENT 'why a record was skipped or failed',
  `reason` VARCHAR(500) NULL COMMENT 'the rejection / revoke reason (or approval remarks) applied to this record',
  `acted_by_employee_id` INT NULL,
  `acted_by_user_id` INT NULL,
  `acted_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`attendance_approval_bulk_action_item_id`),
  KEY `idx_aabulk_operation` (`bulk_operation_id`),
  KEY `idx_aabulk_request` (`attendance_approval_request_id`),
  KEY `idx_aabulk_acted_at` (`acted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
