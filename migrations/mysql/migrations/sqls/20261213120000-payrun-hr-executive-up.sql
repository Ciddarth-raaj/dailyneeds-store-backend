-- HR SEES THE PAYRUN.
--
-- The Payrun needs all three of view_employees, view_payroll and view_salary.
-- view_payroll was declared granted-to-nobody, to be given deliberately on
-- the Designation rights screen - but the screen never listed it, so nobody
-- but an administrator could reach the Payrun. The frontend now lists every
-- Payrun key; this grants the three READ keys to HR, at the owner's request.
--
-- 'HR EXECUTIVE' by name, as earlier migrations in this directory do.
--
-- READ ONLY. process_payroll, approve_payrun, publish_payrun, unlock_payrun
-- and the other Payrun actions are NOT granted: each is ticked deliberately
-- on the rights screen.
--
-- Additive and idempotent. An existing row, active or not, is left alone.

INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM (SELECT 'view_employees' AS `permission_key`
          UNION SELECT 'view_payroll'
          UNION SELECT 'view_salary') k
    JOIN `designation` d ON UPPER(TRIM(d.`designation_name`)) = 'HR EXECUTIVE'
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );
