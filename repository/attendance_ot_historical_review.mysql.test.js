/**
 * HISTORICAL OT REVIEW, AS REAL SQL - its migration, the preview's candidate
 * query, the review's own writes, and the real OT sync creating Pending OT in
 * an UNLOCKED and a LOCKED month through the production `createRequest`
 * (which re-proves the HISTORICAL_REVIEW marker FOR UPDATE).
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_ot_historical_review.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database. Only the
 * attendance ENGINE is stubbed (each date's eligible OT is a fixed figure).
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");
const buildCalcRepo = require("./attendance_calculation");
const buildReviewRepo = require("./attendance_ot_historical_review");
const buildRegularization = require("../usecase/attendance_regularization");
const buildReview = require("../usecase/attendance_ot_historical_review");
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

const REVIEW_UP = fs.readFileSync(path.join(SQL_DIR, "20261128120000-attendance-ot-historical-review-up.sql"), "utf8");
const REVIEW_DOWN = fs.readFileSync(path.join(SQL_DIR, "20261128120000-attendance-ot-historical-review-down.sql"), "utf8");
const LATE_UP = fs.readFileSync(path.join(SQL_DIR, "20261126120000-attendance-ot-late-settlement-up.sql"), "utf8");

const EMP = 945; // unlocked September
const EMP2 = 946; // locked September
const SM3 = 31;
const SEP4 = "2026-09-04";
const NOW = Date.parse("2026-10-08T12:00:00+05:30");

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
const EXTRA = [
  `CREATE TABLE all_permissions (permission_key VARCHAR(80) PRIMARY KEY)`,
  `CREATE TABLE permissions (permission_key VARCHAR(80), designation_id INT)`,
  `CREATE TABLE attendance_day_calculation (
     employee_id INT NOT NULL, attendance_date DATE NOT NULL, status VARCHAR(32) NOT NULL, is_final TINYINT(1) NOT NULL,
     punch_count INT NOT NULL DEFAULT 0, candidate_ot_minutes INT NOT NULL DEFAULT 0,
     shift_authorised_ot_minutes INT NOT NULL DEFAULT 0, approved_ot_minutes INT NOT NULL DEFAULT 0,
     PRIMARY KEY (employee_id, attendance_date)) ENGINE=InnoDB`,
];
const TABLES = [
  "attendance_ot_historical_review_raised",
  "attendance_ot_historical_review_item",
  "attendance_ot_historical_review_batch",
  "attendance_ot_late_settlement_log",
  "attendance_ot_late_settlement",
  "attendance_day_calculation",
  "permissions",
  "all_permissions",
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

describe("Historical OT Review, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let reviewRepo;
  let review;
  const eligible = new Map();

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=8&multipleStatements=true`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    for (const ddl of [...SCHEMA, ...EXTRA]) await q(pool, ddl);
    // The payrun calculation table here is the stand-in plus the two columns the preview reads.
    await q(pool, "ALTER TABLE new_employee ADD COLUMN date_of_joining VARCHAR(40) NULL");
    await q(pool, "ALTER TABLE payrun_employee_calculation ADD COLUMN payrun_calculation_id BIGINT NULL, ADD COLUMN published_at DATETIME NULL");
    await q(pool, UP);
    await q(pool, PRIORITY_UP);
    await q(pool, MODE_HISTORY_TABLE);
    await q(pool, LATE_UP);
    await q(pool, REVIEW_UP);
    const repo = buildRepo(pool);
    const calcRepo = buildCalcRepo(pool);
    const engine = {
      findPayrollLockedPeriods: (rows) => calcRepo.findPayrollLockedPeriods(rows),
      attendanceDayState: () => ({ closed: true, reason: null, closes_at: null }),
      employmentWindowFor: async () => ({ joined_on: "2020-01-01", ended_on: null }),
      calculateRange: async ({ employee_id, from_date, to_date }) => {
        const out = [];
        for (let d = from_date; d <= to_date; d = addDays(d, 1)) {
          const ot = eligible.get(`${employee_id}:${d}`) || 0;
          out.push({
            employee_id, attendance_date: d, status: "FINAL", is_final: true, punch_count: 2,
            shift_snapshot: { work_shift_id: 7, shift_code: "GEN", in_time: "09:00:00", out_time: "18:00:00" },
            effective_punches: [{ io_time: `${d} 08:58:00` }, { io_time: `${d} 18:22:00` }],
            worked_minutes: 600, candidate_ot_minutes: ot, excess_ot_minutes: ot, attendance_calculation_mode: "STANDARD",
          });
        }
        return out;
      },
      toStorageRow: (d) => d,
    };
    reviewRepo = buildReviewRepo(pool);
    review = buildReview({ reviewRepo, regularization: buildRegularization(repo, engine) });
  });

  after(async () => {
    if (!pool) return;
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    await new Promise((resolve) => pool.end(resolve));
  });

  beforeEach(async () => {
    eligible.clear();
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES.filter((x) => !["attendance_ot_auto_pending_setting", "all_permissions"].includes(x))) await q(pool, `DELETE FROM ${t}`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    // The production cutover: 7 Oct.
    await q(pool, "UPDATE attendance_ot_auto_pending_setting SET enabled = 1, auto_pending_from_date = '2026-10-07' WHERE setting_id = 1");
    await q(pool, "INSERT INTO designation VALUES (1, 'Staff'), (2, 'Store Manager')");
    await q(pool, "INSERT INTO attendance_approval_role VALUES (2, 'STORE_MANAGER', 'MANAGER')");
    await q(pool, "INSERT INTO outlets VALUES (3, 'DN3')");
    await q(pool, "INSERT INTO new_employee (employee_id, employee_name, store_id, designation_id) VALUES ?", [[[EMP, "Mritunjay Kharwar", 3, 1], [EMP2, "Staff Locked", 3, 1], [SM3, "Manager DN3", 3, 2]]]);
    for (const id of [EMP, EMP2]) {
      eligible.set(`${id}:${SEP4}`, 22);
      await q(pool, "INSERT INTO attendance_day_calculation VALUES (?, ?, 'FINAL', 1, 2, 22, 0, 0)", [id, SEP4]);
    }
    await q(pool, "INSERT INTO payrun_employee_calculation (employee_id, period_year, period_month, status, payrun_calculation_id, published_at) VALUES (?, 2026, 9, 'APPROVED_LOCKED', 7001, '2026-10-06 10:00:00')", [EMP2]);
  });

  const otRows = (emp) =>
    q(pool, `SELECT attendance_approval_request_id AS id, DATE_FORMAT(attendance_date, '%Y-%m-%d') AS d, status,
                    candidate_ot_minutes AS minutes, auto_created, reason FROM attendance_approval_request
              WHERE requested_for_employee_id = ? AND request_type = 'OT' ORDER BY id`, [emp]);

  it("the migration: three review tables and the permission key, granted to nobody; down removes them", async () => {
    const [perm] = await q(pool, "SELECT COUNT(*) AS n FROM all_permissions WHERE permission_key = 'attendance_ot_historical_review'");
    assert.equal(Number(perm.n), 1);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM permissions"))[0].n, 0);
    await q(pool, REVIEW_DOWN);
    const left = await q(pool, "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'attendance_ot_historical_review%'");
    assert.equal(left.length, 0);
    await q(pool, REVIEW_UP);
    await q(pool, REVIEW_UP); // idempotent
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM all_permissions WHERE permission_key = 'attendance_ot_historical_review'"))[0].n, 1);
  });

  it("PREVIEW over real SQL: 945 unlocked -> CREATE_PENDING_OT; 946 published -> Prior-Month route; nothing written", async () => {
    const p = await review.preview({ now: NOW });
    assert.deepEqual([p.from_date, p.to_date, p.cutover], ["2026-09-01", "2026-10-06", "2026-10-07"]);
    assert.deepEqual(
      p.lines.map((l) => [l.employee_id, l.attendance_date, l.calculated_ot_minutes, l.payroll_status, l.payroll_calculation_id, l.proposed_action]),
      [
        [EMP, SEP4, 22, "NOT_CALCULATED", null, "CREATE_PENDING_OT"],
        [EMP2, SEP4, 22, "PUBLISHED", 7001, "CREATE_PENDING_OT_PRIOR_MONTH_SETTLEMENT"],
      ]
    );
    assert.deepEqual(p.summary.to_create, { entries: 2, minutes: 44, employees: 2 });
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_approval_request"))[0].n, 0);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_deferred_sync"))[0].n, 0);
  });

  it("AUTHORISE over real SQL: Pending OT in both months (the locked one through the marker re-proved FOR UPDATE), audited, never twice", async () => {
    const p = await review.preview({ now: NOW });
    const out = await review.authorise({ actor: { employee_id: 1, user_id: 1 }, preview_hash: p.preview_hash, now: NOW });
    assert.deepEqual(out.summary, { authorised: 2, created: 2, skipped: 0, failed: 0, created_minutes: 44 });
    for (const emp of [EMP, EMP2]) {
      // eslint-disable-next-line no-await-in-loop
      const [ot] = await otRows(emp);
      assert.deepEqual([ot.d, ot.status, ot.minutes, ot.auto_created], [SEP4, "PENDING", 22, 1]);
      assert.match(ot.reason, /Historical OT review #\d+ \(item \d+\) for the 2026-09-04 work date/);
    }
    const items = await q(pool, "SELECT outcome, created_request_id, payroll_status, payroll_calculation_id FROM attendance_ot_historical_review_item ORDER BY employee_id");
    assert.deepEqual(items.map((i) => [i.outcome, i.payroll_status, i.payroll_calculation_id === null ? null : Number(i.payroll_calculation_id)]), [["CREATED", "NOT_CALCULATED", null], ["CREATED", "PUBLISHED", 7001]]);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_historical_review_raised"))[0].n, 2);
    const log = await q(pool, "SELECT action, trigger_source FROM attendance_ot_auto_pending_log ORDER BY 1");
    assert.ok(log.every((l) => l.action === "CREATED" && /^HISTORICAL_REVIEW#\d+$/.test(l.trigger_source)));
    const markers = await q(pool, "SELECT source, status, resolution FROM attendance_ot_deferred_sync ORDER BY employee_id");
    assert.deepEqual(markers.map((m) => [m.source, m.status, m.resolution]), [["HISTORICAL_REVIEW", "RESOLVED", "RESOLVED_OT_CREATED"], ["HISTORICAL_REVIEW", "RESOLVED", "RESOLVED_OT_CREATED"]]);
    // Nothing approved, nothing paid, the locked payroll row untouched.
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_late_settlement"))[0].n, 0);
    const [payroll] = await q(pool, "SELECT status, DATE_FORMAT(published_at, '%Y-%m-%d %H:%i:%s') AS p FROM payrun_employee_calculation WHERE employee_id = ?", [EMP2]);
    assert.deepEqual({ ...payroll }, { status: "APPROVED_LOCKED", p: "2026-10-06 10:00:00" });

    // Withdrawn later: the review never raises the date again.
    await q(pool, "UPDATE attendance_approval_request SET status = 'CANCELLED' WHERE requested_for_employee_id = ?", [EMP]);
    const again = await review.preview({ now: NOW });
    assert.equal(again.lines.find((l) => l.employee_id === EMP).proposed_action, "SKIP_ALREADY_REVIEWED");
    assert.ok(again.lines.find((l) => l.employee_id === EMP).withdrawn_request_id);
    // And the database itself refuses a second guard row.
    assert.equal(await reviewRepo.recordRaised({ employee_id: EMP, attendance_date: SEP4, review_item_id: 99, attendance_approval_request_id: 1 }), false);
  });

  it("STALE: when the live engine's answer moves after a preview, the preview's hash no longer matches and nothing is written", async () => {
    const p = await review.preview({ now: NOW });
    eligible.delete(`${EMP}:${SEP4}`);
    await assert.rejects(review.authorise({ actor: { employee_id: 1 }, preview_hash: p.preview_hash, now: NOW }), (err) => err.code === "PREVIEW_STALE");
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_historical_review_batch"))[0].n, 0);
    const fresh = await review.preview({ now: NOW });
    const line = fresh.lines.find((l) => l.employee_id === EMP);
    assert.equal(line.dry_run.outcome, "WOULD_NOT_CREATE");
    assert.ok(line.proposed_action.startsWith("SKIP_"));
  });

  it("a date the sync does not raise at apply time is SKIPPED and its marker closed, so no later recalculation raises it unreviewed", async () => {
    const p = await review.preview({ now: NOW });
    // The OT disappears in the instant between the authorisation's own check and the apply.
    const open = reviewRepo.openMarker.bind(reviewRepo);
    reviewRepo.openMarker = async (args) => {
      eligible.delete(`${args.employee_id}:${args.attendance_date}`);
      return open(args);
    };
    let out;
    try {
      out = await review.authorise({ actor: { employee_id: 1 }, preview_hash: p.preview_hash, items: [{ employee_id: EMP, attendance_date: SEP4 }], now: NOW });
    } finally {
      reviewRepo.openMarker = open;
    }
    assert.equal(out.summary.skipped, 1);
    assert.equal((await otRows(EMP)).length, 0);
    const [marker] = await q(pool, "SELECT status, resolution FROM attendance_ot_deferred_sync WHERE employee_id = ?", [EMP]);
    assert.equal(marker.status, "RESOLVED");
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_ot_historical_review_raised"))[0].n, 0);
  });

  it("an ordinary (non-review) locked-month date is still refused by createRequest - the exception is the marker's alone", async () => {
    const regularization = buildRegularization(buildRepo(pool), {
      findPayrollLockedPeriods: (rows) => buildCalcRepo(pool).findPayrollLockedPeriods(rows),
      attendanceDayState: () => ({ closed: true }),
      employmentWindowFor: async () => ({ joined_on: "2020-01-01", ended_on: null }),
      calculateRange: async ({ employee_id, from_date }) => [{ employee_id, attendance_date: from_date, status: "FINAL", is_final: true, punch_count: 2, shift_snapshot: { work_shift_id: 7 }, effective_punches: [], worked_minutes: 600, candidate_ot_minutes: 22, excess_ot_minutes: 22, attendance_calculation_mode: "STANDARD" }],
    });
    const out = await regularization.syncAutoOt({ employee_id: EMP2, dates: [SEP4], now: NOW, notify: false });
    assert.deepEqual(out.skipped.map((s) => s.reason), ["BEFORE_CUTOVER"]);
    assert.equal((await otRows(EMP2)).length, 0);
  });
});
