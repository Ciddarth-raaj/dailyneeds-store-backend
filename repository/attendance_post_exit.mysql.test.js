/**
 * THE LAST WORKING DATE AS THE HARD UPPER BOUNDARY - a Sep 9 joiner whose last
 * working date is 13 Sep, through the REAL attendance and payroll
 * repositories, as SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_post_exit.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database. The suite
 * creates, fills and drops its own tables.
 *
 * The world is the one found in production for employee 2284 (joined
 * 09-09-2026, last working date 13-09-2026): 14-09..30-09 stored ABSENT by an
 * earlier Process Attendance, plus - so the summary-finality rule is tested on
 * the upper side - one stale NO_SHIFT_FOR_DATE row on 20-09 that held the
 * summary non-final. Punches exist on 9, 10 and 11 Sep only.
 *
 * It proves: payroll reads the month final BEFORE any clean-up; a payroll-
 * locked month refuses Process Attendance and Recalculate with every table
 * byte-identical; Process Attendance on an open month leaves exactly
 * 09-09..13-09 with a final summary over those five dates; re-processing and
 * Recalculate cannot bring 14-30 Sep back; the payrun NRM evidence ignores a
 * stale post-exit row.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildCalcRepo = require("./attendance_calculation");
const { CALCULATION_COLUMNS, MONTHLY_PAYROLL_COLUMNS } = require("./attendance_calculation");
const buildPayrunCalcRepo = require("./payrun_calculation");
const buildPayrunRepo = require("./payrun");
const buildCalculation = require("../usecase/attendance_calculation");
const { evaluatePayrollReadiness, READINESS_REASON: REASON } = require("../utils/payroll_readiness");
const { attendanceStatusOf, evaluateEmployee } = require("../utils/payrun_eligibility");
const { resolveEffectiveNrm } = require("../utils/payrun_calculation");

const EMP = 2284;
const JOINED = "2026-09-09";
const LAST = "2026-09-13";
const YEAR = 2026;
const MONTH = 9;
const NOW = Date.parse("2026-10-04T12:00:00+05:30");
const pad = (n) => String(n).padStart(2, "0");
const sep = (d) => `2026-09-${pad(d)}`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => sep(a + i));
const SEP_9_TO_13 = range(9, 13);
const SEP_14_TO_30 = range(14, 30);

const SCHEMA = [
  `CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), store_id INT NULL, status INT NULL,
     attendance_required TINYINT(1) NOT NULL DEFAULT 1, date_of_joining VARCHAR(20) NULL, resignation_date DATE NULL,
     special_break_override_minutes INT NULL, extra_break_hours DECIMAL(5,2) NULL)`,
  `CREATE TABLE attendance_day_calculation (
     ${CALCULATION_COLUMNS.map((c) =>
       c === "employee_id" ? "employee_id INT NOT NULL" : c === "attendance_date" ? "attendance_date DATE NOT NULL" : `\`${c}\` TEXT NULL`
     ).join(",\n     ")},
     calculated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
     UNIQUE KEY uq_day (employee_id, attendance_date)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_monthly_payroll (
     attendance_monthly_payroll_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     ${MONTHLY_PAYROLL_COLUMNS.map((c) =>
       ["employee_id", "period_year", "period_month"].includes(c) ? `${c} INT NOT NULL` : `\`${c}\` TEXT NULL`
     ).join(",\n     ")},
     calculated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
     UNIQUE KEY uq_amp (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
  `CREATE TABLE payrun_employee_calculation (
     payrun_calculation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     payrun_employee_id INT NOT NULL, employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
     status VARCHAR(32) NOT NULL, net_pay DECIMAL(12,2) NULL, calculation_hash VARCHAR(64) NULL,
     UNIQUE KEY uq_pec (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
];
const TABLES = ["payrun_employee_calculation", "attendance_monthly_payroll", "attendance_day_calculation", "new_employee"];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

/* --------------------------------------------- the in-memory side: shift and punches */
const SHIFT = {
  config: {
    work_shift_id: 7, shift_code: "LATE", shift_name: "Late Shift", active: 1,
    overtime_allowed: 1, overtime_minimum_minutes: 0, overtime_rounding_method: "NONE",
    overtime_rounding_interval_minutes: 0, overtime_minimum_threshold_only: 0,
    maximum_ot_minutes_per_day: null, pre_shift_overtime_allowed: 0,
    pre_shift_overtime_minimum_minutes: 0, pre_shift_overtime_rounding_method: "NONE",
    pre_shift_overtime_rounding_interval_minutes: 0, late_offset_against_overtime: 0,
    early_exit_offset_against_overtime: 0,
  },
  schedule: Array.from({ length: 7 }, (_, day) => ({
    work_shift_weekly_schedule_id: 700 + day, work_shift_id: 7, day_of_week: day, is_working_day: 1,
    in_time: "10:00:00", out_time: "22:00:00", attendance_day_cutoff: "04:00:00",
    break_minutes: 60, normal_work_minutes: 660, ot_rate: 1,
  })),
};
const PUNCHES = [];
for (const d of [9, 10, 11]) {
  for (const t of ["10:00:00", "22:00:00"]) {
    PUNCHES.push({
      punch_id: PUNCHES.length + 1, employee_id: EMP, io_time: `${sep(d)} ${t}`, punch_date: sep(d),
      ingest_attendance_date: sep(d), dev_id: "DEV1", ingest_source: "DEVICE",
    });
  }
}

