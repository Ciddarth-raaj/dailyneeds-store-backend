/**
 * AUTOMATIC PENDING OT, AS REAL SQL - the migration file itself, the
 * production repository's guarded writes, the open-request key, the payroll
 * lock taken FOR UPDATE, payroll's pending-OT count, and the production sync
 * and backfill over them.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_ot_auto_pending.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its tables, fills them and drops them again.
 *
 * WHAT IS STUBBED. Only the attendance ENGINE: each date's eligible OT is a
 * fixed figure the test sets, because the engine's arithmetic is proven
 * elsewhere (usecase/attendance_ot_auto_pending.test.js runs the real one).
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");
const buildCalcRepo = require("./attendance_calculation");
const buildPayrunRepo = require("./payrun");
const buildRegularization = require("../usecase/attendance_regularization");
const backfill = require("../scripts/attendance/ot-auto-pending-backfill");
const { istToday } = require("../utils/istDate");
const { addDays } = require("../utils/attendance_engine");

const SQL_DIR = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const UP = fs.readFileSync(path.join(SQL_DIR, "20261125120000-attendance-ot-auto-pending-up.sql"), "utf8");
const DOWN = fs.readFileSync(path.join(SQL_DIR, "20261125120000-attendance-ot-auto-pending-down.sql"), "utf8");
// Attendance correction before system OT: the AUTO_OT group, the one-pending-OT
// key and the deferred-sync tables.
const PRIORITY_UP = fs.readFileSync(path.join(SQL_DIR, "20261127120000-attendance-ot-correction-priority-up.sql"), "utf8");
const PRIORITY_DOWN = fs.readFileSync(path.join(SQL_DIR, "20261127120000-attendance-ot-correction-priority-down.sql"), "utf8");
// A PERMISSION raise reads the employee's attendance-mode history: the real
// table, taken from its own migration (as the permission suite does), so this
// suite never depends on a table another suite left behind.
const MODE_HISTORY_TABLE = fs
  .readFileSync(path.join(SQL_DIR, "20261108120000-employee-attendance-calculation-mode-up.sql"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n")
  .split(/;\s*(?:\n|$)/)
  .map((st) => st.trim())
  .find((st) => /^CREATE TABLE IF NOT EXISTS `employee_attendance_calculation_mode`/.test(st));

const EMP = 601;
const EMP2 = 602;
const SM3 = 31;
const TODAY = istToday();
const D1 = addDays(TODAY, -3);
const D2 = addDays(TODAY, -2);

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
     employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
     status VARCHAR(32) NOT NULL, PRIMARY KEY (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_regularized_punch (
     attendance_regularized_punch_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL, employee_id INT NOT NULL,
     attendance_date DATE NOT NULL, punch_time DATETIME NOT NULL,
     punch_source VARCHAR(16) NOT NULL DEFAULT 'REGULARIZED', created_by INT NOT NULL,
     created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
   ) ENGINE=InnoDB`,
];
const TABLES = [
  "employee_attendance_calculation_mode",
  "attendance_regularized_punch",
  "attendance_ot_deferred_sync_log",
  "attendance_ot_deferred_sync",
  "attendance_ot_auto_pending_log",
  "attendance_ot_auto_pending_setting",
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

describe("automatic pending OT, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  let calcRepo;
  let usecase;
  let engineCalc;
  /** The engine's eligible OT per `${employee}:${date}`; absent = no OT. */
  const eligible = new Map();
  /** `${employee}:${date}` with no punches at all (leave, absence, weekly off). */
  const absent = new Set();

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=8&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    await q(pool, UP);
    await q(pool, PRIORITY_UP);
    await q(pool, MODE_HISTORY_TABLE);
    repo = buildRepo(pool);
    calcRepo = buildCalcRepo(pool);
    const engine = {
      findPayrollLockedPeriods: (rows) => calcRepo.findPayrollLockedPeriods(rows),
      attendanceDayState: () => ({ closed: true, reason: null, closes_at: null }),
      employmentWindowFor: async () => ({ joined_on: "2020-01-01", ended_on: null }),
      calculateRange: async ({ employee_id, from_date, to_date }) => {
        const out = [];
        for (let d = from_date; d <= to_date; d = addDays(d, 1)) {
          const ot = eligible.get(`${employee_id}:${d}`) || 0;
          const off = absent.has(`${employee_id}:${d}`);
          out.push({
            employee_id, attendance_date: d, status: off ? "ABSENT" : "FINAL", is_final: true, punch_count: off ? 0 : 2,
            shift_snapshot: { work_shift_id: 7, shift_code: "GEN", in_time: "09:00:00", out_time: "18:00:00" },
            effective_punches: off ? [] : [{ io_time: `${d} 08:58:00` }, { io_time: `${d} 19:05:00` }],
            worked_minutes: 600, candidate_ot_minutes: ot, excess_ot_minutes: ot, attendance_calculation_mode: "STANDARD",
          });
        }
        return out;
      },
      toStorageRow: (d) => d,
    };
    usecase = buildRegularization(repo, engine);
    engineCalc = engine.calculateRange;
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((resolve) => pool.end(resolve));
  });

  beforeEach(async () => {
    eligible.clear();
    absent.clear();
    for (const t of TABLES.filter((x) => x !== "attendance_ot_auto_pending_setting")) await q(pool, `DELETE FROM ${t}`);
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET enabled = 1, auto_pending_from_date = ? WHERE setting_id = 1", [addDays(TODAY, -5)]);
    await q(pool, "INSERT INTO designation VALUES (1, 'Staff'), (2, 'Store Manager')");
    await q(pool, "INSERT INTO attendance_approval_role VALUES (2, 'STORE_MANAGER', 'MANAGER')");
    await q(pool, "INSERT INTO outlets VALUES (3, 'DN3')");
    await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id, designation_id) VALUES ?", [[[EMP, "Staff A", 3, 1], [EMP2, "Staff B", 3, 1], [SM3, "Manager DN3", 3, 2]]]);
  });

  const otRows = (emp = EMP) =>
    q(pool, `SELECT attendance_approval_request_id AS id, DATE_FORMAT(attendance_date, '%Y-%m-%d') AS d, status,
                    candidate_ot_minutes AS minutes, auto_created FROM attendance_approval_request
              WHERE requested_for_employee_id = ? AND request_type = 'OT' ORDER BY id`, [emp]);
  const log = () => q(pool, "SELECT action, previous_ot_minutes AS prev, new_ot_minutes AS next, trigger_source AS src FROM attendance_ot_auto_pending_log ORDER BY attendance_ot_auto_pending_log_id");

  it("the migration seeds ONE enabled cutover row at the IST deploy date (ongoing automation starts at deploy), idempotently", async () => {
    await q(pool, "DROP TABLE attendance_ot_auto_pending_log");
    await q(pool, "DROP TABLE attendance_ot_auto_pending_setting");
    await q(pool, UP);
    await q(pool, UP);
    const rows = await q(pool, "SELECT setting_id, enabled, DATE_FORMAT(auto_pending_from_date, '%Y-%m-%d') AS d FROM attendance_ot_auto_pending_setting");
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].enabled), 1);
    assert.equal(rows[0].d, TODAY);
    assert.deepEqual({ ...(await repo.getAutoOtSetting()) }, { enabled: 1, auto_pending_from_date: TODAY });
  });

  it("the down drops exactly the two new tables; the setting reads null (disabled) without them", async () => {
    await q(pool, DOWN);
    assert.equal(await repo.getAutoOtSetting(), null);
    assert.deepEqual(await repo.listAutoOtLog([1]), []);
    await q(pool, UP);
  });

  it("creates a pending OT through the real chain, and a second run creates nothing", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    const first = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "RECALCULATION" });
    assert.equal(first.created.length, 1, JSON.stringify(first));
    const second = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "RECALCULATION" });
    assert.equal(second.created.length, 0);
    const rows = await otRows();
    assert.deepEqual(rows.map((r) => [r.d, r.status, r.minutes, Number(r.auto_created)]), [[D1, "PENDING", 60, 1]]);
    const steps = await q(pool, "SELECT stage_no, approver_role, outlet_id FROM attendance_approval_step WHERE attendance_approval_request_id = ? ORDER BY stage_no", [rows[0].id]);
    assert.equal(steps[0].approver_role, "STORE_MANAGER");
    assert.equal(Number(steps[0].outlet_id), 3);
    assert.deepEqual((await log()).map((l) => [l.action, l.next, l.src]), [["CREATED", 60, "RECALCULATION"]]);
  });

  it("concurrent runs: the open-request key admits exactly one pending OT", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    const runs = await Promise.all([1, 2, 3, 4].map(() => usecase.syncAutoOt({ employee_id: EMP, dates: [D1] })));
    assert.equal((await otRows()).length, 1);
    assert.equal(runs.reduce((n, r) => n + r.created.length, 0), 1);
    assert.deepEqual(runs.flatMap((r) => r.errors), []);
  });

  it("minutes follow the engine under the guard, audited; a moved figure is refused", async () => {
    eligible.set(`${EMP}:${D1}`, 90);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    eligible.set(`${EMP}:${D1}`, 60);
    const out = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "DECISION_REGULARIZATION" });
    assert.deepEqual(out.updated.map((u) => [u.previous_ot_minutes, u.ot_minutes]), [[90, 60]]);
    const [row] = await otRows();
    assert.equal(row.minutes, 60);
    assert.deepEqual({ ...(await log()).pop() }, { action: "MINUTES_CHANGED", prev: 90, next: 60, src: "DECISION_REGULARIZATION" });
    assert.deepEqual(await repo.setPendingOtMinutes({ requestId: row.id, fromMinutes: 90, toMinutes: 30 }), { updated: false, reason: "MOVED" });
  });

  it("an increase after a stage approved is refused by the repository itself", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    const [row] = await otRows();
    await q(pool, "UPDATE attendance_approval_step SET decision = 'APPROVED', decided_by_employee_id = ? WHERE attendance_approval_request_id = ? AND stage_no = 1", [SM3, row.id]);
    await q(pool, "UPDATE attendance_approval_request SET current_stage_no = 2 WHERE attendance_approval_request_id = ?", [row.id]);
    assert.deepEqual(await repo.setPendingOtMinutes({ requestId: row.id, fromMinutes: 60, toMinutes: 90 }), { updated: false, reason: "INCREASE_AFTER_PARTIAL_APPROVAL" });
    assert.deepEqual(await repo.setPendingOtMinutes({ requestId: row.id, fromMinutes: 60, toMinutes: 45 }), { updated: true });
  });

  it("withdrawal: only an undecided SYSTEM request, CANCELLED with its steps SKIPPED", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    eligible.delete(`${EMP}:${D1}`);
    const out = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "RECALCULATION" });
    assert.equal(out.withdrawn.length, 1);
    const [row] = await otRows();
    assert.equal(row.status, "CANCELLED");
    const steps = await q(pool, "SELECT DISTINCT decision FROM attendance_approval_step WHERE attendance_approval_request_id = ?", [row.id]);
    assert.deepEqual(steps.map((s) => s.decision), ["SKIPPED"]);
    // An employee-raised request is never withdrawn by the system.
    await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, candidate_ot_minutes, auto_created, total_stages)
                   VALUES ('OT', ?, ?, ?, 'Stock count', 60, 0, 1)`, [EMP2, EMP2, D1]);
    const [manual] = await otRows(EMP2);
    assert.deepEqual(await repo.withdrawAutoOtRequest({ requestId: manual.id }), { withdrawn: false, reason: "NOT_WITHDRAWABLE" });
  });

  it("decided records are never touched; a decision racing a minutes update leaves one consistent row", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    eligible.set(`${EMP}:${D2}`, 30);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1, D2] });
    const [a, b] = await otRows();
    await q(pool, "UPDATE attendance_approval_request SET status = 'APPROVED', approved_ot_minutes = 60, finalization_state = 'SETTLED' WHERE attendance_approval_request_id = ?", [a.id]);
    await q(pool, "UPDATE attendance_approval_request SET status = 'REJECTED', approved_ot_minutes = 0, finalization_state = 'SETTLED' WHERE attendance_approval_request_id = ?", [b.id]);
    eligible.set(`${EMP}:${D1}`, 15);
    eligible.set(`${EMP}:${D2}`, 90);
    const out = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1, D2] });
    assert.equal(out.preserved_approved.length, 1);
    assert.equal(out.preserved_rejected.length, 1);
    assert.deepEqual((await otRows()).map((r) => [r.status, r.minutes]), [["APPROVED", 60], ["REJECTED", 30]]);
    assert.equal(out.created.length, 0, "a rejected date is never re-raised");

    // The race: the guarded update loses to a decision that commits first.
    eligible.set(`${EMP2}:${D1}`, 60);
    await usecase.syncAutoOt({ employee_id: EMP2, dates: [D1] });
    const [c] = await otRows(EMP2);
    const step = await repo.decideStage({
      requestId: c.id, stageNo: 1, decision: "REJECTED", actorId: SM3, remarks: "Not authorised",
      adminOverride: false, next: { status: "REJECTED", current_stage_no: 1, approved_ot_minutes: 0 }, calculations: [],
    });
    assert.equal(step.code, 200);
    assert.deepEqual(await repo.setPendingOtMinutes({ requestId: c.id, fromMinutes: 60, toMinutes: 45 }), { updated: false, reason: "MOVED" });
    const again = await repo.decideStage({
      requestId: c.id, stageNo: 1, decision: "APPROVED", actorId: SM3, remarks: null,
      adminOverride: false, next: { status: "APPROVED", current_stage_no: 1, approved_ot_minutes: 60 }, calculations: [],
    });
    assert.equal(again.code, 409, "approve after reject is refused by the guarded UPDATE");
  });

  it("approval vs recalculation: an approval computed from minutes a recalculation has since moved is refused under the lock", async () => {
    eligible.set(`${EMP}:${D1}`, 120);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    const [r] = await otRows();
    // The approver read 120; a punch void is recalculated and the sync lowers
    // the pending OT to 60 before the decision's transaction runs.
    eligible.set(`${EMP}:${D1}`, 60);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    assert.equal((await otRows())[0].minutes, 60);
    const stale = await repo.decideStage({
      requestId: r.id, stageNo: 1, decision: "APPROVED", actorId: SM3, remarks: null, adminOverride: false,
      next: { status: "APPROVED", current_stage_no: 1, approved_ot_minutes: 120 }, calculations: [],
      expectCandidateOtMinutes: 120,
    });
    assert.equal(stale.code, 409);
    assert.equal(stale.ot_minutes_changed, true, "told apart from a moved decision, so the card is re-presented");
    assert.equal(stale.candidate_ot_minutes, 60);
    const [after] = await otRows();
    assert.deepEqual([after.status, after.minutes], ["PENDING", 60], "nothing approved, nothing over-approved");
    const steps = await q(pool, "SELECT decision FROM attendance_approval_step WHERE attendance_approval_request_id = ?", [r.id]);
    assert.ok(steps.every((x) => x.decision === "PENDING"), "the step write rolled back too");
    // Decided on the current figure, it goes through.
    const fresh = await repo.decideStage({
      requestId: r.id, stageNo: 1, decision: "APPROVED", actorId: SM3, remarks: null, adminOverride: false,
      next: { status: "APPROVED", current_stage_no: 2, approved_ot_minutes: 60 }, calculations: [],
      expectCandidateOtMinutes: 60,
    });
    assert.equal(fresh.code, 200);
  });

  it("a date whose open slot a PENDING regularization holds: not raised, and REPORTED with its minutes - preview and apply alike", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, candidate_ot_minutes, auto_created, total_stages)
                   VALUES ('REGULARIZATION', ?, ?, ?, 'Missed punch', 0, 0, 1)`, [EMP, EMP, D1]);
    const [reg] = await q(pool, "SELECT attendance_approval_request_id AS id FROM attendance_approval_request WHERE request_type = 'REGULARIZATION'");
    for (const dry_run of [true, false]) {
      // eslint-disable-next-line no-await-in-loop
      const out = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], dry_run });
      assert.deepEqual(out.created, [], `dry_run=${dry_run}: nothing promised, nothing created`);
      assert.deepEqual(out.skipped.map((x) => [x.reason, x.eligible_ot_minutes, x.blocking_request_id, x.blocking_request_type]),
        [["BLOCKED_BY_OPEN_REQUEST", 60, Number(reg.id), "REGULARIZATION"]]);
    }
    assert.equal((await otRows()).length, 0);
    // Once the regularization is no longer pending, the slot is free.
    await q(pool, "UPDATE attendance_approval_request SET status = 'APPROVED' WHERE attendance_approval_request_id = ?", [reg.id]);
    const freed = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    assert.equal(freed.created.length, 1);
  });


  /* ============ ATTENDANCE CORRECTION BEFORE SYSTEM OT, as SQL (migration 20261127120000) ==== */

  const CHAIN = [{ stage_no: 1, approver_role: "STORE_MANAGER", outlet_id: 3, approver_employee_id: null, approval_level: null }];
  const raise = (type, { emp = EMP, date = D1, auto = false, minutes = 0, by = emp } = {}) =>
    repo.createRequest({
      request: {
        request_type: type, requested_for_employee_id: emp, requested_by_employee_id: by, attendance_date: date,
        outlet_id: 3, requester_class: "STAFF", reason: `${type} for the test`, candidate_ot_minutes: minutes,
        auto_created: auto, chain_source: "ROLE",
      },
      chain: CHAIN,
      punch: null,
    });
  const requests = (emp = EMP) =>
    q(pool, `SELECT attendance_approval_request_id AS id, request_type AS type, status, auto_created AS auto, open_request_group AS grp
               FROM attendance_approval_request WHERE requested_for_employee_id = ? ORDER BY id`, [emp]);
  const deferredRows = () => q(pool, "SELECT employee_id, DATE_FORMAT(attendance_date, '%Y-%m-%d') AS d, status, resolution, blocking_request_type AS type FROM attendance_ot_deferred_sync ORDER BY deferred_sync_id");
  const deferredLog = () => q(pool, "SELECT action, trigger_source AS src FROM attendance_ot_deferred_sync_log ORDER BY deferred_sync_log_id");

  it("1/2. a pending SYSTEM OT does not block a regularization (employee or HR) or a permission; manual requests still exclude each other", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    assert.equal((await requests())[0].grp, "AUTO_OT", "the system OT holds its own group, not the correction's slot");
    // The date can never hold a second pending OT, system or manual - the
    // one-pending-OT key, on its own.
    await assert.rejects(raise("OT", { minutes: 30 }), (err) => err.code === "ER_DUP_ENTRY" && /uq_aareq_open_ot_per_employee_date/.test(err.message));
    await assert.rejects(raise("OT", { auto: true, minutes: 30 }), (err) => err.code === "ER_DUP_ENTRY");
    // An employee's own regularization, and an HR correction for another date.
    assert.ok((await raise("REGULARIZATION")).attendance_approval_request_id);
    await raise("PERMISSION");
    // ...but two manual corrections on one date still cannot coexist.
    await assert.rejects(raise("REGULARIZATION", { by: SM3 }), (err) => err.code === "ER_DUP_ENTRY");
    // An HR correction on a date with a pending system OT is raised too.
    eligible.set(`${EMP}:${D2}`, 45);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D2] });
    assert.ok((await raise("REGULARIZATION", { date: D2, by: SM3 })).attendance_approval_request_id);
    assert.equal((await repo.findOpenRequest(EMP, D2)).request_type, "REGULARIZATION");
    assert.equal((await repo.findOpenRequest(EMP, D1)).request_type, "REGULARIZATION", "the open request a correction waits on is never the system OT");
  });

  it("3/9. while a correction is pending the OT is not decided: refused under the OT row lock, nothing written", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    const [ot] = await otRows();
    const reg = await raise("REGULARIZATION");
    const out = await repo.decideStage({
      requestId: ot.id, stageNo: 1, decision: "APPROVED", actorId: SM3, remarks: null, adminOverride: false,
      next: { status: "APPROVED", current_stage_no: 1, approved_ot_minutes: 60 }, calculations: [],
      expectCandidateOtMinutes: 60, refuseWhileCorrectionPending: { employee_id: EMP, attendance_date: D1 },
    });
    assert.equal(out.code, 409);
    assert.equal(out.waiting_for_correction, true);
    assert.equal(out.reason_code, "ATTENDANCE_CORRECTION_PENDING");
    assert.equal(out.blocking_request_id, Number(reg.attendance_approval_request_id));
    assert.equal(out.msg, "Attendance is being corrected. OT will be recalculated before approval.");
    assert.equal((await otRows())[0].status, "PENDING");
    const steps = await q(pool, "SELECT decision FROM attendance_approval_step WHERE attendance_approval_request_id = ?", [ot.id]);
    assert.ok(steps.every((x) => x.decision === "PENDING"));
    // The usecase answers the same before any work (DnDS, bulk, Telegram).
    const early = await usecase.decide({ actor: { employee_id: SM3, user_type: 2 }, request_id: ot.id, decision: "APPROVED" });
    assert.equal(early.waiting_for_correction, true);
  });

  it("concurrency: a correction raised while an approval runs - they serialize on the OT row; the approval sees the correction and is refused", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    const [ot] = await otRows();
    // The correction's transaction takes the OT row first (as createRequest does) and has not committed yet.
    const conn = await new Promise((resolve, reject) => pool.getConnection((e, c) => (e ? reject(e) : resolve(c))));
    const cq = (sql, params = []) => new Promise((resolve, reject) => conn.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));
    await cq("START TRANSACTION");
    await cq("SELECT attendance_approval_request_id FROM attendance_approval_request WHERE requested_for_employee_id = ? AND attendance_date = ? AND request_type = 'OT' AND status = 'PENDING' FOR UPDATE", [EMP, D1]);
    await cq(`INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, candidate_ot_minutes, auto_created, total_stages)
              VALUES ('REGULARIZATION', ?, ?, ?, 'Missed punch', 0, 0, 1)`, [EMP, EMP, D1]);
    let settled = false;
    const approval = repo.decideStage({
      requestId: ot.id, stageNo: 1, decision: "APPROVED", actorId: SM3, remarks: null, adminOverride: false,
      next: { status: "APPROVED", current_stage_no: 1, approved_ot_minutes: 60 }, calculations: [],
      expectCandidateOtMinutes: 60, refuseWhileCorrectionPending: { employee_id: EMP, attendance_date: D1 },
    }).then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(settled, false, "the approval waits on the OT row the correction holds");
    await cq("COMMIT");
    conn.release();
    const out = await approval;
    assert.equal(out.waiting_for_correction, true, "the correction won: the approval is refused, never committed over it");
    assert.equal((await otRows())[0].status, "PENDING");
  });

  it("concurrency: the approval first - the correction waits on the OT row and then follows the approved OT (no silent overpayment)", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    const [ot] = await otRows();
    const [approve, correction] = await Promise.all([
      repo.decideStage({
        requestId: ot.id, stageNo: 1, decision: "APPROVED", actorId: SM3, remarks: null, adminOverride: false,
        next: { status: "APPROVED", current_stage_no: 1, approved_ot_minutes: 60 }, calculations: [],
        expectCandidateOtMinutes: 60, refuseWhileCorrectionPending: { employee_id: EMP, attendance_date: D1 },
      }),
      raise("REGULARIZATION"),
    ]);
    const [o] = await otRows();
    // Exactly one consistent outcome, whichever transaction won the OT row.
    if (approve.code === 200) assert.equal(o.status, "APPROVED");
    else { assert.equal(approve.waiting_for_correction, true); assert.equal(o.status, "PENDING"); }
    assert.ok(correction.attendance_approval_request_id, "the correction is always raised");
  });

  it("10/11/15. backfill: a date a correction holds is REMEMBERED on --apply only; a preview writes nothing; a re-run adds no second marker", async () => {
    // A pre-cutover date: the cutover is the deploy date.
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET auto_pending_from_date = ? WHERE setting_id = 1", [TODAY]);
    eligible.set(`${EMP}:${D1}`, 90);
    await raise("REGULARIZATION");
    const args = { employee_id: EMP, dates: [D1], source: "BACKFILL", notify: false, allow_creation_from: D1, track_deferred: true };
    const preview = await usecase.syncAutoOt({ ...args, dry_run: true });
    assert.deepEqual(preview.deferred.map((d) => [d.attendance_date, d.eligible_ot_minutes, d.blocking_request_type, d.blocking_request_kind, d.recorded]),
      [[D1, 90, "REGULARIZATION", "EMPLOYEE_REGULARIZATION", false]]);
    assert.deepEqual(await deferredRows(), [], "11. a preview creates no marker");
    const applied = await usecase.syncAutoOt(args);
    assert.equal(applied.deferred[0].recorded, true);
    assert.deepEqual((await deferredRows()).map((r) => [r.employee_id, r.d, r.status, r.type]), [[EMP, D1, "WAITING_FOR_CORRECTION", "REGULARIZATION"]]);
    assert.equal((await otRows()).length, 0, "no OT from the uncorrected day");
    const again = await usecase.syncAutoOt(args);
    assert.equal(again.deferred[0].recorded, false);
    assert.equal((await deferredRows()).length, 1, "15. one marker per employee and date");
    assert.deepEqual((await deferredLog()).map((l) => l.action), ["DEFERRED"]);
  });

  it("12/13/14. the correction decided: OT is re-run for THAT pre-cutover date only; the cutover does not move; other old dates stay closed", async () => {
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET auto_pending_from_date = ? WHERE setting_id = 1", [TODAY]);
    eligible.set(`${EMP}:${D1}`, 90);
    eligible.set(`${EMP}:${D2}`, 45); // eligible too, but nobody remembered it
    const reg = await raise("REGULARIZATION");
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "BACKFILL", notify: false, allow_creation_from: D1, track_deferred: true });
    // The correction is decided (its decision re-runs the sync for its date).
    await q(pool, "UPDATE attendance_approval_request SET status = 'APPROVED' WHERE attendance_approval_request_id = ?", [reg.attendance_approval_request_id]);
    eligible.set(`${EMP}:${D1}`, 120); // the corrected day has more OT
    const decided = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1, D2], source: "DECISION_REGULARIZATION" });
    assert.deepEqual(decided.created.map((c) => [c.attendance_date, c.ot_minutes]), [[D1, 120]], "12. the remembered date only");
    assert.deepEqual(decided.skipped.map((x) => [x.attendance_date, x.reason]), [[D2, "BEFORE_CUTOVER"]], "14. no broad historical creation");
    assert.equal((await repo.getAutoOtSetting()).auto_pending_from_date, TODAY, "13. the cutover is untouched");
    const [m] = await deferredRows();
    assert.deepEqual([m.status, m.resolution], ["RESOLVED", "RESOLVED_OT_CREATED"]);
    assert.deepEqual((await deferredLog()).map((l) => l.action), ["DEFERRED", "SYNC_ATTEMPTED", "RESOLVED"]);
    // Resolved once: a later sync of the date is ordinary (no second create, no allowance left).
    const later = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    assert.equal(later.created.length, 0);
    assert.equal((await otRows()).length, 1);
  });

  it("4 (zero). a remembered date whose corrected day has no OT: nothing created, resolved NO_OT; another correction still open keeps it waiting", async () => {
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET auto_pending_from_date = ? WHERE setting_id = 1", [TODAY]);
    eligible.set(`${EMP}:${D1}`, 60);
    const reg = await raise("REGULARIZATION");
    const perm = await raise("PERMISSION");
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "BACKFILL", notify: false, allow_creation_from: D1, track_deferred: true });
    // The regularization is decided, the permission still pending: still blocked.
    await q(pool, "UPDATE attendance_approval_request SET status = 'REJECTED' WHERE attendance_approval_request_id = ?", [reg.attendance_approval_request_id]);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "DECISION_REGULARIZATION" });
    const [waiting] = await deferredRows();
    assert.deepEqual([waiting.status, waiting.type], ["WAITING_FOR_CORRECTION", "PERMISSION"]);
    assert.ok((await deferredLog()).some((l) => l.action === "STILL_BLOCKED"));
    // Now the permission is decided too, and the corrected day has no OT.
    await q(pool, "UPDATE attendance_approval_request SET status = 'APPROVED' WHERE attendance_approval_request_id = ?", [perm.attendance_approval_request_id]);
    eligible.delete(`${EMP}:${D1}`);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "DECISION_PERMISSION" });
    assert.deepEqual((await deferredRows()).map((r) => [r.status, r.resolution]), [["RESOLVED", "RESOLVED_NO_OT"]]);
    assert.equal((await otRows()).length, 0);
  });

  it("16. a remembered date's sync and an ordinary sync at once create ONE OT; the safety-net sweep resolves what a decision left", async () => {
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET auto_pending_from_date = ? WHERE setting_id = 1", [TODAY]);
    eligible.set(`${EMP}:${D1}`, 60);
    const reg = await raise("REGULARIZATION");
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "BACKFILL", notify: false, allow_creation_from: D1, track_deferred: true });
    await q(pool, "UPDATE attendance_approval_request SET status = 'APPROVED' WHERE attendance_approval_request_id = ?", [reg.attendance_approval_request_id]);
    const runs = await Promise.all([
      usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "DECISION_REGULARIZATION" }),
      usecase.resolveDeferredOt({ source: "DEFERRED_SWEEP" }),
      usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "RECALCULATION" }),
    ]);
    assert.equal((await otRows()).filter((r) => r.status === "PENDING").length, 1, "one pending OT, whoever ran first");
    assert.equal((await deferredRows())[0].status, "RESOLVED");
    assert.equal((await deferredLog()).filter((l) => l.action === "RESOLVED").length, 1, "resolved exactly once");
    assert.ok(runs);
  });

  it("17. a remembered date whose OT was already decided is never overwritten: PRESERVED_DECIDED", async () => {
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET auto_pending_from_date = ? WHERE setting_id = 1", [TODAY]);
    await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, candidate_ot_minutes, auto_created, total_stages, status, approved_ot_minutes)
                   VALUES ('OT', ?, ?, ?, 'decided before', 60, 1, 1, 'APPROVED', 60)`, [EMP, EMP, D1]);
    await repo.upsertDeferredOt({ employee_id: EMP, attendance_date: D1, blocking_request_id: 999, blocking_request_type: "REGULARIZATION", eligible_ot_minutes: 60 });
    eligible.set(`${EMP}:${D1}`, 15);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1], source: "DECISION_REGULARIZATION" });
    const [o] = await otRows();
    assert.deepEqual([o.status, o.minutes], ["APPROVED", 60]);
    assert.deepEqual((await deferredRows()).map((r) => r.resolution), ["RESOLVED_EXISTING_DECISION"]);
  });

  it("the migration: down restores the old groups, up again is clean (no rows rewritten)", async () => {
    await q(pool, PRIORITY_DOWN);
    const groups = await q(pool, "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_approval_request' AND COLUMN_NAME = 'open_request_group'");
    assert.equal(groups[0].t, "enum('ATT','SHIFT','PERM')");
    assert.equal((await q(pool, "SHOW TABLES LIKE 'attendance_ot_deferred_sync'")).length, 0);
    await q(pool, PRIORITY_UP);
    const again = await q(pool, "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_approval_request' AND COLUMN_NAME = 'open_request_group'");
    assert.equal(again[0].t, "enum('ATT','SHIFT','PERM','AUTO_OT')");
  });

  it("a payroll-locked month: nothing is raised, and the insert itself refuses under FOR UPDATE", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    await q(pool, "INSERT INTO payrun_employee_calculation VALUES (?, ?, ?, 'APPROVED_LOCKED')", [EMP, Number(D1.slice(0, 4)), Number(D1.slice(5, 7))]);
    const out = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    assert.deepEqual(out.skipped.map((s) => s.reason), ["PAYROLL_LOCKED"]);
    await assert.rejects(
      repo.createRequest({
        request: { request_type: "OT", requested_for_employee_id: EMP, requested_by_employee_id: EMP, attendance_date: D1, outlet_id: 3,
          requester_class: "STORE_EMPLOYEE", reason: "x", candidate_ot_minutes: 60, auto_created: true, refuse_when_payroll_locked: true },
        chain: [{ stage_no: 1, approver_role: "HR", outlet_id: null }],
        punch: null,
      }),
      (err) => err.code === "PAYROLL_MONTH_LOCKED"
    );
    assert.equal((await otRows()).length, 0);
  });

  it("payroll counts the system's pending OT as pending - never withdrawn, approved or rejected ones", async () => {
    eligible.set(`${EMP}:${D1}`, 60);
    eligible.set(`${EMP}:${D2}`, 30);
    await usecase.syncAutoOt({ employee_id: EMP, dates: [D1, D2] });
    const [, second] = await otRows();
    await q(pool, "UPDATE attendance_approval_request SET status = 'APPROVED', approved_ot_minutes = 30, finalization_state = 'SETTLED' WHERE attendance_approval_request_id = ?", [second.id]);
    const payrun = buildPayrunRepo(pool);
    const [counts] = await payrun.listPendingApprovals([EMP], addDays(TODAY, -10), TODAY);
    assert.equal(Number(counts.pending_ot), 1);
  });

  it("the backfill: 5 ATTENDANCE days per employee; preview writes nothing; apply creates once; the cutover is NOT moved", async () => {
    // EMP did not punch on -1, -4, -5, -6: its last 5 attendance days are
    // -2, -3, -7, -8, -9, so -9 (120 min) is in its window and -10 is not.
    [1, 4, 5, 6].forEach((n) => absent.add(`${EMP}:${addDays(TODAY, -n)}`));
    eligible.set(`${EMP}:${D1}`, 60);
    eligible.set(`${EMP}:${addDays(TODAY, -9)}`, 120);
    eligible.set(`${EMP}:${addDays(TODAY, -10)}`, 200);
    eligible.set(`${EMP2}:${D2}`, 45);
    // As deployed: the migration seeds the cutover at the deploy date, so
    // every date the backfill raises is BEFORE the cutover.
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET auto_pending_from_date = ? WHERE setting_id = 1", [TODAY]);
    const args = {
      calculateRange: engineCalc,
      syncAutoOt: usecase.syncAutoOt,
      listEmployees: async () => [{ employee_id: EMP }, { employee_id: EMP2 }],
      listApprovalAuthority: () => repo.listApprovalAuthority(),
      // The persisted attendance days: the stub engine's punched dates.
      listAttendedDates: async ({ employee_ids, from_date, to_date }) => {
        const out = [];
        for (const employee_id of employee_ids) {
          // eslint-disable-next-line no-await-in-loop
          (await engineCalc({ employee_id, from_date, to_date }))
            .filter((d) => d.punch_count > 0)
            .forEach((d) => out.push({ employee_id, attendance_date: d.attendance_date }));
        }
        return out;
      },
      setting: await repo.getAutoOtSetting(),
      today: TODAY, days: 5, lookback: 31, telegram: false,
    };
    const preview = await backfill.run({ ...args, apply: false });
    const mine = preview.detail.find((d) => d.employee_id === EMP);
    assert.equal(mine.from_date, addDays(TODAY, -9));
    assert.deepEqual(mine.attendance_dates_counted, [-9, -8, -7, -3, -2].map((n) => addDays(TODAY, n)));
    assert.equal(preview.detail.find((d) => d.employee_id === EMP2).from_date, addDays(TODAY, -5));
    assert.equal(preview.totals.new_pending_would_be_created, 3);
    assert.equal(preview.totals.new_pending_ot_minutes, 225);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_approval_request"))[0].n, 0);
    assert.equal((await repo.getAutoOtSetting()).auto_pending_from_date, TODAY, "preview leaves the cutover alone");

    const applied = await backfill.run({ ...args, apply: true });
    assert.equal(applied.totals.new_pending_created, 3);
    assert.equal((await repo.getAutoOtSetting()).auto_pending_from_date, TODAY, "the global cutover is untouched");
    const again = await backfill.run({ ...args, setting: await repo.getAutoOtSetting(), apply: true });
    assert.equal(again.totals.new_pending_created, 0);
    assert.equal(again.totals.already_pending_unchanged, 3);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_approval_request"))[0].n, 3);
    // Ongoing automation does not reach back: -10 (eligible, in nobody's
    // window, before the cutover) is still not raised by a later sync.
    const later = await usecase.syncAutoOt({ employee_id: EMP, dates: [addDays(TODAY, -10)] });
    assert.deepEqual(later.created, []);
    // ...and not even inside a backfilled window: a newly eligible date
    // there (-7) is not raised by ongoing automation, which starts at deploy.
    eligible.set(`${EMP}:${addDays(TODAY, -7)}`, 30);
    const inWindow = await usecase.syncAutoOt({ employee_id: EMP, dates: [addDays(TODAY, -7)] });
    assert.deepEqual(inWindow.created, []);
    // But a record the backfill created is still followed by recalculation.
    eligible.set(`${EMP}:${D1}`, 75);
    const followed = await usecase.syncAutoOt({ employee_id: EMP, dates: [D1] });
    assert.equal(followed.updated.length, 1);
  });

  it("the chain check reads active employees and their mapped roles", async () => {
    const rows = await repo.listApprovalAuthority();
    const sm = rows.find((r) => Number(r.employee_id) === SM3);
    assert.equal(sm.approver_role, "STORE_MANAGER");
    assert.equal(Number(sm.outlet_id), 3);
    assert.equal(rows.find((r) => Number(r.employee_id) === EMP).approver_role, null);
  });
});
