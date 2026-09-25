/**
 * ADMIN REVOKE, AS REAL SQL - the transaction `revokeRequest` runs.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_approval_revoke.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its tables, fills them and drops them again, and reads no table it
 * did not create.
 *
 * THE RULE UNDER TEST. A revocation VOIDS the request: it becomes CANCELLED,
 * it is not reopened, its approval steps keep their decisions, and the
 * employee may raise a FRESH request for the date - a new id, a new chain.
 * The request, the audit row and the recalculated day commit together or not
 * at all. The tables carry the production shapes that matter: the generated
 * `open_attendance_date` / `open_request_group` columns and their UNIQUE key,
 * the production `createRequest` for the fresh request, the production
 * regularized-punch read, and the audit table built from the MIGRATION FILE
 * ITSELF.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");
const buildCalcRepo = require("./attendance_calculation");
const { CALCULATION_COLUMNS } = require("./attendance_calculation");

const EMP = 501;
const OTHER = 502;
const ADMIN = 900;
const DATE = "2026-09-10";
const REVOCABLE = ["REGULARIZATION", "REGULARIZATION_WITH_OT", "OT"];

const MIGRATION = path.join(
  __dirname,
  "..",
  "migrations/mysql/migrations/sqls/20261103120000-attendance-approval-revocation-up.sql"
);

const SCHEMA = [
  `CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), store_id INT NULL, designation_id INT NULL)`,
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
  `CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80))`,
  `CREATE TABLE work_shift (work_shift_id INT PRIMARY KEY, shift_code VARCHAR(20), shift_name VARCHAR(80))`,
  `CREATE TABLE payrun_employee_calculation (
     employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
     status VARCHAR(32) NOT NULL, PRIMARY KEY (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
  // Every column the calculation writer names; the ones the assertions read
  // are typed, the rest are permissive.
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
  "attendance_approval_revocation",
  "attendance_day_calculation",
  "payrun_employee_calculation",
  "attendance_regularized_punch",
  "attendance_approval_step",
  "attendance_approval_request",
  "work_shift",
  "outlets",
  "new_employee",
];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("admin revoke = VOID, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  let calcRepo;

  before(async () => {
    // Several connections, for the race below; multiple statements, for the
    // migration file, which is run as it is written.
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=6&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    await q(pool, fs.readFileSync(MIGRATION, "utf8"));
    repo = buildRepo(pool);
    calcRepo = buildCalcRepo(pool);
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((resolve) => pool.end(resolve));
  });

  beforeEach(async () => {
    for (const t of TABLES) await q(pool, `DELETE FROM ${t}`);
    await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id) VALUES ?", [[[EMP, "Staff", 3], [OTHER, "Other", 3], [ADMIN, "Admin", 1], [11, "First", 3], [22, "Second", 3], [33, "Final", 1]]]);
  });

  /** A request and its chain. Steps: [approver, level, decision, decided_by, remarks]. */
  const seed = async ({ id, type = "OT", emp = EMP, date = DATE, status, stage, approvedOt = null, finalization = "NOT_REQUIRED", closure = null, steps, punch = null }) => {
    await q(
      pool,
      `INSERT INTO attendance_approval_request
         (attendance_approval_request_id, request_type, requested_for_employee_id, requested_by_employee_id,
          attendance_date, reason, candidate_ot_minutes, approved_ot_minutes, status, current_stage_no,
          total_stages, finalization_state, closure_reason, chain_source, decided_at)
       VALUES (?, ?, ?, ?, ?, 'worked late', 180, ?, ?, ?, ?, ?, ?, 'EMPLOYEE', ?)`,
      [id, type, emp, emp, date, approvedOt, status, stage, steps.length, finalization, closure,
        status === "PENDING" ? null : "2026-09-11 10:00:00.000"]
    );
    await q(
      pool,
      `INSERT INTO attendance_approval_step
         (attendance_approval_request_id, stage_no, approver_role, approver_employee_id, approval_level,
          decision, decided_by_employee_id, decided_at, remarks, decision_source)
       VALUES ?`,
      [steps.map(([approver, level, decision, by, remarks], i) => [
        id, i + 1, "EMPLOYEE", approver, level, decision,
        decision === "PENDING" ? null : by,
        decision === "PENDING" ? null : `2026-09-11 0${i + 1}:00:00.000`,
        decision === "PENDING" ? null : remarks || null,
        decision === "PENDING" ? null : "WEB",
      ])]
    );
    if (punch) {
      await q(pool, "INSERT INTO attendance_regularized_punch (attendance_approval_request_id, employee_id, attendance_date, punch_time, created_by) VALUES (?, ?, ?, ?, ?)", [id, emp, date, punch, emp]);
    }
  };
  const APPROVED3 = [[11, "FIRST", "APPROVED", 11, "ok"], [22, "SECOND", "APPROVED", 22, "fine"], [33, "FINAL", "APPROVED", 33, "approved in error"]];
  const approvedOt = (id = 100) =>
    seed({ id, type: "OT", status: "APPROVED", stage: 3, approvedOt: 95, finalization: "SETTLED", steps: APPROVED3 });

  /** The day the usecase would hand over for a voided OT: no approved OT. */
  const day = (overrides = {}) => ({ employee_id: EMP, attendance_date: DATE, approved_ot_minutes: 0, punch_count: 2, status: "FINAL", is_final: 1, ...overrides });
  const revoke = async (id, extra = {}) => {
    const snap = await repo.getRevocationSnapshot(id);
    return repo.revokeRequest({
      requestId: id, stageNo: 3, originalDecision: "APPROVED", expectedFingerprint: snap.fingerprint, employeeId: EMP,
      actor: { employee_id: ADMIN, user_id: 7 }, reason: "approved by mistake", revocableTypes: REVOCABLE,
      calculations: [day()], ...extra,
    });
  };
  const state = async (id) => {
    const [r] = await q(pool, "SELECT status, current_stage_no, approved_ot_minutes, finalization_state, open_attendance_date FROM attendance_approval_request WHERE attendance_approval_request_id = ?", [id]);
    const steps = await q(pool, "SELECT stage_no, decision, decided_by_employee_id, remarks FROM attendance_approval_step WHERE attendance_approval_request_id = ? ORDER BY stage_no", [id]);
    const audits = await q(pool, "SELECT * FROM attendance_approval_revocation WHERE attendance_approval_request_id = ?", [id]);
    const days = await q(pool, "SELECT approved_ot_minutes, punch_count FROM attendance_day_calculation WHERE employee_id = ? AND attendance_date = ?", [EMP, DATE]);
    return { r, steps, audits, days };
  };
  const decisions = (steps) => steps.map((s) => [s.stage_no, s.decision, s.decided_by_employee_id]);
  const pendingFor = (actorId, types) =>
    repo.countApprovals({ request_type: types, status: "PENDING", approver_roles: [], outlet_id: 3, actor_employee_id: actorId, is_admin: false, permitted_outlet_ids: null });

  it("1./7./8. final APPROVED OT -> CANCELLED; the steps keep their decisions; approved OT 0 on the request and the day", async () => {
    await approvedOt();
    const out = await revoke(100);
    assert.equal(out.code, 200);
    assert.equal(out.status, "CANCELLED");
    const { r, steps, days } = await state(100);
    assert.equal(r.status, "CANCELLED");
    assert.equal(r.open_attendance_date, null, "not an open request - the date is free");
    assert.equal(r.approved_ot_minutes, 0, "nothing payable from it");
    assert.equal(r.current_stage_no, 3, "the chain is not rewound");
    assert.deepEqual(decisions(steps), [[1, "APPROVED", 11], [2, "APPROVED", 22], [3, "APPROVED", 33]], "NOT reset to PENDING");
    assert.deepEqual(steps.map((s) => s.remarks), ["ok", "fine", "approved in error"]);
    assert.deepEqual(days.map((d) => d.approved_ot_minutes), [0], "payroll's day row pays nothing for it");
  });

  it("2. REJECTED OT -> CANCELLED, the rejection stays on its step", async () => {
    await seed({ id: 100, type: "OT", status: "REJECTED", stage: 2, finalization: "SETTLED", steps: [[11, "FIRST", "APPROVED", 11], [22, "SECOND", "REJECTED", 22, "not worked"], [33, "FINAL", "PENDING"]] });
    const out = await revoke(100, { stageNo: 2, originalDecision: "REJECTED" });
    assert.equal(out.code, 200);
    const { r, steps } = await state(100);
    assert.equal(r.status, "CANCELLED");
    assert.deepEqual(decisions(steps), [[1, "APPROVED", 11], [2, "REJECTED", 22], [3, "PENDING", null]]);
  });

  it("3. the revoked OT is in NOBODY's Pending queue, and it IS in the history, as CANCELLED", async () => {
    await approvedOt();
    await revoke(100);
    for (const approver of [11, 22, 33]) {
      /* eslint-disable-next-line no-await-in-loop */
      assert.equal(await pendingFor(approver, ["OT"]), 0, `approver ${approver}`);
    }
    const history = await repo.listApprovals({ request_type: ["OT"], status: "ALL", approver_roles: [], outlet_id: 3, actor_employee_id: 33, is_admin: false, permitted_outlet_ids: null, limit: 10 });
    assert.deepEqual(history.map((h) => [Number(h.attendance_approval_request_id), h.status]), [[100, "CANCELLED"]]);
    const approved = await repo.countApprovals({ request_type: ["OT"], status: "APPROVED", approver_roles: [], outlet_id: 3, actor_employee_id: 33, is_admin: false, permitted_outlet_ids: null });
    assert.equal(approved, 0, "no longer counted as approved");
  });

  it("5./6. the employee can raise a FRESH OT for the same date: a new id, a new chain from stage 1", async () => {
    await approvedOt();
    await revoke(100);
    const created = await repo.createRequest({
      request: { request_type: "OT", requested_for_employee_id: EMP, requested_by_employee_id: EMP, attendance_date: DATE, outlet_id: 3, requester_class: "STORE_EMPLOYEE", reason: "again", candidate_ot_minutes: 180, auto_created: false, chain_source: "EMPLOYEE" },
      chain: [{ stage_no: 1, approver_role: "EMPLOYEE", outlet_id: null, approver_employee_id: 11, approval_level: "FIRST" }, { stage_no: 2, approver_role: "EMPLOYEE", outlet_id: null, approver_employee_id: 33, approval_level: "FINAL" }],
      punch: null,
    });
    const fresh = Number(created.attendance_approval_request_id);
    assert.ok(fresh > 100, "a NEW request id");
    const { r, steps } = await state(fresh);
    assert.equal(r.status, "PENDING");
    assert.equal(r.current_stage_no, 1);
    assert.deepEqual(decisions(steps), [[1, "PENDING", null], [2, "PENDING", null]], "a fresh chain");
    assert.equal((await state(100)).r.status, "CANCELLED", "the old one stays cancelled");
    assert.equal(await pendingFor(11, ["OT"]), 1, "the NEW request is in the first approver's queue");
  });

  it("9. APPROVED correction -> CANCELLED, and its punch is no longer an effective punch", async () => {
    await seed({ id: 100, type: "REGULARIZATION", status: "APPROVED", stage: 1, finalization: "SETTLED", steps: [[33, "FINAL", "APPROVED", 33]], punch: `${DATE} 18:00:00` });
    assert.equal((await calcRepo.getApprovedRegularizedPunches(EMP, DATE, DATE)).length, 1, "effective before");
    const out = await revoke(100, { stageNo: 1, calculations: [day({ punch_count: 1, approved_ot_minutes: null })] });
    assert.equal(out.code, 200);
    assert.equal((await state(100)).r.status, "CANCELLED");
    assert.deepEqual(await calcRepo.getApprovedRegularizedPunches(EMP, DATE, DATE), [], "not effective after");
    assert.deepEqual((await state(100)).days.map((d) => d.punch_count), [1]);
  });

  it("10. REJECTED correction -> CANCELLED, and a fresh correction for the date is accepted", async () => {
    await seed({ id: 100, type: "REGULARIZATION", status: "REJECTED", stage: 1, finalization: "SETTLED", steps: [[33, "FINAL", "REJECTED", 33, "wrong time"]] });
    assert.equal((await revoke(100, { stageNo: 1, originalDecision: "REJECTED", calculations: [day({ approved_ot_minutes: null })] })).code, 200);
    const created = await repo.createRequest({
      request: { request_type: "REGULARIZATION", requested_for_employee_id: EMP, requested_by_employee_id: EMP, attendance_date: DATE, outlet_id: 3, requester_class: "STORE_EMPLOYEE", reason: "correct time", candidate_ot_minutes: 0, auto_created: false, chain_source: "EMPLOYEE" },
      chain: [{ stage_no: 1, approver_role: "EMPLOYEE", outlet_id: null, approver_employee_id: 33, approval_level: "FINAL" }],
      punch: { punch_time: `${DATE} 18:30:00`, created_by: EMP },
    });
    assert.ok(Number(created.attendance_approval_request_id) > 100);
  });

  it("11. the audit keeps the voided decision, the request as it stood, the whole chain, and who/why", async () => {
    await approvedOt();
    await revoke(100);
    const { audits } = await state(100);
    assert.equal(audits.length, 1);
    const a = audits[0];
    assert.equal(Number(a.attendance_approval_request_id), 100);
    assert.equal(a.request_type, "OT");
    assert.equal(a.revoked_stage_no, 3);
    assert.equal(a.revoked_approval_level, "FINAL");
    assert.equal(a.original_decision, "APPROVED");
    assert.equal(a.original_decided_by_employee_id, 33);
    assert.equal(a.original_remarks, "approved in error");
    assert.ok(a.original_decided_at);
    assert.equal(a.original_request_status, "APPROVED");
    assert.equal(a.original_approved_ot_minutes, 95);
    assert.equal(a.original_finalization_state, "SETTLED");
    assert.equal(a.revoked_by_employee_id, ADMIN);
    assert.equal(a.revoked_by_user_id, 7);
    assert.equal(a.reason, "approved by mistake");
    const chain = typeof a.reset_steps === "string" ? JSON.parse(a.reset_steps) : a.reset_steps;
    assert.deepEqual(chain.map((s) => [s.stage_no, s.decision, s.decided_by_employee_id]), [[1, "APPROVED", 11], [2, "APPROVED", 22], [3, "APPROVED", 33]]);
  });

  it("12. a payroll-LOCKED month is refused, and nothing changes", async () => {
    await approvedOt();
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'APPROVED_LOCKED')", [EMP]);
    await assert.rejects(() => revoke(100), (err) => err.code === "PAYROLL_MONTH_LOCKED");
    const { r, audits, days } = await state(100);
    assert.equal(r.status, "APPROVED");
    assert.equal(r.approved_ot_minutes, 95);
    assert.equal(audits.length, 0);
    assert.equal(days.length, 0);
  });

  it("13. ATOMIC: a failure writing the day leaves the request, its steps and the audit exactly as they were", async () => {
    await approvedOt();
    await assert.rejects(() => revoke(100, { calculations: [day({ employee_id: null })] }));
    const { r, steps, audits, days } = await state(100);
    assert.equal(r.status, "APPROVED");
    assert.equal(r.approved_ot_minutes, 95);
    assert.deepEqual(decisions(steps), [[1, "APPROVED", 11], [2, "APPROVED", 22], [3, "APPROVED", 33]]);
    assert.equal(audits.length, 0);
    assert.equal(days.length, 0);
  });

  it("14. a SHIFT_CHANGE is refused inside the transaction as well", async () => {
    await seed({ id: 100, type: "SHIFT_CHANGE", status: "APPROVED", stage: 1, finalization: "SETTLED", steps: [[33, "FINAL", "APPROVED", 33]] });
    assert.equal((await revoke(100, { stageNo: 1, calculations: [] })).code, 409);
    assert.equal((await state(100)).r.status, "APPROVED");
  });

  it("a request still in approval (never revoked) is refused - an approver can reject it", async () => {
    await seed({ id: 100, status: "PENDING", stage: 2, steps: [[11, "FIRST", "APPROVED", 11], [22, "SECOND", "PENDING"], [33, "FINAL", "PENDING"]] });
    const out = await revoke(100, { stageNo: 1 });
    assert.equal(out.code, 409);
    assert.match(out.msg, /still in approval/);
  });

  it("a request the EARLIER reopening revoke left PENDING can now be voided", async () => {
    await seed({ id: 100, status: "PENDING", stage: 3, steps: [[11, "FIRST", "APPROVED", 11], [22, "SECOND", "APPROVED", 22], [33, "FINAL", "PENDING"]] });
    await q(pool, `INSERT INTO attendance_approval_revocation (attendance_approval_request_id, request_type, requested_for_employee_id, attendance_date, revoked_stage_no, original_decision, original_request_status, original_current_stage_no, reset_steps, reason)
                   VALUES (100, 'OT', ?, ?, 3, 'APPROVED', 'APPROVED', 3, '[]', 'the first, reopening revoke')`, [EMP, DATE]);
    const out = await revoke(100);
    assert.equal(out.code, 200);
    assert.equal((await state(100)).r.status, "CANCELLED");
    assert.equal(await pendingFor(33, ["OT"]), 0, "gone from the Final approver's queue");
    assert.equal((await state(100)).audits.length, 2, "both revocations on record");
  });

  it("an already-cancelled request, and a payroll-lock closure, are refused", async () => {
    await approvedOt();
    await revoke(100);
    assert.match((await revoke(100)).msg, /already been revoked/);
    await seed({ id: 101, date: "2026-09-12", status: "REJECTED", stage: 1, closure: "NOT_APPROVED_BEFORE_PAYROLL_LOCK", finalization: "SETTLED", steps: [[33, "FINAL", "REJECTED", 33]] });
    assert.match((await revoke(101, { stageNo: 1, originalDecision: "REJECTED", calculations: [] })).msg, /closed by the payroll lock/);
  });

  it("an APPROVED correction cannot be voided under an OT claimed against it - revoke the OT first", async () => {
    await seed({ id: 100, type: "REGULARIZATION", status: "APPROVED", stage: 1, finalization: "SETTLED", steps: [[33, "FINAL", "APPROVED", 33]], punch: `${DATE} 18:00:00` });
    await seed({ id: 101, type: "OT", status: "APPROVED", stage: 1, approvedOt: 60, finalization: "SETTLED", steps: [[33, "FINAL", "APPROVED", 33]] });
    const blocked = await revoke(100, { stageNo: 1 });
    assert.equal(blocked.code, 409);
    assert.match(blocked.msg, /approved OT request \(#101\).*revoke that one first/);
    assert.equal((await revoke(101, { stageNo: 1 })).code, 200, "the OT first");
    assert.equal((await revoke(100, { stageNo: 1 })).code, 200, "then the correction");
  });

  it("a STALE read is refused: the request moved between the read and the lock", async () => {
    await seed({ id: 100, status: "PENDING", stage: 3, steps: [[11, "FIRST", "APPROVED", 11], [22, "SECOND", "APPROVED", 22], [33, "FINAL", "PENDING"]] });
    await q(pool, `INSERT INTO attendance_approval_revocation (attendance_approval_request_id, request_type, requested_for_employee_id, attendance_date, revoked_stage_no, original_decision, original_request_status, original_current_stage_no, reset_steps, reason)
                   VALUES (100, 'OT', ?, ?, 3, 'APPROVED', 'APPROVED', 3, '[]', 'earlier')`, [EMP, DATE]);
    const snap = await repo.getRevocationSnapshot(100);
    await repo.decideStage({ requestId: 100, stageNo: 3, decision: "APPROVED", actorId: 33, remarks: null, adminOverride: false, next: { status: "APPROVED", current_stage_no: 3, approved_ot_minutes: 60 } });
    const out = await repo.revokeRequest({ requestId: 100, stageNo: 3, originalDecision: "APPROVED", expectedFingerprint: snap.fingerprint, employeeId: EMP, actor: { employee_id: ADMIN }, reason: "approved by mistake", revocableTypes: REVOCABLE, calculations: [day()] });
    assert.equal(out.code, 409);
    assert.equal((await state(100)).r.status, "APPROVED", "the approver's decision stands");
  });

  it("15. RACE: a revocation and the Final approval started together end in ONE consistent state, every time", async (t) => {
    const wins = { revoke: 0, approve: 0 };
    for (let i = 0; i < 12; i += 1) {
      /* eslint-disable no-await-in-loop */
      for (const tbl of ["attendance_approval_revocation", "attendance_day_calculation", "attendance_approval_step", "attendance_approval_request"]) {
        await q(pool, `DELETE FROM ${tbl}`);
      }
      await seed({ id: 100, status: "PENDING", stage: 3, steps: [[11, "FIRST", "APPROVED", 11], [22, "SECOND", "APPROVED", 22], [33, "FINAL", "PENDING"]] });
      await q(pool, `INSERT INTO attendance_approval_revocation (attendance_approval_request_id, request_type, requested_for_employee_id, attendance_date, revoked_stage_no, original_decision, original_request_status, original_current_stage_no, reset_steps, reason)
                     VALUES (100, 'OT', ?, ?, 3, 'APPROVED', 'APPROVED', 3, '[]', 'earlier')`, [EMP, DATE]);
      const snap = await repo.getRevocationSnapshot(100);
      const [revoked, decided] = await Promise.all([
        repo.revokeRequest({ requestId: 100, stageNo: 3, originalDecision: "APPROVED", expectedFingerprint: snap.fingerprint, employeeId: EMP, actor: { employee_id: ADMIN }, reason: "approved by mistake", revocableTypes: REVOCABLE, calculations: [day()] }),
        repo.decideStage({ requestId: 100, stageNo: 3, decision: "APPROVED", actorId: 33, remarks: null, adminOverride: false, next: { status: "APPROVED", current_stage_no: 3, approved_ot_minutes: 60 } }),
      ]);
      const { r, audits } = await state(100);
      if (revoked.code === 200) {
        assert.equal(decided.code, 409, `iteration ${i}: both cannot win`);
        assert.equal(r.status, "CANCELLED");
        assert.equal(audits.length, 2);
        wins.revoke += 1;
      } else {
        assert.equal(decided.code, 200, `iteration ${i}: one of them must win`);
        assert.equal(r.status, "APPROVED");
        assert.equal(audits.length, 1);
        wins.approve += 1;
      }
      /* eslint-enable no-await-in-loop */
    }
    t.diagnostic(`race outcomes over 12 runs: revocation won ${wins.revoke}, approval won ${wins.approve}`);
  });

  it("16. another employee's requests, and other dates, are untouched", async () => {
    await approvedOt();
    await seed({ id: 101, emp: OTHER, status: "APPROVED", stage: 3, approvedOt: 30, finalization: "SETTLED", steps: APPROVED3 });
    await seed({ id: 102, date: "2026-09-11", status: "APPROVED", stage: 3, approvedOt: 40, finalization: "SETTLED", steps: APPROVED3 });
    await revoke(100);
    assert.equal((await state(101)).r.status, "APPROVED");
    assert.equal((await state(102)).r.status, "APPROVED");
  });

  it("no statement anywhere resets approval steps to PENDING, and the audit is append-only", () => {
    const src = fs.readFileSync(path.join(__dirname, "attendance_regularization.js"), "utf8");
    assert.ok(!/SET decision = 'PENDING'/.test(src), "a revoke never rewinds a chain");
    const dirs = ["repository", "usecase", "routes", "services", "utils"].map((d) => path.join(__dirname, "..", d));
    for (const dir of dirs) {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js") && !n.endsWith(".test.js"))) {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        assert.ok(!/UPDATE\s+`?attendance_approval_revocation`?/i.test(text), `${f} updates the audit`);
        assert.ok(!/DELETE\s+FROM\s+`?attendance_approval_revocation`?/i.test(text), `${f} deletes from the audit`);
      }
    }
  });
});
