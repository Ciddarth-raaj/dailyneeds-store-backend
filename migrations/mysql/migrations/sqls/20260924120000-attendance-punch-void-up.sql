-- Attendance - manual VOID of a raw punch.
--
-- ADDITIVE ONLY. One new table and one new permission key. No existing table
-- is altered, no existing row is rewritten, no permission is revoked, and no
-- row of `biomax_punch` or `biomax_punch_derived` is touched - now or by the
-- application afterwards.
--
-- WHY A SEPARATE TABLE. The raw punch is evidence: the device (or the DigiSME
-- import) recorded it, and it stays exactly as recorded, forever. "This punch
-- must not count" is a DECISION somebody took, with a reason, and it lives
-- beside the evidence rather than inside it. The calculation LEFT JOINs this
-- table and leaves a voided punch out of the effective stream; the Punch
-- Audit LEFT JOINs it and shows the punch as VOIDED with who, when and why.
--
-- ONE RAW PUNCH, ONE VOID. `biomax_punch_id` is globally unique across every
-- ingest source (LIVE device, HISTORICAL_PULL, DIGISME_IMPORT all insert into
-- the one `biomax_punch` table), so it identifies the punch on its own; the
-- UNIQUE KEY is what makes "two active voids for the same punch" impossible.
-- There is no un-void in this release, so no `is_active` flag is needed; if
-- one is ever added the unique key becomes (punch, active) then.
--
-- THE SNAPSHOT. `punch_source`, `employee_id` and `punch_io_time` are copied
-- from the raw row and its derived row at the moment of the void, so the
-- audit line reads on its own even if the derived row were ever re-matched.
-- They are never used to calculate anything - the calculation still reads
-- the raw punch.
--
-- A REGULARIZED punch (`attendance_regularized_punch`) cannot be recorded
-- here: there is no column for one, and the FOREIGN KEY only accepts a
-- `biomax_punch` id. Those punches belong to the approval workflow.

CREATE TABLE IF NOT EXISTS `attendance_punch_void` (
  `attendance_punch_void_id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `biomax_punch_id`        BIGINT UNSIGNED NOT NULL COMMENT 'the raw punch that must not count - biomax_punch.biomax_punch_id, untouched',
  `punch_source`           ENUM('BIOMAX','IMPORT') NOT NULL COMMENT 'snapshot: BIOMAX for a device punch (LIVE or HISTORICAL_PULL), IMPORT for DIGISME_IMPORT',
  `employee_id`            INT NOT NULL COMMENT 'snapshot of biomax_punch_derived.employee_id at the time of the void',
  `punch_io_time`          DATETIME NOT NULL COMMENT 'snapshot of biomax_punch.io_time (IST wall clock) at the time of the void',
  `attendance_date`        DATE NULL COMMENT 'the attendance date the engine derived for the punch when it was voided - the date that was recalculated',
  `reason`                 VARCHAR(500) NOT NULL COMMENT 'mandatory, entered by the actor',
  `voided_by_employee_id`  INT NULL COMMENT 'new_employee.employee_id of the actor',
  `voided_by_user_id`      INT NULL COMMENT 'user.user_id of the actor',
  `voided_at`              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`attendance_punch_void_id`),
  UNIQUE KEY `uq_apv_punch` (`biomax_punch_id`),
  KEY `idx_apv_employee_date` (`employee_id`, `attendance_date`),
  KEY `idx_apv_voided_at` (`voided_at`),
  CONSTRAINT `fk_apv_punch`
    FOREIGN KEY (`biomax_punch_id`) REFERENCES `biomax_punch` (`biomax_punch_id`)
    ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========================================================== permissions ====
--   void_attendance_punch   exclude ONE raw punch from calculation   NOBODY
--
-- Granted to nobody by this migration: a void changes the punch count and
-- therefore the worked minutes, the shortage, the overtime and the pay of a
-- date. Administrators reach it through the user_type 2 bypass; anybody else
-- is given it deliberately on the designation rights screen. It is NOT
-- implied by `view_attendance_punch_audit`, `view_calculated_attendance` or
-- `recalculate_attendance`.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'void_attendance_punch' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'void_attendance_punch');
