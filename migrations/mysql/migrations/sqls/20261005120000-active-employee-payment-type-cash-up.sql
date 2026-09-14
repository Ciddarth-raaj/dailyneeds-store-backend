-- EVERY ACTIVE EMPLOYEE HAS A PAYMENT ROUTE. THE ONES WHO DO NOT ARE CASH.
--
-- `payment_type` means 1 Bank, 2 Cash. NULL means nobody ever said, and it is
-- not a third route - it is an absence, and the HR Onboarding dashboard reads
-- it honestly as UNKNOWN: `usecase/employee_status_summary.js` puts such an
-- employee in NEITHER Bank Pending NOR Cash -> Bank Pending, because it
-- cannot know which chase is owed. The result is a person nobody is following
-- up, invisible on the one screen that exists to make that visible.
--
-- The business answer is not a new dashboard rule. It is that at Daily Needs
-- an employee with no bank details on file IS being paid in cash - that is
-- how the first salary is handed over - so Cash is what these rows have meant
-- all along. Commit d783ca6 made that the default at creation. This migration
-- is the one-time cleanup of the rows created before it.
--
-- ============================================================== THE SCOPE ==
--
-- ACTIVE ONLY (`status = 1`), AND UNRECORDED ONLY (`payment_type IS NULL`).
-- Both halves of the WHERE are load-bearing:
--
--   status = 1              a resigned or inactive employee is nobody's
--                           outstanding work. Their historical NULL is a fact
--                           about a record nobody will act on again, and
--                           rewriting it would be this migration asserting a
--                           payment route for someone who is not being paid.
--                           They are deliberately left as they are.
--
--   payment_type IS NULL    an employee already marked Bank (1) or Cash (2)
--                           has had a human decide. This must never overwrite
--                           one - least of all a Bank employee, whose row
--                           would silently become "paid in cash".
--
-- NOTHING ELSE IS WRITTEN. One column, on one set of rows. No bank name, no
-- IFSC, no account number, no verification state; no salary and no payroll
-- history; no lifecycle period, resignation or event; no Aadhaar; and no
-- employee_id - identities are permanent and this does not go near them.
-- There is no schema change of any kind here: no ALTER, no DROP, no TRUNCATE,
-- no DELETE.
--
-- RE-RUNNABLE. A second run matches nothing, because the first run left no
-- active NULL rows behind.

UPDATE `new_employee`
   SET `payment_type` = 2
 WHERE `status` = 1
   AND `payment_type` IS NULL;
