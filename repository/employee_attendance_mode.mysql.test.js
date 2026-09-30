/**
 * Attendance Calculation Type, AS SQL, against a real MySQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/employee_attendance_mode.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its tables, fills them and drops them again, and reads no table it
 * did not create.
 *
 * The history table and the new day column are built from the MIGRATION FILES
 * THEMSELVES - `attendance_day_calculation` from its own v2 migration, the
 * later ALTERs on it, then this feature's - so what is exercised is the real
 * ENUM, the real default and the real indexes, not a permissive stand-in.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./employee_attendance_mode");
const { writeCalculationsOnConnection } = require("./attendance_calculation");
const buildAttendanceRepo = require("./attendance_calculation");
const buildCalculation = require("../usecase/attendance_calculation");
const { calculateAttendanceDay } = require("../utils/attendance_engine");
const { resolveAttendanceCalculationMode } = require("../utils/attendance_calculation_mode");
const { hydrateStoredDay } = require("../utils/attendance_stored_read");

const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const sqlOf = (file) =>
  fs
    .readFileSync(path.join(SQLS, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n")
    // a statement ends at a semicolon closing its line: a COMMENT string may
    // carry one of its own
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

/** The day table as the migrations build it (foreign keys dropped: this is a scratch DB). */
function dayTableDdl() {
  const create = sqlOf("20260918120000-attendance-v2-calculation-up.sql").find((s) =>
    /^CREATE TABLE IF NOT EXISTS `attendance_day_calculation`/.test(s)
  );
  const withoutFks = create.replace(/,\s*CONSTRAINT[^,]*?FOREIGN KEY[\s\S]*?REFERENCES[^)]*\)(\s*ON (DELETE|UPDATE) \w+( \w+)?)*/g, "");
  const alters = [
    "20261025120000-attendance-break-provenance-up.sql",
    "20261029120000-shift-change-request-up.sql",
    "20261030120000-shift-authorised-ot-up.sql",
    "20261107120000-attendance-permission-up.sql",
  ].flatMap((f) => sqlOf(f).filter((s) => /^ALTER TABLE `?attendance_day_calculation`?/.test(s)));
  return [withoutFks, ...alters];
}

