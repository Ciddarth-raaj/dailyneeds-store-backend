-- =====================================================================
-- Attendance Regularisation: a missed BREAK (lunch OUT + IN) is regularised
-- through the SAME request, as a PAIR of manual punches.
--
-- Until now a regularization carried exactly one manual punch, and the
-- unique key on the request said so. A day like 10:09 -> 22:04 whose
-- employee took lunch without punching needs TWO punches (14:00 OUT,
-- 15:00 IN) approved together: the day must never be effective with only
-- one of them, which would make it odd again.
--
-- The only change: one request may hold more than one punch, never the
-- same instant twice. The punches stay in `attendance_regularized_punch`,
-- marked REGULARIZED, effective only while their request is APPROVED and
-- SETTLED - exactly as before. Raw Biomax / DigiSME punches are untouched.
--
-- The new key leads with the request id, so it serves the foreign key; it
-- is added BEFORE the old one is dropped.
-- =====================================================================

ALTER TABLE `attendance_regularized_punch`
  ADD UNIQUE KEY `uq_arp_request_time` (`attendance_approval_request_id`, `punch_time`);

ALTER TABLE `attendance_regularized_punch`
  DROP INDEX `uq_arp_request`;
