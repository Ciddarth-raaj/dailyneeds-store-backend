-- A VERIFICATION SESSION RAISED FOR ONE EMPLOYEE BELONGS TO THAT EMPLOYEE.
--
-- ================================================= WHAT THIS CLOSES ========
--
-- The existing-employee Aadhaar flow binds a session to the ACTING USER
-- (`initiated_by_employee_id`) and to nothing else. So a direct API caller
-- holding `verify_employee_aadhaar` could:
--
--   1. POST /hr/employee/A/aadhaar/initiate   -> a verification token
--   2. POST /hr/employee/B/aadhaar/verify-otp -> the same token, another
--                                                employee in the same branch
--   3. POST /hr/employee/B/aadhaar/attach     -> A's Aadhaar lands on B
--
-- Every existing check passes: same caller, same branch, both PENDING. The UI
-- would not do it; authorization must not depend on the UI not doing it. The
-- missing fact is simply WHO the session was raised for, and no column
-- recorded it.
--
--   target_employee_id   NULL      an ONBOARDING session: there is no employee
--                                  yet, and Create Employee consumes it, which
--                                  is the existing and unchanged meaning
--                        an id     an EXISTING-EMPLOYEE session, raised for
--                                  exactly that employee and consumable by no
--                                  other
--
-- IT IS NOT `employee_id`, WHICH ALREADY MEANS SOMETHING ELSE. That column is
-- written when a create or an attach CONSUMES the verification - "this session
-- was spent on employee 412" - and it is NULL for the entire life of a session
-- that has not been consumed yet, which is precisely the window this attack
-- lives in. Overloading it would destroy the distinction between "raised for"
-- and "spent on", and the consume path needs both to compare them.
--
-- NOTHING IS BACKFILLED. Historical rows stay NULL and therefore keep exactly
-- the onboarding semantics they have today: no employee id is guessed for a
-- session whose target nobody recorded, because a guess here would bind an old
-- Aadhaar to the wrong person permanently.
--
-- NO EMPLOYEE ROW, IDENTITY ROW OR VERIFIED RECORD IS TOUCHED. This adds one
-- nullable column and one index and does nothing else.
--
-- NO FOREIGN KEY, deliberately, and consistent with this directory: the
-- comparable nullable reference added by an ALTER here -
-- `employee_bank_verification.duplicate_of_employee_id`, in
-- `20260909120000-c2-bank-duplicate-guard` - carries none either. The column
-- is never joined or used to look an employee up; it exists to be COMPARED
-- against the employee id the route already resolved and branch-scoped, and
-- the comparison is enforced in the usecase. A RESTRICT foreign key would add
-- no integrity this comparison does not already have, and would newly make
-- deleting an employee fail because of a spent verification session.
--
-- MySQL has no `ADD COLUMN IF NOT EXISTS`, and a migration that cannot be
-- re-run is one that cannot be recovered halfway through - which is exactly
-- when it matters. Both statements below are guarded, as
-- `20260909120000-c2-bank-duplicate-guard` does it.

-- ----------------------------------------------------------------- column
SET @add_target = IF(
  (SELECT COUNT(*) FROM `information_schema`.`COLUMNS`
    WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_aadhaar_verification'
      AND `COLUMN_NAME` = 'target_employee_id') = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD COLUMN `target_employee_id` INT NULL COMMENT ''the employee this session was RAISED for; NULL = onboarding, no employee yet'' AFTER `initiated_by_employee_id`',
  'DO 0');
PREPARE add_stmt FROM @add_target;
EXECUTE add_stmt;
DEALLOCATE PREPARE add_stmt;

-- ------------------------------------------------------------------ index
-- For the integrity question "what sessions were raised for this employee",
-- which is the one an audit or a cleanup asks. Small today; it will not be.
SET @has_target_index = (
  SELECT COUNT(*) FROM `information_schema`.`STATISTICS`
   WHERE `TABLE_SCHEMA` = DATABASE()
     AND `TABLE_NAME` = 'employee_aadhaar_verification'
     AND `INDEX_NAME` = 'idx_aadhaar_verification_target_employee'
);
SET @target_index_sql = IF(
  @has_target_index = 0,
  'ALTER TABLE `employee_aadhaar_verification` ADD KEY `idx_aadhaar_verification_target_employee` (`target_employee_id`)',
  'DO 0'
);
PREPARE target_index_stmt FROM @target_index_sql;
EXECUTE target_index_stmt;
DEALLOCATE PREPARE target_index_stmt;