const FEATURE = sqlOf("20261108120000-employee-attendance-calculation-mode-up.sql");
const TABLES = [
  "employee_attendance_calculation_mode", "attendance_day_calculation", "attendance_monthly_payroll",
  "payrun_employee_calculation", "new_employee",
];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("Attendance Calculation Type, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=4&multipleStatements=true&dateStrings=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await q(pool, "CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(100)) ENGINE=InnoDB");
    await q(
      pool,
      `CREATE TABLE payrun_employee_calculation (
         employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
         status VARCHAR(32) NOT NULL, PRIMARY KEY (employee_id, period_year, period_month)) ENGINE=InnoDB`
    );
    for (const ddl of dayTableDdl()) await q(pool, ddl);
    // The month summary's fingerprint as the Permission migration leaves it,
    // holding a version-1 hash, to prove the widening keeps it.
    await q(
      pool,
      `CREATE TABLE attendance_monthly_payroll (
         employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
         day_rows_fingerprint CHAR(64) NULL DEFAULT NULL) ENGINE=InnoDB`
    );
    await q(pool, `INSERT INTO attendance_monthly_payroll VALUES (42, 2026, 9, '${"a".repeat(64)}')`);
    // A row stored BEFORE the feature exists, to prove what the default says about it.
    await q(
      pool,
      `INSERT INTO attendance_day_calculation (employee_id, attendance_date, shift_snapshot, shift_snapshot_hash,
         raw_punch_ids, effective_punches, status, review_reasons, calculation_version)
       VALUES (42, '2026-08-20', '{}', '', '[]', '[]', 'FINAL', '[]', 10)`
    );
    for (const s of FEATURE) await q(pool, s);
    await q(pool, "INSERT INTO new_employee VALUES (42, 'Kavi'), (7, 'Hema HR')");
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (42, 2026, 8, 'APPROVED_LOCKED'), (42, 2026, 9, 'CALCULATED')");
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    pool.end();
  });

  it("a row stored before the feature reads SHIFT_BASED - the default states what calculated it", async () => {
    const [row] = await q(pool, "SELECT attendance_calculation_mode FROM attendance_day_calculation WHERE attendance_date = '2026-08-20'");
    assert.equal(row.attendance_calculation_mode, "SHIFT_BASED");
  });

  it("widens the month fingerprint for its version prefix and keeps every existing value", async () => {
    const [col] = await q(pool, "SHOW COLUMNS FROM attendance_monthly_payroll WHERE Field = 'day_rows_fingerprint'");
    assert.equal(col.Type, "varchar(80)");
    assert.equal(col.Null, "YES");
    const [row] = await q(pool, "SELECT day_rows_fingerprint AS f FROM attendance_monthly_payroll WHERE employee_id = 42");
    assert.equal(row.f, "a".repeat(64));
    const { dayRowsFingerprint } = require("../utils/attendance_month_freshness");
    const v2 = dayRowsFingerprint([]);
    await q(pool, "UPDATE attendance_monthly_payroll SET day_rows_fingerprint = ? WHERE employee_id = 42", [v2]);
    assert.equal((await q(pool, "SELECT day_rows_fingerprint AS f FROM attendance_monthly_payroll WHERE employee_id = 42"))[0].f, v2);
  });

  it("appends a dated row, and the history reads back newest first with the actor's name", async () => {
    const repo = buildRepo(pool);
    const r = await repo.appendMode({
      employeeId: 42,
      calculationMode: "PRESENT_ABSENT_ONLY",
      effectiveFrom: "2026-10-01",
      note: "housekeeping - attendance only",
      createdBy: 7,
      today: "2026-09-30",
    });
    assert.equal(r.code, 200);
    const later = await repo.appendMode({
      employeeId: 42,
      calculationMode: "SHIFT_BASED",
      effectiveFrom: "2026-11-01",
      createdBy: 7,
      today: "2026-09-30",
    });
    assert.equal(later.code, 200);
    const history = await repo.listHistory(42);
    assert.deepEqual(
      history.map((h) => [h.calculation_mode, h.effective_from]),
      [["SHIFT_BASED", "2026-11-01"], ["PRESENT_ABSENT_ONLY", "2026-10-01"]]
    );
    assert.equal(history[1].changed_by_name, "Hema HR");
    assert.equal(resolveAttendanceCalculationMode(history, "2026-09-30"), "SHIFT_BASED");
    assert.equal(resolveAttendanceCalculationMode(history, "2026-10-15"), "PRESENT_ABSENT_ONLY");
    assert.equal(resolveAttendanceCalculationMode(history, "2026-11-15"), "SHIFT_BASED");
    // The attendance repository's own reader returns the same rows.
    const forEngine = await buildAttendanceRepo(pool).getAttendanceCalculationModeHistory(42);
    assert.equal(forEngine.length, 2);
    assert.equal(forEngine[0].effective_from, "2026-10-01");
  });

  it("a change reaching the payroll-LOCKED August is refused, and nothing is inserted", async () => {
    const before = await q(pool, "SELECT COUNT(*) AS n FROM employee_attendance_calculation_mode");
    await assert.rejects(
      () =>
        buildRepo(pool).appendMode({
          employeeId: 42,
          calculationMode: "PRESENT_ABSENT_ONLY",
          effectiveFrom: "2026-08-15",
          createdBy: 7,
          today: "2026-09-30",
        }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    const after_ = await q(pool, "SELECT COUNT(*) AS n FROM employee_attendance_calculation_mode");
    assert.equal(after_[0].n, before[0].n);
  });

  it("stores a Present/Absent Only day through the guarded writer, and reads it back", async () => {
    const storage = buildCalculation({}).toStorageRow(
      calculateAttendanceDay({
        employee_id: 42,
        attendance_date: "2026-09-10",
        punches: [{ punch_id: 1, io_time: "2026-09-10 09:00:00" }],
        attendance_calculation_mode: "PRESENT_ABSENT_ONLY",
      })
    );
    const connection = await new Promise((r, j) => pool.getConnection((e, c) => (e ? j(e) : r(c))));
    try {
      await writeCalculationsOnConnection(connection, [storage]);
    } finally {
      connection.release();
    }
    const [row] = await buildAttendanceRepo(pool).listCalculations({
      employee_id: 42,
      from_date: "2026-09-10",
      to_date: "2026-09-10",
    });
    const day = hydrateStoredDay(row);
    assert.equal(day.attendance_calculation_mode, "PRESENT_ABSENT_ONLY");
    assert.equal(day.status, "FINAL");
    assert.equal(day.attendance_day_count, 1);
    assert.equal(day.shortage_minutes, 0);
    assert.equal(day.work_shift_id, null);
  });

  it("the Employee Report's as-of-today SQL agrees with the JS resolver, row for row", async () => {
    const catalogue = require("../constants/employee_report_catalogue");
    const { istToday } = require("../utils/istDate");
    const { addDays } = require("../utils/attendance_engine");
    const today = istToday();
    const yesterday = addDays(today, -1);
    const tomorrow = addDays(today, 1);
    // 101 no history; 102 PAO since yesterday; 103 PAO only from tomorrow;
    // 104 PAO since yesterday, back to SHIFT_BASED today; 105 two rows on
    // the SAME date - the greater id wins.
    await q(pool, "INSERT INTO new_employee VALUES (101,'a'),(102,'b'),(103,'c'),(104,'d'),(105,'e')");
    const rows = [
      [102, "PRESENT_ABSENT_ONLY", yesterday],
      [103, "PRESENT_ABSENT_ONLY", tomorrow],
      [104, "PRESENT_ABSENT_ONLY", yesterday],
      [104, "SHIFT_BASED", today],
      [105, "SHIFT_BASED", today],
      [105, "PRESENT_ABSENT_ONLY", today],
    ];
    for (const [id, mode, from] of rows) {
      await q(pool, "INSERT INTO employee_attendance_calculation_mode (employee_id, calculation_mode, effective_from) VALUES (?,?,?)", [id, mode, from]);
    }
    const field = catalogue.getField("attendance_calculation_mode");
    const got = await q(
      pool,
      `SELECT new_employee.employee_id, ${field.select} AS mode
         FROM new_employee
         ${catalogue.JOINS[field.join]}
        WHERE new_employee.employee_id BETWEEN 101 AND 105
        ORDER BY new_employee.employee_id`
    );
    assert.equal(got.length, 5, "never more than one row per employee");
    const history = await q(
      pool,
      "SELECT employee_attendance_calculation_mode_id, employee_id, calculation_mode, DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from FROM employee_attendance_calculation_mode"
    );
    for (const row of got) {
      const expected = resolveAttendanceCalculationMode(
        history.filter((h) => Number(h.employee_id) === Number(row.employee_id)),
        today
      );
      assert.equal(row.mode, expected, `employee ${row.employee_id}`);
    }
    assert.deepEqual(
      got.map((r) => field.transform(r.mode)),
      ["Shift Based", "Present/Absent Only", "Shift Based", "Shift Based", "Present/Absent Only"]
    );
  });

  it("and the same writer refuses that day in the locked August", async () => {
    const storage = buildCalculation({}).toStorageRow(
      calculateAttendanceDay({
        employee_id: 42,
        attendance_date: "2026-08-21",
        punches: [{ punch_id: 2, io_time: "2026-08-21 09:00:00" }],
        attendance_calculation_mode: "PRESENT_ABSENT_ONLY",
      })
    );
    const connection = await new Promise((r, j) => pool.getConnection((e, c) => (e ? j(e) : r(c))));
    try {
      await assert.rejects(() => writeCalculationsOnConnection(connection, [storage]), (err) => err.code === "PAYROLL_MONTH_LOCKED");
    } finally {
      connection.release();
    }
    const rows = await q(pool, "SELECT COUNT(*) AS n FROM attendance_day_calculation WHERE attendance_date = '2026-08-21'");
    assert.equal(rows[0].n, 0);
  });
});
