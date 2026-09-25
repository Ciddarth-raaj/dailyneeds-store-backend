/**
 * ADMIN REVOKE of a one-day SHIFT change, AS REAL SQL - the production
 * repository and approval usecase, single and bulk.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_shift_revoke.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * THE RULE UNDER TEST.
 *   APPROVED Shift -> Revoke -> CANCELLED. Its override row is KEPT as
 *     history and stops applying: the production override readers (the
 *     engine's, the dashboard's) no longer return it, so the date resolves to
 *     the permanent shift and the OT that shift authorised is gone. Refused
 *     while any OT decision stands on the date.
 *   REJECTED Shift -> Revoke -> REOPENED: PENDING again at the rejecting
 *     stage, earlier approvals kept, back in that approver's queue. Refused
 *     beside another open or approved shift request for the date.
 *   Both: payroll-locked month refused; one audit row recording who, when,
 *   why, the state before and the state after.
 *
 * The ENGINE is stubbed (a closed day) - what a revoked Shift day calculates
 * to is proven on the production engine in
 * usecase/shift_assignment_and_one_day_requests.test.js (F.).
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");
const buildCalcRepo = require("./attendance_calculation");
const buildDashboardRepo = require("./attendance_dashboard");
const buildRegularization = require("../usecase/attendance_regularization");
const { CALCULATION_COLUMNS } = require("./attendance_calculation");

const EMP = 501;
const EMP2 = 502;
const EMP3 = 503;
const ADMIN = { employee_id: 900, user_id: 7, user_type: 2 };
const DATE = "2026-09-10";
const BASE = 1;
const LONG = 2;

const SQL_DIR = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const MIGRATIONS = [
  "20261103120000-attendance-approval-revocation-up.sql",
  "20261105120000-attendance-approval-bulk-action-up.sql",
  "20261106120000-attendance-approval-revocation-outcome-up.sql",
].map((f) => path.join(SQL_DIR, f));

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
     source ENUM('DIRECT','APPROVED_REQUEST') NOT NULL DEFAULT 'DIRECT', reason VARCHAR(500) NULL,
     created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
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
  "attendance_shift_change_block",
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

const OUTCOME_MIGRATION = path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20261106120000-attendance-approval-revocation-outcome-up.sql");

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("Shift revoke, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  let calcRepo;
  let dashboardRepo;
  let usecase;
  const engineCalls = [];

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=6&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    for (const m of MIGRATIONS) await q(pool, fs.readFileSync(m, "utf8"));
    // The HR block table, as production has it (only the columns the reopen reads).
    await q(pool, "CREATE TABLE attendance_shift_change_block (attendance_shift_change_block_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, employee_id INT NOT NULL, attendance_date DATE NOT NULL, reason VARCHAR(500) NOT NULL, removed_at TIMESTAMP(3) NULL) ENGINE=InnoDB");
    repo = buildRepo(pool);
    calcRepo = buildCalcRepo(pool);
    dashboardRepo = buildDashboardRepo(pool);
    // The engine, stubbed: the shift it resolves is the one the PRODUCTION
    // override reader returns for the date - so a withdrawn override really
    // does change the day this suite stores.
    const engine = {
      findPayrollLockedPeriods: (rows) => calcRepo.findPayrollLockedPeriods(rows),
      attendanceDayState: () => ({ closed: true, reason: null, closes_at: null }),
      calculateRange: async (args) => {
        engineCalls.push(args);
        const overrides = (await calcRepo.getDateShiftOverrides(args.employee_id, args.from_date, args.to_date))
          .filter((o) => Number(o.attendance_approval_request_id) !== Number(args.exclude_request_id));
        const top = overrides[overrides.length - 1] || null;
        const authorised = top && Number(top.shift_change_approved) === 1 ? 300 : 0;
        return [{
          employee_id: args.employee_id, attendance_date: args.from_date, shift_snapshot: null,
          work_shift_id: top ? Number(top.work_shift_id) : BASE, punch_count: 2,
          shift_authorised_ot_minutes: authorised, approved_ot_minutes: authorised,
          shift_authorising_request_id: authorised ? Number(top.attendance_approval_request_id) : null,
        }];
      },
      toStorageRow: (d) => ({
        employee_id: d.employee_id, attendance_date: d.attendance_date, work_shift_id: d.work_shift_id,
        approved_ot_minutes: d.approved_ot_minutes, shift_authorised_ot_minutes: d.shift_authorised_ot_minutes,
        shift_authorising_request_id: d.shift_authorising_request_id, punch_count: d.punch_count, status: "FINAL", is_final: 1,
      }),
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
    await q(pool, "INSERT INTO designation VALUES (1, 'Staff')");
    await q(pool, "INSERT INTO outlets VALUES (3, 'DN3')");
    await q(pool, "INSERT INTO work_shift VALUES (1, 'BASE', 'Base'), (2, 'LONG', 'Long')");
    await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id, designation_id) VALUES ?", [[
      [EMP, "Staff A", 3, 1], [EMP2, "Staff B", 3, 1], [EMP3, "Staff C", 3, 1], [900, "Admin", 1, null], [11, "First", 3, 1], [33, "Final", 1, 1],
    ]]);
  });

  /** A request with an employee-level chain; an APPROVED Shift also gets its override row. */
  const seed = async ({ id, type = "SHIFT_CHANGE", emp = EMP, date = DATE, status, stage, steps, closure = null }) => {
    await q(
      pool,
      `INSERT INTO attendance_approval_request
         (attendance_approval_request_id, request_type, requested_for_employee_id, requested_by_employee_id,
          attendance_date, outlet_id, reason, candidate_ot_minutes, approved_ot_minutes, status, current_stage_no,
          total_stages, finalization_state, closure_reason, chain_source, requested_work_shift_id, base_work_shift_id, decided_at)
       VALUES (?, ?, ?, ?, ?, 3, 'covering', 0, ?, ?, ?, ?, ?, ?, 'EMPLOYEE', ?, ?, ?)`,
      [id, type, emp, emp, date, status === "APPROVED" ? 0 : null, status, stage, steps.length,
        status === "PENDING" ? "NOT_REQUIRED" : "SETTLED", closure,
        type === "SHIFT_CHANGE" ? LONG : null, type === "SHIFT_CHANGE" ? BASE : null,
        status === "PENDING" ? null : "2026-09-11 10:00:00.000"]
    );
    await q(
      pool,
      `INSERT INTO attendance_approval_step
         (attendance_approval_request_id, stage_no, approver_role, approver_employee_id, approval_level,
          decision, decided_by_employee_id, decided_at, remarks, decision_source)
       VALUES ?`,
      [steps.map(([approver, level, decision, remarks], i) => [
        id, i + 1, "EMPLOYEE", approver, level, decision,
        decision === "PENDING" ? null : approver,
        decision === "PENDING" ? null : `2026-09-11 0${i + 1}:00:00.000`,
        decision === "PENDING" ? null : remarks || null,
        decision === "PENDING" ? null : "WEB",
      ])]
    );
    if (type === "SHIFT_CHANGE" && status === "APPROVED") {
      const r = await q(pool,
        `INSERT INTO attendance_date_shift_override (employee_id, attendance_date, work_shift_id, previous_work_shift_id, changed_by, attendance_approval_request_id, source, reason)
         VALUES (?, ?, ?, ?, 33, ?, 'APPROVED_REQUEST', 'covering')`, [emp, date, LONG, BASE, id]);
      return Number(r.insertId);
    }
    return null;
  };
  const APPROVED2 = [[11, "FIRST", "APPROVED", "ok"], [33, "FINAL", "APPROVED", "fine"]];
  const REJECTED2 = [[11, "FIRST", "APPROVED", "ok"], [33, "FINAL", "REJECTED", "not needed that day"]];

  const request = async (id) => (await q(pool, "SELECT status, current_stage_no, finalization_state, decided_at, open_attendance_date FROM attendance_approval_request WHERE attendance_approval_request_id = ?", [id]))[0];
  const steps = async (id) =>
    (await q(pool, "SELECT stage_no, decision, decided_by_employee_id, remarks FROM attendance_approval_step WHERE attendance_approval_request_id = ? ORDER BY stage_no", [id]))
      .map((s) => [s.stage_no, s.decision, s.decided_by_employee_id, s.remarks]);
  const audit = async (id) => q(pool, "SELECT * FROM attendance_approval_revocation WHERE attendance_approval_request_id = ?", [id]);
  const day = async (emp = EMP) => (await q(pool, "SELECT work_shift_id, approved_ot_minutes, shift_authorised_ot_minutes, shift_authorising_request_id FROM attendance_day_calculation WHERE employee_id = ? AND attendance_date = ?", [emp, DATE]))[0] || null;
  const revoke = (id, extra = {}) => usecase.revokeDecision({ actor: ADMIN, request_id: id, reason: "decided in error", ...extra });

  it("1./5./6./7. APPROVED Shift -> CANCELLED: the override is KEPT but no reader applies it; the day is stored on the permanent shift with no authorised OT", async () => {
    const overrideId = await seed({ id: 100, status: "APPROVED", stage: 2, steps: APPROVED2 });
    assert.equal((await calcRepo.getDateShiftOverrides(EMP, DATE, DATE)).length, 1, "sanity: the approved override applies");
    assert.equal(Number((await calcRepo.getDateShiftOverrides(EMP, DATE, DATE))[0].shift_change_approved), 1);

    const out = await revoke(100);
    assert.equal(out.code, 200);
    assert.equal(out.status, "CANCELLED");
    assert.deepEqual(out.withdrawn_override_ids, [overrideId]);
    const r = await request(100);
    assert.equal(r.status, "CANCELLED");
    assert.equal(r.open_attendance_date, null);
    assert.deepEqual(await steps(100), [[1, "APPROVED", 11, "ok"], [2, "APPROVED", 33, "fine"]], "the chain is history, untouched");

    // 5. The row is still there - and the production readers skip it.
    const rows = await q(pool, "SELECT attendance_date_shift_override_id, work_shift_id, attendance_approval_request_id FROM attendance_date_shift_override");
    assert.deepEqual(rows.map((o) => Number(o.attendance_date_shift_override_id)), [overrideId], "never deleted");
    assert.deepEqual(await calcRepo.getDateShiftOverrides(EMP, DATE, DATE), [], "the engine's reader");
    assert.deepEqual(await dashboardRepo.getDateShiftOverridesForEmployees([EMP], DATE, DATE), [], "the dashboard's reader");

    // 6./7. The day, recalculated WITHOUT the request, stored in the same transaction.
    assert.equal(engineCalls[0].exclude_request_id, 100);
    const d = await day();
    assert.deepEqual(
      [Number(d.work_shift_id), Number(d.approved_ot_minutes), Number(d.shift_authorised_ot_minutes), d.shift_authorising_request_id],
      [BASE, 0, 0, null],
      "the permanent shift, no approved OT, no shift-authorised OT, no authorising request"
    );
  });

  it("5. only THAT approval's override stops applying: a direct management edit, and another employee's approved shift, still apply", async () => {
    await seed({ id: 100, status: "APPROVED", stage: 2, steps: APPROVED2 });
    await seed({ id: 101, emp: EMP2, status: "APPROVED", stage: 2, steps: APPROVED2 });
    await q(pool, "INSERT INTO attendance_date_shift_override (employee_id, attendance_date, work_shift_id, previous_work_shift_id, changed_by, source) VALUES (?, '2026-09-12', ?, ?, 33, 'DIRECT')", [EMP, LONG, BASE]);
    await revoke(100);
    assert.deepEqual((await calcRepo.getDateShiftOverrides(EMP, DATE, "2026-09-12")).map((o) => [o.attendance_date, o.source]), [["2026-09-12", "DIRECT"]]);
    assert.equal((await calcRepo.getDateShiftOverrides(EMP2, DATE, DATE)).length, 1);
    assert.equal((await dashboardRepo.getDateShiftOverridesForEmployees([EMP, EMP2], DATE, "2026-09-12")).length, 2);
  });

  it("2. REJECTED Shift -> REOPENED at the rejecting stage: PENDING, earlier approval kept, back in the Final approver's queue", async () => {
    await seed({ id: 100, status: "REJECTED", stage: 2, steps: REJECTED2 });
    const out = await revoke(100);
    assert.equal(out.status, "PENDING");
    assert.equal(out.reopened_stage_no, 2);
    const r = await request(100);
    assert.deepEqual([r.status, r.current_stage_no, r.finalization_state, r.decided_at], ["PENDING", 2, "NOT_REQUIRED", null]);
    assert.ok(r.open_attendance_date, "an open request for the date again");
    assert.deepEqual(await steps(100), [[1, "APPROVED", 11, "ok"], [2, "PENDING", null, null]]);
    const pending = await repo.countApprovals({ request_type: ["SHIFT_CHANGE"], status: "PENDING", approver_roles: [], outlet_id: 1, actor_employee_id: 33, is_admin: false, permitted_outlet_ids: null });
    assert.equal(pending, 1, "the Final approver can act on it again");
    // ...and does: approving it now writes the override exactly as a first approval would.
    const decided = await usecase.decide({ actor: { employee_id: 33, user_type: 1 }, request_id: 100, decision: "APPROVED" });
    assert.equal(decided.status, "APPROVED");
    assert.equal((await calcRepo.getDateShiftOverrides(EMP, DATE, DATE)).length, 1);
  });

  it("10. AUDIT: who revoked, when, why, the state before and the state after - for both outcomes", async () => {
    const overrideId = await seed({ id: 100, status: "APPROVED", stage: 2, steps: APPROVED2 });
    await seed({ id: 101, emp: EMP2, status: "REJECTED", stage: 2, steps: REJECTED2 });
    await revoke(100, { reason: "approved in error" });
    await revoke(101, { reason: "rejected in error" });
    const [a] = await audit(100);
    assert.equal(a.request_type, "SHIFT_CHANGE");
    assert.equal(a.revoked_by_employee_id, 900);
    assert.equal(a.revoked_by_user_id, 7);
    assert.ok(a.revoked_at);
    assert.equal(a.reason, "approved in error");
    assert.equal(a.original_request_status, "APPROVED");
    assert.equal(a.original_decision, "APPROVED");
    assert.equal(a.original_decided_by_employee_id, 33);
    assert.equal(a.new_request_status, "CANCELLED");
    assert.equal(a.reopened_stage_no, null);
    const withdrawn = typeof a.withdrawn_override_ids === "string" ? JSON.parse(a.withdrawn_override_ids) : a.withdrawn_override_ids;
    assert.deepEqual(withdrawn, [overrideId]);
    const [b] = await audit(101);
    assert.equal(b.reason, "rejected in error");
    assert.equal(b.original_request_status, "REJECTED");
    assert.equal(b.original_decision, "REJECTED");
    assert.equal(b.original_remarks, "not needed that day", "the rejection survives in the audit after its step is reopened");
    assert.equal(b.new_request_status, "PENDING");
    assert.equal(b.reopened_stage_no, 2);
    assert.equal(b.withdrawn_override_ids, null);
  });

  it("an approved Shift is NOT revoked while any OT decision stands on the date - pending, approved or rejected", async () => {
    for (const [i, otStatus] of ["PENDING", "APPROVED", "REJECTED"].entries()) {
      /* eslint-disable no-await-in-loop */
      const shiftId = 100 + i * 10;
      const otId = shiftId + 1;
      const emp = [EMP, EMP2, EMP3][i];
      await seed({ id: shiftId, emp, status: "APPROVED", stage: 2, steps: APPROVED2 });
      await seed({ id: otId, emp, type: "OT", status: otStatus, stage: 1, steps: [[33, "FINAL", otStatus === "PENDING" ? "PENDING" : otStatus]] });
      const out = await revoke(shiftId);
      assert.equal(out.code, 409, otStatus);
      assert.equal(out.reason_code, "DEPENDENT_OT");
      assert.match(out.msg, new RegExp(`${otStatus.toLowerCase()} OT request \\(#${otId}\\) measured against this shift change; revoke that one first`));
      assert.equal((await request(shiftId)).status, "APPROVED");
      assert.equal((await calcRepo.getDateShiftOverrides(emp, DATE, DATE)).length, 1, "the override still applies");
      assert.equal((await audit(shiftId)).length, 0);
      /* eslint-enable no-await-in-loop */
    }
    // Revoke the OT first, then the shift.
    assert.equal((await revoke(111)).status, "CANCELLED");
    assert.equal((await revoke(110)).status, "CANCELLED");
  });

  it("a rejected Shift is NOT reopened beside another open or approved shift request for the date", async () => {
    await seed({ id: 100, status: "REJECTED", stage: 2, steps: REJECTED2 });
    await seed({ id: 101, status: "PENDING", stage: 1, steps: [[11, "FIRST", "PENDING"], [33, "FINAL", "PENDING"]] });
    await assert.rejects(() => revoke(100), /cannot be reopened: A shift change for 2026-09-10 is already pending \(#101\)/);
    // And the transaction refuses it on its own, under lock.
    const snap = await repo.getRevocationSnapshot(100);
    const out = await repo.revokeRequest({
      requestId: 100, stageNo: 2, originalDecision: "REJECTED", expectedFingerprint: snap.fingerprint, employeeId: EMP,
      actor: { employee_id: 900 }, reason: "rejected in error", revocableTypes: usecase.REVOCABLE_TYPES, calculations: [],
    });
    assert.equal(out.code, 409);
    assert.equal(out.reason_code, "CONFLICTING_REQUEST");
    assert.equal((await request(100)).status, "REJECTED");
    assert.equal((await audit(100)).length, 0);
  });

  it("a rejected Shift is NOT reopened on a date HR has blocked - checked again inside the transaction", async () => {
    await seed({ id: 100, status: "REJECTED", stage: 2, steps: REJECTED2 });
    await q(pool, "INSERT INTO attendance_shift_change_block (employee_id, attendance_date, reason) VALUES (?, ?, 'stock count')", [EMP, DATE]);
    const snap = await repo.getRevocationSnapshot(100);
    const out = await repo.revokeRequest({
      requestId: 100, stageNo: 2, originalDecision: "REJECTED", expectedFingerprint: snap.fingerprint, employeeId: EMP,
      actor: { employee_id: 900 }, reason: "rejected in error", revocableTypes: usecase.REVOCABLE_TYPES, calculations: [],
    });
    assert.equal(out.code, 409);
    assert.equal(out.reason_code, "HR_BLOCKED");
    assert.equal((await request(100)).status, "REJECTED");
    await q(pool, "UPDATE attendance_shift_change_block SET removed_at = CURRENT_TIMESTAMP(3)");
    assert.equal((await revoke(100)).status, "PENDING", "a removed block no longer stands in the way");
  });

  it("8. a payroll-LOCKED month: neither outcome is allowed, and nothing changes", async () => {
    await seed({ id: 100, status: "APPROVED", stage: 2, steps: APPROVED2 });
    await seed({ id: 101, emp: EMP2, status: "REJECTED", stage: 2, steps: REJECTED2 });
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'APPROVED_LOCKED'), (?, 2026, 9, 'APPROVED_LOCKED')", [EMP, EMP2]);
    await assert.rejects(() => revoke(100), (err) => err.code === "PAYROLL_MONTH_LOCKED");
    await assert.rejects(() => revoke(101), (err) => err.code === "PAYROLL_MONTH_LOCKED");
    assert.equal((await request(100)).status, "APPROVED");
    assert.equal((await request(101)).status, "REJECTED");
    assert.equal((await calcRepo.getDateShiftOverrides(EMP, DATE, DATE)).length, 1);
    // The transaction refuses it too, whatever the caller checked.
    const snap = await repo.getRevocationSnapshot(100);
    await assert.rejects(
      () => repo.revokeRequest({ requestId: 100, stageNo: 2, originalDecision: "APPROVED", expectedFingerprint: snap.fingerprint, employeeId: EMP, actor: { employee_id: 900 }, reason: "x", revocableTypes: usecase.REVOCABLE_TYPES, calculations: [] }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.equal((await request(100)).status, "APPROVED");
    assert.equal((await audit(100)).length + (await audit(101)).length, 0);
  });

  it("9. an out-of-scope user cannot revoke - single or bulk", async () => {
    await seed({ id: 100, status: "APPROVED", stage: 2, steps: APPROVED2 });
    await assert.rejects(() => revoke(100, { actor: { employee_id: 33, user_type: 1 } }), (err) => err.name === "ForbiddenError");
    await assert.rejects(
      () => usecase.bulkAction({ actor: { employee_id: 33, user_type: 1 }, revoke_actor: { employee_id: 33, user_type: 1 }, action: "REVOKE", request_type: "SHIFT_CHANGE", items: [{ request_id: 100 }], reason: "decided in error" }),
      (err) => err.name === "ForbiddenError"
    );
    assert.equal((await request(100)).status, "APPROVED");
  });

  it("3./4./11. BULK Shift revoke: approved -> CANCELLED, rejected -> reopened, locked and OT-dependent ones SKIPPED with the rule; the rest stand", async () => {
    await seed({ id: 100, status: "APPROVED", stage: 2, steps: APPROVED2 });
    await seed({ id: 101, emp: EMP2, status: "REJECTED", stage: 2, steps: REJECTED2 });
    await seed({ id: 102, emp: EMP3, status: "APPROVED", stage: 2, steps: APPROVED2 });
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'APPROVED_LOCKED')", [EMP3]);
    await seed({ id: 103, emp: EMP, date: "2026-09-12", status: "APPROVED", stage: 2, steps: APPROVED2 });
    await seed({ id: 104, emp: EMP, date: "2026-09-12", type: "OT", status: "APPROVED", stage: 1, steps: [[33, "FINAL", "APPROVED"]] });
    const out = await usecase.bulkAction({
      actor: ADMIN, revoke_actor: ADMIN, action: "REVOKE", request_type: "SHIFT_CHANGE", reason: "decided in error",
      items: [{ request_id: 100, status: "APPROVED" }, { request_id: 101, status: "REJECTED" }, { request_id: 102 }, { request_id: 103 }, { request_id: 104 }],
    });
    const r = Object.fromEntries(out.results.map((x) => [x.request_id, x]));
    assert.deepEqual(out.summary, { requested: 5, succeeded: 2, skipped: 3, failed: 0 });
    assert.deepEqual([r[100].outcome, r[100].new_status], ["SUCCEEDED", "CANCELLED"]);
    assert.deepEqual([r[101].outcome, r[101].new_status], ["SUCCEEDED", "PENDING"]);
    assert.equal(r[102].code, "PAYROLL_LOCKED");
    assert.equal(r[103].code, "DEPENDENT_OT");
    assert.match(r[103].message, /revoke that one first/);
    assert.equal(r[104].code, "WRONG_TYPE", "an OT id under the Shift tab is refused");
    assert.equal((await request(100)).status, "CANCELLED");
    assert.equal((await request(101)).status, "PENDING");
    assert.equal((await request(102)).status, "APPROVED");
    assert.equal((await request(103)).status, "APPROVED");
    // One bulk log row per record, and one revocation audit row per success.
    const log = await q(pool, "SELECT attendance_approval_request_id id, outcome, previous_status, new_status, outcome_reason FROM attendance_approval_bulk_action_item ORDER BY id");
    assert.deepEqual(log.map((l) => [Number(l.id), l.outcome, l.previous_status, l.new_status]), [
      [100, "SUCCEEDED", "APPROVED", "CANCELLED"],
      [101, "SUCCEEDED", "REJECTED", "PENDING"],
      [102, "SKIPPED", "APPROVED", null],
      [103, "SKIPPED", "APPROVED", null],
      [104, "SKIPPED", "APPROVED", null],
    ]);
    assert.equal((await audit(100)).length + (await audit(101)).length, 2);
    assert.equal((await audit(102)).length + (await audit(103)).length, 0);
  });

  it("the Shift tab's 'select all matching' now offers decided Shift requests to an administrator", async () => {
    await seed({ id: 100, status: "APPROVED", stage: 2, steps: APPROVED2 });
    await seed({ id: 101, emp: EMP2, status: "REJECTED", stage: 2, steps: REJECTED2 });
    const all = { kind: "ALL_BRANCHES" };
    const approved = await usecase.listBulkTargets({ actor: { ...ADMIN, branch_scope: all }, request_type: "SHIFT_CHANGE", status: "APPROVED", action: "REVOKE" });
    const rejected = await usecase.listBulkTargets({ actor: { ...ADMIN, branch_scope: all }, request_type: "SHIFT_CHANGE", status: "REJECTED", action: "REVOKE" });
    assert.deepEqual(approved.items.map((i) => i.request_id), [100]);
    assert.deepEqual(rejected.items.map((i) => i.request_id), [101]);
  });
});
