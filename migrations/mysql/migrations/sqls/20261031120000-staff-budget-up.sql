-- Staff Budget Master - Phase 1.
--
-- The approved headcount plan, on the common hierarchy
--
--   Location -> Department -> Designation -> Shift -> Approved Headcount
--
-- and the SAME hierarchy for every operating location, Warehouse included.
-- Warehouse is an ordinary row in `outlets`, so nothing here special-cases it
-- and no department is flattened away for it.
--
-- ADDITIVE AND ISOLATED. Nothing here reads, copies or alters the legacy
-- `budget` table (the /store-budget "Employee Count" screen); that feature is
-- left running untouched and is superseded, not migrated, in this phase.
-- Payroll, attendance, GST/Tally and the employee master are not touched.
--
-- APPROVED HEADCOUNT IS A MANAGEMENT NUMBER, NOT A MEASUREMENT. It is typed
-- in, it is never derived from who is currently employed, and no attendance
-- or payroll process writes to it. There is deliberately no financial year
-- and no from/to date: exactly one current row exists per combination, and
-- what it used to say lives in `staff_budget_history`.

-- ------------------------------------------------------- the budget itself
--
-- The unique key is the whole point of the table: one current approved
-- headcount per (location, department, designation, shift), enforced by the
-- database rather than by whoever last edited the screen.
--
-- The four dimensions are separate masters with no mapping between them -
-- there is no department <-> designation table in this schema and this
-- migration does not invent one. A row here IS the record that management
-- approved that combination; the application validates only that each master
-- record exists and is active.
CREATE TABLE IF NOT EXISTS `staff_budget` (
  `staff_budget_id` INT AUTO_INCREMENT PRIMARY KEY,

  -- `outlets` is the one location master (docs/hr-schema.md): it is what
  -- `new_employee.store_id` points at. The legacy `store` table is not used.
  `outlet_id` INT NOT NULL,
  `department_id` INT NOT NULL,
  `designation_id` INT NOT NULL,

  -- `work_shift` - THE SHIFT MASTER THE ATTENDANCE ENGINE ACTUALLY USES, not
  -- the legacy `shift_master`.
  --
  -- The engine resolves "which shift applied" from the dated
  -- `employee_work_shift_assignment` history, whose `work_shift_id` is
  -- documented in its own migration as "the NEW master, never shift_master",
  -- and the Staffing Dashboard filters on the same `work_shift_id`. Nothing in
  -- attendance_calculation or attendance_dashboard reads `shift_master` at
  -- all. Budgeting against `shift_master` would mean the approved headcount
  -- for a shift and the attendance measured on it were keyed to two different
  -- entities - an ECR Cashier 2-10 budget that no staffing figure could ever
  -- be compared against.
  --
  -- Daily In/Out times live in `work_shift_weekly_schedule`, which is where
  -- the Opening/Peak/Closing coverage is derived from.
  `work_shift_id` INT NOT NULL,

  -- Integer, never negative. The CHECK is enforced on MySQL 8.0.16+ and is
  -- inert on older servers, so usecase/staff_budget.js validates it as well
  -- and is the guarantee that actually holds everywhere.
  `approved_headcount` INT NOT NULL DEFAULT 0,

  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, 0=removed from the plan',

  -- The audit convention already used across this backend: the actor is an
  -- `new_employee.employee_id`. No FK is declared on it, matching the tables
  -- added most recently.
  `created_by` INT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` INT NULL,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT `chk_staff_budget_headcount` CHECK (`approved_headcount` >= 0),

  -- THE RULE THIS TABLE EXISTS TO HOLD: no duplicate combination, ever.
  -- Soft-deleted rows (status = 0) stay inside the key on purpose, so
  -- re-adding a combination reuses its row and keeps its history rather than
  -- starting a second one beside it.
  UNIQUE KEY `uq_staff_budget_combination`
    (`outlet_id`, `department_id`, `designation_id`, `work_shift_id`),

  -- The screen is read location by location.
  KEY `idx_staff_budget_outlet` (`outlet_id`, `department_id`, `designation_id`),

  CONSTRAINT `fk_staff_budget_outlet`
    FOREIGN KEY (`outlet_id`) REFERENCES `outlets` (`outlet_id`),
  CONSTRAINT `fk_staff_budget_department`
    FOREIGN KEY (`department_id`) REFERENCES `department` (`department_id`),
  CONSTRAINT `fk_staff_budget_designation`
    FOREIGN KEY (`designation_id`) REFERENCES `designation` (`designation_id`),
  CONSTRAINT `fk_staff_budget_work_shift`
    FOREIGN KEY (`work_shift_id`) REFERENCES `work_shift` (`work_shift_id`)
) ENGINE = InnoDB;

-- --------------------------------------------------------- the shift rates
--
-- Monthly rate per designation per shift, and NOT per location: the same
-- Customer Service Associate 10-10 rate applies at every store, so holding it
-- once is the whole reason this is its own table.
--
-- DELIBERATELY EMPTY AT MIGRATION TIME, AND NOT FILLED BY ANY AUTOMATIC
-- MATCH. The five decided rates belong to two designations and five shifts
-- whose ids differ between production and any restored copy. A migration that
-- guessed an id would attach real money to whatever designation held that
-- number, and an action that matched on a NAME or on a pair of TIMES would do
-- the same thing with an extra step - silently, in production.
--
-- So the rows are entered on the rate screen, where a person picks the
-- designation and the work shift by name from the live masters and confirms
-- the amount. What is stored is the ids they picked.
CREATE TABLE IF NOT EXISTS `staff_budget_rate` (
  `staff_budget_rate_id` INT AUTO_INCREMENT PRIMARY KEY,
  `designation_id` INT NOT NULL,
  `work_shift_id` INT NOT NULL,

  -- Rupees per month for one approved position on this shift.
  `monthly_rate` DECIMAL(12,2) NOT NULL,

  `status` TINYINT NOT NULL DEFAULT 1 COMMENT '1=active, 0=retired',
  `created_by` INT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_by` INT NULL,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT `chk_staff_budget_rate_amount` CHECK (`monthly_rate` >= 0),

  UNIQUE KEY `uq_staff_budget_rate_designation_shift` (`designation_id`, `work_shift_id`),

  CONSTRAINT `fk_staff_budget_rate_designation`
    FOREIGN KEY (`designation_id`) REFERENCES `designation` (`designation_id`),
  CONSTRAINT `fk_staff_budget_rate_work_shift`
    FOREIGN KEY (`work_shift_id`) REFERENCES `work_shift` (`work_shift_id`)
) ENGINE = InnoDB;

-- ------------------------------------------------------------- the history
--
-- Append-only. The current value lives on `staff_budget` and changes in
-- place; every change that actually moved the number appends one row here and
-- nothing ever updates or deletes one. `old_headcount` is NULL for the row
-- that created the combination.
--
-- This is not a parallel versioning framework: it answers one question - who
-- changed an approved headcount, from what, to what, and when.
CREATE TABLE IF NOT EXISTS `staff_budget_history` (
  `staff_budget_history_id` INT AUTO_INCREMENT PRIMARY KEY,
  `staff_budget_id` INT NOT NULL,
  `old_headcount` INT NULL COMMENT 'NULL when the budget row was created',
  `new_headcount` INT NOT NULL,
  `changed_by` INT NULL,
  `changed_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,

  KEY `idx_staff_budget_history_budget` (`staff_budget_id`, `changed_at`),

  -- The history of a combination dies with the combination only if the
  -- combination is hard-deleted, which the application never does: removal is
  -- `status = 0` and keeps both the row and its history.
  CONSTRAINT `fk_staff_budget_history_budget`
    FOREIGN KEY (`staff_budget_id`) REFERENCES `staff_budget` (`staff_budget_id`)
    ON DELETE CASCADE
) ENGINE = InnoDB;
