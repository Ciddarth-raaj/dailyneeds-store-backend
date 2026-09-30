/**
 * PAYROLL CANNOT LOCK A STALE MONTHLY ATTENDANCE SUMMARY - and a Permission
 * decision cannot deadlock against Approve & Lock. As real SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_month_freshness.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database. The suite
 * creates, fills and drops its own tables; the Permission tables and columns
 * come from the MIGRATION FILE ITSELF.
 *
 * THE PATH THAT MUST NOT EXIST:
 *   1. the month is persisted (summary: 120 minutes short);
 *   2. payroll is calculated on that summary;
 *   3. a Permission is finally approved - its transaction rewrites the DAY
 *      (0 short) and the month refresh does not run;
 *   4. Approve & Lock would lock pay on the 120-minute summary.
 * Step 4 is refused, with the summary named stale, and succeeds once the
 * month is persisted again and payroll recalculated.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildCalcRepo = require("./attendance_calculation");
const { CALCULATION_COLUMNS, MONTHLY_PAYROLL_COLUMNS } = require("./attendance_calculation");
const buildRegRepo = require("./attendance_regularization");
const buildPayrunRepo = require("./payrun_calculation");
const { closePendingPermissionsForLock } = require("./lib/attendance_permission_guard");
const { resolveEffectiveNrm } = require("../utils/payrun_calculation");

const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const UP = fs.readFileSync(path.join(SQLS, "20261107120000-attendance-permission-up.sql"), "utf8");

const EMP = 601;
const DATE = "2026-09-14";
const YEAR = 2026;
const MONTH = 9;

const NEW_DAY = [
  "permission_ids", "permission_window_minutes", "permission_minutes", "permission_late_minutes",
  "permission_early_minutes", "permission_away_minutes", "shortage_before_permission_minutes", "payable_minutes",
];
const NEW_MONTH = ["permission_minutes", "day_rows_fingerprint"];

const SCHEMA = [
  `CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), store_id INT NULL,
     attendance_required TINYINT(1) NOT NULL DEFAULT 1, date_of_joining VARCHAR(20) NULL, resignation_date DATE NULL)`,
  `CREATE TABLE all_permissions (id INT AUTO_INCREMENT PRIMARY KEY, permission_key VARCHAR(100))`,
  `CREATE TABLE permissions (id INT AUTO_INCREMENT PRIMARY KEY, permission_key VARCHAR(100), designation_id INT, is_active TINYINT(1) DEFAULT 1)`,
  `CREATE TABLE attendance_approval_request (
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     request_type ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE') NOT NULL,
     requested_for_employee_id INT NOT NULL, requested_by_employee_id INT NOT NULL,
     attendance_date DATE NOT NULL, outlet_id INT NULL,
     requester_class VARCHAR(20) NOT NULL DEFAULT 'STORE_EMPLOYEE', reason VARCHAR(500) NOT NULL,
     candidate_ot_minutes INT NOT NULL DEFAULT 0, approved_ot_minutes INT NULL,
     auto_created TINYINT(1) NOT NULL DEFAULT 0,
     closure_reason ENUM('NOT_REQUESTED_BEFORE_PAYROLL_LOCK','NOT_APPROVED_BEFORE_PAYROLL_LOCK') NULL,
     status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
     current_stage_no INT NOT NULL DEFAULT 1, total_stages INT NOT NULL,
     finalization_state ENUM('NOT_REQUIRED','PENDING','SETTLED') NOT NULL DEFAULT 'NOT_REQUIRED',
     chain_source VARCHAR(16) NULL, requested_work_shift_id INT NULL, base_work_shift_id INT NULL,
     created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), decided_at TIMESTAMP(3) NULL,
     open_attendance_date DATE GENERATED ALWAYS AS (CASE WHEN status = 'PENDING' THEN attendance_date ELSE NULL END) STORED,
     open_request_group ENUM('ATT','SHIFT') GENERATED ALWAYS AS
       (CASE WHEN status = 'PENDING' THEN (CASE WHEN request_type = 'SHIFT_CHANGE' THEN 'SHIFT' ELSE 'ATT' END) ELSE NULL END) STORED,
     PRIMARY KEY (attendance_approval_request_id),
     UNIQUE KEY uq_aareq_open_per_employee_date (requested_for_employee_id, open_attendance_date, open_request_group),
     KEY idx_aareq_employee_date (requested_for_employee_id, attendance_date)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_approval_step (
     attendance_approval_step_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL, stage_no INT NOT NULL,
     approver_role VARCHAR(32) NOT NULL, outlet_id INT NULL, approver_employee_id INT NULL, approval_level VARCHAR(16) NULL,
     decision ENUM('PENDING','APPROVED','REJECTED','SKIPPED') NOT NULL DEFAULT 'PENDING',
     decided_by_employee_id INT NULL, decided_at TIMESTAMP(3) NULL, remarks VARCHAR(500) NULL,
     acted_as_admin_override TINYINT(1) NOT NULL DEFAULT 0, decision_source VARCHAR(16) NULL,
     UNIQUE KEY uq_step (attendance_approval_request_id, stage_no)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_day_calculation (
     ${CALCULATION_COLUMNS.filter((c) => !NEW_DAY.includes(c))
       .map((c) => (c === "employee_id" ? "employee_id INT NOT NULL" : c === "attendance_date" ? "attendance_date DATE NOT NULL" : `${c} TEXT NULL`))
       .join(",\n     ")},
     calculated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
     UNIQUE KEY uq_day (employee_id, attendance_date)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_monthly_payroll (
     attendance_monthly_payroll_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     ${MONTHLY_PAYROLL_COLUMNS.filter((c) => !NEW_MONTH.includes(c))
       .map((c) => (["employee_id", "period_year", "period_month"].includes(c) ? `${c} INT NOT NULL` : `${c} TEXT NULL`))
       .join(",\n     ")},
     calculated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
     UNIQUE KEY uq_amp (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
  `CREATE TABLE payrun_employee_calculation (
     payrun_calculation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     payrun_employee_id INT NOT NULL, employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
     status VARCHAR(32) NOT NULL, calculation_hash VARCHAR(64), calculation_version INT, calculation_revision INT,
     source_hash VARCHAR(64), net_pay DECIMAL(12,2),
     attendance_monthly_payroll_id BIGINT NULL, attendance_payroll_version INT NULL, attendance_calculated_at DATETIME(3) NULL,
     approved_ot_minutes INT NULL, effective_nrm_minutes INT NULL, effective_nrm_source VARCHAR(32) NULL, ot_groups TEXT NULL,
     approved_by INT NULL, approved_at DATETIME NULL, locked_by INT NULL, locked_at DATETIME NULL,
     UNIQUE KEY uq_pec (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
  `CREATE TABLE payrun_employee_calculation_audit (
     id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, payrun_employee_id INT, period_year INT, period_month INT,
     employee_id INT, action VARCHAR(32), calculation_version INT, calculation_revision INT, calculation_hash VARCHAR(64),
     source_hash VARCHAR(64), net_pay DECIMAL(12,2), changed_by INT
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_recalculation_run (
     attendance_recalculation_run_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     work_shift_id INT NULL, status VARCHAR(32) NOT NULL, trigger_source VARCHAR(32) NOT NULL
   ) ENGINE=InnoDB`,
];
const TABLES = [
  "attendance_permission_bulk_item", "attendance_permission", "attendance_permission_bulk_operation",
  "attendance_recalculation_run", "payrun_employee_calculation_audit", "payrun_employee_calculation",
  "attendance_monthly_payroll", "attendance_day_calculation", "attendance_approval_step",
  "attendance_approval_request", "permissions", "all_permissions", "new_employee",
];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

/** A stored day as the calculation writes it; only the priced fields matter here. */
const day = (date, over = {}) => {
  const row = {};
  CALCULATION_COLUMNS.forEach((c) => {
    row[c] = null;
  });
  return {
    ...row,
    employee_id: EMP,
    attendance_date: date,
    status: "FINAL",
    is_final: 1,
    attendance_day_count: 1,
    nrm_minutes: 660,
    base_nrm_minutes: 660,
    worked_minutes: 540,
    shortage_minutes: 120,
    approved_ot_minutes: 0,
    ot_rate: 1,
    break_allowance_source: "SHIFT",
    calculation_version: 11,
    permission_ids: "[]",
    permission_window_minutes: 0,
    permission_minutes: 0,
    permission_late_minutes: 0,
    permission_early_minutes: 0,
    permission_away_minutes: 0,
    shortage_before_permission_minutes: 120,
    payable_minutes: 540,
    ...over,
  };
};
const monthly = (shortage) => {
  const row = {};
  MONTHLY_PAYROLL_COLUMNS.forEach((c) => {
    row[c] = null;
  });
  return { ...row, employee_id: EMP, period_year: YEAR, period_month: MONTH, shortage_minutes: shortage, approved_ot_minutes: 0, payroll_version: 1, is_final: 1, permission_minutes: 0 };
};

