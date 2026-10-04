/**
 * THE JOINING DATE AS THE HARD LOWER BOUNDARY - a Sep 9 joiner, through the
 * REAL attendance and payroll repositories, as SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_pre_joining.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database. The suite
 * creates, fills and drops its own tables.
 *
 * The world is the one found in production for employee 2284 (joined
 * 09-09-2026): stale NO_SHIFT_FOR_DATE rows for 01-09..08-09 written by an
 * earlier Process Attendance, and a September summary stored NON-final with
 * exactly those dates held. Shift history and punches are supplied in memory
 * (the A0 backfill dated the shift from 01-09, so a roster DOES cover the
 * pre-joining dates); every attendance and payroll table write and read is
 * the real repository SQL.
 *
 * It proves, in order:
 *   1. BEFORE ANY CLEAN-UP, payroll already reads the month as final - the
 *      stored summary's pre-joining held dates do not hold it, and nobody has
 *      to remember to run Process Attendance first;
 *   2. a payroll-LOCKED month is refused before anything is deleted: no day
 *      row, no summary and no payrun row changes;
 *   3. Process Attendance on an open month removes 01-09..08-09, stores
 *      09-09..30-09, and writes a FINAL summary whose period starts 09-09;
 *   4. running it again, or Recalculate, cannot bring 01-09..08-09 back;
 *   5. the payrun's NRM evidence never reads a pre-joining row.
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
const YEAR = 2026;
const MONTH = 9;
const NOW = Date.parse("2026-10-04T12:00:00+05:30");
const pad = (n) => String(n).padStart(2, "0");
const sep = (d) => `2026-09-${pad(d)}`;
const SEP_1_TO_8 = [1, 2, 3, 4, 5, 6, 7, 8].map(sep);

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
for (let d = 9; d <= 30; d += 1) {
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

/** The stored world before the fix: 8 stale pre-joining rows and a held summary. */
async function seedStaleWorld(pool) {
  const blank = Object.fromEntries(CALCULATION_COLUMNS.map((c) => [c, null]));
  for (const date of SEP_1_TO_8) {
    const row = {
      ...blank, employee_id: EMP, attendance_date: date, status: "NO_SHIFT_FOR_DATE", is_final: 0,
      attendance_day_count: 0, nrm_minutes: 0, shortage_minutes: 0, approved_ot_minutes: 0,
      review_reasons: '["NO_SHIFT_FOR_DATE"]', calculation_version: 11, attendance_calculation_mode: "SHIFT_BASED",
    };
    await q(pool, `INSERT INTO attendance_day_calculation (${CALCULATION_COLUMNS.map((c) => `\`${c}\``).join(",")}) VALUES (?)`, [
      CALCULATION_COLUMNS.map((c) => row[c]),
    ]);
  }
  // A stale FINAL row too, with an NRM, so the payrun boundary is tested on
  // a row that WOULD otherwise be evidence.
  await q(pool, `UPDATE attendance_day_calculation SET status='FINAL', is_final=1, nrm_minutes=480, attendance_day_count=1 WHERE attendance_date='2026-09-08'`);
  // The summary as the old Process Attendance stored it: period from the 9th
  // (availableDates was always bounded), but the 1st-7th held -> is_final 0.
  const monthly = Object.fromEntries(MONTHLY_PAYROLL_COLUMNS.map((c) => [c, null]));
  Object.assign(monthly, {
    employee_id: EMP, period_year: YEAR, period_month: MONTH, available_from: JOINED, available_to: sep(30),
    available_dates: 22, attendance_days: 0, salary_days: 0, shortage_minutes: 0, approved_ot_minutes: 0,
    held_dates: JSON.stringify(SEP_1_TO_8.slice(0, 7)), is_final: 0, payroll_version: 1, permission_minutes: 0,
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

describe("a Sep 9 joiner through the real repositories, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let calcRepo;
  let payrunCalcRepo;
  let payrunRepo;
  let calculation;

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=10`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    calcRepo = hybridRepo(pool);
    payrunCalcRepo = buildPayrunCalcRepo(pool);
    payrunRepo = buildPayrunRepo(pool);
    calculation = buildCalculation(calcRepo);
  });

  after(async () => {
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((r) => pool.end(r));
  });

  beforeEach(async () => {
    for (const t of TABLES) await q(pool, `DELETE FROM ${t}`);
    await q(pool, `INSERT INTO new_employee (employee_id, employee_name, store_id, status, date_of_joining) VALUES (?, 'Jayagandhi', 3, 1, ?)`, [EMP, JOINED]);
    await seedStaleWorld(pool);
  });

  describe("1. before any clean-up, payroll already respects the joining date", () => {
    it("both payroll reads of the stored summary see it FINAL, naming the pre-joining dates they ignored", async () => {
      const [a] = await payrunCalcRepo.listAttendanceMonths([EMP], YEAR, MONTH);
      const [b] = await payrunRepo.listAttendanceMonths([EMP], YEAR, MONTH);
      for (const row of [a, b]) {
        assert.equal(row.is_final, 1);
        assert.deepEqual(row.pre_joining_held_dates, SEP_1_TO_8.slice(0, 7));
      }
      // The stored row itself is untouched - reading never writes.
      const [stored] = await q(pool, "SELECT is_final FROM attendance_monthly_payroll WHERE employee_id = ?", [EMP]);
      assert.equal(String(stored.is_final), "0");
    });

    it("no manual close: payrun attendance status READY, no ATTENDANCE_INCOMPLETE warning, no readiness blocker from 1-8 Sep", async () => {
      const [attendance] = await payrunRepo.listAttendanceMonths([EMP], YEAR, MONTH);
      const status = attendanceStatusOf({ attendance });
      assert.equal(status.status, "READY");
      assert.equal(status.closeable, false);

      const init = evaluateEmployee({
        year: YEAR, month: MONTH,
        employee: { employee_id: EMP, date_of_joining: JOINED, resignation_date: null, pf_applicable: 0, esi_applicable: 0 },
        salary: { monthly_gross: 26000 }, attendance,
      });
      assert.ok(!(init.warnings || []).includes("ATTENDANCE_INCOMPLETE"), JSON.stringify(init.warnings));

      const [monthly] = await payrunCalcRepo.listAttendanceMonths([EMP], YEAR, MONTH);
      const dayRows = await payrunCalcRepo.listAttendanceDayRows([EMP], sep(1), sep(30));
      const readiness = evaluatePayrollReadiness({
        year: YEAR, month: MONTH, snapshot: { monthly_gross: 26000, basic: 13000, date_of_joining: JOINED },
        monthly, day_rows: dayRows.map(({ employee_id, ...r }) => r),
      });
      const codes = readiness.reasons.map((r) => r.code);
      assert.ok(!codes.includes(REASON.ATTENDANCE_SUMMARY_NOT_FINAL), codes.join(","));
      const incomplete = readiness.reasons.find((r) => r.code === REASON.ATTENDANCE_DAY_ROWS_INCOMPLETE);
      // The 9th onward was never processed in this seeded world, so those are
      // reported as NOT PROCESSED - and not one pre-joining date is named.
      assert.ok(incomplete, "9-30 Sep are missing in the seeded world");
      assert.deepEqual(incomplete.not_final_dates, []);
      assert.ok(incomplete.missing_dates.every((d) => d >= JOINED));
    });

    it("a summary held by a date ON or AFTER the joining date stays non-final", async () => {
      await q(pool, "UPDATE attendance_monthly_payroll SET held_dates = ? WHERE employee_id = ?", [JSON.stringify(["2026-09-03", "2026-09-12"]), EMP]);
      const [row] = await payrunCalcRepo.listAttendanceMonths([EMP], YEAR, MONTH);
      assert.equal(String(row.is_final), "0");
    });
  });

  describe("2. a payroll-LOCKED month", () => {
    it("Process Attendance is refused before anything is deleted: days, summary and payrun row are byte-identical", async () => {
      await q(pool, `INSERT INTO payrun_employee_calculation (payrun_employee_id, employee_id, period_year, period_month, status, net_pay, calculation_hash)
                     VALUES (1, ?, ?, ?, 'APPROVED_LOCKED', 18000, 'h-locked')`, [EMP, YEAR, MONTH]);
      const beforeTables = await snapshotTables(pool);
      await assert.rejects(
        calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW }),
        (err) => err.code === "PAYROLL_MONTH_LOCKED"
      );
      assert.deepEqual(await snapshotTables(pool), beforeTables);
      assert.deepEqual(await dayDates(pool), SEP_1_TO_8, "all eight stale rows are still there");
    });

    it("Recalculate is refused the same way, and deletes nothing", async () => {
      await q(pool, `INSERT INTO payrun_employee_calculation (payrun_employee_id, employee_id, period_year, period_month, status)
                     VALUES (1, ?, ?, ?, 'APPROVED_LOCKED')`, [EMP, YEAR, MONTH]);
      const beforeTables = await snapshotTables(pool);
      await assert.rejects(
        calculation.recalculateRange({ employee_id: EMP, from_date: sep(1), to_date: sep(30), now: NOW }),
        (err) => err.code === "PAYROLL_MONTH_LOCKED"
      );
      assert.deepEqual(await snapshotTables(pool), beforeTables);
    });
  });

  describe("3-5. an open month, through the normal workflow", () => {
    it("Process Attendance removes 1-8 Sep, stores 9-30 Sep, and the summary is FINAL from 09-09", async () => {
      const result = await calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW });
      assert.equal(result.is_final, true);
      const dates = await dayDates(pool);
      assert.equal(dates.length, 22);
      assert.equal(dates[0], JOINED);

      const [m] = await q(pool, "SELECT * FROM attendance_monthly_payroll WHERE employee_id = ?", [EMP]);
      assert.equal(m.available_from, JOINED);
      assert.equal(String(m.available_dates), "22");
      assert.equal(String(m.attendance_days), "22");
      assert.equal(String(m.is_final), "1");
      assert.equal(m.held_dates, "[]");
      assert.equal(String(m.shortage_minutes), "0");

      // Payroll readiness on the processed month: no attendance blocker at all.
      const [monthly] = await payrunCalcRepo.listAttendanceMonths([EMP], YEAR, MONTH);
      const dayRows = await payrunCalcRepo.listAttendanceDayRows([EMP], sep(1), sep(30));
      const readiness = evaluatePayrollReadiness({
        year: YEAR, month: MONTH, snapshot: { monthly_gross: 26000, basic: 13000, date_of_joining: JOINED },
        monthly, day_rows: dayRows.map(({ employee_id, ...r }) => r),
      });
      assert.equal(readiness.attendance_ready, true, JSON.stringify(readiness.reasons));
    });

    it("processing again, and Recalculate, cannot bring 1-8 Sep back", async () => {
      await calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW });
      await calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW });
      await calculation.recalculateRange({ employee_id: EMP, from_date: sep(1), to_date: sep(30), now: NOW });
      const dates = await dayDates(pool);
      assert.equal(dates.length, 22);
      assert.ok(dates.every((d) => d >= JOINED));
      const [m] = await q(pool, "SELECT is_final, held_dates FROM attendance_monthly_payroll WHERE employee_id = ?", [EMP]);
      assert.equal(String(m.is_final), "1");
    });

    it("the payrun's NRM evidence: 660 over 22 days, never the stale 480 row of 8 Sep", async () => {
      // Before clean-up, with the stale FINAL 480-minute row of the 8th present.
      const stale = await payrunCalcRepo.listEffectiveNrm([EMP], sep(1), sep(30));
      assert.deepEqual(stale, [], "the only stored final row is pre-joining, and it is not read");
      await calculation.calculateMonth({ employee_id: EMP, year: YEAR, month: MONTH, persist: true, now: NOW });
      const groups = await payrunCalcRepo.listEffectiveNrm([EMP], sep(1), sep(30));
      assert.deepEqual(groups.map((g) => [Number(g.nrm_minutes), Number(g.day_count)]), [[660, 22]]);
      assert.equal(resolveEffectiveNrm(groups).nrm_minutes, 660);
    });
  });
});
