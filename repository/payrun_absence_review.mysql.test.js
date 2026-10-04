/**
 * THE 3-DAY ABSENT REVIEW'S READS, AS REAL SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/payrun_absence_review.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * What a fake repository cannot prove: that the working-day flag comes out of
 * the engine's stored JSON snapshot in a shape the rule reads, that a
 * Present/Absent Only day's `{}` snapshot reads as "no flag", and that the
 * exit-record read finds every kind of exit through the REAL C1a period table
 * and `v_employee_current_period` view - and ignores a voided resignation and
 * a previous spell's. The rows are then fed through the production usecase.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildPayrunRepo = require("./payrun");
const buildUsecase = require("../usecase/payrun");

const C1A = fs.readFileSync(
  path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20260907140000-c1a-employee-lifecycle-schema-up.sql"),
  "utf8"
);
/** The migration's own DDL for one statement, so the test cannot drift from it. */
const statement = (startsWith) => {
  const at = C1A.indexOf(startsWith);
  assert.ok(at >= 0, `the C1a migration has no "${startsWith}"`);
  return C1A.slice(at, C1A.indexOf(";", at) + 1);
};

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));

describe("3-Day Absent reads, over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL not set" }, () => {
  let pool;
  let repo;

  const drop = async () => {
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    await q(pool, "DROP VIEW IF EXISTS v_employee_current_period");
    for (const t of ["resignation", "employee_employment_period", "attendance_day_calculation", "new_employee"]) {
      await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    }
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
  };

  /** A stored engine day, with the snapshot serialised exactly as the persist writes it. */
  const storeDay = (employee_id, date, { status = "ABSENT", is_final = 1, punch = 0, mode = "SHIFT_BASED", snapshot } = {}) =>
    q(
      pool,
      `INSERT INTO attendance_day_calculation
         (employee_id, attendance_date, status, is_final, punch_count, attendance_day_count,
          attendance_calculation_mode, shift_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        employee_id, date, status, is_final, punch, punch > 0 ? 1 : 0, mode,
        JSON.stringify(snapshot === undefined ? { work_shift_id: 3, is_working_day: true } : snapshot || {}),
      ]
    );

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=4`);
    await drop();
    // new_employee: the columns these reads and the C1a foreign keys use.
    await q(pool, `CREATE TABLE new_employee (
      employee_id INT PRIMARY KEY, employee_name VARCHAR(100), status TINYINT(1) DEFAULT 1,
      resignation_date DATE NULL, date_of_joining VARCHAR(40)
    ) ENGINE=InnoDB`);
    // The production day table's read columns, with the JSON snapshot column as declared.
    await q(pool, `CREATE TABLE attendance_day_calculation (
      employee_id INT NOT NULL, attendance_date DATE NOT NULL,
      status VARCHAR(32) NOT NULL, is_final TINYINT(1) NOT NULL DEFAULT 0,
      punch_count INT NOT NULL DEFAULT 0, attendance_day_count TINYINT NOT NULL DEFAULT 0,
      attendance_calculation_mode ENUM('SHIFT_BASED','PRESENT_ABSENT_ONLY') NOT NULL DEFAULT 'SHIFT_BASED',
      shift_snapshot JSON NOT NULL,
      UNIQUE KEY uq_adc_employee_date (employee_id, attendance_date)
    ) ENGINE=InnoDB`);
    // The real C1a period table and view, verbatim from the migration.
    await q(pool, statement("CREATE TABLE IF NOT EXISTS `employee_employment_period`"));
    await q(pool, statement("CREATE OR REPLACE VIEW `v_employee_current_period`"));
    // The legacy resignation table plus the columns C1a added to it.
    await q(pool, `CREATE TABLE resignation (
      resignation_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NULL, period_id BIGINT UNSIGNED NULL,
      employee_name VARCHAR(45) NOT NULL, reason VARCHAR(45) NOT NULL, resignation_date VARCHAR(45) NOT NULL,
      voided_at TIMESTAMP NULL DEFAULT NULL
    ) ENGINE=InnoDB`);

    /*
     * 1  absent Sep 28-30, nothing recorded               -> flagged
     * 2  same, resignation entered for 5 Oct              -> exit (RESIGNATION_DATE)
     * 3  same, marked Inactive with no date               -> exit (EMPLOYEE_INACTIVE)
     * 4  same, current period closed, no date             -> exit (EMPLOYMENT_PERIOD_CLOSED)
     * 5  same, resignation row on the current period      -> exit (RESIGNATION_RECORD)
     * 6  same, a VOIDED resignation row                   -> flagged
     * 7  same, a resignation from an EARLIER spell; rejoined, current period open -> flagged
     * 8  Sep 30 never calculated                          -> not evaluable
     * 9  Sep 29 rest day (is_working_day false); 27/28/30 absent -> flagged
     * 10 Present/Absent Only, absent 28-30                -> not evaluable
     * 11 DEVI'S CASE: Sep 28-30 + Oct 1-2 absent, Oct 3 present (reviewed 4 Oct) -> not flagged
     * 12 Oct 1-3 absent (reviewed 4 Oct)                  -> flagged, across the boundary
     */
    const people = [
      [1, 1, null], [2, 1, "2026-10-05"], [3, 0, null], [4, 1, null], [5, 1, null],
      [6, 1, null], [7, 1, null], [8, 1, null], [9, 1, null], [10, 1, null],
      [11, 1, null], [12, 1, null],
    ];
    for (const [id, status, resigned] of people) {
      await q(pool, "INSERT INTO new_employee VALUES (?, ?, ?, ?, '2020-01-01')", [id, `E${id}`, status, resigned]);
    }
    const period = async (id, no, state, ended = null) =>
      (await q(pool, `INSERT INTO employee_employment_period (employee_id, period_no, period_state, joined_on, ended_on, source)
                      VALUES (?, ?, ?, '2020-01-01', ?, 'local')`, [id, no, state, ended])).insertId;
    for (const id of [1, 2, 3, 5, 6, 8, 9, 10, 11, 12]) await period(id, 1, "open");
    await period(4, 1, "closed");
    const p5 = (await q(pool, "SELECT period_id FROM employee_employment_period WHERE employee_id = 5"))[0].period_id;
    const p6 = (await q(pool, "SELECT period_id FROM employee_employment_period WHERE employee_id = 6"))[0].period_id;
    const old7 = await period(7, 1, "closed", "2023-03-31");
    await period(7, 2, "open");
    await q(pool, "INSERT INTO resignation (employee_id, period_id, employee_name, reason, resignation_date) VALUES (5, ?, 'E5', 'personal', '2026-10-10')", [p5]);
    await q(pool, "INSERT INTO resignation (employee_id, period_id, employee_name, reason, resignation_date, voided_at) VALUES (6, ?, 'E6', 'personal', '2026-10-10', NOW())", [p6]);
    await q(pool, "INSERT INTO resignation (employee_id, period_id, employee_name, reason, resignation_date) VALUES (7, ?, 'E7', 'personal', '2023-03-31')", [old7]);

    for (let id = 1; id <= 10; id += 1) {
      await storeDay(id, "2026-09-26", { status: "FINAL", punch: 4 });
      if (id === 9) {
        await storeDay(id, "2026-09-27");
        await storeDay(id, "2026-09-28");
        await storeDay(id, "2026-09-29", { snapshot: { work_shift_id: 3, is_working_day: false } });
        await storeDay(id, "2026-09-30");
      } else if (id === 10) {
        for (const d of ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]) {
          await storeDay(id, d, { mode: "PRESENT_ABSENT_ONLY", snapshot: null });
        }
      } else {
        await storeDay(id, "2026-09-27", { status: "FINAL", punch: 2 });
        await storeDay(id, "2026-09-28");
        await storeDay(id, "2026-09-29");
        if (id !== 8) await storeDay(id, "2026-09-30");
      }
    }
    for (const d of ["2026-09-27"]) await storeDay(11, d, { status: "FINAL", punch: 4 });
    for (const d of ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]) await storeDay(11, d);
    await storeDay(11, "2026-10-03", { status: "FINAL", punch: 2 });
    await storeDay(12, "2026-09-30", { status: "FINAL", punch: 4 });
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-03"]) await storeDay(12, d);
    repo = buildPayrunRepo(pool);
  });

  /** The three reads under test are the REAL repository; the rest are inert. */
  const mixedRepo = (population) => ({
    getPeriod: async () => null,
    listPopulation: async () => population,
    listApprovedSalaries: async (ids) => ids.map((employee_id) => ({ employee_id, monthly_gross: 1 })),
    listAttendanceMonths: async () => [],
    listPendingApprovals: async () => [],
    listPayrunRows: async () => [],
    listAttendanceDays: (...a) => repo.listAttendanceDays(...a),
    listExitRecords: (...a) => repo.listExitRecords(...a),
    listLastPresentDates: (...a) => repo.listLastPresentDates(...a),
  });
  const person = (id, over = {}) => ({
    employee_id: id, employee_name: `E${id}`, store_id: 1, payment_type: 1,
    pf_applicable: 0, esi_applicable: 0, date_of_joining: "2020-01-01", resignation_date: null, ...over,
  });

  after(async () => {
    if (pool) {
      await drop();
      await new Promise((resolve) => pool.end(resolve));
    }
  });

  it("the working-day flag comes out of the stored JSON snapshot readably", async () => {
    const rows = await repo.listAttendanceDays([9, 10], "2026-09-29", "2026-09-30");
    const of = (id, d) => rows.find((r) => r.employee_id === id && r.attendance_date === d);
    assert.equal(of(9, "2026-09-29").is_working_day, "false");
    assert.equal(of(9, "2026-09-30").is_working_day, "true");
    assert.equal(of(10, "2026-09-30").is_working_day, null, "a Present/Absent Only {} snapshot carries no flag");
    assert.equal(Number(of(9, "2026-09-30").is_final), 1);
  });

  it("every kind of exit record is found, a voided one and an earlier spell's are not", async () => {
    const rows = await repo.listExitRecords([1, 2, 3, 4, 5, 6, 7]);
    const { exitRecordOf } = require("../usecase/payrun");
    const source = (id) => exitRecordOf(rows.find((r) => r.employee_id === id)).source;
    assert.equal(source(1), null);
    assert.equal(source(2), "RESIGNATION_DATE");
    assert.equal(source(3), "EMPLOYEE_INACTIVE");
    assert.equal(source(4), "EMPLOYMENT_PERIOD_CLOSED");
    assert.equal(source(5), "RESIGNATION_RECORD");
    assert.equal(source(6), null, "a voided resignation is not an exit");
    assert.equal(source(7), null, "an earlier spell's resignation is not this spell's exit");
  });

  it("end to end through the usecase: only the reliably-evaluated, unrecorded absences are flagged", async () => {
    const population = Array.from({ length: 10 }, (_, i) =>
      person(i + 1, { resignation_date: i + 1 === 2 ? "2026-10-05" : null })
    );
    // Reviewed on 1 Oct: the latest completed date is 30 Sep.
    const usecase = buildUsecase(mixedRepo(population), null, { today: () => "2026-10-01" });
    const view = await usecase.getMonth({ year: 2026, month: 9, include_absence_review: true });
    const r = (id) => view.rows.find((row) => row.employee_id === id).absence_review;

    assert.deepEqual(
      view.rows.filter((row) => row.absence_review && row.absence_review.three_day_absent).map((row) => row.employee_id),
      [1, 6, 7, 9]
    );
    assert.equal(view.summary.three_day_absent, 4);
    assert.deepEqual(r(1).absent_dates, ["2026-09-28", "2026-09-29", "2026-09-30"]);
    assert.equal(r(1).last_present_date, "2026-09-27");
    assert.deepEqual(r(9).absent_dates, ["2026-09-27", "2026-09-28", "2026-09-30"]);
    assert.equal(r(9).last_present_date, "2026-09-26");
    for (const id of [2, 3, 4, 5]) assert.equal(r(id).evaluation, "EXIT_RECORDED", `E${id}`);
    assert.equal(r(8).not_evaluable_reason, "NOT_CALCULATED");
    assert.equal(r(10).not_evaluable_reason, "NO_WORKING_DAY_SOURCE");

    // Read only: the employee master and the day rows are exactly as stored.
    const master = await q(pool, "SELECT employee_id, status, DATE_FORMAT(resignation_date, '%Y-%m-%d') AS r FROM new_employee ORDER BY employee_id");
    assert.deepEqual(master.map((m) => [m.employee_id, m.status, m.r]), [
      [1, 1, null], [2, 1, "2026-10-05"], [3, 0, null], [4, 1, null], [5, 1, null],
      [6, 1, null], [7, 1, null], [8, 1, null], [9, 1, null], [10, 1, null],
      [11, 1, null], [12, 1, null],
    ]);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM resignation"))[0].n, 3);
  });

  it("REGRESSION (Devi G): September population reviewed on 4 Oct reads October, across the boundary", async () => {
    const usecase = buildUsecase(mixedRepo([person(11, { employee_name: "Devi G" }), person(12), person(1)]), null, {
      today: () => "2026-10-04",
    });
    const view = await usecase.getMonth({ year: 2026, month: 9, include_absence_review: true });
    const r = (id) => view.rows.find((row) => row.employee_id === id).absence_review;

    // Absent Sep 28 - Oct 2, PRESENT Oct 3: not flagged.
    assert.equal(r(11).three_day_absent, false);
    assert.equal(r(11).evaluation, "NOT_ABSENT");
    assert.equal(r(11).last_present_date, "2026-10-03");
    // Absent Oct 1-3: flagged, with the October dates.
    assert.equal(r(12).three_day_absent, true);
    assert.deepEqual(r(12).absent_dates, ["2026-10-01", "2026-10-02", "2026-10-03"]);
    assert.equal(r(12).last_present_date, "2026-09-30");
    // E1 was absent Sep 28-30 but has no October rows: its latest day is not
    // calculated, so it is NOT flagged on September's ending.
    assert.equal(r(1).three_day_absent, false);
    assert.equal(r(1).not_evaluable_reason, "NOT_CALCULATED");
    assert.equal(r(1).not_evaluable_date, "2026-10-03");
    assert.equal(view.summary.three_day_absent, 1);
  });
});