/** The REAL repository for every table write and read; shift and punches in memory. */
function hybridRepo(pool) {
  const real = buildCalcRepo(pool);
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    getShiftAssignmentHistory: async () => [
      { employee_work_shift_assignment_id: 1, employee_id: EMP, work_shift_id: 7, effective_from: "2026-09-01", source: "MIGRATION_BACKFILL" },
    ],
    getDateShiftOverrides: async () => [],
    getWorkShiftConfigsByIds: null,
    getWorkShiftSchedulesByIds: null,
    getWorkShiftConfigVersionsByIds: null,
    getWorkShiftWithSchedule: async (id) => (Number(id) === 7 ? SHIFT : null),
    getWorkShiftConfigVersions: async () => [],
    getRawPunchesByCalendarWindow: async (_e, from, to) => PUNCHES.filter((p) => p.punch_date >= from && p.punch_date <= to),
    getApprovedRegularizedPunches: async () => [],
    getApprovalStateByDate: async () => [],
    getPermissionsForRange: async () => [],
    getAttendanceCalculationModeHistory: async () => [],
    getMonthlyGrossAsOf: async () => ({ salary_id: 1, monthly_gross: 26000, effective_from: JOINED }),
  });
}

/** The stored world before the fix: 14-30 Sep ABSENT, one held NO_SHIFT row, a held summary. */
async function seedStaleWorld(pool) {
  const blank = Object.fromEntries(CALCULATION_COLUMNS.map((c) => [c, null]));
  const insert = (row) =>
    q(pool, `INSERT INTO attendance_day_calculation (${CALCULATION_COLUMNS.map((c) => `\`${c}\``).join(",")}) VALUES (?)`, [
      CALCULATION_COLUMNS.map((c) => row[c]),
    ]);
  for (const date of SEP_14_TO_30) {
    await insert({
      ...blank, employee_id: EMP, attendance_date: date, status: "ABSENT", is_final: 1, attendance_day_count: 0,
      nrm_minutes: 660, shortage_minutes: 0, approved_ot_minutes: 0, review_reasons: "[]",
      calculation_version: 11, attendance_calculation_mode: "SHIFT_BASED",
    });
  }
  // A stale held day and a stale FINAL one with an odd NRM, both after exit.
  await q(pool, `UPDATE attendance_day_calculation SET status='NO_SHIFT_FOR_DATE', is_final=0, nrm_minutes=0 WHERE attendance_date='2026-09-20'`);
  await q(pool, `UPDATE attendance_day_calculation SET status='FINAL', is_final=1, nrm_minutes=480, attendance_day_count=1 WHERE attendance_date='2026-09-21'`);
  const monthly = Object.fromEntries(MONTHLY_PAYROLL_COLUMNS.map((c) => [c, null]));
  Object.assign(monthly, {
    employee_id: EMP, period_year: YEAR, period_month: MONTH, available_from: JOINED, available_to: LAST,
    available_dates: 5, attendance_days: 3, salary_days: 3, shortage_minutes: 0, approved_ot_minutes: 0,
    held_dates: JSON.stringify(["2026-09-20"]), is_final: 0, payroll_version: 1, permission_minutes: 0,
    day_rows_fingerprint: "v0:stale",
  });
  await q(pool, `INSERT INTO attendance_monthly_payroll (${MONTHLY_PAYROLL_COLUMNS.map((c) => `\`${c}\``).join(",")}) VALUES (?)`, [
    MONTHLY_PAYROLL_COLUMNS.map((c) => monthly[c]),
  ]);
}

const dayDates = async (pool) =>
  (await q(pool, "SELECT DATE_FORMAT(attendance_date, '%Y-%m-%d') AS d FROM attendance_day_calculation WHERE employee_id = ? ORDER BY d", [EMP])).map((r) => r.d);
const snapshotTables = async (pool) => ({
  days: await q(pool, "SELECT * FROM attendance_day_calculation ORDER BY attendance_date"),
  month: await q(pool, "SELECT * FROM attendance_monthly_payroll"),
  payrun: await q(pool, "SELECT * FROM payrun_employee_calculation"),
});

describe("a Sep 9 joiner who left on Sep 13, through the real repositories, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let payrunCalcRepo;
  let payrunRepo;
  let calculation;

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=10`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    payrunCalcRepo = buildPayrunCalcRepo(pool);
    payrunRepo = buildPayrunRepo(pool);
    calculation = buildCalculation(hybridRepo(pool));
  });

  after(async () => {
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((r) => pool.end(r));
  });

  beforeEach(async () => {
    for (const t of TABLES) await q(pool, `DELETE FROM ${t}`);
    await q(pool, `INSERT INTO new_employee (employee_id, employee_name, store_id, status, date_of_joining, resignation_date)
                   VALUES (?, 'Jayagandhi', 3, 0, ?, ?)`, [EMP, JOINED, LAST]);
    await seedStaleWorld(pool);
  });

  const readiness = async () => {
    const [monthly] = await payrunCalcRepo.listAttendanceMonths([EMP], YEAR, MONTH);
    const dayRows = await payrunCalcRepo.listAttendanceDayRows([EMP], sep(1), sep(30));
    return evaluatePayrollReadiness({
      year: YEAR, month: MONTH,
      snapshot: { monthly_gross: 26000, basic: 13000, date_of_joining: JOINED, resignation_date: LAST },
      monthly, day_rows: dayRows.map(({ employee_id, ...r }) => r),
    });
  };

  it("1. before any clean-up: payroll reads the stored summary FINAL, status READY, no attendance blocker", async () => {
    for (const repo of [payrunCalcRepo, payrunRepo]) {
      const [row] = await repo.listAttendanceMonths([EMP], YEAR, MONTH);
      assert.equal(row.is_final, 1);
      assert.deepEqual(row.post_exit_held_dates, ["2026-09-20"]);
    }
    const [stored] = await q(pool, "SELECT is_final FROM attendance_monthly_payroll WHERE employee_id = ?", [EMP]);
    assert.equal(String(stored.is_final), "0", "reading never writes");
    const [attendance] = await payrunRepo.listAttendanceMonths([EMP], YEAR, MONTH);
    assert.equal(attendanceStatusOf({ attendance }).status, "READY");
    const r = await readiness();
    const codes = r.reasons.map((x) => x.code);
    assert.ok(!codes.includes(REASON.ATTENDANCE_SUMMARY_NOT_FINAL), codes.join(","));
    const incomplete = r.reasons.find((x) => x.code === REASON.ATTENDANCE_DAY_ROWS_INCOMPLETE);
    // 9-13 were never processed in the seeded world; not one post-exit date is named.
    assert.ok(incomplete);
    assert.deepEqual(incomplete.not_final_dates, []);
    assert.ok(incomplete.missing_dates.every((d) => d >= JOINED && d <= LAST), incomplete.missing_dates.join(","));
  });

  it("2. a payroll-LOCKED month: Process Attendance and Recalculate are refused, every table byte-identical", async () => {
    await q(pool, `INSERT INTO payrun_employee_calculation (payrun_employee_id, employee_id, period_year, period_month, status, net_pay, calculation_hash)
                   VALUES (1, ?, ?, ?, 'APPROVED_LOCKED', 3000, 'h-locked')`, [EMP, YEAR, MONTH]);
    const beforeTables = await snapshotTables(pool);
    await assert.rejects(
      calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    await assert.rejects(
      calculation.recalculateRange({ employee_id: EMP, from_date: sep(1), to_date: sep(30), now: NOW }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.deepEqual(await snapshotTables(pool), beforeTables);
    assert.deepEqual(await dayDates(pool), SEP_14_TO_30);
  });

  it("3. Process Attendance on an open month leaves exactly 9-13 Sep and a final summary over those 5 dates", async () => {
    const result = await calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW });
    assert.equal(result.is_final, true);
    assert.deepEqual(await dayDates(pool), SEP_9_TO_13);
    const statuses = await q(pool, "SELECT DATE_FORMAT(attendance_date, '%Y-%m-%d') AS d, status FROM attendance_day_calculation ORDER BY d");
    assert.deepEqual(statuses.map((r) => r.status), ["FINAL", "FINAL", "FINAL", "ABSENT", "ABSENT"]);
    const [m] = await q(pool, "SELECT * FROM attendance_monthly_payroll WHERE employee_id = ?", [EMP]);
    assert.equal(m.available_from, JOINED);
    assert.equal(m.available_to, LAST);
    assert.equal(String(m.available_dates), "5");
    assert.equal(String(m.attendance_days), "3");
    assert.equal(String(m.is_final), "1");
    assert.equal(m.held_dates, "[]");
    assert.equal((await readiness()).attendance_ready, true);
  });

  it("4. re-processing and Recalculate cannot bring 14-30 Sep back", async () => {
    await calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW });
    await calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW });
    await calculation.recalculateRange({ employee_id: EMP, from_date: sep(1), to_date: sep(30), now: NOW });
    assert.deepEqual(await dayDates(pool), SEP_9_TO_13);
  });

  it("5. the payrun NRM evidence never reads a post-exit row", async () => {
    assert.deepEqual(await payrunCalcRepo.listEffectiveNrm([EMP], sep(1), sep(30)), [], "the stale 480-min FINAL row of 21 Sep is not read");
    await calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW });
    const groups = await payrunCalcRepo.listEffectiveNrm([EMP], sep(1), sep(30));
    // 9-13 Sep: three worked days and two ABSENT ones, all final at the
    // shift's 660 - and nothing from after the last working date.
    assert.deepEqual(groups.map((g) => [Number(g.nrm_minutes), Number(g.day_count)]), [[660, 5]]);
  });
});
