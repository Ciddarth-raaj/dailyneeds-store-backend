-- Reverses 20261030120000-shift-authorised-ot-up.sql. The authorisation
-- survives the reversal, because it never lived in these columns: it is the
-- override's link to its approved request, and that is untouched here.
ALTER TABLE `attendance_day_calculation`
  DROP INDEX `idx_adc_ot_request`,
  DROP INDEX `idx_adc_shift_authorising_request`,
  DROP COLUMN `ot_request_id`,
  DROP COLUMN `ot_request_approved_minutes`,
  DROP COLUMN `shift_authorising_request_id`,
  DROP COLUMN `shift_authorised_ot_minutes`;
