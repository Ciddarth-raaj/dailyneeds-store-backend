/**
 * The Attendance List's read-only queries, AS SQL, against a real MySQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_list_calendar_date.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its tables, fills them and drops them again.
 *
 * What is exercised is the real `repository/biomax_punch.js` - `listDated`,
 * `listCalendarCandidates`, `summaryNoShiftDays` - the real batched mode read
 * of `repository/attendance_dashboard.js`, and `usecase/attendance_raw.js`
 * over them: a Present/Absent Only punch is listed on its CALENDAR date,
 * with or without a shift; a Shift Based one is listed exactly as ingest
 * dated it. The history table and the device time correction tables are
 * built from their own migration files.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildPunchRepo = require("./biomax_punch");
const buildDashboardRepo = require("./attendance_dashboard");
const buildRaw = require("../usecase/attendance_raw");

const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const TIME_CORRECTION = path.join(SQLS, "20261104120000-attendance-device-time-correction-up.sql");
const MODE_TABLE = fs
  .readFileSync(path.join(SQLS, "20261107120000-employee-attendance-calculation-mode-up.sql"), "utf8")
  .split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .find((s) => /^CREATE TABLE IF NOT EXISTS `employee_attendance_calculation_mode`/.test(s));

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
];
const TABLES = [
  "attendance_device_time_correction_punch",
  "attendance_device_time_correction",
  "employee_attendance_calculation_mode",
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

/*
 * 1  Present/Absent Only, NO shift     - ingest could not date: NO_SHIFT
 * 2  Present/Absent Only, a shift      - ingest dated 02:00 back onto 01/10
 * 4  SHIFT BASED, a shift              - the control
 * 6  PAO 01/10-15/10, SB from 16/10    - transition back
 * 7  Present/Absent Only, NO shift, OUTLET 2 - the outlet filter
 * 8  SHIFT BASED, NO shift             - a genuine NO_SHIFT fault
 */
const PUNCHES = [
  [1, "2026-10-01 22:00:00", null, "NO_SHIFT", 1],
  [1, "2026-10-02 02:00:00", null, "NO_SHIFT", 1],
  [2, "2026-10-01 22:00:00", "2026-10-01", "OK", 1],
  [2, "2026-10-02 02:00:00", "2026-10-01", "OK", 1],
  [4, "2026-10-01 22:00:00", "2026-10-01", "OK", 1],
  [4, "2026-10-02 02:00:00", "2026-10-01", "OK", 1],
  [6, "2026-10-15 22:00:00", "2026-10-15", "OK", 1],
  [6, "2026-10-16 02:00:00", "2026-10-15", "OK", 1],
  [6, "2026-10-16 22:00:00", "2026-10-16", "OK", 1],
  [6, "2026-10-17 02:00:00", "2026-10-16", "OK", 1],
  [7, "2026-10-01 22:00:00", null, "NO_SHIFT", 2],
  [8, "2026-10-01 10:00:00", null, "NO_SHIFT", 1],
];

