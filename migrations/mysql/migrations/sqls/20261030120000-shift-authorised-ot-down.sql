-- Reverses 20261030120000-shift-authorised-ot-up.sql. The authorisation
-- survives the reversal, because it never lived in these columns: it is the
-- override's link to its approved request, and that is untouched here.
ALTER TABLE `attendance_day_calculation`
  DROP INDEX `idx_adc_ot_authorising_request`,
  DROP COLUMN `ot_authorising_request_id`,
  DROP COLUMN `approved_ot_source`,
  DROP COLUMN `shift_authorised_ot_minutes`;
