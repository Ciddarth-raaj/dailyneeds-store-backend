/**
 * BULK Approve / Reject / Revoke, AS REAL SQL - the production repository and
 * the production approval usecase, one selected request at a time.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_approval_bulk.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its tables, fills them and drops them again.
 *
 * WHAT IS REAL. `repository/attendance_regularization.js` (getRequest,
 * decideStage, getRevocationSnapshot, revokeRequest, the payroll lock taken
 * FOR UPDATE inside those transactions, listApprovals / countApprovals) and
 * `usecase/attendance_regularization.js` (`bulkAction` -> `decide` /
 * `revokeDecision`, `canApprove`, `listBulkTargets`). The per-record log table
 * and the revocation audit table are built from their MIGRATION FILES.
 *
 * WHAT IS STUBBED. Only the attendance ENGINE: the day a decision would store
 * is a fixed closed day, because the engine's arithmetic is not what bulk
 * changes and is proven elsewhere (usecase/attendance_approval_bulk.test.js
 * runs the production engine). The payroll-lock lookup the usecase asks
 * before a write is the production repository's query.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");
const buildCalcRepo = require("./attendance_calculation");
const buildRegularization = require("../usecase/attendance_regularization");
const { CALCULATION_COLUMNS } = require("./attendance_calculation");

const EMP = 501;
const EMP2 = 502;
const EMP3 = 503;
const ADMIN = 900;
const SM3 = 31; // Store Manager of outlet 3
const SM4 = 41; // Store Manager of outlet 4
const DATE = "2026-09-10";

const SQL_DIR = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const REVOCATION_MIGRATION = path.join(SQL_DIR, "20261103120000-attendance-approval-revocation-up.sql");
const BULK_MIGRATION = path.join(SQL_DIR, "20261105120000-attendance-approval-bulk-action-up.sql");

const SCHEMA = [
  `CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), store_id INT NULL, designation_id INT NULL)`,
  `CREATE TABLE designation (designation_id INT PRIMARY KEY, designation_name VARCHAR(80))`,
  `CREATE TABLE attendance_approval_role (designation_id INT PRIMARY KEY, approver_role VARCHAR(32) NULL, requester_class VARCHAR(20) NULL)`,
  `CREATE TABLE attendance_approval_request (
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     request_type ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE') NOT NULL,
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
     open_attendance_date DATE GENERATED ALWAYS AS
       (CASE WHEN status = 'PENDING' THEN attendance_date ELSE NULL END) STORED,
     open_request_group ENUM('ATT','SHIFT') GENERATED ALWAYS AS
       (CASE WHEN status = 'PENDING'
             THEN (CASE WHEN request_type = 'SHIFT_CHANGE' THEN 'SHIFT' ELSE 'ATT' END)
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
  `CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80))`,
  `CREATE TABLE work_shift (work_shift_id INT PRIMARY KEY, shift_code VARCHAR(20), shift_name VARCHAR(80))`,
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
         : c === "approved_ot_minutes" || c === "punch_count"
         ? `${c} INT NULL`
         : `${c} TEXT NULL`
     ).join(",\n     ")},
     UNIQUE KEY uq_day (employee_id, attendance_date)
   ) ENGINE=InnoDB`,
];
const TABLES = [
  "attendance_approval_bulk_action_item",
  "attendance_approval_revocation",
  "attendance_day_calculation",
  "payrun_employee_calculation",
  "attendance_date_shift_override",
  "attendance_regularized_punch",
  "attendance_approval_step",
  "attendance_approval_request",
  "attendance_approval_role",
  "designation",
  "work_shift",
  "outlets",
  "new_employee",
];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("bulk approval actions, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  let calcRepo;
  let usecase;
  const engineCalls = [];

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=6&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    await q(pool, fs.readFileSync(REVOCATION_MIGRATION, "utf8"));
    await q(pool, fs.readFileSync(BULK_MIGRATION, "utf8"));
    repo = buildRepo(pool);
    calcRepo = buildCalcRepo(pool);
    // The ENGINE, stubbed: a closed day; approved OT follows the assumed
    // decision; a day calculated WITHOUT a request has none of its OT.
    const engine = {
      findPayrollLockedPeriods: (rows) => calcRepo.findPayrollLockedPeriods(rows),
      attendanceDayState: () => ({ closed: true, reason: null, closes_at: null }),
      calculateRange: async (args) => {
        engineCalls.push(args);
        const assumed = args.assume && args.assume.status === "APPROVED" ? Number(args.assume.approved_ot_minutes) || 0 : 0;
        return [{
          employee_id: args.employee_id, attendance_date: args.from_date, shift_snapshot: null,
          punch_count: 2, candidate_ot_minutes: 180, excess_ot_minutes: 180, approved_ot_minutes: assumed,
          ot_claim_state: args.exclude_request_id ? "AVAILABLE" : "PENDING",
        }];
      },
      toStorageRow: (d) => ({ employee_id: d.employee_id, attendance_date: d.attendance_date, approved_ot_minutes: d.approved_ot_minutes, punch_count: d.punch_count, status: "FINAL", is_final: 1 }),
    };
    usecase = buildRegularization(repo, engine);
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((resolve) => pool.end(resolve));
  });

  beforeEach(async () => {
    engineCalls.length = 0;
    for (const t of TABLES) await q(pool, `DELETE FROM ${t}`);
    await q(pool, "INSERT INTO designation VALUES (1, 'Staff'), (2, 'Store Manager')");
    await q(pool, "INSERT INTO attendance_approval_role VALUES (2, 'STORE_MANAGER', 'MANAGER')");
    await q(pool, "INSERT INTO outlets VALUES (3, 'DN3'), (4, 'DN4')");
    await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id, designation_id) VALUES ?", [[
      [EMP, "Staff A", 3, 1], [EMP2, "Staff B", 3, 1], [EMP3, "Staff C", 3, 1], [ADMIN, "Admin", 1, null],
      [11, "First", 3, 1], [22, "Second", 3, 1], [33, "Final", 1, 1], [SM3, "Manager DN3", 3, 2], [SM4, "Manager DN4", 4, 2],
    ]]);
  });

  /** A request and its chain. Steps: [approver, level, decision, decided_by, remarks]. */
  const seed = async ({ id, type = "OT", emp = EMP, date = DATE, status, stage, approvedOt = null, finalization = "NOT_REQUIRED", closure = null, steps, roleSteps = null }) => {
    const chain = roleSteps || steps;
    await q(
      pool,
      `INSERT INTO attendance_approval_request
         (attendance_approval_request_id, request_type, requested_for_employee_id, requested_by_employee_id,
          attendance_date, outlet_id, reason, candidate_ot_minutes, approved_ot_minutes, status, current_stage_no,
          total_stages, finalization_state, closure_reason, chain_source, requested_work_shift_id, base_work_shift_id, decided_at)
       VALUES (?, ?, ?, ?, ?, 3, 'worked late', 180, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, type, emp, emp, date, approvedOt, status, stage, chain.length, finalization, closure,
        roleSteps ? "ROLE" : "EMPLOYEE", type === "SHIFT_CHANGE" ? 2 : null, type === "SHIFT_CHANGE" ? 1 : null,
        status === "PENDING" ? null : "2026-09-11 10:00:00.000"]
    );
    await q(
      pool,
      `INSERT INTO attendance_approval_step
         (attendance_approval_request_id, stage_no, approver_role, outlet_id, approver_employee_id, approval_level,
          decision, decided_by_employee_id, decided_at, remarks, decision_source)
       VALUES ?`,
      [roleSteps
        ? roleSteps.map(([role, outlet, decision], i) => [id, i + 1, role, outlet, null, null, decision, null, null, null, null])
        : steps.map(([approver, level, decision, by, remarks], i) => [
          id, i + 1, "EMPLOYEE", null, approver, level, decision,
          decision === "PENDING" ? null : by,
          decision === "PENDING" ? null : `2026-09-11 0${i + 1}:00:00.000`,
          decision === "PENDING" ? null : remarks || null,
          decision === "PENDING" ? null : "WEB",
        ])]
    );
  };
  const PENDING_FINAL = [[33, "FINAL", "PENDING"]];
  const APPROVED_FINAL = [[33, "FINAL", "APPROVED", 33, "ok"]];
  const REJECTED_FINAL = [[33, "FINAL", "REJECTED", 33, "not worked"]];

  const approver = (employeeId, userType = 1) => ({ employee_id: employeeId, user_type: userType, user_id: employeeId + 10000 });
  const adminRevoker = { employee_id: ADMIN, user_id: 7, user_type: 2 };
  const bulk = (args) =>
    usecase.bulkAction({ actor: args.actor || approver(33), revoke_actor: args.revoke_actor || null, ...args });

  const request = async (id) => {
    const [r] = await q(pool, "SELECT status, current_stage_no, approved_ot_minutes, open_attendance_date FROM attendance_approval_request WHERE attendance_approval_request_id = ?", [id]);
    return r;
  };
  const steps = async (id) =>
    (await q(pool, "SELECT stage_no, decision, decided_by_employee_id, remarks, decision_source FROM attendance_approval_step WHERE attendance_approval_request_id = ? ORDER BY stage_no", [id]))
      .map((s) => [s.stage_no, s.decision, s.decided_by_employee_id, s.remarks]);
  const log = async () => q(pool, "SELECT * FROM attendance_approval_bulk_action_item ORDER BY attendance_approval_bulk_action_item_id");
  const revocations = async (id) => q(pool, "SELECT * FROM attendance_approval_revocation WHERE attendance_approval_request_id = ?", [id]);
  const byId = (out) => Object.fromEntries(out.results.map((r) => [r.request_id, r]));

  it("1. bulk APPROVE of several valid Pending requests: each finally approved through the single-record transaction", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await seed({ id: 101, emp: EMP2, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await seed({ id: 102, emp: EMP3, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    const out = await bulk({ action: "APPROVE", request_type: "OT", items: [{ request_id: 100, current_stage_no: 1 }, { request_id: 101 }, { request_id: 102 }] });
    assert.deepEqual(out.summary, { requested: 3, succeeded: 3, skipped: 0, failed: 0 });
    for (const id of [100, 101, 102]) {
      /* eslint-disable no-await-in-loop */
      assert.equal((await request(id)).status, "APPROVED");
      assert.equal((await request(id)).approved_ot_minutes, 180, "clamped to the engine's eligible, as a single approval");
      assert.deepEqual(await steps(id), [[1, "APPROVED", 33, null]]);
      /* eslint-enable no-await-in-loop */
    }
    const days = await q(pool, "SELECT employee_id, approved_ot_minutes FROM attendance_day_calculation ORDER BY employee_id");
    assert.deepEqual(days.map((d) => [d.employee_id, d.approved_ot_minutes]), [[EMP, 180], [EMP2, 180], [EMP3, 180]], "each day stored in its own decision's transaction");
  });

  it("an intermediate stage is passed on, exactly as a single approval would", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: [[11, "FIRST", "PENDING"], [33, "FINAL", "PENDING"]] });
    const out = await bulk({ actor: approver(11), action: "APPROVE", request_type: "OT", items: [{ request_id: 100, current_stage_no: 1 }] });
    assert.equal(out.results[0].new_status, "PENDING");
    assert.equal(out.results[0].message, "Passed to the next stage");
    const r = await request(100);
    assert.deepEqual([r.status, r.current_stage_no, r.approved_ot_minutes], ["PENDING", 2, null]);
    assert.deepEqual(await steps(100), [[1, "APPROVED", 11, null], [2, "PENDING", null, null]]);
  });

  it("2. bulk REJECT with ONE reason: every request rejected, the reason on EVERY decided step", async () => {
    await seed({ id: 100, type: "REGULARIZATION", status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await seed({ id: 101, type: "REGULARIZATION", emp: EMP2, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    const out = await bulk({ action: "REJECT", request_type: "REGULARIZATION", items: [{ request_id: 100 }, { request_id: 101 }], reason: "no such shift that day" });
    assert.deepEqual(out.summary, { requested: 2, succeeded: 2, skipped: 0, failed: 0 });
    for (const id of [100, 101]) {
      /* eslint-disable no-await-in-loop */
      assert.equal((await request(id)).status, "REJECTED");
      assert.deepEqual(await steps(id), [[1, "REJECTED", 33, "no such shift that day"]]);
      /* eslint-enable no-await-in-loop */
    }
  });

  it("a bulk REJECT without a reason is refused as a whole, before anything is touched", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await assert.rejects(() => bulk({ action: "REJECT", request_type: "OT", items: [{ request_id: 100 }], reason: " " }), /rejection reason/);
    assert.equal((await request(100)).status, "PENDING");
    assert.equal((await log()).length, 0);
  });

  it("3./5. bulk REVOKE of Approved OT: each CANCELLED (back to Request - never Pending), steps untouched, one revocation audit row each", async () => {
    await seed({ id: 100, status: "APPROVED", stage: 1, approvedOt: 95, finalization: "SETTLED", steps: APPROVED_FINAL });
    await seed({ id: 101, emp: EMP2, status: "APPROVED", stage: 1, approvedOt: 60, finalization: "SETTLED", steps: APPROVED_FINAL });
    const out = await bulk({ action: "REVOKE", request_type: "OT", revoke_actor: adminRevoker, items: [{ request_id: 100, status: "APPROVED" }, { request_id: 101, status: "APPROVED" }], reason: "approved by mistake" });
    assert.deepEqual(out.summary, { requested: 2, succeeded: 2, skipped: 0, failed: 0 });
    for (const id of [100, 101]) {
      /* eslint-disable no-await-in-loop */
      const r = await request(id);
      assert.equal(r.status, "CANCELLED", "voided - NOT sent back to Pending");
      assert.equal(r.open_attendance_date, null, "the date is free for a fresh request");
      assert.equal(r.approved_ot_minutes, 0);
      assert.deepEqual(await steps(id), [[1, "APPROVED", 33, "ok"]], "the chain keeps its decision");
      const audit = await revocations(id);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].reason, "approved by mistake");
      assert.equal(audit[0].original_decision, "APPROVED");
      assert.equal(audit[0].revoked_by_employee_id, ADMIN);
      /* eslint-enable no-await-in-loop */
    }
    // "Request": nothing blocks the date, so the engine reads it Not Requested
    // and a FRESH OT can be raised - a new id and a new chain.
    assert.deepEqual(await calcRepo.getApprovalStateByDate(EMP, DATE, DATE), []);
    const created = await repo.createRequest({
      request: { request_type: "OT", requested_for_employee_id: EMP, requested_by_employee_id: EMP, attendance_date: DATE, outlet_id: 3, requester_class: "STORE_EMPLOYEE", reason: "again", candidate_ot_minutes: 180, auto_created: false, chain_source: "EMPLOYEE" },
      chain: [{ stage_no: 1, approver_role: "EMPLOYEE", outlet_id: null, approver_employee_id: 33, approval_level: "FINAL" }],
      punch: null,
    });
    assert.ok(Number(created.attendance_approval_request_id) > 101);
    // The day handed to each revoke transaction was the day WITHOUT that request.
    assert.deepEqual(engineCalls.filter((c) => c.exclude_request_id).map((c) => c.exclude_request_id), [100, 101]);
  });

  it("4./6. bulk REVOKE of Rejected OT: CANCELLED too (back to Request), the rejection kept on its step", async () => {
    await seed({ id: 100, status: "REJECTED", stage: 1, finalization: "SETTLED", steps: REJECTED_FINAL });
    await seed({ id: 101, emp: EMP2, status: "REJECTED", stage: 1, finalization: "SETTLED", steps: REJECTED_FINAL });
    const out = await bulk({ action: "REVOKE", request_type: "OT", revoke_actor: adminRevoker, items: [{ request_id: 100, status: "REJECTED" }, { request_id: 101, status: "REJECTED" }], reason: "rejected in error" });
    assert.deepEqual(out.summary, { requested: 2, succeeded: 2, skipped: 0, failed: 0 });
    for (const id of [100, 101]) {
      /* eslint-disable no-await-in-loop */
      assert.equal((await request(id)).status, "CANCELLED");
      assert.deepEqual(await steps(id), [[1, "REJECTED", 33, "not worked"]]);
      assert.equal((await revocations(id))[0].original_decision, "REJECTED");
      /* eslint-enable no-await-in-loop */
    }
  });

  it("14. Attendance revoke is unchanged (CANCELLED, punch no longer effective); a Shift decision is still NOT revocable", async () => {
    await seed({ id: 100, type: "REGULARIZATION", status: "APPROVED", stage: 1, finalization: "SETTLED", steps: APPROVED_FINAL });
    await q(pool, "INSERT INTO attendance_regularized_punch (attendance_approval_request_id, employee_id, attendance_date, punch_time, created_by) VALUES (100, ?, ?, ?, ?)", [EMP, DATE, `${DATE} 18:00:00`, EMP]);
    await seed({ id: 101, type: "SHIFT_CHANGE", emp: EMP2, status: "APPROVED", stage: 1, finalization: "SETTLED", steps: APPROVED_FINAL });
    const att = await bulk({ action: "REVOKE", request_type: "REGULARIZATION", revoke_actor: adminRevoker, items: [{ request_id: 100 }], reason: "wrong punch" });
    assert.equal(att.results[0].outcome, "SUCCEEDED");
    assert.equal((await request(100)).status, "CANCELLED");
    assert.deepEqual(await calcRepo.getApprovedRegularizedPunches(EMP, DATE, DATE), []);

    const shift = await bulk({ action: "REVOKE", request_type: "SHIFT_CHANGE", revoke_actor: adminRevoker, items: [{ request_id: 101 }], reason: "wrong shift" });
    assert.equal(shift.results[0].outcome, "SKIPPED");
    assert.match(shift.results[0].message, /shift change decision cannot be revoked/);
    assert.equal((await request(101)).status, "APPROVED", "the Shift rule is not changed to suit bulk");
    assert.equal((await revocations(101)).length, 0);
  });

  it("bulk APPROVE on the Shift tab runs the single Shift approval: the one-day override is written with it", async () => {
    await seed({ id: 100, type: "SHIFT_CHANGE", status: "PENDING", stage: 1, steps: PENDING_FINAL });
    const out = await bulk({ action: "APPROVE", request_type: "SHIFT_CHANGE", items: [{ request_id: 100 }] });
    assert.equal(out.results[0].outcome, "SUCCEEDED");
    const overrides = await q(pool, "SELECT employee_id, work_shift_id, attendance_approval_request_id FROM attendance_date_shift_override");
    assert.deepEqual(overrides.map((o) => [o.employee_id, o.work_shift_id, Number(o.attendance_approval_request_id)]), [[EMP, 2, 100]]);
  });

  it("7. a payroll-LOCKED month is SKIPPED with the reason; the rest of the batch still completes", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await seed({ id: 101, emp: EMP2, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'APPROVED_LOCKED')", [EMP2]);
    const out = await bulk({ action: "APPROVE", request_type: "OT", items: [{ request_id: 100 }, { request_id: 101 }] });
    assert.deepEqual(out.summary, { requested: 2, succeeded: 1, skipped: 1, failed: 0 });
    assert.equal(byId(out)[101].code, "PAYROLL_LOCKED");
    assert.match(byId(out)[101].message, /payroll for 09\/2026 is approved and locked/);
    assert.equal((await request(100)).status, "APPROVED");
    assert.equal((await request(101)).status, "PENDING", "untouched");

    // Revoke too.
    await seed({ id: 102, emp: EMP2, date: "2026-09-12", status: "APPROVED", stage: 1, approvedOt: 30, finalization: "SETTLED", steps: APPROVED_FINAL });
    const rv = await bulk({ action: "REVOKE", request_type: "OT", revoke_actor: adminRevoker, items: [{ request_id: 102 }], reason: "approved by mistake" });
    assert.equal(rv.results[0].code, "PAYROLL_LOCKED");
    assert.equal((await request(102)).status, "APPROVED");
  });

  it("8. OUT-OF-BRANCH: a Store Manager cannot bulk-approve another outlet's request, and can approve their own outlet's", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, roleSteps: [["STORE_MANAGER", 3, "PENDING"]] });
    const other = await bulk({ actor: approver(SM4), action: "APPROVE", request_type: "OT", items: [{ request_id: 100 }] });
    assert.equal(other.results[0].outcome, "SKIPPED");
    assert.equal(other.results[0].code, "NOT_PERMITTED");
    assert.match(other.results[0].message, /only decide requests from their own outlet/);
    assert.equal((await request(100)).status, "PENDING");
    const own = await bulk({ actor: approver(SM3), action: "APPROVE", request_type: "OT", items: [{ request_id: 100 }] });
    assert.equal(own.results[0].outcome, "SUCCEEDED");
  });

  it("9. PERMISSION: an approver who is not the stage's approver, and one acting on their OWN request, are refused per record", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await seed({ id: 101, emp: 22, status: "PENDING", stage: 1, steps: [[22, "FINAL", "PENDING"]] });
    const out = await bulk({ actor: approver(22), action: "APPROVE", request_type: "OT", items: [{ request_id: 100 }, { request_id: 101 }] });
    assert.equal(byId(out)[100].code, "NOT_PERMITTED");
    assert.match(byId(out)[100].message, /assigned approver/);
    assert.equal(byId(out)[101].code, "NOT_PERMITTED");
    assert.match(byId(out)[101].message, /your own attendance/);
    assert.equal((await request(100)).status, "PENDING");
    assert.equal((await request(101)).status, "PENDING");
    // And a non-administrator can never revoke, in bulk either.
    await assert.rejects(
      () => bulk({ action: "REVOKE", request_type: "OT", revoke_actor: { employee_id: 33, user_type: 1 }, items: [{ request_id: 100 }], reason: "approved by mistake" }),
      (err) => err.name === "ForbiddenError"
    );
  });

  it("a SHIFT_CHANGE id sent under the OT tab is refused - the tab's type is checked against the stored request", async () => {
    await seed({ id: 100, type: "SHIFT_CHANGE", status: "PENDING", stage: 1, steps: PENDING_FINAL });
    const out = await bulk({ action: "APPROVE", request_type: "OT", items: [{ request_id: 100 }] });
    assert.equal(out.results[0].code, "WRONG_TYPE");
    assert.equal((await request(100)).status, "PENDING");
  });

  it("10. a MIXED batch: valid, locked, not permitted, already decided, unknown - partial success, nothing rolled back", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await seed({ id: 101, emp: EMP2, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await seed({ id: 102, emp: EMP3, status: "PENDING", stage: 1, steps: [[11, "FINAL", "PENDING"]] });
    await seed({ id: 103, emp: EMP, date: "2026-09-12", status: "APPROVED", stage: 1, approvedOt: 10, finalization: "SETTLED", steps: APPROVED_FINAL });
    await seed({ id: 104, emp: EMP3, date: "2026-09-13", status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'APPROVED_LOCKED')", [EMP2]);
    const out = await bulk({ action: "APPROVE", request_type: "OT", items: [100, 101, 102, 103, 999, 104].map((id) => ({ request_id: id })) });
    assert.deepEqual(out.summary, { requested: 6, succeeded: 2, skipped: 3, failed: 1 });
    const r = byId(out);
    assert.equal(r[100].outcome, "SUCCEEDED");
    assert.equal(r[101].code, "PAYROLL_LOCKED");
    assert.equal(r[102].code, "NOT_PERMITTED");
    assert.equal(r[103].code, "STATE_CHANGED");
    assert.equal(r[103].outcome, "FAILED");
    assert.equal(r[999].code, "NOT_FOUND");
    assert.equal(r[104].outcome, "SUCCEEDED", "a refusal earlier in the batch does not stop the later ones");
    assert.equal((await request(100)).status, "APPROVED", "a success stays done");
    assert.equal((await request(104)).status, "APPROVED");
  });

  it("11. CONCURRENCY: a request decided by somebody else after it was loaded is NOT overwritten", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: [[11, "FIRST", "PENDING"], [33, "FINAL", "PENDING"]] });
    // The screen loaded it at stage 1; approver 11 then approves stage 1 elsewhere.
    await usecase.decide({ actor: approver(11), request_id: 100, decision: "APPROVED" });
    // The administrator's bulk approval was for stage 1 - stage 2 was never shown.
    const out = await bulk({ actor: approver(ADMIN, 2), action: "APPROVE", request_type: "OT", items: [{ request_id: 100, current_stage_no: 1 }] });
    assert.equal(out.results[0].outcome, "FAILED");
    assert.equal(out.results[0].code, "STATE_CHANGED");
    assert.deepEqual(await steps(100), [[1, "APPROVED", 11, null], [2, "PENDING", null, null]], "stage 2 not decided behind the approver's back");

    // Rejected elsewhere after a revoke was selected against its APPROVED state.
    await seed({ id: 101, emp: EMP2, status: "APPROVED", stage: 1, approvedOt: 60, finalization: "SETTLED", steps: APPROVED_FINAL });
    await bulk({ action: "REVOKE", request_type: "OT", revoke_actor: adminRevoker, items: [{ request_id: 101 }], reason: "first revoke" });
    const again = await bulk({ action: "REVOKE", request_type: "OT", revoke_actor: adminRevoker, items: [{ request_id: 101, status: "APPROVED" }], reason: "second revoke" });
    assert.equal(again.results[0].code, "STATE_CHANGED");
    assert.equal((await revocations(101)).length, 1, "revoked once, not twice");
  });

  it("11. RACE: two bulk approvals of the same requests at once decide each request exactly once", async () => {
    const ids = [100, 101, 102, 103];
    for (const [i, id] of ids.entries()) {
      /* eslint-disable-next-line no-await-in-loop */
      await seed({ id, emp: [EMP, EMP2, EMP3, 11][i], status: "PENDING", stage: 1, steps: PENDING_FINAL });
    }
    const items = ids.map((id) => ({ request_id: id, current_stage_no: 1 }));
    const [a, b] = await Promise.all([
      bulk({ action: "APPROVE", request_type: "OT", items }),
      bulk({ actor: approver(ADMIN, 2), action: "REJECT", request_type: "OT", items, reason: "duplicate claim" }),
    ]);
    for (const id of ids) {
      const outcomes = [byId(a)[id].outcome, byId(b)[id].outcome].sort();
      assert.deepEqual(outcomes, ["FAILED", "SUCCEEDED"], `request ${id}: exactly one of the two decided it`);
      /* eslint-disable-next-line no-await-in-loop */
      const decided = (await steps(id)).filter((s) => s[1] !== "PENDING");
      assert.equal(decided.length, 1);
    }
  });

  it("12. AUDIT: one log row PER RECORD (never one per batch), with employee, statuses, action, actor, time, reason and the operation id", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await seed({ id: 101, emp: EMP2, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'APPROVED_LOCKED')", [EMP2]);
    const out = await bulk({ action: "REJECT", request_type: "OT", items: [{ request_id: 100 }, { request_id: 101 }], reason: "not authorised" });
    const rows = await log();
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.bulk_operation_id, out.bulk_operation_id);
      assert.equal(row.action, "REJECT");
      assert.equal(row.reason, "not authorised");
      assert.equal(row.acted_by_employee_id, 33);
      assert.equal(row.acted_by_user_id, 10033);
      assert.ok(row.acted_at);
      assert.equal(row.request_type, "OT");
      assert.equal(row.previous_status, "PENDING");
    }
    const [first] = rows;
    assert.equal(Number(first.attendance_approval_request_id), 100);
    assert.equal(first.requested_for_employee_id, EMP);
    assert.equal(first.new_status, "REJECTED");
    assert.equal(first.outcome, "SUCCEEDED");
    assert.equal(first.outcome_reason, null);
    // A SKIPPED record is logged too, with why. (The single decision's
    // transaction refuses ANY decision in a locked month - a rejection
    // included - and bulk inherits exactly that.)
    assert.equal(Number(rows[1].attendance_approval_request_id), 101);
    assert.equal(rows[1].outcome, "SKIPPED");
    assert.equal(rows[1].new_status, null);
    assert.match(rows[1].outcome_reason, /payroll for this month is approved and locked/);
    assert.equal((await request(101)).status, "PENDING");
    // The request's own history is written exactly as a single decision's.
    assert.deepEqual(await steps(100), [[1, "REJECTED", 33, "not authorised"]]);
    assert.deepEqual(out.results.map((r) => r.logged), [true, true]);
  });

  it("13. the single-record actions are unchanged and share the same code path", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    const single = await usecase.decide({ actor: approver(33), request_id: 100, decision: "APPROVED" });
    assert.equal(single.code, 200);
    assert.equal(single.status, "APPROVED");
    const revoked = await usecase.revokeDecision({ actor: adminRevoker, request_id: 100, reason: "approved by mistake" });
    assert.equal(revoked.status, "CANCELLED");
    assert.equal((await log()).length, 0, "a single action writes no bulk log row");
  });

  it("SELECT ALL MATCHING: the targets are the caller's actionable / revocable rows under the same scope as the list", async () => {
    await seed({ id: 100, status: "PENDING", stage: 1, steps: PENDING_FINAL });
    await seed({ id: 101, emp: EMP2, status: "PENDING", stage: 1, steps: [[11, "FINAL", "PENDING"]] });
    await seed({ id: 102, emp: EMP3, status: "APPROVED", stage: 1, approvedOt: 5, finalization: "SETTLED", steps: APPROVED_FINAL });
    await seed({ id: 103, emp: EMP3, date: "2026-09-12", status: "REJECTED", stage: 1, finalization: "SETTLED", closure: "NOT_APPROVED_BEFORE_PAYROLL_LOCK", steps: REJECTED_FINAL });
    const all = { kind: "ALL_BRANCHES" };
    const mine = await usecase.listBulkTargets({ actor: { ...approver(33), branch_scope: all }, request_type: "OT", status: "PENDING", action: "APPROVE" });
    assert.deepEqual(mine.items.map((i) => i.request_id), [100], "only the stage this approver may decide");
    assert.deepEqual(mine.items[0], { request_id: 100, current_stage_no: 1, status: "PENDING" });

    const revoke = await usecase.listBulkTargets({ actor: { employee_id: ADMIN, user_type: 2, branch_scope: all }, request_type: "OT", status: "APPROVED", action: "REVOKE" });
    assert.deepEqual(revoke.items.map((i) => i.request_id), [102]);
    const rejected = await usecase.listBulkTargets({ actor: { employee_id: ADMIN, user_type: 2, branch_scope: all }, request_type: "OT", status: "REJECTED", action: "REVOKE" });
    assert.deepEqual(rejected.items, [], "a payroll-lock closure is not revocable");
    const nonAdmin = await usecase.listBulkTargets({ actor: { ...approver(33), branch_scope: all }, request_type: "OT", status: "APPROVED", action: "REVOKE" });
    assert.deepEqual(nonAdmin.items, [], "nothing to revoke for a non-administrator");
    const shift = await usecase.listBulkTargets({ actor: { employee_id: ADMIN, user_type: 2, branch_scope: all }, request_type: "SHIFT_CHANGE", status: "APPROVED", action: "REVOKE" });
    assert.deepEqual(shift.items, [], "Shift is not revocable");
    // Out of scope: an OWN_BRANCHES actor of another outlet sees nothing to select.
    const outside = await usecase.listBulkTargets({ actor: { ...approver(33), branch_scope: { kind: "OWN_BRANCHES", store_ids: [4] } }, request_type: "OT", status: "PENDING", action: "APPROVE" });
    assert.ok(outside.items.every((i) => i.request_id === 100), "authority still reaches the assigned approver's own stage");
  });
});
