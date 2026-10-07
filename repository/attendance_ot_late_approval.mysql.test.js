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
  // Attendance correction before system OT: groups, the OT key, the deferred markers.
  "20261126120000-attendance-ot-correction-priority-up.sql",
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
  "attendance_ot_deferred_sync_log",
  "attendance_ot_deferred_sync",
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
  // What the engine finds eligible on any date (the deferred tests vary it).
  let eligibleMinutes = 60;
  // Whether the engine finds the day's attendance complete (one punch when not).
  let dayComplete = true;

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
        employee_id, attendance_date: from_date,
        ...(dayComplete
          ? { status: "FINAL", is_final: true, punch_count: 2 }
          : { status: "REVIEW_REQUIRED", is_final: false, punch_count: 1, review_reasons: ["MISSING_PUNCH"] }),
        shift_snapshot: { work_shift_id: 7, in_time: "09:00:00", out_time: "18:00:00" }, effective_punches: [],
        candidate_ot_minutes: eligibleMinutes, excess_ot_minutes: eligibleMinutes, attendance_calculation_mode: "STANDARD",
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
    eligibleMinutes = 60;
    dayComplete = true;
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

  it("revoke in the LOCKED source month: an unsettled late OT is CANCELLED with nothing locked written; a settled one, or a rejection, is refused", async () => {
    const ot = await request();
    await decideAll(ot.attendance_approval_request_id);
    const before = await frozen();
    // September stays APPROVED_LOCKED throughout.
    await q(pool, "UPDATE attendance_ot_late_settlement SET settlement_status = 'SETTLED', settlement_year = 2026, settlement_month = 10");
    await assert.rejects(
      usecase.revokeDecision({ actor: ADMIN, request_id: ot.attendance_approval_request_id, reason: "approved by mistake" }),
      /already paid as Prior-Month OT in the 10\/2026 payroll/
    );
    assert.equal((await request()).status, "APPROVED");

    await q(pool, "UPDATE attendance_ot_late_settlement SET settlement_status = 'PENDING_SETTLEMENT', settlement_year = NULL, settlement_month = NULL");
    const done = await usecase.revokeDecision({ actor: ADMIN, request_id: ot.attendance_approval_request_id, reason: "approved by mistake" });
    assert.equal(done.code, 200, JSON.stringify(done));
    assert.equal((await request()).status, "CANCELLED");
    const [s] = await q(pool, "SELECT settlement_status FROM attendance_ot_late_settlement");
    assert.equal(s.settlement_status, "CANCELLED");
    assert.equal(await frozen(), before, "the locked calculation and the locked day are byte-identical");
    assert.equal((await q(pool, "SELECT status FROM payrun_employee_calculation WHERE employee_id = ?", [EMP]))[0].status, "APPROVED_LOCKED");
  });

  it("revoke in the LOCKED source month of a late REJECTION is still refused (nothing to cancel, and it would re-raise nothing)", async () => {
    const ot = await request();
    await usecase.decide({ actor: ADMIN, request_id: ot.attendance_approval_request_id, decision: "REJECTED", remarks: "Not authorised" });
    await assert.rejects(
      usecase.revokeDecision({ actor: ADMIN, request_id: ot.attendance_approval_request_id, reason: "rejected by mistake" }),
      /payroll/i
    );
    assert.equal((await request()).status, "REJECTED");
  });


  /* ===================== DEFERRED HISTORICAL DATE, SOURCE MONTH LOCKED (the narrow exception) ==== */

  /*
   * 10 Sep had an attendance correction open when the deploy backfill ran, so
   * the date was REMEMBERED. September has since been locked; the correction
   * has now finished (here: a permission closed by the lock). The OT approval
   * request must still be raised - as an ordinary pending OT - and approving
   * it goes through the existing Prior-Month OT settlement.
   */
  const ADMIN_ACTOR = { employee_id: SM3, user_type: 2 };
  const markers = () => q(pool, "SELECT deferred_sync_id AS id, status, resolution, source FROM attendance_ot_deferred_sync ORDER BY deferred_sync_id");
  const otRequests = () => q(pool, "SELECT attendance_approval_request_id AS id, status, candidate_ot_minutes AS minutes, auto_created FROM attendance_approval_request WHERE requested_for_employee_id = ? AND request_type = 'OT' ORDER BY id", [EMP]);
  const deferredLocked = async ({ source = "BACKFILL" } = {}) => {
    // No OT record on the date yet: the backfill could not evaluate it.
    await q(pool, "DELETE FROM attendance_approval_step");
    await q(pool, "DELETE FROM attendance_approval_request");
    // The date is BEFORE the global cutover (the deploy date).
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET auto_pending_from_date = '2026-10-01'");
    // The blocking correction, finished (a permission closed by the lock).
    await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, candidate_ot_minutes, auto_created, total_stages, status)
                   VALUES ('PERMISSION', ?, ?, ?, 'Left early', 0, 0, 1, 'REJECTED')`, [EMP, EMP, DATE]);
    const saved = await repo.upsertDeferredOt({ employee_id: EMP, attendance_date: DATE, blocking_request_id: 1, blocking_request_type: "PERMISSION", eligible_ot_minutes: 0, source });
    return saved.deferred_sync_id;
  };

  it("2/3/17. a remembered date in a LOCKED month: the ordinary pending OT is raised; nothing locked is written; RESOLVED_OT_CREATED", async () => {
    await deferredLocked();
    const before = await frozen();
    const out = await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    assert.equal(out.resolved.length, 1);
    const [ot] = await otRequests();
    assert.deepEqual([ot.status, ot.minutes, Number(ot.auto_created)], ["PENDING", 60, 1], "the same ordinary system OT approval request");
    assert.equal(await frozen(), before, "the locked calculation and the locked day are byte-identical");
    assert.equal((await q(pool, "SELECT status FROM payrun_employee_calculation WHERE employee_id = ?", [EMP]))[0].status, "APPROVED_LOCKED");
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_late_settlement"))[0].n, 0, "5. not priced, not payable - only an approval item");
    assert.deepEqual((await markers()).map((m) => [m.status, m.resolution]), [["RESOLVED", "RESOLVED_OT_CREATED"]]);
  });

  it("4/16. approved in DnDS: the existing Prior-Month OT settlement - PENDING_SETTLEMENT, priced on September; locked rows unchanged", async () => {
    await deferredLocked();
    await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    const [ot] = await otRequests();
    const before = await frozen();
    const out = await decideAll(ot.id);
    assert.equal(out.status, "APPROVED");
    assert.equal(out.late_settlement.message, "Approved — will be settled in the next eligible payroll as Prior-Month OT");
    const [s] = await q(pool, "SELECT settlement_status, approved_ot_minutes, source_year, source_month, amount FROM attendance_ot_late_settlement");
    assert.deepEqual([s.settlement_status, s.approved_ot_minutes, s.source_year, s.source_month, Number(s.amount)], ["PENDING_SETTLEMENT", 60, 2026, 9, 100],
      "priced at approval on September's Rs 800 a day over 8 hours - the existing late-approval pricing");
    assert.equal(await frozen(), before, "17. the locked payroll and day stay data-equivalent");
  });

  it("5. rejected: final REJECTED, no settlement", async () => {
    await deferredLocked();
    await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    const [ot] = await otRequests();
    const out = await usecase.decide({ actor: ADMIN_ACTOR, request_id: ot.id, decision: "REJECTED", remarks: "Not authorised" });
    assert.equal(out.status, "REJECTED");
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_late_settlement"))[0].n, 0);
  });

  it("6. the corrected day has no eligible OT: nothing raised, RESOLVED_NO_OT", async () => {
    await deferredLocked();
    eligibleMinutes = 0;
    await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    assert.equal((await otRequests()).length, 0);
    assert.deepEqual((await markers()).map((m) => [m.status, m.resolution]), [["RESOLVED", "RESOLVED_NO_OT"]]);
  });

  it("7/8. an OT already APPROVED or REJECTED on the date wins: no new pending, RESOLVED_EXISTING_DECISION", async () => {
    for (const decided of ["APPROVED", "REJECTED"]) {
      /* eslint-disable no-await-in-loop */
      await deferredLocked();
      await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, candidate_ot_minutes, auto_created, total_stages, status, approved_ot_minutes)
                     VALUES ('OT', ?, ?, ?, 'decided before', 60, 1, 1, ?, ?)`, [EMP, EMP, DATE, decided, decided === "APPROVED" ? 60 : 0]);
      await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
      const rows = await otRequests();
      assert.deepEqual(rows.map((r) => r.status), [decided], `${decided}: never re-raised`);
      assert.deepEqual((await markers()).map((m) => m.resolution), ["RESOLVED_EXISTING_DECISION"]);
      await q(pool, "DELETE FROM attendance_ot_deferred_sync_log");
      await q(pool, "DELETE FROM attendance_ot_deferred_sync");
      /* eslint-enable no-await-in-loop */
    }
  });

  it("9/10/11. ORDINARY dates keep the lock rule; an unrelated old date stays BEFORE_CUTOVER; the cutover never moves", async () => {
    await deferredLocked();
    // 10. An unrelated pre-cutover date in the same locked month, nobody remembered it.
    const unrelated = await usecase.syncAutoOt({ employee_id: EMP, dates: ["2026-09-12"], source: "RECALCULATION" });
    assert.deepEqual(unrelated.skipped.map((x) => x.reason), ["BEFORE_CUTOVER"]);
    // 11. An ordinary date AFTER the cutover in a locked month: the existing lock rule.
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET auto_pending_from_date = '2026-09-01'");
    const ordinary = await usecase.syncAutoOt({ employee_id: EMP, dates: ["2026-09-15"], source: "RECALCULATION" });
    assert.deepEqual(ordinary.skipped.map((x) => x.reason), ["PAYROLL_LOCKED"]);
    assert.equal((await otRequests()).length, 0, "no OT on any date but the remembered one");
    // 9. The cutover was only ever changed by this test itself.
    assert.equal((await repo.getAutoOtSetting()).auto_pending_from_date, "2026-09-01");
  });

  it("the exception is the database's, not the caller's: a marker not from the backfill, or already resolved, does not open a locked month", async () => {
    const id = await deferredLocked({ source: "MANUAL" });
    const out = await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    assert.equal(out.resolved.length, 0);
    assert.equal((await otRequests()).length, 0);
    assert.deepEqual((await markers()).map((m) => m.status), ["WAITING_FOR_CORRECTION"], "14. not resolved: nothing was created");
    // A forged call straight to the repository with a non-qualifying marker is refused under the lock.
    await assert.rejects(
      repo.createRequest({
        request: { request_type: "OT", requested_for_employee_id: EMP, requested_by_employee_id: EMP, attendance_date: DATE, outlet_id: 3,
          requester_class: "STORE_EMPLOYEE", reason: "forged", candidate_ot_minutes: 60, auto_created: true, chain_source: "ROLE",
          refuse_when_payroll_locked: true, deferred_sync_id: id },
        chain: [{ stage_no: 1, approver_role: "STORE_MANAGER", outlet_id: 3, approver_employee_id: null, approval_level: null }],
        punch: null,
      }),
      (err) => /payroll/i.test(err.message)
    );
  });

  it("14. a failed creation leaves the marker WAITING; the next run raises it and only then resolves", async () => {
    await deferredLocked();
    const real = repo.createRequest.bind(repo);
    repo.createRequest = async () => { throw new Error("connection lost"); };
    const first = await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    repo.createRequest = real;
    assert.equal(first.resolved.length, 0);
    assert.deepEqual((await markers()).map((m) => m.status), ["WAITING_FOR_CORRECTION"]);
    const second = await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    assert.equal(second.resolved.length, 1);
    assert.equal((await otRequests()).length, 1);
  });

  it("12/13. the sweep, the correction's decision hook and a backfill re-run at once: exactly ONE pending OT, resolved once", async () => {
    await deferredLocked();
    await Promise.all([
      usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" }),
      usecase.syncAutoOt({ employee_id: EMP, dates: [DATE], source: "DECISION_PERMISSION" }),
      usecase.syncAutoOt({ employee_id: EMP, dates: [DATE], source: "BACKFILL", notify: false, allow_creation_from: DATE, track_deferred: true }),
      usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" }),
    ]);
    assert.deepEqual((await otRequests()).map((r) => r.status), ["PENDING"]);
    assert.equal((await markers()).length, 1);
    const resolvedLogs = await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_deferred_sync_log WHERE action = 'RESOLVED'");
    assert.equal(resolvedLogs[0].n, 1);
  });

  it("deferred creation vs an approver: the request is created in one transaction, and a sweep re-run beside the approval never re-raises it", async () => {
    await deferredLocked();
    await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    const [ot] = await otRequests();
    const [a, b] = await Promise.all([
      decideAll(ot.id),
      usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" }),
    ]);
    assert.equal(a.status, "APPROVED");
    assert.ok(b);
    assert.deepEqual((await otRequests()).map((r) => r.status), ["APPROVED"], "never re-raised beside the decision");
  });

  it("the engine read: the request carries its settlement, so the day never pays it", async () => {
    const ot = await request();
    await decideAll(ot.attendance_approval_request_id);
    const rows = await buildCalcRepo(pool).getApprovalStateByDate(EMP, DATE, DATE);
    const mine = rows.find((r) => Number(r.attendance_approval_request_id) === Number(ot.attendance_approval_request_id));
    assert.equal(mine.late_settlement_status, "PENDING_SETTLEMENT");
    assert.equal(mine.late_settlement_minutes, 60);
  });

  /* ====================== INCOMPLETE ATTENDANCE: no OT at all; remembered; re-evaluated when complete ==== */

  const unlockSeptember = () => q(pool, "DELETE FROM payrun_employee_calculation WHERE employee_id = ?", [EMP]);
  const lockSeptember = () =>
    q(pool, "INSERT INTO payrun_employee_calculation (employee_id, period_year, period_month, status, daily_rate, monthly_gross, net_pay) VALUES (?, 2026, 9, 'APPROVED_LOCKED', 800, 20800, 19000)", [EMP]);
  const markerRows = () => q(pool, "SELECT status, resolution, reason, source, blocking_request_id FROM attendance_ot_deferred_sync ORDER BY deferred_sync_id");

  it("INCOMPLETE: the day loses a punch -> the pending system OT is WITHDRAWN (not waiting) and the date remembered; once complete after the lock -> Pending OT -> Prior-Month OT", async () => {
    await unlockSeptember();
    const [ot] = await otRequests();
    assert.equal(ot.status, "PENDING");
    dayComplete = false;
    const out = await usecase.syncAutoOt({ employee_id: EMP, dates: [DATE], source: "RECALCULATION" });
    assert.equal(out.withdrawn[0].incomplete_reason, "MISSING_IN_OR_OUT_PUNCH");
    assert.deepEqual((await otRequests()).map((r) => r.status), ["CANCELLED"], "no waiting OT");
    assert.deepEqual((await markerRows()).map((m) => [m.status, m.reason, m.source, m.blocking_request_id]),
      [["WAITING_FOR_CORRECTION", "INCOMPLETE_ATTENDANCE", "OT_WITHDRAWN_INCOMPLETE", null]]);
    const [log] = await q(pool, "SELECT action, detail FROM attendance_ot_deferred_sync_log");
    assert.equal(log.action, "DEFERRED");
    assert.match(log.detail, /attendance incomplete \(MISSING_IN_OR_OUT_PUNCH; pending OT #\d+ \(60 min\) withdrawn\); no OT until complete/);
    // The month locks while the attendance is still incomplete: nothing.
    await lockSeptember();
    const still = await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    assert.equal(still.resolved.length, 0);
    assert.equal((await otRequests()).filter((r) => r.status === "PENDING").length, 0);
    // Complete now (the missing punch arrived): an ordinary pending OT in the locked month.
    dayComplete = true;
    const before = await frozen();
    const done = await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
    assert.equal(done.resolved[0].resolution, "RESOLVED_OT_CREATED");
    const fresh = (await otRequests()).find((r) => r.status === "PENDING");
    assert.deepEqual([fresh.minutes, Number(fresh.auto_created)], [60, 1]);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_late_settlement"))[0].n, 0, "not priced at creation");
    const approved = await decideAll(fresh.id);
    assert.equal(approved.status, "APPROVED");
    const [s] = await q(pool, "SELECT settlement_status, approved_ot_minutes FROM attendance_ot_late_settlement");
    assert.deepEqual([s.settlement_status, s.approved_ot_minutes], ["PENDING_SETTLEMENT", 60]);
    assert.equal(await frozen(), before, "the locked payroll and day are untouched");
  });

  it("INCOMPLETE: a remembered date is never resolved from the broken day; the reason is logged once, and it moves to the back of the sweep", async () => {
    const id = await deferredLocked({ source: "OT_WITHDRAWN_INCOMPLETE" });
    dayComplete = false;
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const out = await usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" });
      assert.equal(out.resolved.length, 0);
    }
    assert.deepEqual((await markerRows()).map((m) => [m.status, m.reason]), [["WAITING_FOR_CORRECTION", "INCOMPLETE_ATTENDANCE"]]);
    assert.deepEqual((await q(pool, "SELECT action FROM attendance_ot_deferred_sync_log ORDER BY deferred_sync_log_id")).map((l) => l.action), ["DEFERRED", "STILL_BLOCKED"]);
    assert.equal((await otRequests()).length, 0);
    // Rotation: a newer, untouched marker is swept first.
    await q(pool, "INSERT INTO attendance_ot_deferred_sync (employee_id, attendance_date, source, updated_at) VALUES (?, '2026-09-11', 'BACKFILL', '2026-01-01 00:00:00')", [EMP]);
    const order = await repo.listResolvableDeferredOt(10);
    assert.deepEqual(order.map((m) => Number(m.deferred_sync_id) === Number(id)), [false, true]);
  });

  it("INCOMPLETE: an approver cannot approve an OT whose day is now incomplete - 409, and the system's OT is withdrawn", async () => {
    await unlockSeptember();
    const [ot] = await otRequests();
    dayComplete = false;
    const out = await usecase.decide({ actor: ADMIN, request_id: ot.id, decision: "APPROVED" });
    assert.equal(out.code, 409);
    assert.equal(out.reason_code, "ATTENDANCE_INCOMPLETE");
    assert.equal(out.msg, "Attendance is incomplete. OT will be calculated after attendance is complete.");
    assert.equal(out.withdrawn, true);
    assert.deepEqual((await otRequests()).map((r) => r.status), ["CANCELLED"]);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_approval_step WHERE decision = 'APPROVED'"))[0].n, 0);
  });

  it("a database without the marker table (a preview before the migration) reads none - and logs nothing", async () => {
    const logged = [];
    const realLog = repo._log;
    repo._log = (code, err) => logged.push([code, err && err.code]);
    await q(pool, "RENAME TABLE attendance_ot_deferred_sync TO attendance_ot_deferred_sync_hidden");
    try {
      assert.deepEqual(await repo.listWaitingDeferredOt(EMP, [DATE]), []);
      assert.deepEqual(await repo.listResolvableDeferredOt(10), []);
      const preview = await usecase.syncAutoOt({ employee_id: EMP, dates: [DATE], dry_run: true, track_deferred: true, source: "BACKFILL" });
      assert.equal(preview.errors.length, 0);
    } finally {
      await q(pool, "RENAME TABLE attendance_ot_deferred_sync_hidden TO attendance_ot_deferred_sync");
      repo._log = realLog;
    }
    assert.deepEqual(logged, [], "no 'attendance_ot_deferred_sync doesn't exist' noise");
  });
});
