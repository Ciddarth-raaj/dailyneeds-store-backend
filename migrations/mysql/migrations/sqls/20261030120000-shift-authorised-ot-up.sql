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
-- what these columns hold is the ANSWER IT REACHED and WHY.
--
-- ============================ TWO COMPONENTS, BECAUSE A DAY CAN HAVE BOTH ==
--
-- One date can legitimately carry approved OT from TWO decisions:
--
--   the approved SHIFT_CHANGE     the overtime the longer shift produced
--   a standalone OT REQUEST       the excess earned outside that shift
--
-- A single `approved_ot_source` column could not describe that day without
-- lying about half of it, and a single request id could not say which
-- decision authorised which minutes. So each component is stored with its
-- own minutes and its own authorising request, and:
--
--     approved_ot_minutes = shift_authorised_ot_minutes
--                         + ot_request_approved_minutes
--
-- always, on every row. The SOURCE is DERIVED from the two figures where it
-- is wanted (both > 0 = MIXED) rather than stored, because a stored enum is
-- one more thing that can contradict the numbers it describes.
ALTER TABLE `attendance_day_calculation`
  ADD COLUMN `shift_authorised_ot_minutes` INT NOT NULL DEFAULT 0
    COMMENT 'of approved_ot_minutes, the part an approved SHIFT_CHANGE authorised - no OT request exists for it'
    AFTER `approved_ot_minutes`,
  ADD COLUMN `shift_authorising_request_id` BIGINT UNSIGNED NULL
    COMMENT 'the SHIFT_CHANGE request that authorised the minutes above'
    AFTER `shift_authorised_ot_minutes`,
  ADD COLUMN `ot_request_approved_minutes` INT NOT NULL DEFAULT 0
    COMMENT 'of approved_ot_minutes, the part a standalone OT request approved (the excess)'
    AFTER `shift_authorising_request_id`,
  ADD COLUMN `ot_request_id` BIGINT UNSIGNED NULL
    COMMENT 'the OT request that approved the minutes above'
    AFTER `ot_request_approved_minutes`,
  ADD KEY `idx_adc_shift_authorising_request` (`shift_authorising_request_id`),
  ADD KEY `idx_adc_ot_request` (`ot_request_id`);
