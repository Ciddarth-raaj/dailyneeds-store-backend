/**
 * DEVICE TIME CORRECTION, AS REAL SQL - end to end.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_device_time_correction.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its tables, fills them and drops them again, and reads no table it
 * did not create.
 *
 * WHAT IS REAL. The correction tables are built from the MIGRATION FILE
 * ITSELF. The correction repository, the calculation repository's punch read
 * (`getRawPunchesByCalendarWindow`, with the effective-time join) and its
 * payroll-lock reads, the Punch Audit repository, the device time correction
 * usecase and the attendance calculation usecase and engine are all the
 * production modules. Only the SHIFT configuration is supplied in memory: a
 * 09:00-18:00 shift, cutoff 04:00, every day working.
 *
 * THE INCIDENT. 2026-09-25, device WH (outlet 2) showed 06:30 while the real
 * time was 09:00: +150 minutes, punches stamped 06:30:00-08:30:00.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildDtcRepo = require("./attendance_device_time_correction");
const buildCalcRepo = require("./attendance_calculation");
const { CALCULATION_COLUMNS } = require("./attendance_calculation");
const buildPunchRepo = require("./biomax_punch");
const buildDtcUsecase = require("../usecase/attendance_device_time_correction");
const buildCalcUsecase = require("../usecase/attendance_calculation");

const DATE = "2026-09-25";
const ADMIN = { employee_id: 900, user_id: 7, user_type: 2 };

const DEV_WH = 1; // the affected terminal, outlet 2
const DEV_G2 = 2; // a second terminal at the SAME outlet - must not move
const DEV_DN1 = 3; // another outlet
const DEV_MOVED = 4; // moved from outlet 2 to outlet 3 at 07:00 that morning

const ASHA = 501;
const BALA = 502;
const CHITRA = 503; // punches on G2
const DEEPA = 504; // punched on WH the day BEFORE
const ESHA = 505; // punched on WH just outside the window
const FARAH = 506; // punches on the moved device

const MIGRATION = path.join(
  __dirname,
  "..",
  "migrations/mysql/migrations/sqls/20261104120000-attendance-device-time-correction-up.sql"
);

const SCHEMA = [
  `CREATE TABLE new_employee (
     employee_id INT PRIMARY KEY, employee_name VARCHAR(80), store_id INT NULL,
     status INT NOT NULL DEFAULT 1, attendance_required TINYINT(1) NOT NULL DEFAULT 1
   ) ENGINE=InnoDB`,
  `CREATE TABLE department (department_id INT PRIMARY KEY, department_name VARCHAR(80)) ENGINE=InnoDB`,
  `CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80), outlet_code VARCHAR(20)) ENGINE=InnoDB`,
  `CREATE TABLE biomax_device (
     biomax_device_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, dev_id VARCHAR(32) NOT NULL,
     label VARCHAR(100) NOT NULL, UNIQUE KEY uq_dev (dev_id)
   ) ENGINE=InnoDB`,
  `CREATE TABLE biomax_device_assignment (
     biomax_device_assignment_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
     biomax_device_id INT NOT NULL, outlet_id INT NOT NULL,
     effective_from DATETIME NOT NULL, effective_to DATETIME NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE biomax_punch (
     biomax_punch_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     dev_id VARCHAR(32) NULL, user_id VARCHAR(32) NOT NULL, io_time_raw CHAR(14) NOT NULL,
     io_time DATETIME NOT NULL, punch_date DATE GENERATED ALWAYS AS (DATE(io_time)) STORED,
     source_ip VARCHAR(45) NULL, ingest_source VARCHAR(20) NOT NULL DEFAULT 'LIVE',
     import_batch_id BIGINT NULL, retransmit_count INT NOT NULL DEFAULT 0,
     received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
   ) ENGINE=InnoDB`,
  `CREATE TABLE biomax_punch_derived (
     biomax_punch_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, attendance_date DATE NULL,
     derivation_status VARCHAR(20) NOT NULL DEFAULT 'OK', employee_id INT NULL,
     home_outlet_id INT NULL, department_id INT NULL, work_shift_id INT NULL, cutoff_applied TIME NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_punch_void (
     attendance_punch_void_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     biomax_punch_id BIGINT UNSIGNED NOT NULL, reason VARCHAR(500) NOT NULL,
     voided_by_employee_id INT NULL, voided_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_approval_request (
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     request_type VARCHAR(30) NOT NULL, requested_for_employee_id INT NOT NULL,
     attendance_date DATE NOT NULL, status VARCHAR(20) NOT NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE payrun_employee_calculation (
     employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
     status VARCHAR(32) NOT NULL, PRIMARY KEY (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_day_calculation (
     ${CALCULATION_COLUMNS.map((c) =>
       c === "employee_id"
         ? "employee_id INT NOT NULL"
         : c === "attendance_date"
         ? "attendance_date DATE NOT NULL"
         : `${c} TEXT NULL`
     ).join(",\n     ")},
     UNIQUE KEY uq_day (employee_id, attendance_date)
   ) ENGINE=InnoDB`,
];

/** Drop order: children first. */
const TABLES = [
  "attendance_device_time_correction_punch",
  "attendance_device_time_correction",
  "attendance_day_calculation",
  "payrun_employee_calculation",
  "attendance_approval_request",
  "attendance_punch_void",
  "biomax_punch_derived",
  "biomax_punch",
  "biomax_device_assignment",
  "biomax_device",
  "outlets",
  "department",
  "new_employee",
];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

