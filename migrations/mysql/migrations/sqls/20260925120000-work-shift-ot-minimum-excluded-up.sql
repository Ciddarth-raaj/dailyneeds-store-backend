-- Work Shift - "Exclude Minimum Over Time", as the DigiSME shift configuration
-- had it, for post-shift and for pre-shift OT.
--
-- With the flag on, the minimum is NOT paid: OT below the minimum pays
-- nothing, and OT at or above it pays only the minutes BEYOND the minimum
-- (39 minutes after out-time on a 20-minute minimum pays 19). With it off the
-- existing reading of the minimum applies (threshold-only or floor, per
-- `overtime_minimum_threshold_only`).
--
-- Seeded ON for every shift that already has OT allowed with a minimum, so
-- the DigiSME behaviour those shifts were configured with carries over. A
-- shift with no minimum is unaffected either way.
ALTER TABLE `work_shift`
  ADD COLUMN `overtime_minimum_excluded` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = the minimum OT minutes are excluded from pay; only minutes beyond it are paid'
    AFTER `overtime_minimum_threshold_only`,
  ADD COLUMN `pre_shift_overtime_minimum_excluded` TINYINT(1) NOT NULL DEFAULT 0
    COMMENT '1 = the pre-shift minimum OT minutes are excluded from pay'
    AFTER `pre_shift_overtime_minimum_minutes`;

UPDATE `work_shift`
   SET `overtime_minimum_excluded` = 1
 WHERE `overtime_allowed` = 1 AND `overtime_minimum_minutes` > 0;

UPDATE `work_shift`
   SET `pre_shift_overtime_minimum_excluded` = 1
 WHERE `pre_shift_overtime_allowed` = 1 AND `pre_shift_overtime_minimum_minutes` > 0;
