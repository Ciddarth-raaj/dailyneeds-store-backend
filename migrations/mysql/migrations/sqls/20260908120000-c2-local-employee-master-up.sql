-- Stage 0C / C2 — dnds.co.in becomes the employee master.
--
-- Two things, both additive, neither touching an employee row:
--
--   1. the five permission keys the local lifecycle actions need, granted to
--      exactly the designations that can already create employees, so that
--      nobody's effective access changes when this runs;
--   2. a deterministic seed of the `new_employee` AUTO_INCREMENT counter.
--
-- No table is created, no column is added, no employee, period or event is
-- written or renumbered.

-- ------------------------------------------------------------ permissions
-- `add_employees` is one key covering create, edit and status change alike,
-- which cannot express "may record a resignation but not create a hire".
-- These five can. Declared first; `all_permissions` has no unique key on
-- permission_key, so each insert guards itself.
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'employee_create' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'employee_create');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'employee_edit' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'employee_edit');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'employee_resign' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'employee_resign');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'employee_rejoin' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'employee_rejoin');
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_employee_lifecycle' FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM `all_permissions` WHERE `permission_key` = 'view_employee_lifecycle');

-- The grants. A designation that already holds an ACTIVE `add_employees`
-- can create and edit employees through POST /employee today, so giving it
-- the four action keys reproduces the access it already has rather than
-- widening anything. No designation that lacks `add_employees` gains
-- anything here, and `user_type = 2` needs no grant because the middleware
-- bypasses the table for administrators entirely.
--
-- Each insert is guarded on (permission_key, designation_id) because
-- `permissions` has no unique key either, so a re-run adds nothing.
INSERT INTO `permissions` (`permission_key`, `designation_id`, `is_active`)
  SELECT k.`permission_key`, d.`designation_id`, TRUE
    FROM ( SELECT 'employee_create' AS `permission_key`
           UNION ALL SELECT 'employee_edit'
           UNION ALL SELECT 'employee_resign'
           UNION ALL SELECT 'employee_rejoin'
           UNION ALL SELECT 'view_employee_lifecycle' ) k
    JOIN ( SELECT DISTINCT `designation_id` FROM `permissions`
            WHERE `permission_key` = 'add_employees' AND `is_active` = TRUE ) d
   WHERE NOT EXISTS (
     SELECT 1 FROM `permissions` p
      WHERE p.`permission_key` = k.`permission_key`
        AND p.`designation_id` = d.`designation_id` );

-- -------------------------------------------------- employee_id allocator
-- `new_employee.employee_id` is INT NOT NULL AUTO_INCREMENT PRIMARY KEY, so
-- the database already provides a concurrency-safe, restart-persistent,
-- never-reusing allocator. C2 adds no second one; it simply stops supplying
-- the column and takes what InnoDB allocates.
--
-- Both historical writers set the id explicitly - the Digisme sync from
-- EmployeeCode, the old create route from the client - so the counter has
-- only ever been dragged along behind those inserts. MySQL raises it past
-- any explicit value, and 8.0+ persists it across restart, so it should
-- already be correct; this makes that a fact rather than an assumption.
--
-- ALTER ... AUTO_INCREMENT never lowers the counter below the current
-- maximum, so this cannot cause a collision even if run twice, and it
-- renumbers nothing.
SET @next_employee_id = (SELECT IFNULL(MAX(`employee_id`), 0) + 1 FROM `new_employee`);
SET @seed_sql = CONCAT('ALTER TABLE `new_employee` AUTO_INCREMENT = ', @next_employee_id);
PREPARE seed_stmt FROM @seed_sql;
EXECUTE seed_stmt;
DEALLOCATE PREPARE seed_stmt;
