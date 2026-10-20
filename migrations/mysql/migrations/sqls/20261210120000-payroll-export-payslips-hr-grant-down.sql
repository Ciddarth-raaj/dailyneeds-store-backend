-- Takes back HR's export grant, and nothing else: the key itself (declared by
-- 20261122120000) and any other designation's grant are untouched.
DELETE p FROM `permissions` p
  JOIN `designation` d ON d.`designation_id` = p.`designation_id`
 WHERE p.`permission_key` = 'payroll_export_payslips'
   AND UPPER(TRIM(d.`designation_name`)) = 'HR EXECUTIVE';
