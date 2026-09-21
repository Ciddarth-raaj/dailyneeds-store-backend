-- Remove the Shift Change Eligibility report's two permission keys and every
-- grant of them.
--
-- SAFE TO RUN. The keys gate only the read-only report router, so removing
-- them makes that screen 403 and changes nothing else.
--
-- NO TABLE IS DROPPED, because the `up` created none. No attendance, punch,
-- shift, employee, request or payroll table is touched, because the `up`
-- altered none.
DELETE FROM `permissions` WHERE `permission_key` IN ('view_shift_change_eligibility_report', 'export_shift_change_eligibility_report');
DELETE FROM `all_permissions` WHERE `permission_key` IN ('view_shift_change_eligibility_report', 'export_shift_change_eligibility_report');