describe("monthly attendance freshness and lock order, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let calcRepo;
  let regRepo;
  let payrunRepo;

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=10&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    await q(pool, UP);
    calcRepo = buildCalcRepo(pool);
    regRepo = buildRegRepo(pool);
    payrunRepo = buildPayrunRepo(pool);
  });

  after(async () => {
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((r) => pool.end(r));
  });

  beforeEach(async () => {
    for (const t of ["attendance_permission", "attendance_recalculation_run", "payrun_employee_calculation_audit", "payrun_employee_calculation", "attendance_monthly_payroll", "attendance_day_calculation", "attendance_approval_step", "attendance_approval_request", "new_employee"]) {
      await q(pool, `DELETE FROM ${t}`);
    }
    await q(pool, `INSERT INTO new_employee (employee_id, employee_name, store_id, date_of_joining) VALUES (${EMP}, 'Asha', 3, '2020-01-01')`);
  });

  /** The month persist, exactly as `calculateMonth(persist=true)` stores it. */
  const persistMonth = (shortage, days) =>
    calcRepo.saveMonthWithPayroll({ employee_id: EMP, period_year: YEAR, period_month: MONTH, rows: days, monthly: monthly(shortage) });

  /** Payroll calculated now: the payrun row records the attendance it priced. */
  const calculatePayroll = async () => {
    const [att] = await payrunRepo.listAttendanceMonths([EMP], YEAR, MONTH);
    const nrm = resolveEffectiveNrm(await payrunRepo.listEffectiveNrm([EMP], "2026-09-01", "2026-09-30"));
    await q(pool, `DELETE FROM payrun_employee_calculation WHERE employee_id = ?`, [EMP]);
    await q(
      pool,
      `INSERT INTO payrun_employee_calculation
         (payrun_employee_id, employee_id, period_year, period_month, status, calculation_hash, calculation_version,
          calculation_revision, source_hash, net_pay, attendance_monthly_payroll_id, attendance_payroll_version,
          attendance_calculated_at, approved_ot_minutes, effective_nrm_minutes, effective_nrm_source, ot_groups)
       VALUES (1, ?, ?, ?, 'CALCULATED', 'h', 1, 1, 's', 1000, ?, ?, ?, ?, ?, ?, ?)`,
      [EMP, YEAR, MONTH, att.attendance_monthly_payroll_id, att.payroll_version, att.calculated_at, att.approved_ot_minutes,
        nrm.nrm_minutes, nrm.nrm_source, JSON.stringify(nrm.ot_groups || [])]
    );
  };

  const approveAndLock = () =>
    payrunRepo.approve({ year: YEAR, month: MONTH, employees: [{ employee_id: EMP, calculation_hash: "h" }], approved_by: 9 });
  const payrunStatus = async () => (await q(pool, "SELECT status FROM payrun_employee_calculation WHERE employee_id = ?", [EMP]))[0].status;

  /** A PERMISSION request, pending at its only stage. */
  const raisePermission = async () => {
    const created = await regRepo.createRequest({
      request: { request_type: "PERMISSION", requested_for_employee_id: EMP, requested_by_employee_id: EMP, attendance_date: DATE, outlet_id: 3, requester_class: "STORE_EMPLOYEE", reason: "Family function", candidate_ot_minutes: 0, auto_created: false, chain_source: "ROLE" },
      chain: [{ stage_no: 1, approver_role: "HR", outlet_id: null }],
      punch: null,
      permissions: [{ permission_from: `${DATE} 20:00:00`, permission_to: `${DATE} 22:00:00`, to_shift_end: true, permission_minutes: 120, reason: "Family function" }],
    });
    return created.attendance_approval_request_id;
  };
  /** Its final approval, as `decide` sends it: the day recalculated with the permission. */
  const approvePermission = (requestId) =>
    regRepo.decideStage({
      requestId,
      stageNo: 1,
      decision: "APPROVED",
      actorId: 8,
      remarks: null,
      adminOverride: false,
      next: { status: "APPROVED", current_stage_no: 1, approved_ot_minutes: 0 },
      calculations: [day(DATE, { shortage_minutes: 0, permission_minutes: 120, permission_early_minutes: 120, payable_minutes: 660 })],
      attendanceLock: { employee_id: EMP, attendance_date: DATE },
      allowRejectWhenLocked: true,
    });

  describe("THE STALE PATH IS CLOSED", () => {
    it("a Permission approved after the month was persisted cannot be locked on the old summary", async () => {
      // 1. month persisted: one day 120 short; 2. payroll calculated on it.
      await persistMonth(120, [day(DATE)]);
      await calculatePayroll();
      // 3. the Permission is finally approved; its day is 0 short; the month
      //    refresh does NOT run (it failed, or it was never wired).
      const id = await raisePermission();
      assert.equal((await approvePermission(id)).code, 200);
      const [stored] = await q(pool, "SELECT shortage_minutes FROM attendance_day_calculation WHERE employee_id = ?", [EMP]);
      assert.equal(Number(stored.shortage_minutes), 0, "the day carries the permission");
      const [summary] = await q(pool, "SELECT shortage_minutes FROM attendance_monthly_payroll WHERE employee_id = ?", [EMP]);
      assert.equal(Number(summary.shortage_minutes), 120, "the summary is stale");

      // 4. Approve & Lock refuses, and nothing is locked.
      const [outcome] = await approveAndLock();
      assert.equal(outcome.outcome, "ATTENDANCE_STALE");
      assert.equal(await payrunStatus(), "CALCULATED");
      assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM payrun_employee_calculation_audit"))[0].n, 0);
    });

    it("once the month is persisted again and payroll recalculated, it locks on the new figures", async () => {
      await persistMonth(120, [day(DATE)]);
      await calculatePayroll();
      await approvePermission(await raisePermission());
      assert.equal((await approveAndLock())[0].outcome, "ATTENDANCE_STALE");

      // The refresh (calculateMonth persist) writes the summary from the days.
      await persistMonth(0, [day(DATE, { shortage_minutes: 0, permission_minutes: 120, payable_minutes: 660 })]);
      // Payroll has not been recalculated yet: its summary is not the current one.
      assert.equal((await approveAndLock())[0].outcome, "SOURCE_MOVED");
      await calculatePayroll();
      assert.equal((await approveAndLock())[0].outcome, "APPROVED");
      assert.equal(await payrunStatus(), "APPROVED_LOCKED");
    });

    it("a month refreshed right after the approval locks without further steps once payroll is calculated", async () => {
      await persistMonth(120, [day(DATE)]);
      await approvePermission(await raisePermission());
      await persistMonth(0, [day(DATE, { shortage_minutes: 0, permission_minutes: 120, payable_minutes: 660 })]);
      await calculatePayroll();
      assert.equal((await approveAndLock())[0].outcome, "APPROVED");
    });

    it("any day change after the persist - not only a Permission - is caught", async () => {
      await persistMonth(120, [day(DATE)]);
      await calculatePayroll();
      // e.g. a correction approval or a daily recalculation rewriting a day
      await calcRepo.saveCalculations([day(DATE, { shortage_minutes: 30 })]);
      assert.equal((await approveAndLock())[0].outcome, "ATTENDANCE_STALE");
    });

    it("a rewrite that changes nothing is not mistaken for a change", async () => {
      await persistMonth(120, [day(DATE)]);
      await calculatePayroll();
      await calcRepo.saveCalculations([day(DATE)]);
      assert.equal((await approveAndLock())[0].outcome, "APPROVED");
    });

    it("a summary written before freshness tracking is treated as stale", async () => {
      await persistMonth(120, [day(DATE)]);
      await q(pool, "UPDATE attendance_monthly_payroll SET day_rows_fingerprint = NULL");
      await calculatePayroll();
      const [outcome] = await approveAndLock();
      assert.equal(outcome.outcome, "ATTENDANCE_STALE");
      assert.equal(outcome.reason, "UNTRACKED");
    });
  });

  describe("LOCK ORDER: a Permission decision and Approve & Lock never deadlock", () => {
    /** Approve & Lock's own lock sequence: the payrun row, then the closure of pending permissions. */
    const lockPayroll = async () => {
      const conn = await new Promise((res, rej) => pool.getConnection((e, c) => (e ? rej(e) : res(c))));
      const run = (sql, params = []) => new Promise((res, rej) => conn.query(sql, params, (e, r) => (e ? rej(e) : res(r))));
      try {
        await run("BEGIN");
        await run("SELECT status FROM payrun_employee_calculation WHERE employee_id = ? AND period_year = ? AND period_month = ? FOR UPDATE", [EMP, YEAR, MONTH]);
        await run("UPDATE payrun_employee_calculation SET status = 'APPROVED_LOCKED' WHERE employee_id = ? AND period_year = ? AND period_month = ?", [EMP, YEAR, MONTH]);
        const closed = await closePendingPermissionsForLock(conn, { employee_id: EMP, year: YEAR, month: MONTH });
        await run("COMMIT");
        return closed;
      } catch (err) {
        await run("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    };

    it("run together 25 times: no deadlock, and every run ends in exactly one consistent state", async () => {
      for (let i = 0; i < 25; i += 1) {
        /* eslint-disable no-await-in-loop */
        await q(pool, "DELETE FROM attendance_permission");
        await q(pool, "DELETE FROM attendance_approval_step");
        await q(pool, "DELETE FROM attendance_approval_request");
        await q(pool, "DELETE FROM attendance_day_calculation");
        await q(pool, "DELETE FROM payrun_employee_calculation");
        await q(pool, `INSERT INTO payrun_employee_calculation (payrun_employee_id, employee_id, period_year, period_month, status) VALUES (1, ?, ?, ?, 'CALCULATED')`, [EMP, YEAR, MONTH]);
        const id = await raisePermission();

        const [decision, lock] = await Promise.allSettled([approvePermission(id), lockPayroll()]);
        /* eslint-enable no-await-in-loop */
        for (const r of [decision, lock]) {
          if (r.status === "rejected") {
            assert.doesNotMatch(String(r.reason && (r.reason.code || r.reason.message)), /DEADLOCK/i, `run ${i}: deadlock`);
          }
        }
        assert.equal(lock.status, "fulfilled", `run ${i}: the payroll lock always completes`);

        // eslint-disable-next-line no-await-in-loop
        const [req] = await q(pool, "SELECT status, closure_reason FROM attendance_approval_request WHERE attendance_approval_request_id = ?", [id]);
        // eslint-disable-next-line no-await-in-loop
        const [dayRow] = await q(pool, "SELECT shortage_minutes FROM attendance_day_calculation WHERE employee_id = ?", [EMP]);
        if (decision.status === "fulfilled") {
          // The decision went first: approved and its day written, then the
          // month locked; nothing left pending to close.
          assert.equal(req.status, "APPROVED", `run ${i}`);
          assert.equal(Number(dayRow.shortage_minutes), 0, `run ${i}`);
          assert.equal(lock.value.closed, 0, `run ${i}`);
        } else {
          // The lock went first: the approval was refused cleanly - no day
          // written, the request closed by the lock, never half-approved.
          assert.equal(decision.reason.code, "PAYROLL_MONTH_LOCKED", `run ${i}`);
          assert.equal(req.status, "REJECTED", `run ${i}`);
          assert.equal(req.closure_reason, "NOT_APPROVED_BEFORE_PAYROLL_LOCK", `run ${i}`);
          assert.equal(dayRow, undefined, `run ${i}: no attendance written`);
        }
      }
    });

    it("the decision takes the payroll row before touching the request", async () => {
      // With the payrun row held elsewhere, the decision must not have locked
      // the request row yet: a second session can still lock the request
      // immediately while the decision waits.
      await q(pool, `INSERT INTO payrun_employee_calculation (payrun_employee_id, employee_id, period_year, period_month, status) VALUES (1, ?, ?, ?, 'CALCULATED')`, [EMP, YEAR, MONTH]);
      const id = await raisePermission();
      const holder = await new Promise((res, rej) => pool.getConnection((e, c) => (e ? rej(e) : res(c))));
      const run = (conn, sql, params = []) => new Promise((res, rej) => conn.query(sql, params, (e, r) => (e ? rej(e) : res(r))));
      await run(holder, "BEGIN");
      await run(holder, "SELECT status FROM payrun_employee_calculation WHERE employee_id = ? FOR UPDATE", [EMP]);
      const pending = approvePermission(id);
      await new Promise((r) => setTimeout(r, 300));
      const probe = await new Promise((res, rej) => pool.getConnection((e, c) => (e ? rej(e) : res(c))));
      await run(probe, "SET SESSION innodb_lock_wait_timeout = 1");
      await run(probe, "BEGIN");
      await run(probe, "SELECT status FROM attendance_approval_request WHERE attendance_approval_request_id = ? FOR UPDATE", [id]);
      await run(probe, "ROLLBACK");
      probe.release();
      await run(holder, "COMMIT");
      holder.release();
      assert.equal((await pending).code, 200);
    });

    it("a Permission may be rejected in a locked month; nothing is written to its attendance", async () => {
      await q(pool, `INSERT INTO payrun_employee_calculation (payrun_employee_id, employee_id, period_year, period_month, status) VALUES (1, ?, ?, ?, 'APPROVED_LOCKED')`, [EMP, YEAR, MONTH]);
      const id = await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, total_stages) VALUES ('PERMISSION', ?, ?, ?, 'x', 1)`, [EMP, EMP, DATE]).then((r) => r.insertId);
      await q(pool, `INSERT INTO attendance_approval_step (attendance_approval_request_id, stage_no, approver_role) VALUES (?, 1, 'HR')`, [id]);
      const out = await regRepo.decideStage({
        requestId: id, stageNo: 1, decision: "REJECTED", actorId: 8, remarks: "Not needed", adminOverride: false,
        next: { status: "REJECTED", current_stage_no: 1, approved_ot_minutes: null },
        calculations: [day(DATE)], attendanceLock: { employee_id: EMP, attendance_date: DATE }, allowRejectWhenLocked: true,
      });
      assert.equal(out.code, 200);
      assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_day_calculation"))[0].n, 0);
      // Any other type keeps the existing refusal.
      const other = await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, total_stages) VALUES ('OT', ?, ?, ?, 'x', 1)`, [EMP, EMP, DATE]).then((r) => r.insertId);
      await q(pool, `INSERT INTO attendance_approval_step (attendance_approval_request_id, stage_no, approver_role) VALUES (?, 1, 'HR')`, [other]);
      await assert.rejects(
        regRepo.decideStage({
          requestId: other, stageNo: 1, decision: "REJECTED", actorId: 8, remarks: "no", adminOverride: false,
          next: { status: "REJECTED", current_stage_no: 1, approved_ot_minutes: null },
          calculations: [], attendanceLock: { employee_id: EMP, attendance_date: DATE },
        }),
        (err) => err.code === "PAYROLL_MONTH_LOCKED"
      );
    });
  });
});
