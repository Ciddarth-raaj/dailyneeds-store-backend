/**
 * LOCKED-PERIOD CORRECTION, AS REAL SQL - the narrow locked-day write gate in
 * `decideStage` / `revokeRequest`, the authorisation transaction and the
 * settlement, against a scratch MySQL/MariaDB.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_locked_correction.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");
const { CALCULATION_COLUMNS } = require("./attendance_calculation");

const EMP = 501;
const RAISER = 7;
const AUTHORISER = 8;
const HR = 9;
const DATE = "2026-09-12";
const REVOCABLE = ["REGULARIZATION", "REGULARIZATION_WITH_OT", "OT"];
const sql = (f) => path.join(__dirname, "..", "migrations/mysql/migrations/sqls", f);

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
     payrun_calculation_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
     employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
     status VARCHAR(32) NOT NULL, monthly_gross DECIMAL(12,2) NULL, daily_rate DECIMAL(12,2) NULL,
     approved_ot_minutes INT NULL, ot_amount DECIMAL(12,2) NULL, ot_groups JSON NULL,
     missing_hours_minutes INT NULL, missing_hours_deduction DECIMAL(12,2) NULL,
     net_pay DECIMAL(12,2) NULL, calculation_hash CHAR(32) NULL,
     PRIMARY KEY (employee_id, period_year, period_month)
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
  "attendance_locked_period_correction_event",
  "attendance_locked_period_authorisation",
  "attendance_approval_revocation",
  "attendance_day_calculation",
  "payrun_employee_calculation",
  "attendance_regularized_punch",
  "attendance_approval_step",
  "attendance_approval_request",
  "work_shift",
  "outlets",
  "new_employee",
  "all_permissions",
  "permissions",
];
const q = (pool, s, params = []) =>
  new Promise((resolve, reject) =>
    pool.query(s, params, (err, rows) =>
      err ? reject(err) : resolve(Array.isArray(rows) ? rows.map((r) => ({ ...r })) : rows)
    )
  );

describe("locked-period correction, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=4&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    await q(pool, "CREATE TABLE all_permissions (permission_key VARCHAR(100))");
    await q(pool, "CREATE TABLE permissions (permission_key VARCHAR(100))");
    await q(pool, fs.readFileSync(sql("20261103120000-attendance-approval-revocation-up.sql"), "utf8"));
    await q(pool, fs.readFileSync(sql("20261106120000-attendance-approval-revocation-outcome-up.sql"), "utf8"));
    await q(pool, fs.readFileSync(sql("20261111120000-attendance-locked-period-correction-up.sql"), "utf8"));
    repo = buildRepo(pool);
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((resolve) => pool.end(resolve));
  });

  const FROZEN = { daily_rate: 1000, net_pay: 24500, calculation_hash: "f".repeat(32) };
  beforeEach(async () => {
    for (const t of TABLES.filter((t) => !["all_permissions", "permissions"].includes(t))) await q(pool, `DELETE FROM ${t}`);
    await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id) VALUES ?", [[[EMP, "Staff", 3], [RAISER, "Mgr", 3], [AUTHORISER, "Admin", 1], [HR, "HR", 1]]]);
    await q(pool, "INSERT INTO payrun_employee_calculation (employee_id, period_year, period_month, status, daily_rate, net_pay, calculation_hash) VALUES (?, 2026, 9, 'APPROVED_LOCKED', ?, ?, ?)", [EMP, FROZEN.daily_rate, FROZEN.net_pay, FROZEN.calculation_hash]);
    // The day as payroll calculated it.
    await q(pool, "INSERT INTO attendance_day_calculation (employee_id, attendance_date, punch_count, approved_ot_minutes, status) VALUES (?, ?, 2, 235, 'FINAL')", [EMP, DATE]);
  });

  /** A pending regularization with a 2-stage chain, and its authorisation in `authStatus` (or none). */
  const seed = async ({ id = 300, authStatus = "AUTHORISED", stage = 1, requestStatus = "PENDING", date = DATE } = {}) => {
    await q(pool, `INSERT INTO attendance_approval_request
        (attendance_approval_request_id, request_type, requested_for_employee_id, requested_by_employee_id,
         attendance_date, reason, status, current_stage_no, total_stages, finalization_state, chain_source)
        VALUES (?, 'REGULARIZATION', ?, ?, ?, 'Missing Lunch Punches', ?, ?, 2, ?, 'ROLE')`,
      [id, EMP, RAISER, date, requestStatus, stage, requestStatus === "APPROVED" ? "SETTLED" : "NOT_REQUIRED"]);
    await q(pool, `INSERT INTO attendance_approval_step (attendance_approval_request_id, stage_no, approver_role, decision, decided_by_employee_id, decided_at, decision_source) VALUES ?`,
      [[[id, 1, "STORE_MANAGER", stage > 1 || requestStatus === "APPROVED" ? "APPROVED" : "PENDING", stage > 1 || requestStatus === "APPROVED" ? RAISER + 100 : null, stage > 1 || requestStatus === "APPROVED" ? "2026-10-01 10:00:00" : null, stage > 1 || requestStatus === "APPROVED" ? "WEB" : null],
        [id, 2, "HR", requestStatus === "APPROVED" ? "APPROVED" : "PENDING", requestStatus === "APPROVED" ? HR : null, requestStatus === "APPROVED" ? "2026-10-01 11:00:00" : null, requestStatus === "APPROVED" ? "WEB" : null]]]);
    if (authStatus) {
      await q(pool, `INSERT INTO attendance_locked_period_authorisation
          (attendance_approval_request_id, employee_id, attendance_date, period_year, period_month, status,
           authorised_by_employee_id, authorisation_reason, authorised_at)
          VALUES (?, ?, ?, 2026, 9, ?, ?, ?, ?)`,
        [id, EMP, date, authStatus, authStatus === "REQUIRED" ? null : AUTHORISER,
          authStatus === "REQUIRED" ? null : "Lunch was taken; device missed it", authStatus === "REQUIRED" ? null : "2026-10-02 09:00:00"]);
    }
  };
  const corrected = (o = {}) => ({ employee_id: EMP, attendance_date: DATE, punch_count: 4, approved_ot_minutes: 205, status: "FINAL", ...o });
  const EVENT = {
    old_calculation: { punch_count: 2, approved_ot_minutes: 235 },
    new_calculation: { punch_count: 4, approved_ot_minutes: 205 },
    payroll_difference: {
      basis: { payrun_calculation_id: 1, calculation_hash: "f".repeat(32), daily_rate: 1000, frozen_net_pay: 24500 },
      components: { approved_ot: { before: 235, after: 205, amount: -66.67 } },
      net_difference: -66.67, absolute_amount: 66.67, direction: "RECOVERABLE_FROM_EMPLOYEE",
      adjustment_status: "PENDING_ADJUSTMENT", statutory_recomputed: false,
    },
  };
  const decideFinal = (extra = {}) =>
    repo.decideStage({
      requestId: 300, stageNo: 2, decision: "APPROVED", actorId: HR, remarks: null, adminOverride: false,
      next: { status: "APPROVED", current_stage_no: 2, approved_ot_minutes: 0 },
      calculations: [corrected()], attendanceLock: { employee_id: EMP, attendance_date: DATE },
      lockedCorrection: { event: EVENT }, ...extra,
    });
  const storedDay = async () => (await q(pool, "SELECT punch_count, approved_ot_minutes FROM attendance_day_calculation WHERE employee_id = ? AND attendance_date = ?", [EMP, DATE]))[0];
  const auth = async () => (await q(pool, "SELECT status FROM attendance_locked_period_authorisation WHERE attendance_approval_request_id = 300"))[0];
  const events = async () => q(pool, "SELECT * FROM attendance_locked_period_correction_event ORDER BY attendance_locked_period_correction_event_id");
  const payrun = async () => (await q(pool, "SELECT status, daily_rate, net_pay, calculation_hash FROM payrun_employee_calculation WHERE employee_id = ?", [EMP]))[0];

  it("final approval of an AUTHORISED correction writes the one day, appends the event, marks APPLIED - payrun untouched", async () => {
    await seed({ stage: 2 });
    const before = await payrun();
    const out = await decideFinal();
    assert.equal(out.code, 200);
    assert.equal(out.status, "APPROVED");
    assert.ok(out.locked_correction_event_id > 0);
    assert.deepEqual(await storedDay(), { punch_count: 4, approved_ot_minutes: 205 });
    assert.equal((await auth()).status, "APPLIED");
    const [ev] = await events();
    assert.equal(ev.event_type, "APPROVAL");
    assert.equal(ev.attendance_approval_request_id, 300);
    assert.equal(ev.authorised_by_employee_id, AUTHORISER);
    assert.equal(ev.authorisation_reason, "Lunch was taken; device missed it");
    assert.equal(ev.direction, "RECOVERABLE_FROM_EMPLOYEE");
    assert.equal(Number(ev.net_difference), -66.67);
    assert.equal(ev.adjustment_status, "PENDING_ADJUSTMENT");
    assert.equal(ev.payrun_calculation_hash, "f".repeat(32));
    assert.deepEqual(await payrun(), before, "the frozen payrun row is never written");
  });

  it("REQUIRED (not yet authorised): every approving stage is refused and nothing is written", async () => {
    await seed({ authStatus: "REQUIRED" });
    await assert.rejects(
      repo.decideStage({
        requestId: 300, stageNo: 1, decision: "APPROVED", actorId: RAISER + 100, adminOverride: false,
        next: { status: "PENDING", current_stage_no: 2, approved_ot_minutes: null }, calculations: [],
        attendanceLock: { employee_id: EMP, attendance_date: DATE }, lockedCorrection: { event: null },
      }),
      /Locked-period authorisation required/
    );
    const [step] = await q(pool, "SELECT decision FROM attendance_approval_step WHERE attendance_approval_request_id = 300 AND stage_no = 1");
    assert.equal(step.decision, "PENDING");
  });

  it("no authorisation and no lockedCorrection: the ordinary payroll lock refuses, as before", async () => {
    await seed({ authStatus: null, stage: 2 });
    await assert.rejects(decideFinal({ lockedCorrection: null }), /locked/i);
    assert.deepEqual(await storedDay(), { punch_count: 2, approved_ot_minutes: 235 });
  });

  it("the write must match the authorisation's employee and date exactly", async () => {
    await seed({ stage: 2 });
    await assert.rejects(decideFinal({ calculations: [corrected({ attendance_date: "2026-09-13" })] }), /does not match/);
    await assert.rejects(decideFinal({ calculations: [corrected(), corrected({ attendance_date: "2026-09-13" })] }), /exactly one/);
    assert.deepEqual(await storedDay(), { punch_count: 2, approved_ot_minutes: 235 }, "rolled back");
    assert.equal((await auth()).status, "AUTHORISED");
    assert.equal((await events()).length, 0);
  });

  it("an intermediate stage of an authorised correction is recorded and writes no attendance", async () => {
    await seed();
    const out = await repo.decideStage({
      requestId: 300, stageNo: 1, decision: "APPROVED", actorId: RAISER + 100, adminOverride: false,
      next: { status: "PENDING", current_stage_no: 2, approved_ot_minutes: null }, calculations: [corrected()],
      attendanceLock: { employee_id: EMP, attendance_date: DATE }, lockedCorrection: { event: null },
    });
    assert.equal(out.code, 200);
    assert.equal(out.calculations_written, 0);
    assert.deepEqual(await storedDay(), { punch_count: 2, approved_ot_minutes: 235 });
    assert.equal((await auth()).status, "AUTHORISED");
  });

  it("a rejection in the locked month is recorded and writes nothing", async () => {
    await seed({ authStatus: "REQUIRED" });
    const out = await repo.decideStage({
      requestId: 300, stageNo: 1, decision: "REJECTED", actorId: RAISER + 100, remarks: "not needed", adminOverride: false,
      next: { status: "REJECTED", current_stage_no: 1, approved_ot_minutes: 0 }, calculations: [corrected()],
      attendanceLock: { employee_id: EMP, attendance_date: DATE }, allowRejectWhenLocked: true,
    });
    assert.equal(out.status, "REJECTED");
    assert.deepEqual(await storedDay(), { punch_count: 2, approved_ot_minutes: 235 });
  });

  it("revoke of an APPLIED correction writes the day back, APPENDS a REVOKE event, keeps the approval event", async () => {
    await seed({ stage: 2 });
    await decideFinal();
    const snap = await repo.getRevocationSnapshot(300);
    const out = await repo.revokeRequest({
      requestId: 300, stageNo: 2, originalDecision: "APPROVED", expectedFingerprint: snap.fingerprint, employeeId: EMP,
      actor: { employee_id: AUTHORISER, user_id: 5 }, reason: "Lunch was punched on paper after all",
      revocableTypes: REVOCABLE, calculations: [corrected({ punch_count: 2, approved_ot_minutes: 235 })],
      attendanceDate: DATE,
      lockedCorrection: { event: { ...EVENT, payroll_difference: { ...EVENT.payroll_difference, net_difference: 66.67, direction: "PAYABLE_TO_EMPLOYEE" } } },
    });
    assert.equal(out.code, 200);
    assert.equal(out.status, "CANCELLED");
    assert.deepEqual(await storedDay(), { punch_count: 2, approved_ot_minutes: 235 });
    assert.equal((await auth()).status, "REVOKED");
    const evs = await events();
    assert.deepEqual(evs.map((e) => [e.event_type, Number(e.net_difference), e.direction]), [
      ["APPROVAL", -66.67, "RECOVERABLE_FROM_EMPLOYEE"],
      ["REVOKE", 66.67, "PAYABLE_TO_EMPLOYEE"],
    ]);
    assert.equal(evs[1].event_reason, "Lunch was punched on paper after all");
    assert.equal(evs[1].actor_user_id, 5);
    const audit = await q(pool, "SELECT reason FROM attendance_approval_revocation WHERE attendance_approval_request_id = 300");
    assert.equal(audit.length, 1, "the ordinary revocation audit row is written too");
  });

  it("revoke without lockedCorrection in the locked month is refused, as before", async () => {
    await seed({ stage: 2 });
    await decideFinal();
    const snap = await repo.getRevocationSnapshot(300);
    await assert.rejects(
      repo.revokeRequest({
        requestId: 300, stageNo: 2, originalDecision: "APPROVED", expectedFingerprint: snap.fingerprint, employeeId: EMP,
        actor: { employee_id: AUTHORISER }, reason: "should be refused", revocableTypes: REVOCABLE,
        calculations: [corrected({ punch_count: 2 })], attendanceDate: DATE,
      }),
      /locked/i
    );
    assert.equal((await auth()).status, "APPLIED");
  });

  it("authorise: REQUIRED -> AUTHORISED once; refused when the month is not locked; created when the request predates the lock", async () => {
    await seed({ authStatus: "REQUIRED" });
    const ok = await repo.authoriseLockedCorrection({ request_id: 300, actor_employee_id: AUTHORISER, actor_user_id: 5, reason: "Verified with CCTV" });
    assert.equal(ok.code, 200);
    const [row] = await q(pool, "SELECT status, authorised_by_employee_id, authorised_by_user_id, authorisation_reason, authorised_at FROM attendance_locked_period_authorisation WHERE attendance_approval_request_id = 300");
    assert.equal(row.status, "AUTHORISED");
    assert.equal(row.authorised_by_employee_id, AUTHORISER);
    assert.equal(row.authorisation_reason, "Verified with CCTV");
    assert.ok(row.authorised_at);
    assert.equal((await repo.authoriseLockedCorrection({ request_id: 300, actor_employee_id: AUTHORISER, reason: "again" })).code, 409);

    await seed({ id: 301, authStatus: null, date: "2026-09-13" });
    assert.equal((await repo.authoriseLockedCorrection({ request_id: 301, actor_employee_id: AUTHORISER, reason: "Raised before the lock" })).code, 200);

    await q(pool, "UPDATE payrun_employee_calculation SET status = 'CALCULATED'");
    await seed({ id: 302, authStatus: null, date: "2026-09-14" });
    const notLocked = await repo.authoriseLockedCorrection({ request_id: 302, actor_employee_id: AUTHORISER, reason: "Not locked" });
    assert.equal(notLocked.code, 409);
    assert.match(notLocked.msg, /not locked/);
  });

  it("settlement moves PENDING_ADJUSTMENT -> SETTLED once and touches nothing else", async () => {
    await seed({ stage: 2 });
    const { locked_correction_event_id: id } = await decideFinal();
    const before = (await events())[0];
    const first = await repo.settleLockedCorrectionEvent({ event_id: id, applied_by: HR, applied_note: "Shortage recovery in Oct", applied_payroll_year: 2026, applied_payroll_month: 10 });
    assert.equal(first.updated, 1);
    const again = await repo.settleLockedCorrectionEvent({ event_id: id, applied_by: HR, applied_note: "twice", applied_payroll_year: 2026, applied_payroll_month: 11 });
    assert.equal(again.updated, 0);
    const after = (await events())[0];
    assert.equal(after.adjustment_status, "SETTLED");
    assert.equal(after.applied_by, HR);
    assert.equal(after.applied_payroll_month, 10);
    for (const k of ["old_calculation", "new_calculation", "payroll_difference", "net_difference", "direction"]) {
      assert.deepEqual(after[k], before[k], k);
    }
  });

  it("frozen payrun and stored day reads", async () => {
    const frozen = await repo.getFrozenPayrun(EMP, DATE);
    assert.equal(Number(frozen.daily_rate), 1000);
    assert.equal((await repo.getStoredDay(EMP, DATE)).punch_count, 2);
  });
});