describe("Attendance List queries on Present/Absent Only dates, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let raw;
  let punchRepo;

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=4&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    await q(pool, fs.readFileSync(TIME_CORRECTION, "utf8"));
    await q(pool, MODE_TABLE);

    await q(pool, "INSERT INTO outlets VALUES (1, 'Moolakulam', 'MOO'), (2, 'ECR', 'ECR')");
    await q(pool, "INSERT INTO biomax_device (dev_id, label) VALUES ('DEV1', 'G1')");
    await q(pool, "INSERT INTO biomax_device_assignment (biomax_device_id, outlet_id, effective_from) VALUES (1, 1, '2026-01-01 00:00:00')");
    for (const id of [1, 2, 4, 6, 7, 8]) {
      await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id) VALUES (?, ?, ?)", [id, `Employee ${id}`, id === 7 ? 2 : 1]);
    }
    for (const [employeeId, ioTime, attendanceDate, status, outlet] of PUNCHES) {
      const r = await q(
        pool,
        "INSERT INTO biomax_punch (dev_id, user_id, io_time_raw, io_time) VALUES ('DEV1', ?, REPLACE(REPLACE(REPLACE(?, '-', ''), ' ', ''), ':', ''), ?)",
        [String(employeeId), ioTime, ioTime]
      );
      await q(
        pool,
        `INSERT INTO biomax_punch_derived (biomax_punch_id, attendance_date, derivation_status, employee_id, home_outlet_id, work_shift_id, cutoff_applied)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [r.insertId, attendanceDate, status, employeeId, outlet, attendanceDate ? 1 : null, attendanceDate ? "04:00:00" : null]
      );
    }
    for (const [employeeId, mode, from] of [
      [1, "PRESENT_ABSENT_ONLY", "2026-09-01"],
      [2, "PRESENT_ABSENT_ONLY", "2026-09-01"],
      [6, "PRESENT_ABSENT_ONLY", "2026-10-01"],
      [6, "SHIFT_BASED", "2026-10-16"],
      [7, "PRESENT_ABSENT_ONLY", "2026-09-01"],
    ]) {
      await q(pool, "INSERT INTO employee_attendance_calculation_mode (employee_id, calculation_mode, effective_from) VALUES (?, ?, ?)", [employeeId, mode, from]);
    }
    punchRepo = buildPunchRepo(pool);
    raw = buildRaw(punchRepo, null, buildDashboardRepo(pool));
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    pool.end();
  });

  const layout = (data, id) =>
    data.filter((r) => r.employee_id === id).map((r) => `${r.clock_date}: ${r.punches.map((p) => String(p.time).slice(0, 5)).join(" ")}`);

  it("listCalendarCandidates returns exactly the calendar-window punches listDated did not", async () => {
    const f = { from: "2026-10-02", to: "2026-10-02" };
    const dated = await punchRepo.listDated(f);
    const cand = await punchRepo.listCalendarCandidates(f);
    assert.deepEqual(dated.map((r) => r.employee_id), [], "nothing is ingest-dated 02/10");
    assert.deepEqual(
      cand.map((r) => `${r.employee_id}@${r.calendar_date}:${r.attendance_date}`).sort(),
      ["1@2026-10-02:null", "2@2026-10-02:2026-10-01", "4@2026-10-02:2026-10-01"]
    );
  });

  it("22:00 on 01/10 and 02:00 on 02/10: Present/Absent Only lists them on their calendar dates - with or without a shift", async () => {
    const { data } = await raw.list({ from: "2026-10-01", to: "2026-10-02" });
    assert.deepEqual(layout(data, 1), ["2026-10-01: 22:00", "2026-10-02: 02:00"], "no shift");
    assert.deepEqual(layout(data, 2), ["2026-10-01: 22:00", "2026-10-02: 02:00"], "with a shift");
  });

  it("the Shift Based control is exactly as ingest dated it", async () => {
    const { data } = await raw.list({ from: "2026-10-01", to: "2026-10-02" });
    assert.deepEqual(layout(data, 4), ["2026-10-01: 22:00 02:00"]);
    assert.deepEqual(layout(data, 8), [], "an undated Shift Based punch is still not listed");
  });

  it("a one-day range finds 02/10's punch, and 01/10 alone does not", async () => {
    const only02 = await raw.list({ from: "2026-10-02", to: "2026-10-02" });
    assert.deepEqual(layout(only02.data, 2), ["2026-10-02: 02:00"]);
    assert.deepEqual(layout(only02.data, 4), []);
    const only01 = await raw.list({ from: "2026-10-01", to: "2026-10-01" });
    assert.deepEqual(layout(only01.data, 2), ["2026-10-01: 22:00"]);
    assert.deepEqual(layout(only01.data, 4), ["2026-10-01: 22:00 02:00"]);
  });

  it("switching back to Shift Based on 16/10 returns to shift dating from 16/10", async () => {
    const { data } = await raw.list({ from: "2026-10-15", to: "2026-10-17" });
    assert.deepEqual(layout(data, 6), ["2026-10-15: 22:00", "2026-10-16: 02:00 22:00 02:00"]);
  });

  it("the outlet and search filters apply to the calendar candidates too", async () => {
    const outlet2 = await raw.list({ from: "2026-10-01", to: "2026-10-02", home_outlet_id: "2" });
    assert.deepEqual(outlet2.data.map((r) => r.employee_id), [7]);
    const outlet1 = await raw.list({ from: "2026-10-01", to: "2026-10-02", home_outlet_id: "1" });
    assert.ok(!outlet1.data.some((r) => r.employee_id === 7));
    const search = await raw.list({ from: "2026-10-01", to: "2026-10-02", search: "Employee 1" });
    assert.deepEqual([...new Set(search.data.map((r) => r.employee_id))], [1]);
  });

  it("the no-shift banner counts only the Shift Based fault (summaryNoShiftDays, as SQL)", async () => {
    const days = await punchRepo.summaryNoShiftDays({ from: "2026-10-01", to: "2026-10-02" });
    assert.deepEqual(
      days.map((d) => `${d.employee_id}@${d.calendar_date}x${d.punches}`).sort(),
      ["1@2026-10-01x1", "1@2026-10-02x1", "7@2026-10-01x1", "8@2026-10-01x1"]
    );
    const { meta } = await raw.list({ from: "2026-10-01", to: "2026-10-02" });
    assert.equal(meta.no_shift_punches, 1, "employee 8 only");
    assert.equal(meta.present_absent_only_punches, 3);
  });
});
