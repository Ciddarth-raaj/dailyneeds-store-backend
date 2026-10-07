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
const UP = fs.readFileSync(path.join(SQL_DIR, "20261124120000-attendance-ot-auto-pending-up.sql"), "utf8");
const DOWN = fs.readFileSync(path.join(SQL_DIR, "20261124120000-attendance-ot-auto-pending-down.sql"), "utf8");

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
];
const TABLES = [
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

  it("the migration seeds ONE enabled cutover row at the IST date five days back, idempotently", async () => {
    await q(pool, "DROP TABLE attendance_ot_auto_pending_log");
    await q(pool, "DROP TABLE attendance_ot_auto_pending_setting");
    await q(pool, UP);
    await q(pool, UP);
    const rows = await q(pool, "SELECT setting_id, enabled, DATE_FORMAT(auto_pending_from_date, '%Y-%m-%d') AS d FROM attendance_ot_auto_pending_setting");
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].enabled), 1);
    assert.equal(rows[0].d, addDays(TODAY, -5));
    assert.deepEqual({ ...(await repo.getAutoOtSetting()) }, { enabled: 1, auto_pending_from_date: addDays(TODAY, -5) });
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

  it("the backfill: 5 ATTENDANCE days per employee; preview writes nothing; apply creates once; the cutover is lowered", async () => {
    // EMP did not punch on -1, -4, -5, -6: its last 5 attendance days are
    // -2, -3, -7, -8, -9, so -9 (120 min) is in its window and -10 is not.
    [1, 4, 5, 6].forEach((n) => absent.add(`${EMP}:${addDays(TODAY, -n)}`));
    eligible.set(`${EMP}:${D1}`, 60);
    eligible.set(`${EMP}:${addDays(TODAY, -9)}`, 120);
    eligible.set(`${EMP}:${addDays(TODAY, -10)}`, 200);
    eligible.set(`${EMP2}:${D2}`, 45);
    const args = {
      calculateRange: engineCalc,
      syncAutoOt: usecase.syncAutoOt,
      listEmployees: async () => [{ employee_id: EMP }, { employee_id: EMP2 }],
      listApprovalAuthority: () => repo.listApprovalAuthority(),
      lowerCutover: (d) => repo.lowerAutoOtCutover(d),
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
    assert.equal((await repo.getAutoOtSetting()).auto_pending_from_date, addDays(TODAY, -5), "preview leaves the cutover alone");

    const applied = await backfill.run({ ...args, apply: true });
    assert.equal(applied.totals.new_pending_created, 3);
    assert.equal((await repo.getAutoOtSetting()).auto_pending_from_date, addDays(TODAY, -9), "lowered to the earliest window");
    const again = await backfill.run({ ...args, setting: await repo.getAutoOtSetting(), apply: true });
    assert.equal(again.totals.new_pending_created, 0);
    assert.equal(again.totals.already_pending_unchanged, 3);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_approval_request"))[0].n, 3);
    // The cutover is only ever lowered.
    await repo.lowerAutoOtCutover(TODAY);
    assert.equal((await repo.getAutoOtSetting()).auto_pending_from_date, addDays(TODAY, -9));
  });

  it("the chain check reads active employees and their mapped roles", async () => {
    const rows = await repo.listApprovalAuthority();
    const sm = rows.find((r) => Number(r.employee_id) === SM3);
    assert.equal(sm.approver_role, "STORE_MANAGER");
    assert.equal(Number(sm.outlet_id), 3);
    assert.equal(rows.find((r) => Number(r.employee_id) === EMP).approver_role, null);
  });
});
