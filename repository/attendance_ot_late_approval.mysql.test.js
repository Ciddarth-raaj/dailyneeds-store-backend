/**
 * PRIOR-MONTH OT, THE DECISION, AS REAL SQL - the production regularization
 * repository's `decideStage` (settlement row in the decision's own
 * transaction, the lock re-proved under FOR UPDATE), `getLateOtPricingBasis`,
 * `revokeRequest`'s settlement rules, and the production `decide` /
 * `revokeDecision` over them.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_ot_late_approval.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database. Only the
 * attendance ENGINE is stubbed (a fixed closed day with 60 min eligible OT).
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");
const buildCalcRepo = require("./attendance_calculation");
const { CALCULATION_COLUMNS } = require("./attendance_calculation");
const buildRegularization = require("../usecase/attendance_regularization");

const SQL_DIR = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const read = (f) => fs.readFileSync(path.join(SQL_DIR, f), "utf8");
const MIGRATIONS = [
  "20261124120000-attendance-ot-auto-pending-up.sql",
  "20261125120000-attendance-ot-late-settlement-up.sql",
  "20261103120000-attendance-approval-revocation-up.sql",
  "20261106120000-attendance-approval-revocation-outcome-up.sql",
];

const EMP = 601;
const SM3 = 31;
const ADMIN = { employee_id: SM3, user_type: 2 };
const DATE = "2026-09-10";

const SCHEMA = [
  `CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), store_id INT NULL, designation_id INT NULL, status TINYINT NOT NULL DEFAULT 1, resignation_date DATE NULL)`,
  `CREATE TABLE designation (designation_id INT PRIMARY KEY, designation_name VARCHAR(80))`,
  `CREATE TABLE attendance_approval_role (designation_id INT PRIMARY KEY, approver_role VARCHAR(32) NULL, requester_class VARCHAR(20) NULL)`,
  `CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80))`,
  `CREATE TABLE attendance_approval_request (
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     request_type ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE','PERMISSION') NOT NULL,
     requested_for_employee_id INT NOT NULL, requested_by_employee_id INT NOT NULL,
     attendance_date DATE NOT NULL, outlet_id INT NULL,
     requester_class VARCHAR(20) NOT NULL DEFAULT 'STORE_EMPLOYEE',
     reason VARCHAR(500) NOT NULL,
     candidate_ot_minutes INT NOT NULL DEFAULT 0, approved_ot_minutes INT NULL,
     auto_created TINYINT(1) NOT NULL DEFAULT 0, closure_reason VARCHAR(64) NULL,
     status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
     current_stage_no INT NOT NULL DEFAULT 1, total_stages INT NOT NULL,
     finalization_state ENUM('NOT_REQUIRED','PENDING','SETTLED') NOT NULL DEFAULT 'NOT_REQUIRED',
     chain_source VARCHAR(16) NULL,
     requested_work_shift_id INT NULL, base_work_shift_id INT NULL,
     telegram_chat_id VARCHAR(64) NULL, telegram_message_id VARCHAR(64) NULL,
     created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
     decided_at TIMESTAMP(3) NULL,
     updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
     open_attendance_date DATE GENERATED ALWAYS AS
       (CASE WHEN status = 'PENDING' THEN attendance_date ELSE NULL END) STORED,
     open_request_group ENUM('ATT','SHIFT','PERM') GENERATED ALWAYS AS
       (CASE WHEN status = 'PENDING'
             THEN (CASE WHEN request_type = 'SHIFT_CHANGE' THEN 'SHIFT'
                        WHEN request_type = 'PERMISSION' THEN 'PERM' ELSE 'ATT' END)
             ELSE NULL END) STORED,
     PRIMARY KEY (attendance_approval_request_id),
     UNIQUE KEY uq_aareq_open_per_employee_date (requested_for_employee_id, open_attendance_date, open_request_group)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_approval_step (
     attendance_approval_step_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL, stage_no INT NOT NULL,
     approver_role VARCHAR(32) NOT NULL, outlet_id INT NULL,
     approver_employee_id INT NULL, approval_level VARCHAR(16) NULL,
     decision ENUM('PENDING','APPROVED','REJECTED','SKIPPED') NOT NULL DEFAULT 'PENDING',
     decided_by_employee_id INT NULL, decided_at TIMESTAMP(3) NULL, remarks VARCHAR(500) NULL,
     acted_as_admin_override TINYINT(1) NOT NULL DEFAULT 0,
     decision_source ENUM('WEB','TELEGRAM') NULL,
     UNIQUE KEY uq_step (attendance_approval_request_id, stage_no)
   ) ENGINE=InnoDB`,
  `CREATE TABLE payrun_employee_calculation (
     payrun_calculation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
     employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
     status VARCHAR(32) NOT NULL, daily_rate DECIMAL(12,2) NULL, monthly_gross DECIMAL(12,2) NULL,
     net_pay DECIMAL(12,2) NULL,
     PRIMARY KEY (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
  // The production column list, as the bulk-approval suite builds it.
  `CREATE TABLE attendance_day_calculation (
     ${CALCULATION_COLUMNS.map((c) =>
       c === "employee_id"
         ? "employee_id INT NOT NULL"
         : c === "attendance_date"
         ? "attendance_date DATE NOT NULL"
         : ["approved_ot_minutes", "punch_count", "nrm_minutes", "candidate_ot_minutes", "attendance_day_count"].includes(c)
         ? `${c} INT NULL`
         : `${c} TEXT NULL`
     ).join(",\n     ")},
     UNIQUE KEY uq_day (employee_id, attendance_date)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_regularized_punch (
     attendance_regularized_punch_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL, employee_id INT NOT NULL,
     attendance_date DATE NOT NULL, punch_time DATETIME NOT NULL,
     punch_source VARCHAR(16) NOT NULL DEFAULT 'REGULARIZED', created_by INT NOT NULL,
     created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_date_shift_override (
     attendance_date_shift_override_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     employee_id INT NOT NULL, attendance_date DATE NOT NULL, work_shift_id INT NOT NULL,
     previous_work_shift_id INT NULL, changed_by INT NULL, attendance_approval_request_id BIGINT UNSIGNED NULL,
     source VARCHAR(32) NULL, reason VARCHAR(500) NULL
   ) ENGINE=InnoDB`,
  `CREATE TABLE work_shift (work_shift_id INT PRIMARY KEY, shift_code VARCHAR(20), shift_name VARCHAR(80))`,
];

const TABLES = [
  "attendance_approval_revocation",
  "attendance_regularized_punch",
  "attendance_date_shift_override",
  "work_shift",
  "attendance_ot_late_settlement_log",
  "attendance_ot_late_settlement",
  "attendance_ot_auto_pending_log",
  "attendance_ot_auto_pending_setting",
  "attendance_day_calculation",
  "payrun_employee_calculation",
  "attendance_approval_step",
  "attendance_approval_request",
  "attendance_approval_role",
  "outlets",
  "designation",
  "new_employee",
];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("Prior-Month OT decisions, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  let usecase;

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=6&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    for (const f of MIGRATIONS) await q(pool, read(f));
    repo = buildRepo(pool);
    const calcRepo = buildCalcRepo(pool);
    const engine = {
      findPayrollLockedPeriods: (rows) => calcRepo.findPayrollLockedPeriods(rows),
      attendanceDayState: () => ({ closed: true, reason: null, closes_at: null }),
      employmentWindowFor: async () => ({ joined_on: "2020-01-01", ended_on: null }),
      calculateRange: async ({ employee_id, from_date }) => [{
        employee_id, attendance_date: from_date, status: "FINAL", is_final: true, punch_count: 2,
        shift_snapshot: { work_shift_id: 7, in_time: "09:00:00", out_time: "18:00:00" }, effective_punches: [],
        candidate_ot_minutes: 60, excess_ot_minutes: 60, attendance_calculation_mode: "STANDARD",
      }],
      // If anything tried to store the locked day, this row would reach the table.
      toStorageRow: (d) => ({ employee_id: d.employee_id, attendance_date: d.attendance_date, approved_ot_minutes: 999 }),
    };
    usecase = buildRegularization(repo, engine);
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((resolve) => pool.end(resolve));
  });

  beforeEach(async () => {
    for (const t of TABLES.filter((x) => !/auto_pending_setting/.test(x))) await q(pool, `DELETE FROM ${t}`);
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET enabled = 1, auto_pending_from_date = '2026-09-01'");
    await q(pool, "INSERT INTO designation VALUES (1, 'Staff'), (2, 'Store Manager')");
    await q(pool, "INSERT INTO attendance_approval_role VALUES (2, 'STORE_MANAGER', 'MANAGER')");
    await q(pool, "INSERT INTO outlets VALUES (3, 'DN3')");
    await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id, designation_id) VALUES ?", [[[EMP, "Staff A", 3, 1], [SM3, "Manager DN3", 3, 2]]]);
    // The OT, raised PENDING before September was locked.
    await usecase.syncAutoOt({ employee_id: EMP, dates: [DATE], today: "2026-09-20" });
    // September: Approved & Locked at Rs 800 a day; the date's stored NRM is 480.
    await q(pool, "INSERT INTO payrun_employee_calculation (employee_id, period_year, period_month, status, daily_rate, monthly_gross, net_pay) VALUES (?, 2026, 9, 'APPROVED_LOCKED', 800, 20800, 19000)", [EMP]);
    await q(pool, "INSERT INTO attendance_day_calculation (employee_id, attendance_date, nrm_minutes, break_allowance_source, candidate_ot_minutes, approved_ot_minutes, attendance_day_count) VALUES (?, ?, 480, 'SHIFT', 60, 0, 1)", [EMP, DATE]);
  });

  const request = async () => (await q(pool, "SELECT * FROM attendance_approval_request WHERE requested_for_employee_id = ? AND request_type = 'OT'", [EMP]))[0];
  const decideAll = async (id, decision = "APPROVED", remarks = null) => {
    let out;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      out = await usecase.decide({ actor: ADMIN, request_id: id, decision, remarks });
      if (out.status !== "PENDING") break;
    }
    return out;
  };
  const frozen = async () =>
    JSON.stringify([
      await q(pool, "SELECT * FROM payrun_employee_calculation ORDER BY employee_id"),
      await q(pool, "SELECT * FROM attendance_day_calculation ORDER BY employee_id"),
    ]);

  it("1/2/3/8. approved after the lock: APPROVED + settlement row PENDING_SETTLEMENT, priced on September; the locked rows untouched", async () => {
    const ot = await request();
    const before = await frozen();
    const out = await decideAll(ot.attendance_approval_request_id);
    assert.equal(out.status, "APPROVED");
    assert.equal(out.late_settlement.message, "Approved — will be settled in the next eligible payroll as Prior-Month OT");
    assert.equal(await frozen(), before, "the locked calculation and the locked day are byte-identical");
    const [s] = await q(pool, "SELECT * FROM attendance_ot_late_settlement");
    assert.equal(s.attendance_approval_request_id, ot.attendance_approval_request_id);
    assert.deepEqual([s.source_year, s.source_month, s.eligible_ot_minutes, s.approved_ot_minutes, Number(s.source_daily_rate), s.nrm_minutes, Number(s.ot_hourly_rate), Number(s.amount), s.settlement_status],
      [2026, 9, 60, 60, 800, 480, 100, 100, "PENDING_SETTLEMENT"]);
    const [r] = await q(pool, "SELECT status, approved_ot_minutes FROM attendance_approval_request WHERE attendance_approval_request_id = ?", [ot.attendance_approval_request_id]);
    assert.deepEqual([r.status, r.approved_ot_minutes], ["APPROVED", 60]);
    const logs = await q(pool, "SELECT to_status FROM attendance_ot_late_settlement_log");
    assert.deepEqual(logs.map((l) => l.to_status), ["PENDING_SETTLEMENT"]);
  });

  it("7. rejected after the lock: REJECTED with its reason on the step, no settlement, nothing locked moved", async () => {
    const ot = await request();
    const before = await frozen();
    const out = await usecase.decide({ actor: ADMIN, request_id: ot.attendance_approval_request_id, decision: "REJECTED", remarks: "Not authorised by store" });
    assert.equal(out.status, "REJECTED");
    const steps = await q(pool, "SELECT decision, remarks, decided_by_employee_id FROM attendance_approval_step WHERE attendance_approval_request_id = ? AND decision = 'REJECTED'", [ot.attendance_approval_request_id]);
    assert.deepEqual([steps[0].remarks, steps[0].decided_by_employee_id], ["Not authorised by store", SM3]);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_late_settlement"))[0].n, 0);
    assert.equal(await frozen(), before);
  });

  it("the lock is re-proved under FOR UPDATE: a month unlocked meanwhile is refused (409), nothing written", async () => {
    const ot = await request();
    await q(pool, "UPDATE payrun_employee_calculation SET status = 'CALCULATED'");
    const out = await repo.decideStage({
      requestId: ot.attendance_approval_request_id, stageNo: 1, decision: "APPROVED", actorId: SM3, remarks: null,
      adminOverride: true, next: { status: "PENDING", current_stage_no: 2, approved_ot_minutes: null },
      calculations: [], attendanceLock: { employee_id: EMP, attendance_date: DATE },
      lateOt: { expect_locked: true, settlement: null },
    });
    assert.equal(out.code, 409);
    const [step] = await q(pool, "SELECT decision FROM attendance_approval_step WHERE attendance_approval_request_id = ? AND stage_no = 1", [ot.attendance_approval_request_id]);
    assert.equal(step.decision, "PENDING");
  });

  it("revoke: a SETTLED late OT cannot be revoked; an unsettled one is CANCELLED with the revoke, logged", async () => {
    const ot = await request();
    await decideAll(ot.attendance_approval_request_id);
    // The source month is unlocked later (revocation is refused while it is locked).
    await q(pool, "UPDATE payrun_employee_calculation SET status = 'CALCULATED'");
    await q(pool, "UPDATE attendance_ot_late_settlement SET settlement_status = 'SETTLED', settlement_year = 2026, settlement_month = 10");
    const refused = await usecase.revokeDecision({ actor: ADMIN, request_id: ot.attendance_approval_request_id, reason: "approved by mistake" });
    assert.equal(refused.code, 409);
    assert.equal(refused.reason_code, "PRIOR_MONTH_OT_SETTLED");
    assert.equal((await request()).status, "APPROVED");

    await q(pool, "UPDATE attendance_ot_late_settlement SET settlement_status = 'PENDING_SETTLEMENT', settlement_year = NULL, settlement_month = NULL");
    const done = await usecase.revokeDecision({ actor: ADMIN, request_id: ot.attendance_approval_request_id, reason: "approved by mistake" });
    assert.equal(done.code, 200, JSON.stringify(done));
    const [s] = await q(pool, "SELECT settlement_status FROM attendance_ot_late_settlement");
    assert.equal(s.settlement_status, "CANCELLED");
    const logs = await q(pool, "SELECT to_status FROM attendance_ot_late_settlement_log ORDER BY late_settlement_log_id");
    assert.deepEqual(logs.map((l) => l.to_status), ["PENDING_SETTLEMENT", "CANCELLED"]);
  });

  it("the engine read: the request carries its settlement, so the day never pays it", async () => {
    const ot = await request();
    await decideAll(ot.attendance_approval_request_id);
    const rows = await buildCalcRepo(pool).getApprovalStateByDate(EMP, DATE, DATE);
    const mine = rows.find((r) => Number(r.attendance_approval_request_id) === Number(ot.attendance_approval_request_id));
    assert.equal(mine.late_settlement_status, "PENDING_SETTLEMENT");
    assert.equal(mine.late_settlement_minutes, 60);
  });
});
