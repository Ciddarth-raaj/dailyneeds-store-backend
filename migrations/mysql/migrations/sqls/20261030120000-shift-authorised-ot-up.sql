-- OT AUTHORISED BY AN APPROVED ONE-DAY SHIFT CHANGE - the PROVENANCE only.
--
-- ADDITIVE, and deliberately small. The authorisation itself is NOT stored
-- here and is not a new concept: it is the link that already exists,
--
--   attendance_date_shift_override.attendance_approval_request_id
--     -> attendance_approval_request (SHIFT_CHANGE, APPROVED, SETTLED)
--
-- read on every calculation. Freezing a number at approval would have been
-- the wrong shape: a request can be approved BEFORE the date is worked, when
-- the right answer is zero, and a later correction to the punches must move
-- it in both directions. The engine therefore derives it every time, and
-- what these columns hold is the ANSWER IT REACHED and WHY - so a payslip
-- query can say where an approved minute came from without re-resolving the
-- override and its request.
ALTER TABLE `attendance_day_calculation`
  ADD COLUMN `shift_authorised_ot_minutes` INT NOT NULL DEFAULT 0
    COMMENT 'of approved_ot_minutes, the part an approved SHIFT_CHANGE authorised - no OT request exists for it'
    AFTER `approved_ot_minutes`,
  ADD COLUMN `approved_ot_source` ENUM('OT_REQUEST','SHIFT_CHANGE') NULL
    COMMENT 'why this day has approved OT. NULL = none approved'
    AFTER `shift_authorised_ot_minutes`,
  ADD COLUMN `ot_authorising_request_id` BIGINT UNSIGNED NULL
    COMMENT 'the SHIFT_CHANGE request that authorised it, for audit'
    AFTER `approved_ot_source`,
  ADD KEY `idx_adc_ot_authorising_request` (`ot_authorising_request_id`);
