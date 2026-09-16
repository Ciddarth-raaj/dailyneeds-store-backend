-- EMPLOYMENT TYPE AND GRADE ON THE EMPLOYEE MASTER.
--
-- Two CLASSIFICATION columns on `new_employee`, and nothing else. They
-- describe how somebody is engaged (Permanent or Contract) and the internal
-- band they sit in (A to E). Nothing reads them to decide anything: not
-- payroll, not attendance, not PF or ESI, not the shift engine and not any
-- permission. They exist to be recorded and displayed.
--
-- ADDITIVE AND BACKWARD-COMPATIBLE. Both are NULLable with no default and
-- there is no backfill, so every one of the existing employees keeps a row
-- that is exactly as valid as it was: "not recorded" stays a legitimate,
-- permanent state and nobody is assigned a type or a grade they were never
-- given. A value arrives only when a human chooses one.
--
-- WHY ENUM AND NOT VARCHAR. The set is fixed, small and controlled by the
-- business - the task states it as a closed list - and this schema already
-- expresses exactly that with ENUM (`employee_work_shift_assignment.source`,
-- `salary_revision.status`, `attendance_ot.closure_reason`). The application
-- validates the same set in `utils/employment_classification.js`, so an
-- unsupported value is a clear 422 rather than a truncation; the column type
-- is the second line of defence, for anything that ever reaches the database
-- without crossing that layer.
ALTER TABLE `new_employee`
  ADD COLUMN `employment_type` ENUM('Permanent','Contract') NULL DEFAULT NULL
    COMMENT 'classification only, how the employee is engaged. Nothing derives pay, attendance or permissions from it',
  ADD COLUMN `grade` ENUM('A','B','C','D','E') NULL DEFAULT NULL
    COMMENT 'classification only, the internal band A to E. Nothing derives pay, attendance or permissions from it';
