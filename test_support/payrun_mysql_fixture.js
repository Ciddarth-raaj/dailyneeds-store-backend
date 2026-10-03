/**
 * The real-SQL payroll schema shared by the payroll MySQL suites.
 *
 * Every payrun table is built from the MIGRATION FILES THEMSELVES; the source
 * tables a calculation reads are stand-ins carrying the production names and
 * the columns those reads use. See the suites for what each proves.
 */
const path = require("path");

const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const MIGRATIONS = [
  "20261021120000-payrun-initialization-up.sql",
  "20261022120000-payrun-adjustments-up.sql",
  "20261023120000-payrun-calculation-up.sql",
  "20261024120000-payrun-calculation-column-drift-up.sql",
  "20261026120000-payrun-attendance-close-up.sql",
  "20261110120000-payrun-calculation-reset-up.sql",
  "20261111120000-payrun-lifecycle-up.sql",
];
const RESET_DOWN = "20261110120000-payrun-calculation-reset-down.sql";

/** Every table this suite creates, children first so they drop cleanly. */
const TABLES = [
  "payrun_employee_lifecycle_audit",
  "attendance_recalculation_run",
  "payrun_employee_calculation_reset_audit",
  "payrun_employee_calculation_audit",
  "payrun_employee_calculation",
  "payrun_attendance_close_audit",
  "payrun_employee_adjustment_audit",
  "payrun_employee_adjustment_state",
  "payrun_employee_adjustment",
  "payrun_employee_pay_type_audit",
  "payrun_employee",
  "payrun_period",
  "all_permissions",
  "employee_salary",
  "attendance_monthly_payroll",
  "attendance_day_calculation",
  "attendance_approval_request",
  "attendance_permission",
  "biomax_punch",
  "employee_bank_verification",
  "new_employee",
];

/** The source / master tables. A reset must leave every one of them identical. */
const SOURCES = [
  "new_employee",
  "employee_salary",
  "attendance_monthly_payroll",
  "attendance_day_calculation",
  "attendance_approval_request",
  "attendance_permission",
  "biomax_punch",
  "employee_bank_verification",
];
/** The payrun's own inputs and history. A reset must leave these identical too. */
const PAYRUN_INPUTS = [
  "payrun_period",
  "payrun_employee",
  "payrun_employee_pay_type_audit",
  "payrun_employee_adjustment",
  "payrun_employee_adjustment_state",
  "payrun_employee_adjustment_audit",
  "payrun_attendance_close_audit",
  "payrun_employee_calculation_audit",
];

const STAND_INS = [
  `CREATE TABLE attendance_recalculation_run (
     attendance_recalculation_run_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     work_shift_id INT NULL, status VARCHAR(32) NOT NULL, trigger_source VARCHAR(32) NOT NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE new_employee (
     employee_id INT PRIMARY KEY, employee_name VARCHAR(100), store_id INT,
     pf_applicable TINYINT(1), esi_applicable TINYINT(1), previous_eps_member TINYINT(1),
     dob DATE, date_of_joining VARCHAR(40), resignation_date DATE NULL,
     uan VARCHAR(45), esi_number VARCHAR(45), attendance_required TINYINT(1) DEFAULT 1
   ) ENGINE=InnoDB`,
  `CREATE TABLE all_permissions (permission_key VARCHAR(100) PRIMARY KEY) ENGINE=InnoDB`,
  `CREATE TABLE employee_salary (
     salary_id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT NOT NULL,
     monthly_gross DECIMAL(12,2), daily_salary DECIMAL(12,2), basic DECIMAL(12,2),
     conveyance DECIMAL(12,2), hra DECIMAL(12,2), special_allowance DECIMAL(12,2),
     effective_from DATE NOT NULL, status VARCHAR(20) NOT NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_monthly_payroll (
     attendance_monthly_payroll_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     employee_id INT NOT NULL, period_year SMALLINT NOT NULL, period_month TINYINT NOT NULL,
     is_final TINYINT(1) NOT NULL, payroll_version INT NOT NULL,
     salary_days INT, extra_days INT, base_days INT,
     monthly_gross DECIMAL(12,2), daily_rate DECIMAL(12,2),
     salary_day_earnings DECIMAL(12,2), extra_day_earnings DECIMAL(12,2),
     shortage_minutes INT, missing_minute_deduction DECIMAL(12,2),
     approved_ot_minutes INT, approved_ot_earnings DECIMAL(12,2),
     calculated_at TIMESTAMP(3) NOT NULL,
     day_rows_fingerprint VARCHAR(80) NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_day_calculation (
     employee_id INT NOT NULL, attendance_date DATE NOT NULL,
     nrm_minutes INT, break_allowance_source VARCHAR(32), is_final TINYINT(1),
     approved_ot_minutes INT DEFAULT 0,
     status VARCHAR(32) NOT NULL DEFAULT 'FINAL', attendance_day_count INT DEFAULT 1,
     base_nrm_minutes INT, worked_minutes INT, shortage_minutes INT DEFAULT 0,
     ot_rate DECIMAL(6,2) DEFAULT 1, permission_minutes INT DEFAULT 0,
     calculation_version INT DEFAULT 11, attendance_calculation_mode VARCHAR(32) DEFAULT 'SHIFT_BASED',
     PRIMARY KEY (employee_id, attendance_date)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_approval_request (
     attendance_approval_request_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     request_type VARCHAR(32) NOT NULL, requested_for_employee_id INT NOT NULL,
     attendance_date DATE NOT NULL, status VARCHAR(16) NOT NULL,
     finalization_state VARCHAR(16) NOT NULL DEFAULT 'NOT_REQUIRED',
     approved_ot_minutes INT NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_permission (
     attendance_permission_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     employee_id INT NOT NULL, attendance_date DATE NOT NULL, minutes INT, status VARCHAR(16)
   ) ENGINE=InnoDB`,
  `CREATE TABLE biomax_punch (
     biomax_punch_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     employee_id INT NOT NULL, punch_time DATETIME NOT NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE employee_bank_verification (
     employee_bank_verification_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     employee_id INT NOT NULL, account_last4 CHAR(4), status VARCHAR(16)
   ) ENGINE=InnoDB`,
];


module.exports = { SQLS, MIGRATIONS, RESET_DOWN, TABLES, SOURCES, PAYRUN_INPUTS, STAND_INS };
