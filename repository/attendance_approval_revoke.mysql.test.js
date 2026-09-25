/**
 * ADMIN REVOKE, AS REAL SQL - the transaction `revokeStage` runs.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_approval_revoke.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its tables, fills them and drops them again, and reads no table it
 * did not create.
 *
 * WHY REAL SQL. What this feature promises is transactional: the steps, the
 * request, the audit row and the recalculated day commit together or not at
 * all; the payroll lock is taken under a row lock; the database's own
 * one-open-request-per-date key still holds; and a concurrent decision cannot
 * interleave with a revocation. A fake can only agree with the code it fakes.
 * The tables below carry the production shapes that matter: the generated
 * `open_attendance_date` / `open_request_group` columns and their UNIQUE key,
 * and the revocation table built from the MIGRATION FILE ITSELF.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");
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
  `CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), store_id INT NULL)`,
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
  `CREATE TABLE payrun_employee_calculation (
     employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
     status VARCHAR(32) NOT NULL, PRIMARY KEY (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
  // Every column the calculation writer names; the two the assertions read
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
  "attendance_approval_step",
  "attendance_approval_request",
  "new_employee",
];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("admin revoke, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;

  before(async () => {
    // Several connections, for the race below; multiple statements, for the
    // migration file, which is run as it is written.
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=6&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    // THE MIGRATION ITSELF, not a copy of it.
    await q(pool, fs.readFileSync(MIGRATION, "utf8"));
    repo = buildRepo(pool);
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((resolve) => pool.end(resolve));
  });

  beforeEach(async () => {
    for (const t of ["attendance_approval_revocation", "attendance_day_calculation", "payrun_employee_calculation", "attendance_approval_step", "attendance_approval_request", "new_employee"]) {
      await q(pool, `DELETE FROM ${t}`);
    }
    await q(pool, "INSERT INTO new_employee VALUES ?", [[[EMP, "Staff", 3], [OTHER, "Other", 3], [ADMIN, "Admin", 1], [11, "First", 3], [22, "Second", 3], [33, "Final", 1]]]);
  });

  /** A request and its chain. Steps: [approver, level, decision, decided_by, remarks]. */
  const seed = async ({ id, type = "OT", emp = EMP, date = DATE, status, stage, approvedOt = null, finalization = "NOT_REQUIRED", closure = null, steps }) => {
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
  };
  const approvedOt3 = (id = 1) =>
    seed({
      id, type: "OT", status: "APPROVED", stage: 3, approvedOt: 95, finalization: "SETTLED",
      steps: [[11, "FIRST", "APPROVED", 11, "ok"], [22, "SECOND", "APPROVED", 22, "fine"], [33, "FINAL", "APPROVED", 33, "approved in error"]],
    });
  /** The day the usecase would hand over for a reopened OT: approved OT 0. */
  const day = (overrides = {}) => ({ employee_id: EMP, attendance_date: DATE, approved_ot_minutes: 0, punch_count: 2, status: "FINAL", is_final: 1, ...overrides });
  const revoke = async (id, stageNo, extra = {}) => {
    const snap = await repo.getRevocationSnapshot(id);
    return repo.revokeStage({
      requestId: id, stageNo, expectedFingerprint: snap.fingerprint, employeeId: EMP,
      actor: { employee_id: ADMIN, user_id: 7 }, reason: "approved by mistake", revocableTypes: REVOCABLE,
      calculations: [day()], ...extra,
    });
  };
  const state = async (id) => {
    const [r] = await q(pool, "SELECT status, current_stage_no, approved_ot_minutes, finalization_state, decided_at FROM attendance_approval_request WHERE attendance_approval_request_id = ?", [id]);
    const steps = await q(pool, "SELECT stage_no, decision, decided_by_employee_id, decided_at, remarks, decision_source FROM attendance_approval_step WHERE attendance_approval_request_id = ? ORDER BY stage_no", [id]);
    const audits = await q(pool, "SELECT * FROM attendance_approval_revocation WHERE attendance_approval_request_id = ?", [id]);
    const days = await q(pool, "SELECT approved_ot_minutes FROM attendance_day_calculation WHERE employee_id = ? AND attendance_date = ?", [EMP, DATE]);
    return { r, steps, audits, days };
  };

  it("1. revoking the FINAL approval of an OT: request PENDING at the final stage, approved OT cleared, the day rewritten with 0 payable", async () => {
    await approvedOt3();
    const out = await revoke(1, 3);
    assert.equal(out.code, 200);
    assert.deepEqual(out.reset_stage_nos, [3]);
    const { r, steps, days } = await state(1);
    assert.equal(r.status, "PENDING");
    assert.equal(r.current_stage_no, 3);
    assert.equal(r.approved_ot_minutes, null, "no approved OT on the request");
    assert.equal(r.finalization_state, "NOT_REQUIRED");
    assert.equal(r.decided_at, null);
    assert.deepEqual(steps.map((s) => s.decision), ["APPROVED", "APPROVED", "PENDING"]);
    assert.equal(steps[2].decided_by_employee_id, null);
    assert.equal(steps[2].remarks, null);
    assert.equal(steps[0].decided_by_employee_id, 11, "earlier stages keep their decisions");
    assert.deepEqual(days.map((d) => d.approved_ot_minutes), [0], "payroll's day row pays nothing for it");
  });

  it("4. revoking STAGE 2 after the Final approved: Stage 2 and Final reset, reopened at Stage 2", async () => {
    await approvedOt3();
    const out = await revoke(1, 2);
    assert.deepEqual(out.reset_stage_nos, [2, 3]);
    const { r, steps } = await state(1);
    assert.equal(r.status, "PENDING");
    assert.equal(r.current_stage_no, 2);
    assert.deepEqual(steps.map((s) => s.decision), ["APPROVED", "PENDING", "PENDING"]);
    assert.deepEqual(steps.slice(1).map((s) => s.decided_by_employee_id), [null, null]);
  });

  it("5. revoking STAGE 1 clears Stage 2 and the Final as well", async () => {
    await approvedOt3();
    await revoke(1, 1);
    const { r, steps } = await state(1);
    assert.equal(r.current_stage_no, 1);
    assert.deepEqual(steps.map((s) => s.decision), ["PENDING", "PENDING", "PENDING"]);
    assert.ok(steps.every((s) => s.decided_at === null && s.remarks === null && s.decision_source === null));
  });

  it("3. revoking a REJECTED stage reopens the request at that stage", async () => {
    await seed({ id: 1, type: "REGULARIZATION", status: "REJECTED", stage: 2, finalization: "SETTLED",
      steps: [[11, "FIRST", "APPROVED", 11], [22, "SECOND", "REJECTED", 22, "wrong punch"], [33, "FINAL", "PENDING"]] });
    await revoke(1, 2, { calculations: [day({ approved_ot_minutes: null })] });
    const { r, steps } = await state(1);
    assert.equal(r.status, "PENDING");
    assert.equal(r.current_stage_no, 2);
    assert.deepEqual(steps.map((s) => s.decision), ["APPROVED", "PENDING", "PENDING"]);
  });

  it("11. the audit row keeps every original value the reset cleared", async () => {
    await approvedOt3();
    await revoke(1, 2);
    const { audits } = await state(1);
    assert.equal(audits.length, 1);
    const a = audits[0];
    assert.equal(Number(a.attendance_approval_request_id), 1);
    assert.equal(a.request_type, "OT");
    assert.equal(a.revoked_stage_no, 2);
    assert.equal(a.revoked_approval_level, "SECOND");
    assert.equal(a.original_decision, "APPROVED");
    assert.equal(a.original_decided_by_employee_id, 22);
    assert.ok(a.original_decided_at, "the original decision time");
    assert.equal(a.original_remarks, "fine");
    assert.equal(a.original_decision_source, "WEB");
    assert.equal(a.original_request_status, "APPROVED");
    assert.equal(a.original_current_stage_no, 3);
    assert.equal(a.original_finalization_state, "SETTLED");
    assert.equal(a.original_approved_ot_minutes, 95);
    assert.ok(a.original_request_decided_at);
    assert.equal(a.revoked_by_employee_id, ADMIN);
    assert.equal(a.revoked_by_user_id, 7);
    assert.ok(a.revoked_at);
    assert.equal(a.reason, "approved by mistake");
    assert.equal(a.calculations_written, 1);
    const reset = typeof a.reset_steps === "string" ? JSON.parse(a.reset_steps) : a.reset_steps;
    assert.deepEqual(
      reset.map((s) => [s.stage_no, s.decision, s.decided_by_employee_id, s.remarks]),
      [[2, "APPROVED", 22, "fine"], [3, "APPROVED", 33, "approved in error"]],
      "the LATER stage's decision, voided by this revocation, is kept too"
    );
  });

  it("a second revocation adds a second audit row - history is appended, never rewritten", async () => {
    await approvedOt3();
    await revoke(1, 3);
    // The approver decides the Final again, then it is revoked again.
    await q(pool, "UPDATE attendance_approval_step SET decision='APPROVED', decided_by_employee_id=33, decided_at=NOW(3) WHERE attendance_approval_request_id=1 AND stage_no=3");
    await q(pool, "UPDATE attendance_approval_request SET status='APPROVED', approved_ot_minutes=60, finalization_state='SETTLED', decided_at=NOW(3) WHERE attendance_approval_request_id=1");
    await revoke(1, 3);
    const { audits } = await state(1);
    assert.deepEqual(audits.map((a) => a.original_approved_ot_minutes), [95, 60]);
  });

  it("9. a payroll-LOCKED month is refused, and nothing changes", async () => {
    await approvedOt3();
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'APPROVED_LOCKED')", [EMP]);
    await assert.rejects(() => revoke(1, 3), (err) => err.code === "PAYROLL_MONTH_LOCKED");
    const { r, steps, audits, days } = await state(1);
    assert.equal(r.status, "APPROVED");
    assert.equal(r.approved_ot_minutes, 95);
    assert.deepEqual(steps.map((s) => s.decision), ["APPROVED", "APPROVED", "APPROVED"]);
    assert.equal(audits.length, 0);
    assert.equal(days.length, 0);
  });

  it("an UNLOCKED payroll row (calculated, not approved) does not block", async () => {
    await approvedOt3();
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, 2026, 9, 'CALCULATED')", [EMP]);
    assert.equal((await revoke(1, 3)).code, 200);
  });

  it("12. ATOMIC: a failure writing the day rolls back the steps, the request and the audit", async () => {
    await approvedOt3();
    // A day row with no readable employee: the writer's own guard throws
    // AFTER the resets and the audit insert have run in this transaction.
    await assert.rejects(() => revoke(1, 2, { calculations: [day({ employee_id: null })] }));
    const { r, steps, audits, days } = await state(1);
    assert.equal(r.status, "APPROVED");
    assert.equal(r.current_stage_no, 3);
    assert.equal(r.approved_ot_minutes, 95);
    assert.deepEqual(steps.map((s) => [s.decision, s.decided_by_employee_id]), [["APPROVED", 11], ["APPROVED", 22], ["APPROVED", 33]]);
    assert.equal(audits.length, 0);
    assert.equal(days.length, 0);
  });

  it("13. a PENDING stage has nothing to revoke", async () => {
    await seed({ id: 1, status: "PENDING", stage: 2, steps: [[11, "FIRST", "APPROVED", 11], [22, "SECOND", "PENDING"], [33, "FINAL", "PENDING"]] });
    const out = await revoke(1, 2);
    assert.equal(out.code, 409);
    assert.match(out.msg, /no decision to revoke/);
    assert.equal((await state(1)).audits.length, 0);
  });

  it("14. a SHIFT_CHANGE is refused inside the transaction as well", async () => {
    await seed({ id: 1, type: "SHIFT_CHANGE", status: "APPROVED", stage: 1, finalization: "SETTLED", steps: [[33, "FINAL", "APPROVED", 33]] });
    const out = await revoke(1, 1, { calculations: [] });
    assert.equal(out.code, 409);
    assert.equal((await state(1)).r.status, "APPROVED");
  });

  it("a payroll-lock CLOSURE is not an approver's decision and is refused", async () => {
    await seed({ id: 1, status: "REJECTED", stage: 1, closure: "NOT_APPROVED_BEFORE_PAYROLL_LOCK", finalization: "SETTLED", steps: [[33, "FINAL", "REJECTED", 33]] });
    assert.equal((await revoke(1, 1)).code, 409);
  });

  it("a STALE read is refused: the chain moved between the read and the lock", async () => {
    await seed({ id: 1, status: "PENDING", stage: 2, steps: [[11, "FIRST", "APPROVED", 11], [22, "SECOND", "PENDING"], [33, "FINAL", "PENDING"]] });
    const snap = await repo.getRevocationSnapshot(1);
    // The Stage 2 approver decides in between.
    const decided = await repo.decideStage({ requestId: 1, stageNo: 2, decision: "APPROVED", actorId: 22, remarks: null, adminOverride: false, next: { status: "PENDING", current_stage_no: 3, approved_ot_minutes: null } });
    assert.equal(decided.code, 200);
    const out = await repo.revokeStage({ requestId: 1, stageNo: 1, expectedFingerprint: snap.fingerprint, employeeId: EMP, actor: { employee_id: ADMIN }, reason: "approved by mistake", revocableTypes: REVOCABLE, calculations: [day()] });
    assert.equal(out.code, 409);
    const { r, steps, audits } = await state(1);
    assert.equal(r.current_stage_no, 3, "the approver's decision stands");
    assert.deepEqual(steps.map((s) => s.decision), ["APPROVED", "APPROVED", "PENDING"]);
    assert.equal(audits.length, 0);
  });

  it("15. RACE: a revocation and an approval started together leave ONE consistent chain, every time", async (t) => {
    const wins = { revoke: 0, approve: 0 };
    for (let i = 0; i < 12; i += 1) {
      /* eslint-disable no-await-in-loop */
      await q(pool, "DELETE FROM attendance_approval_revocation");
      await q(pool, "DELETE FROM attendance_day_calculation");
      await q(pool, "DELETE FROM attendance_approval_step");
      await q(pool, "DELETE FROM attendance_approval_request");
      await seed({ id: 1, status: "PENDING", stage: 2, steps: [[11, "FIRST", "APPROVED", 11], [22, "SECOND", "PENDING"], [33, "FINAL", "PENDING"]] });
      const snap = await repo.getRevocationSnapshot(1);
      const [revoked, decided] = await Promise.all([
        repo.revokeStage({ requestId: 1, stageNo: 1, expectedFingerprint: snap.fingerprint, employeeId: EMP, actor: { employee_id: ADMIN }, reason: "approved by mistake", revocableTypes: REVOCABLE, calculations: [day()] }),
        repo.decideStage({ requestId: 1, stageNo: 2, decision: "APPROVED", actorId: 22, remarks: null, adminOverride: false, next: { status: "PENDING", current_stage_no: 3, approved_ot_minutes: null } }),
      ]);
      const { r, steps, audits } = await state(1);
      const decisions = steps.map((s) => s.decision).join(",");
      if (revoked.code === 200) {
        // Revocation won: the approval found no PENDING stage 2 at stage 2.
        assert.equal(decided.code, 409, `iteration ${i}: both cannot win`);
        assert.equal(r.current_stage_no, 1);
        assert.equal(decisions, "PENDING,PENDING,PENDING");
        assert.equal(audits.length, 1);
        wins.revoke += 1;
      } else {
        // The approval won: the revocation saw a changed chain and refused.
        assert.equal(decided.code, 200, `iteration ${i}: one of them must win`);
        assert.equal(revoked.code, 409);
        assert.equal(r.current_stage_no, 3);
        assert.equal(decisions, "APPROVED,APPROVED,PENDING");
        assert.equal(audits.length, 0);
        wins.approve += 1;
      }
      /* eslint-enable no-await-in-loop */
    }
    t.diagnostic(`race outcomes over 12 runs: revocation won ${wins.revoke}, approval won ${wins.approve}`);
  });

  it("16a. ONE OPEN REQUEST PER DATE: a rejected correction cannot be reopened beside an open one", async () => {
    await seed({ id: 1, type: "REGULARIZATION", status: "REJECTED", stage: 1, finalization: "SETTLED", steps: [[33, "FINAL", "REJECTED", 33, "no"]] });
    await seed({ id: 2, type: "REGULARIZATION", status: "PENDING", stage: 1, steps: [[33, "FINAL", "PENDING"]] });
    const out = await revoke(1, 1);
    assert.equal(out.code, 409);
    assert.match(out.msg, /already has an open REGULARIZATION request \(#2\)/);
    assert.equal((await state(1)).r.status, "REJECTED");
  });

  it("16b. a correction cannot be reopened under an APPROVED OT claim that was granted against it", async () => {
    await seed({ id: 1, type: "REGULARIZATION", status: "APPROVED", stage: 1, finalization: "SETTLED", steps: [[33, "FINAL", "APPROVED", 33]] });
    await seed({ id: 2, type: "OT", status: "APPROVED", stage: 1, approvedOt: 60, finalization: "SETTLED", steps: [[33, "FINAL", "APPROVED", 33]] });
    const out = await revoke(1, 1);
    assert.equal(out.code, 409);
    assert.match(out.msg, /approved OT request \(#2\).*revoke that one first/);
    // Revoke the OT first, then the correction - both allowed, in that order.
    assert.equal((await revoke(2, 1)).code, 200);
    assert.equal((await revoke(1, 1)).code, 409, "the reopened OT is now OPEN, so the date still has an open request");
  });

  it("16c. ONE OT CLAIM PER DATE: revoking reopens the SAME request - no new row, same id", async () => {
    await approvedOt3(7);
    await revoke(7, 3);
    const rows = await q(pool, "SELECT attendance_approval_request_id, status FROM attendance_approval_request WHERE requested_for_employee_id = ? AND attendance_date = ? AND request_type = 'OT'", [EMP, DATE]);
    assert.deepEqual(rows.map((r) => [Number(r.attendance_approval_request_id), r.status]), [[7, "PENDING"]]);
    // And the database's own key still stops a second open attendance/OT row.
    await assert.rejects(
      () => q(pool, "INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, status, total_stages) VALUES ('REGULARIZATION', ?, ?, ?, 'x', 'PENDING', 1)", [EMP, EMP, DATE]),
      (err) => err.code === "ER_DUP_ENTRY"
    );
  });

  it("another employee's request on the same date is no conflict", async () => {
    await approvedOt3();
    await seed({ id: 2, emp: OTHER, type: "REGULARIZATION", status: "PENDING", stage: 1, steps: [[33, "FINAL", "PENDING"]] });
    assert.equal((await revoke(1, 3)).code, 200);
  });

  it("the audit table is append-only in the application: no UPDATE or DELETE of it anywhere", () => {
    const dirs = ["repository", "usecase", "routes", "services", "utils"].map((d) => path.join(__dirname, "..", d));
    for (const dir of dirs) {
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js") && !n.endsWith(".test.js"))) {
        const src = fs.readFileSync(path.join(dir, f), "utf8");
        assert.ok(!/UPDATE\s+`?attendance_approval_revocation`?/i.test(src), `${f} updates the audit`);
        assert.ok(!/DELETE\s+FROM\s+`?attendance_approval_revocation`?/i.test(src), `${f} deletes from the audit`);
      }
    }
  });
});
