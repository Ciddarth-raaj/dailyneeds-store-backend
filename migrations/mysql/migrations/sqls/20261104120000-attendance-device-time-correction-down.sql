-- Reverses 20261104120000 exactly. `biomax_punch` is not touched.
--
-- Dropping these tables DISCARDS every device time correction and its audit
-- trail, and every read falls back to the raw device time. Recalculate the
-- affected dates afterwards.
DROP TABLE IF EXISTS `attendance_device_time_correction_punch`;
DROP TABLE IF EXISTS `attendance_device_time_correction`;