/** The shift, in memory: 09:00-18:00, 60 minute break, NRM 480, cutoff 04:00. */
const schedule = Array.from({ length: 7 }, (_, day) => ({
  work_shift_weekly_schedule_id: 70 + day,
  work_shift_id: 7,
  day_of_week: day,
  is_working_day: 1,
  in_time: "09:00:00",
  out_time: "18:00:00",
  attendance_day_cutoff: "04:00:00",
  break_minutes: 60,
  normal_work_minutes: 480,
  ot_rate: 1,
}));

/** Real SQL where it matters; the shift configuration in memory. */
function calcRepoOver(pool) {
  const real = buildCalcRepo(pool);
  return {
    getShiftAssignmentHistory: async (employeeId) => [
      { employee_work_shift_assignment_id: 1, employee_id: employeeId, work_shift_id: 7, effective_from: "2026-09-01", source: "TEST" },
    ],
    getWorkShiftWithSchedule: async (id) => ({
      config: {
        work_shift_id: id, shift_code: "9 TO 6", overtime_allowed: 1, overtime_minimum_minutes: 0,
        overtime_rounding_method: "NONE", overtime_rounding_interval_minutes: 0,
        overtime_minimum_threshold_only: 0, maximum_ot_minutes_per_day: null,
      },
      schedule,
    }),
    getWorkShiftConfigVersions: async () => [],
    // REAL: the effective-time read.
    getRawPunchesByCalendarWindow: (...args) => real.getRawPunchesByCalendarWindow(...args),
    getApprovedRegularizedPunches: async () => [],
    getBreakOverride: async (employeeId) => ({ employee_id: employeeId, special_break_override_minutes: null }),
    getApprovalStateByDate: async () => [],
    getEmploymentWindow: async (employeeId) => ({
      employee_id: employeeId, status: 1, date_of_joining: "2020-01-01", resignation_date: null,
    }),
    // REAL: the payroll-lock pre-flight.
    findPayrollLockedPeriods: (rows) => real.findPayrollLockedPeriods(rows),
  };
}

const INCIDENT = {
  date: DATE,
  biomax_device_id: DEV_WH,
  from_time: "06:30",
  to_time: "08:30",
  offset_minutes: 150,
  reason_code: "BIOMAX_DEVICE_TIME_ERROR",
  remarks: "WH showed 06:30 when the real time was 09:00",
};

describe("device time correction, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let dtcRepo;
  let usecase;
  let calc;
  const ids = {};

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=6&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    // THE MIGRATION ITSELF, not a copy of it.
    await q(pool, fs.readFileSync(MIGRATION, "utf8"));
    dtcRepo = buildDtcRepo(pool);
    // 27 Sep: the 24th and 25th have closed, so recalculated days are STORED.
    calc = buildCalcUsecase(calcRepoOver(pool), { now: Date.parse("2026-09-27T00:00:00+05:30") });
    usecase = buildDtcUsecase(dtcRepo, calc, { today: "2026-09-27" });
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((resolve) => pool.end(resolve));
  });

  const punch = async (key, devId, employeeId, ioTime, extra = {}) => {
    const raw = ioTime.replace(/[-: ]/g, "");
    const r = await q(
      pool,
      `INSERT INTO biomax_punch (dev_id, user_id, io_time_raw, io_time, received_at) VALUES (?, ?, ?, ?, ?)`,
      [devId, String(employeeId), raw, ioTime, extra.received_at || ioTime]
    );
    await q(pool, `INSERT INTO biomax_punch_derived (biomax_punch_id, attendance_date, employee_id, home_outlet_id)
                   VALUES (?, ?, ?, 2)`, [r.insertId, ioTime.slice(0, 10), employeeId]);
    ids[key] = r.insertId;
  };

  beforeEach(async () => {
    for (const t of TABLES) await q(pool, `DELETE FROM ${t}`);
    await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id) VALUES ?", [[
      [ASHA, "Asha", 2], [BALA, "Bala", 2], [CHITRA, "Chitra", 2], [DEEPA, "Deepa", 2],
      [ESHA, "Esha", 2], [FARAH, "Farah", 2], [900, "Admin", 1],
    ]]);
    await q(pool, "INSERT INTO outlets VALUES ?", [[[2, "Warehouse", "WH"], [3, "DN2", "DN2"], [10, "DN1", "DN1"]]]);
    await q(pool, "INSERT INTO biomax_device VALUES ?", [[
      [DEV_WH, "C2695C56D30E1430", "WH"], [DEV_G2, "AMDB24121401307", "G2"],
      [DEV_DN1, "C26924B2E7351O35", "DN1"], [DEV_MOVED, "MOVEDDEVICE0001", "MOVED"],
    ]]);
    await q(pool, "INSERT INTO biomax_device_assignment (biomax_device_id, outlet_id, effective_from, effective_to) VALUES ?", [[
      [DEV_WH, 2, "2026-09-01 00:00:00", null],
      [DEV_G2, 2, "2026-09-01 00:00:00", null],
      [DEV_DN1, 10, "2026-09-01 00:00:00", null],
      [DEV_MOVED, 2, "2026-09-01 00:00:00", "2026-09-25 07:00:00"],
      [DEV_MOVED, 3, "2026-09-25 07:00:00", null],
    ]]);
    const WH = "C2695C56D30E1430";
    // In the window, on WH.
    await punch("ashaIn", WH, ASHA, "2026-09-25 06:42:15");
    await punch("balaIn", WH, BALA, "2026-09-25 06:30:00"); // the window's first second
    await punch("balaMid", WH, BALA, "2026-09-25 08:30:00"); // the window's last second
    // After the clock was fixed (real time), on WH: outside the window.
    await punch("ashaOut", WH, ASHA, "2026-09-25 18:05:00");
    await punch("balaOut", WH, BALA, "2026-09-25 18:10:00");
    // One second either side of the window.
    await punch("eshaEarly", WH, ESHA, "2026-09-25 06:29:59");
    await punch("eshaLate", WH, ESHA, "2026-09-25 08:30:01");
    // Same time, OTHER device at the same outlet.
    await punch("chitraG2", "AMDB24121401307", CHITRA, "2026-09-25 06:45:00");
    // Same device and time, the day BEFORE.
    await punch("deepaPrev", WH, DEEPA, "2026-09-24 06:45:00");
    // The moved device: 06:50 at outlet 2, 07:10 at outlet 3.
    await punch("farahAt2", "MOVEDDEVICE0001", FARAH, "2026-09-25 06:50:00");
    await punch("farahAt3", "MOVEDDEVICE0001", FARAH, "2026-09-25 07:10:00");
  });

  /** Every punch's EFFECTIVE time, read the way the calculation reads it. */
  const effectiveTimes = async () => {
    const real = buildCalcRepo(pool);
    const out = {};
    for (const employeeId of [ASHA, BALA, CHITRA, DEEPA, ESHA, FARAH]) {
      const rows = await real.getRawPunchesByCalendarWindow(employeeId, "2026-09-23", "2026-09-26");
      rows.forEach((r) => {
        const key = Object.keys(ids).find((k) => Number(ids[k]) === Number(r.punch_id));
        out[key] = { io_time: r.io_time, original_io_time: r.original_io_time, correction: r.time_correction_id };
      });
    }
    return out;
  };

  /** A byte-for-byte fingerprint of every table, for "nothing was written". */
  const checksums = async () => {
    const rows = await q(pool, `CHECKSUM TABLE ${TABLES.join(", ")}`);
    return Object.fromEntries(rows.map((r) => [r.Table, String(r.Checksum)]));
  };

  const rawPunchTable = () =>
    q(pool, "SELECT biomax_punch_id, dev_id, user_id, io_time_raw, DATE_FORMAT(io_time, '%Y-%m-%d %H:%i:%s') AS io_time FROM biomax_punch ORDER BY biomax_punch_id");

  const storedDay = async (employeeId, date = DATE) => {
    const [row] = await q(
      pool,
      "SELECT late_minutes, punch_count, worked_minutes, status, effective_punches FROM attendance_day_calculation WHERE employee_id = ? AND attendance_date = ?",
      [employeeId, date]
    );
    return row || null;
  };

  const previewAndApply = async (input = INCIDENT) => {
    const preview = await usecase.preview(input, ADMIN);
    assert.equal(preview.can_apply, true, JSON.stringify(preview.blocking_issues));
    const applied = await usecase.apply(
      { ...input, batch_ref: preview.batch_ref, preview_fingerprint: preview.preview_fingerprint },
      ADMIN
    );
    return { preview, applied };
  };

  it("14. PREVIEW performs zero writes - every table is byte-identical afterwards", async () => {
    const before_ = await checksums();
    const preview = await usecase.preview(INCIDENT, ADMIN);
    assert.deepEqual(await checksums(), before_);
    assert.equal(preview.summary.punch_count, 3);
    assert.equal(preview.summary.employee_count, 2);
    assert.equal(preview.summary.earliest_original, "2026-09-25 06:30:00");
    assert.equal(preview.summary.earliest_corrected, "2026-09-25 09:00:00");
    assert.equal(preview.summary.latest_original, "2026-09-25 08:30:00");
    assert.equal(preview.summary.latest_corrected, "2026-09-25 11:00:00");
    assert.deepEqual(preview.summary.device, { biomax_device_id: DEV_WH, dev_id: "C2695C56D30E1430", label: "WH" });
    const asha = preview.punches.find((p) => p.employee_id === ASHA);
    assert.deepEqual(
      [asha.employee_name, asha.original_punch, asha.corrected_punch, asha.device, asha.outlet],
      ["Asha", "2026-09-25 06:42:15", "2026-09-25 09:12:15", "WH", "Warehouse"]
    );
  });

  it("1-5. only the selected date, device and window move, by exactly +150 minutes; everyone else is untouched", async () => {
    const before_ = await effectiveTimes();
    await previewAndApply();
    const after_ = await effectiveTimes();

    // 5. +150: 06:42:15 -> 09:12:15, and the inclusive window ends.
    assert.equal(after_.ashaIn.io_time, "2026-09-25 09:12:15");
    assert.equal(after_.balaIn.io_time, "2026-09-25 09:00:00");
    assert.equal(after_.balaMid.io_time, "2026-09-25 11:00:00");

    // 1-4. nothing else moved.
    const moved = new Set(["ashaIn", "balaIn", "balaMid"]);
    for (const key of Object.keys(before_)) {
      if (moved.has(key)) continue;
      assert.deepEqual(after_[key], before_[key], `${key} must be unchanged`);
    }
    assert.equal(after_.deepaPrev.io_time, "2026-09-24 06:45:00", "1. the day before");
    assert.equal(after_.chitraG2.io_time, "2026-09-25 06:45:00", "2. the other device at the same outlet");
    assert.equal(after_.eshaEarly.io_time, "2026-09-25 06:29:59", "3. one second before the window");
    assert.equal(after_.eshaLate.io_time, "2026-09-25 08:30:01", "3. one second after the window");
    assert.equal(after_.ashaOut.io_time, "2026-09-25 18:05:00", "punched after the clock was fixed");
  });

  it("the outlet criterion selects only punches made while the device was at that outlet", async () => {
    const input = { ...INCIDENT, biomax_device_id: DEV_MOVED, outlet_id: 2, from_time: "06:00", to_time: "08:00" };
    const preview = await usecase.preview(input, ADMIN);
    assert.deepEqual(preview.punches.map((p) => p.original_punch), ["2026-09-25 06:50:00"]);
    await usecase.apply({ ...input, batch_ref: preview.batch_ref, preview_fingerprint: preview.preview_fingerprint }, ADMIN);
    const t = await effectiveTimes();
    assert.equal(t.farahAt2.io_time, "2026-09-25 09:20:00");
    assert.equal(t.farahAt3.io_time, "2026-09-25 07:10:00", "at outlet 3 by then - not selected");

    await assert.rejects(
      usecase.preview({ ...INCIDENT, outlet_id: 10 }, ADMIN),
      /was not assigned to outlet 10/
    );
  });

  it("6. a NEGATIVE offset works: -30 minutes on G2", async () => {
    await previewAndApply({ ...INCIDENT, biomax_device_id: DEV_G2, offset_minutes: -30 });
    const t = await effectiveTimes();
    assert.equal(t.chitraG2.io_time, "2026-09-25 06:15:00");
    assert.equal(t.chitraG2.original_io_time, "2026-09-25 06:45:00");
    assert.equal(t.ashaIn.io_time, "2026-09-25 06:42:15", "WH is not G2");
  });

  it("7. the raw punch is never written; the original time stays available beside the corrected one", async () => {
    const rawBefore = await rawPunchTable();
    const derivedBefore = (await checksums()).biomax_punch_derived;
    const { applied } = await previewAndApply();
    assert.deepEqual(await rawPunchTable(), rawBefore);
    assert.equal((await checksums()).biomax_punch_derived, derivedBefore);

    const t = await effectiveTimes();
    assert.equal(t.ashaIn.original_io_time, "2026-09-25 06:42:15");
    assert.equal(t.ashaIn.io_time, "2026-09-25 09:12:15");

    const detail = await usecase.get(applied.attendance_device_time_correction_id, ADMIN);
    const row = detail.data.punches.find((p) => Number(p.biomax_punch_id) === Number(ids.ashaIn));
    assert.deepEqual(
      [row.original_io_time, row.corrected_io_time, Number(row.offset_minutes), Number(row.is_active)],
      ["2026-09-25 06:42:15", "2026-09-25 09:12:15", 150, 1]
    );
    assert.equal(detail.data.reason_code, "BIOMAX_DEVICE_TIME_ERROR");
    assert.equal(detail.data.applied_by_name, "Admin");
    assert.equal(detail.data.batch_ref, applied.batch_ref);
  });

  it("8. the stored attendance day is recalculated from the CORRECTED times, in the same transaction", async () => {
    // Before: IN 06:42 is before the shift - not late.
    const before_ = (await calc.calculateRange({ employee_id: ASHA, from_date: DATE, to_date: DATE }))[0];
    assert.equal(before_.late_minutes, 0);

    const { applied } = await previewAndApply();
    assert.ok(applied.days_stored >= 2);

    const day = await storedDay(ASHA);
    assert.ok(day, "the day row was written with the correction");
    assert.equal(Number(day.late_minutes), 12, "IN 09:12:15 on a 09:00 shift");
    const effective = JSON.parse(day.effective_punches).map((p) => p.io_time);
    assert.deepEqual(effective, ["2026-09-25 09:12:15", "2026-09-25 18:05:00"]);

    // And an ordinary recalculation afterwards reads the same corrected time.
    const again = (await calc.calculateRange({ employee_id: ASHA, from_date: DATE, to_date: DATE }))[0];
    assert.equal(again.late_minutes, 12);

    // Esha, Chitra and Deepa were not recalculated by this correction.
    assert.equal(await storedDay(ESHA), null);
    assert.equal(await storedDay(CHITRA), null);
    assert.equal(await storedDay(DEEPA, "2026-09-24"), null);
  });

  it("9. the same batch cannot be applied twice, and a punch is never corrected twice", async () => {
    const { preview } = await previewAndApply();
    const again = { ...INCIDENT, batch_ref: preview.batch_ref, preview_fingerprint: preview.preview_fingerprint };
    await assert.rejects(usecase.apply(again, ADMIN), (err) => err.code === "ALREADY_APPLIED" && err.httpCode === 409);

    // A fresh preview of the same criteria refuses the already-corrected punches.
    const second = await usecase.preview(INCIDENT, ADMIN);
    assert.equal(second.can_apply, false);
    assert.ok(second.blocking_issues.some((b) => b.code === "ALREADY_CORRECTED"));
    await assert.rejects(
      usecase.apply({ ...INCIDENT, batch_ref: second.batch_ref, preview_fingerprint: second.preview_fingerprint }, ADMIN),
      (err) => err.code === "ALREADY_CORRECTED"
    );

    // And the DATABASE refuses it even past the usecase: a second active row
    // for the same punch violates the UNIQUE active-punch key.
    const criteria = await usecase.validateCriteria(INCIDENT);
    await assert.rejects(
      dtcRepo.applyCorrection({
        criteria,
        expected_fingerprint: "x".repeat(64),
        fingerprintOf: () => "x".repeat(64),
        batch: { batch_ref: "00000000-0000-4000-8000-000000000001", correction_date: DATE, biomax_device_id: DEV_WH,
          dev_id: "C2695C56D30E1430", window_from: `${DATE} 06:30:00`, window_to: `${DATE} 08:30:00`,
          offset_minutes: 150, reason_code: "BIOMAX_DEVICE_TIME_ERROR", remarks: "second try", punch_count: 1, employee_count: 1 },
        items: [{ biomax_punch_id: ids.ashaIn, employee_id: ASHA, original_io_time: "2026-09-25 06:42:15",
          corrected_io_time: "2026-09-25 09:12:15", offset_minutes: 150 }],
        lock_rows: [], calculation_rows: [],
      }),
      (err) => err.code === "ALREADY_CORRECTED"
    );

    const t = await effectiveTimes();
    assert.equal(t.ashaIn.io_time, "2026-09-25 09:12:15", "+150 once, never +300");
    const [{ n }] = await q(pool, "SELECT COUNT(*) AS n FROM attendance_device_time_correction");
    assert.equal(Number(n), 1);
  });

  it("a STALE preview is refused: a punch arriving in the window after Preview", async () => {
    const preview = await usecase.preview(INCIDENT, ADMIN);
    await punch("late", "C2695C56D30E1430", ESHA, "2026-09-25 07:15:00");
    await assert.rejects(
      usecase.apply({ ...INCIDENT, batch_ref: preview.batch_ref, preview_fingerprint: preview.preview_fingerprint }, ADMIN),
      (err) => err.code === "PREVIEW_STALE" && err.httpCode === 409
    );
    // ...and changing the offset after previewing is stale too.
    const p2 = await usecase.preview(INCIDENT, ADMIN);
    await assert.rejects(
      usecase.apply({ ...INCIDENT, offset_minutes: 140, batch_ref: p2.batch_ref, preview_fingerprint: p2.preview_fingerprint }, ADMIN),
      (err) => err.code === "PREVIEW_STALE"
    );
    const [{ n }] = await q(pool, "SELECT COUNT(*) AS n FROM attendance_device_time_correction");
    assert.equal(Number(n), 0);
  });

  it("10. a payroll-LOCKED month blocks Apply - at preview, at apply, and inside the transaction", async () => {
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'APPROVED_LOCKED')", [BALA]);
    const preview = await usecase.preview(INCIDENT, ADMIN);
    assert.equal(preview.can_apply, false);
    const lockIssue = preview.blocking_issues.find((b) => b.code === "PAYROLL_MONTH_LOCKED");
    assert.ok(lockIssue);
    assert.match(lockIssue.msg, /09\/2026 is approved and locked/);

    const before_ = await checksums();
    await assert.rejects(
      usecase.apply({ ...INCIDENT, batch_ref: preview.batch_ref, preview_fingerprint: preview.preview_fingerprint }, ADMIN),
      (err) => err.code === "PAYROLL_MONTH_LOCKED" && err.name === "ValidationError"
    );
    assert.deepEqual(await checksums(), before_, "nothing written");

    // No bypass: straight at the repository, the FOR UPDATE gate refuses and
    // the correction rows already inserted in that transaction roll back.
    const criteria = await usecase.validateCriteria(INCIDENT);
    const { fingerprintOf } = require("../usecase/attendance_device_time_correction");
    const current = await dtcRepo.selectCandidatePunches(criteria);
    await assert.rejects(
      dtcRepo.applyCorrection({
        criteria,
        expected_fingerprint: fingerprintOf(criteria, current),
        fingerprintOf: (rows) => fingerprintOf(criteria, rows),
        batch: { batch_ref: "00000000-0000-4000-8000-000000000002", correction_date: DATE, biomax_device_id: DEV_WH,
          dev_id: "C2695C56D30E1430", window_from: `${DATE} 06:30:00`, window_to: `${DATE} 08:30:00`,
          offset_minutes: 150, reason_code: "BIOMAX_DEVICE_TIME_ERROR", remarks: "bypass attempt", punch_count: 3, employee_count: 2 },
        items: current.map((p) => ({ biomax_punch_id: p.biomax_punch_id, employee_id: p.employee_id,
          original_io_time: p.io_time, corrected_io_time: p.io_time, offset_minutes: 150 })),
        lock_rows: [{ employee_id: BALA, attendance_date: DATE }],
        calculation_rows: [],
      }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.deepEqual(await checksums(), before_, "rolled back");
  });

  it("11. a payroll-LOCKED month blocks Revert, and the correction stays applied", async () => {
    const { applied } = await previewAndApply();
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'APPROVED_LOCKED')", [ASHA]);
    const before_ = await checksums();
    await assert.rejects(
      usecase.revert({ correction_id: applied.attendance_device_time_correction_id, reason: "wrong offset" }, ADMIN),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.deepEqual(await checksums(), before_);
    const detail = await usecase.get(applied.attendance_device_time_correction_id, ADMIN);
    assert.equal(detail.data.status, "APPLIED");
    assert.equal((await effectiveTimes()).ashaIn.io_time, "2026-09-25 09:12:15");
  });

  it("12-13. REVERT restores the original times and the attendance, and keeps the whole audit trail", async () => {
    const { applied } = await previewAndApply();
    assert.equal(Number((await storedDay(ASHA)).late_minutes), 12);

    const reverted = await usecase.revert(
      { correction_id: applied.attendance_device_time_correction_id, reason: "Offset was confirmed wrong" },
      ADMIN
    );
    assert.equal(reverted.status, "REVERTED");

    // 12. effective = original again, and the day recalculated on it.
    const t = await effectiveTimes();
    assert.equal(t.ashaIn.io_time, "2026-09-25 06:42:15");
    assert.equal(t.balaIn.io_time, "2026-09-25 06:30:00");
    assert.equal(t.ashaIn.correction, null);
    assert.equal(Number((await storedDay(ASHA)).late_minutes), 0);

    // 13. the batch and every punch row remain, marked, with both times.
    const detail = await usecase.get(applied.attendance_device_time_correction_id, ADMIN);
    assert.equal(detail.data.status, "REVERTED");
    assert.equal(detail.data.reverted_by_name, "Admin");
    assert.equal(detail.data.revert_reason, "Offset was confirmed wrong");
    assert.ok(detail.data.reverted_at);
    assert.equal(detail.data.applied_by_name, "Admin");
    assert.equal(detail.data.punches.length, 3);
    detail.data.punches.forEach((p) => {
      assert.equal(Number(p.is_active), 0);
      assert.ok(p.original_io_time && p.corrected_io_time);
    });

    // A second revert is refused; a fresh correction is allowed again.
    await assert.rejects(
      usecase.revert({ correction_id: applied.attendance_device_time_correction_id, reason: "again please" }, ADMIN),
      (err) => err.code === "ALREADY_REVERTED"
    );
    await previewAndApply({ ...INCIDENT, offset_minutes: 137 });
    assert.equal((await effectiveTimes()).ashaIn.io_time, "2026-09-25 08:59:15");
  });

  it("15. a failure inside the transaction rolls EVERYTHING back", async () => {
    const criteria = await usecase.validateCriteria(INCIDENT);
    const { fingerprintOf } = require("../usecase/attendance_device_time_correction");
    const current = await dtcRepo.selectCandidatePunches(criteria);
    const before_ = await checksums();
    await assert.rejects(
      dtcRepo.applyCorrection({
        criteria,
        expected_fingerprint: fingerprintOf(criteria, current),
        fingerprintOf: (rows) => fingerprintOf(criteria, rows),
        batch: { batch_ref: "00000000-0000-4000-8000-000000000003", correction_date: DATE, biomax_device_id: DEV_WH,
          dev_id: "C2695C56D30E1430", window_from: `${DATE} 06:30:00`, window_to: `${DATE} 08:30:00`,
          offset_minutes: 150, reason_code: "BIOMAX_DEVICE_TIME_ERROR", remarks: "failure injection", punch_count: 3, employee_count: 2 },
        items: current.map((p) => ({ biomax_punch_id: p.biomax_punch_id, employee_id: p.employee_id,
          original_io_time: p.io_time, corrected_io_time: p.io_time, offset_minutes: 150 })),
        lock_rows: [{ employee_id: ASHA, attendance_date: DATE }],
        // The LAST step fails: a day row the guarded writer refuses.
        calculation_rows: [{ employee_id: null, attendance_date: DATE }],
      }),
      /refusing to write attendance/
    );
    assert.deepEqual(await checksums(), before_, "batch, punch rows and day rows all rolled back");
    const t = await effectiveTimes();
    assert.equal(t.ashaIn.io_time, "2026-09-25 06:42:15");
  });

  it("Punch Audit shows the device-clock correction: original, corrected, reason, who", async () => {
    await previewAndApply();
    const rows = await buildPunchRepo(pool).listPunches({ from: DATE, to: DATE, dev_id: "C2695C56D30E1430" });
    const asha = rows.find((r) => Number(r.biomax_punch_id) === Number(ids.ashaIn));
    assert.equal(asha.original_clock_time, "06:42:15");
    assert.equal(asha.clock_time, "09:12:15");
    assert.equal(asha.time_correction_reason_code, "BIOMAX_DEVICE_TIME_ERROR");
    assert.equal(asha.time_corrected_by_name, "Admin");
    assert.equal(Number(asha.time_correction_offset_minutes), 150);
    const untouched = rows.find((r) => Number(r.biomax_punch_id) === Number(ids.eshaEarly));
    assert.equal(untouched.time_correction_id, null);
    assert.equal(untouched.clock_time, untouched.original_clock_time);
  });

  it("the migration's down file removes exactly its two tables", async () => {
    const down = fs.readFileSync(MIGRATION.replace("-up.sql", "-down.sql"), "utf8");
    await q(pool, down);
    const left = await q(pool, "SHOW TABLES LIKE 'attendance_device_time_correction%'");
    assert.equal(left.length, 0);
    assert.ok((await q(pool, "SHOW TABLES LIKE 'biomax_punch'")).length === 1);
    await q(pool, fs.readFileSync(MIGRATION, "utf8")); // and it re-applies cleanly
    await q(pool, fs.readFileSync(MIGRATION, "utf8")); // twice: guarded
  });
});
