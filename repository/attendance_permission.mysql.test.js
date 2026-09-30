/**
 * PERMISSION, AS REAL SQL - the migration and every transaction that writes
 * `attendance_permission`.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_permission.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its tables, fills them and drops them again, and reads no table it
 * did not create. The approval tables are created in their pre-Permission
 * shape and then the MIGRATION FILE ITSELF is run over them, down and up
 * again, so what is tested is what production will run.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildPermissionRepo = require("./attendance_permission");
const buildRegularizationRepo = require("./attendance_regularization");
const { CALCULATION_COLUMNS } = require("./attendance_calculation");
const { closePendingPermissionsForLock } = require("./lib/attendance_permission_guard");

const SQLS = path.join(__dirname, "..", "migrations/mysql/migrations/sqls");
const UP = fs.readFileSync(path.join(SQLS, "20261107120000-attendance-permission-up.sql"), "utf8");
const DOWN = fs.readFileSync(path.join(SQLS, "20261107120000-attendance-permission-down.sql"), "utf8");
// The Attendance Calculation Type history, from the migration that sorts after
// this one - the table the Permission insert guard reads.
const MODE_HISTORY_TABLE = fs
  .readFileSync(path.join(SQLS, "20261108120000-employee-attendance-calculation-mode-up.sql"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n")
  .split(/;\s*(?:\n|$)/)
  .map((st) => st.trim())
  .find((st) => /^CREATE TABLE IF NOT EXISTS `employee_attendance_calculation_mode`/.test(st));

const NEW_DAY_COLUMNS = [
  "permission_ids", "permission_window_minutes", "permission_minutes", "permission_late_minutes",
  "permission_early_minutes", "permission_away_minutes", "shortage_before_permission_minutes", "payable_minutes",
];

const EMP = 501;
const OTHER = 502;
const DATE = "2026-09-14";

const SCHEMA = [
  `CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), store_id INT NULL,
     designation_id INT NULL, attendance_required TINYINT(1) NOT NULL DEFAULT 1, status INT NOT NULL DEFAULT 1,
     date_of_joining VARCHAR(20) NULL, resignation_date DATE NULL)`,
  `CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80))`,
  `CREATE TABLE all_permissions (id INT AUTO_INCREMENT PRIMARY KEY, permission_key VARCHAR(100))`,
  `CREATE TABLE permissions (id INT AUTO_INCREMENT PRIMARY KEY, permission_key VARCHAR(100), designation_id INT, is_active TINYINT(1) DEFAULT 1)`,
  // attendance_approval_request as 20261029 left it.
  `CREATE TABLE attendance_approval_request (
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
     request_type ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE') NOT NULL,
     requested_for_employee_id INT NOT NULL, requested_by_employee_id INT NOT NULL,
     attendance_date DATE NOT NULL, outlet_id INT NULL,
     requester_class VARCHAR(20) NOT NULL DEFAULT 'STORE_EMPLOYEE',
     reason VARCHAR(500) NOT NULL,
     candidate_ot_minutes INT NOT NULL DEFAULT 0, approved_ot_minutes INT NULL,
     auto_created TINYINT(1) NOT NULL DEFAULT 0,
     closure_reason ENUM('NOT_REQUESTED_BEFORE_PAYROLL_LOCK','NOT_APPROVED_BEFORE_PAYROLL_LOCK') NULL,
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
     UNIQUE KEY uq_step (attendance_approval_request_id, stage_no)
   ) ENGINE=InnoDB`,
  `CREATE TABLE payrun_employee_calculation (
     employee_id INT NOT NULL, period_year INT NOT NULL, period_month INT NOT NULL,
     status VARCHAR(32) NOT NULL, PRIMARY KEY (employee_id, period_year, period_month)
   ) ENGINE=InnoDB`,
  // Every column the writer names EXCEPT the ones the migration adds.
  `CREATE TABLE attendance_day_calculation (
     ${CALCULATION_COLUMNS.filter((c) => !NEW_DAY_COLUMNS.includes(c))
       .map((c) =>
         c === "employee_id" ? "employee_id INT NOT NULL" : c === "attendance_date" ? "attendance_date DATE NOT NULL" : `${c} TEXT NULL`
       )
       .join(",\n     ")},
     UNIQUE KEY uq_day (employee_id, attendance_date)
   ) ENGINE=InnoDB`,
  `CREATE TABLE attendance_monthly_payroll (id INT AUTO_INCREMENT PRIMARY KEY)`,
];
const TABLES = [
  "attendance_permission_bulk_item", "attendance_permission", "attendance_permission_bulk_operation",
  "attendance_monthly_payroll", "attendance_day_calculation", "payrun_employee_calculation",
  "attendance_approval_step", "attendance_approval_request", "permissions", "all_permissions",
  "outlets", "new_employee", "employee_attendance_calculation_mode",
];

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

const dayRow = (employee_id, over = {}) => {
  const row = {};
  CALCULATION_COLUMNS.forEach((c) => {
    row[c] = null;
  });
  return {
    ...row,
    employee_id,
    attendance_date: DATE,
    shortage_minutes: 0,
    permission_ids: "[]",
    permission_window_minutes: 120,
    permission_minutes: 120,
    permission_late_minutes: 0,
    permission_early_minutes: 120,
    permission_away_minutes: 0,
    ...over,
  };
};
const window = (from, to) => ({
  permission_from: `${DATE} ${from}:00`,
  permission_to: `${DATE} ${to}:00`,
  to_shift_end: false,
  permission_minutes: 120,
});
const HEADER = { reason: "Festival early closing", created_by_employee_id: 900, outlet_id: 3 };

describe("attendance permission, as SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  let regRepo;

  before(async () => {
    pool = require("mysql").createPool(`${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=6&multipleStatements=true`);
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(pool, ddl);
    await q(pool, MODE_HISTORY_TABLE);
    repo = buildPermissionRepo(pool);
    regRepo = buildRegularizationRepo(pool);
  });

  after(async () => {
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((r) => pool.end(r));
  });

  describe("the migration", () => {
    it("runs up, down and up again over the pre-Permission tables", async () => {
      await q(pool, UP);
      await q(pool, DOWN);
      await q(pool, UP);
      const cols = await q(pool, "SHOW COLUMNS FROM attendance_day_calculation");
      NEW_DAY_COLUMNS.forEach((c) => assert.ok(cols.some((x) => x.Field === c), c));
      const keys = await q(pool, "SELECT permission_key FROM all_permissions ORDER BY permission_key");
      assert.equal(keys.length, 7);
      assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM permissions"))[0].n, 0, "granted to nobody");
    });
  });

  describe("the transactions", () => {
    beforeEach(async () => {
      for (const t of ["attendance_permission_bulk_item", "attendance_permission", "attendance_permission_bulk_operation", "attendance_day_calculation", "payrun_employee_calculation", "attendance_approval_step", "attendance_approval_request", "outlets", "new_employee", "employee_attendance_calculation_mode"]) {
        await q(pool, `DELETE FROM ${t}`);
      }
      await q(pool, "INSERT INTO outlets VALUES (3, 'Main'), (5, 'East')");
      await q(pool, `INSERT INTO new_employee (employee_id, employee_name, store_id, date_of_joining) VALUES (${EMP}, 'Asha', 3, '2020-01-01'), (${OTHER}, 'Bala', 5, '2020-01-01'), (900, 'Boss', 3, '2020-01-01')`);
    });

    const createPermissionRequest = (windows, employee = EMP) =>
      regRepo.createRequest({
        request: {
          request_type: "PERMISSION", requested_for_employee_id: employee, requested_by_employee_id: employee,
          attendance_date: DATE, outlet_id: 3, requester_class: "STORE_EMPLOYEE", reason: "Family function",
          candidate_ot_minutes: 0, auto_created: false, chain_source: "ROLE",
        },
        chain: [{ stage_no: 1, approver_role: "STORE_MANAGER", outlet_id: 3 }, { stage_no: 2, approver_role: "HR", outlet_id: null }],
        punch: null,
        permissions: windows,
      });

    it("a PERMISSION request writes its windows as payload, and a pending one does not block a correction", async () => {
      const created = await createPermissionRequest([window("20:00", "22:00")]);
      assert.equal(created.attendance_permission_ids.length, 1);
      const [row] = await q(pool, "SELECT source, attendance_approval_request_id, DATE_FORMAT(permission_to, '%H:%i') AS t FROM attendance_permission");
      assert.equal(row.source, "REQUEST");
      assert.equal(Number(row.attendance_approval_request_id), created.attendance_approval_request_id);
      assert.equal(row.t, "22:00");

      // Same employee, same date, a pending REGULARIZATION: another group.
      await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, total_stages) VALUES ('REGULARIZATION', ${EMP}, ${EMP}, '${DATE}', 'Missed punch', 1)`);
      // A SECOND pending PERMISSION: refused by the key.
      await assert.rejects(
        q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, requested_by_employee_id, attendance_date, reason, total_stages) VALUES ('PERMISSION', ${EMP}, ${EMP}, '${DATE}', 'Again', 1)`),
        /Duplicate entry/
      );
    });

    it("a DIRECT grant overlapping a live window is refused and writes nothing; touching windows are fine", async () => {
      await createPermissionRequest([window("20:00", "22:00")]);
      const clash = await repo.grant({ employee_id: EMP, attendance_date: DATE, windows: [window("21:00", "22:00")], header: HEADER, calculations: [] });
      assert.equal(clash.code, 409);
      assert.equal(clash.reason, "OVERLAP");
      const ok = await repo.grant({ employee_id: EMP, attendance_date: DATE, windows: [window("19:00", "20:00")], header: HEADER, calculations: [dayRow(EMP)] });
      assert.equal(ok.code, 200);
      const rows = await q(pool, "SELECT source FROM attendance_permission ORDER BY attendance_permission_id");
      assert.deepEqual(rows.map((r) => r.source), ["REQUEST", "DIRECT"]);
      const [day] = await q(pool, `SELECT permission_ids FROM attendance_day_calculation WHERE employee_id = ${EMP}`);
      assert.deepEqual(JSON.parse(day.permission_ids), ok.attendance_permission_ids, "the stored day names the new grant");
    });

    it("a rejected request's window blocks nothing", async () => {
      const created = await createPermissionRequest([window("20:00", "22:00")]);
      await q(pool, `UPDATE attendance_approval_request SET status = 'REJECTED' WHERE attendance_approval_request_id = ${created.attendance_approval_request_id}`);
      const ok = await repo.grant({ employee_id: EMP, attendance_date: DATE, windows: [window("20:00", "22:00")], header: HEADER, calculations: [] });
      assert.equal(ok.code, 200);
    });

    it("a payroll-locked month refuses the grant and rolls everything back", async () => {
      await q(pool, `INSERT INTO payrun_employee_calculation VALUES (${EMP}, 2026, 9, 'APPROVED_LOCKED')`);
      await assert.rejects(
        repo.grant({ employee_id: EMP, attendance_date: DATE, windows: [window("20:00", "22:00")], header: HEADER, calculations: [dayRow(EMP)] }),
        (err) => err.code === "PAYROLL_MONTH_LOCKED"
      );
      assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_permission"))[0].n, 0);
      assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM attendance_day_calculation"))[0].n, 0);
    });

    it("revoke records who, when and why, stores the day, and cannot happen twice", async () => {
      const { attendance_permission_ids: [id] } = await repo.grant({ employee_id: EMP, attendance_date: DATE, windows: [window("20:00", "22:00")], header: HEADER, calculations: [] });
      const r = await repo.revoke({ attendance_permission_id: id, actor: { employee_id: 900, user_id: 9 }, reason: "Store stayed open", calculations: [dayRow(EMP, { permission_minutes: 0 })] });
      assert.equal(r.code, 200);
      const [row] = await q(pool, `SELECT revoked_by_employee_id, revoked_by_user_id, revoke_reason, revoked_at FROM attendance_permission WHERE attendance_permission_id = ${id}`);
      assert.equal(row.revoked_by_employee_id, 900);
      assert.equal(row.revoked_by_user_id, 9);
      assert.equal(row.revoke_reason, "Store stayed open");
      assert.ok(row.revoked_at);
      const again = await repo.revoke({ attendance_permission_id: id, actor: { employee_id: 900 }, reason: "Again", calculations: [] });
      assert.equal(again.reason, "ALREADY_REVOKED");
    });

    it("a REQUEST permission cannot be revoked as a direct grant", async () => {
      const { attendance_permission_ids: [id] } = await createPermissionRequest([window("20:00", "22:00")]);
      const r = await repo.revoke({ attendance_permission_id: id, actor: { employee_id: 900 }, reason: "Not here", calculations: [] });
      assert.equal(r.reason, "NOT_DIRECT");
    });

    it("the payroll lock closes PENDING permission requests of the month and nothing else", async () => {
      const pending = await createPermissionRequest([window("20:00", "22:00")]);
      const approved = await createPermissionRequest([window("20:00", "22:00")], OTHER);
      await q(pool, `UPDATE attendance_approval_request SET status = 'APPROVED', finalization_state = 'SETTLED' WHERE attendance_approval_request_id = ${approved.attendance_approval_request_id}`);
      const conn = await new Promise((res, rej) => pool.getConnection((e, c) => (e ? rej(e) : res(c))));
      try {
        const first = await closePendingPermissionsForLock(conn, { employee_id: EMP, year: 2026, month: 9 });
        assert.equal(first.closed, 1);
        const again = await closePendingPermissionsForLock(conn, { employee_id: EMP, year: 2026, month: 9 });
        assert.equal(again.closed, 0, "idempotent");
        await closePendingPermissionsForLock(conn, { employee_id: OTHER, year: 2026, month: 9 });
      } finally {
        conn.release();
      }
      const [closed] = await q(pool, `SELECT status, closure_reason, finalization_state FROM attendance_approval_request WHERE attendance_approval_request_id = ${pending.attendance_approval_request_id}`);
      assert.deepEqual({ ...closed }, { status: "REJECTED", closure_reason: "NOT_APPROVED_BEFORE_PAYROLL_LOCK", finalization_state: "SETTLED" });
      const steps = await q(pool, `SELECT decision, remarks FROM attendance_approval_step WHERE attendance_approval_request_id = ${pending.attendance_approval_request_id}`);
      assert.ok(steps.every((s) => s.decision === "SKIPPED" && /Not approved before payroll lock/.test(s.remarks)));
      const [kept] = await q(pool, `SELECT status FROM attendance_approval_request WHERE attendance_approval_request_id = ${approved.attendance_approval_request_id}`);
      assert.equal(kept.status, "APPROVED");
    });

    it("the register is confined to the caller's outlets and names who did what", async () => {
      await repo.grant({ employee_id: EMP, attendance_date: DATE, windows: [window("20:00", "22:00")], header: HEADER, calculations: [] });
      await repo.grant({ employee_id: OTHER, attendance_date: DATE, windows: [window("20:00", "22:00")], header: { ...HEADER, outlet_id: 5 }, calculations: [] });
      const mine = await repo.list({ store_ids: [3], from_date: DATE, to_date: DATE });
      assert.equal(mine.total, 1);
      assert.equal(mine.rows[0].employee_name, "Asha");
      assert.equal(mine.rows[0].outlet_name, "Main");
      assert.equal(mine.rows[0].created_by_name, "Boss");
      assert.equal((await repo.list({ store_ids: null, from_date: DATE, to_date: DATE })).total, 2);
      assert.equal((await repo.list({ store_ids: [], from_date: DATE, to_date: DATE })).total, 0, "an empty scope sees nothing");
    });

    describe("PRESENT/ABSENT ONLY: a new Permission is not applicable on the date", () => {
      const NOT_APPLICABLE = "Permission is not applicable because this employee uses Present/Absent Only attendance.";
      const setMode = (employee, mode, from) =>
        q(pool, "INSERT INTO employee_attendance_calculation_mode (employee_id, calculation_mode, effective_from) VALUES (?, ?, ?)", [employee, mode, from]);
      const on = (date, from = "20:00", to = "22:00") => ({
        permission_from: `${date} ${from}:00`, permission_to: `${date} ${to}:00`, to_shift_end: false, permission_minutes: 120,
      });
      const grantOn = (date, employee = EMP) =>
        repo.grant({ employee_id: employee, attendance_date: date, windows: [on(date)], header: HEADER, calculations: [] });
      const refused = (err) => err.name === "ValidationError" && err.code === "PERMISSION_NOT_APPLICABLE_PRESENT_ABSENT_ONLY" && err.message === NOT_APPLICABLE;
      const count = async (table) => Number((await q(pool, `SELECT COUNT(*) AS n FROM ${table}`))[0].n);

      it("a direct grant is refused and writes nothing - whatever the grantor's rights", async () => {
        await setMode(EMP, "PRESENT_ABSENT_ONLY", "2026-09-01");
        await assert.rejects(grantOn(DATE), refused);
        assert.equal(await count("attendance_permission"), 0);
      });

      it("a request is refused and rolls back with its request row and steps", async () => {
        await setMode(EMP, "PRESENT_ABSENT_ONLY", "2026-09-01");
        await assert.rejects(createPermissionRequest([window("20:00", "22:00")]), refused);
        assert.equal(await count("attendance_permission"), 0);
        assert.equal(await count("attendance_approval_request"), 0);
        assert.equal(await count("attendance_approval_step"), 0);
      });

      it("Shift Based through 30/09, Present/Absent Only from 01/10: 30/09 allowed, 01/10 and 02/10 refused", async () => {
        await setMode(EMP, "PRESENT_ABSENT_ONLY", "2026-10-01");
        assert.equal((await grantOn("2026-09-30")).code, 200);
        await assert.rejects(grantOn("2026-10-01"), refused);
        await assert.rejects(grantOn("2026-10-02"), refused);
      });

      it("Present/Absent Only through 15/10, Shift Based from 16/10: 15/10 refused, 16/10 allowed", async () => {
        await setMode(EMP, "PRESENT_ABSENT_ONLY", "2026-10-01");
        await setMode(EMP, "SHIFT_BASED", "2026-10-16");
        await assert.rejects(grantOn("2026-10-15"), refused);
        assert.equal((await grantOn("2026-10-16")).code, 200);
      });

      it("another employee, and an employee with no mode row, are untouched", async () => {
        await setMode(OTHER, "PRESENT_ABSENT_ONLY", "2026-09-01");
        assert.equal((await grantOn(DATE, EMP)).code, 200);
        await assert.rejects(grantOn(DATE, OTHER), refused);
      });

      it("a historical permission on a date that later became Present/Absent Only is kept exactly as it was", async () => {
        const { attendance_permission_ids: [id] } = await grantOn(DATE);
        const before = await q(pool, `SELECT * FROM attendance_permission WHERE attendance_permission_id = ${id}`);
        await setMode(EMP, "PRESENT_ABSENT_ONLY", "2026-09-01");
        await assert.rejects(grantOn(DATE), refused, "a NEW one is refused");
        const after = await q(pool, `SELECT * FROM attendance_permission WHERE attendance_permission_id = ${id}`);
        assert.deepEqual(after, before, "not deleted, revoked or rewritten");
      });
    });

    it("the bulk log keeps one row per employee considered", async () => {
      await repo.createBulkOperation({ bulk_operation_id: "00000000-0000-4000-8000-000000000001", target_mode: "ALL", attendance_date: DATE, from_time: "19:00", to_shift_end: true, reason: "Deepavali", preview_fingerprint: "f".repeat(64), considered_count: 2, created_by_employee_id: 900 });
      await repo.recordBulkItem({ bulk_operation_id: "00000000-0000-4000-8000-000000000001", employee_id: EMP, outlet_id: 3, outcome: "SUCCEEDED", attendance_permission_id: 1, recalculated: true });
      await repo.recordBulkItem({ bulk_operation_id: "00000000-0000-4000-8000-000000000001", employee_id: OTHER, outlet_id: 5, outcome: "SKIPPED", code: "PAYROLL_LOCKED", message: "locked" });
      await repo.finishBulkOperation("00000000-0000-4000-8000-000000000001", { succeeded: 1, skipped: 1, failed: 0 });
      const ops = await repo.listBulkOperations({ store_ids: [3] });
      assert.equal(ops.length, 1);
      assert.equal(ops[0].to_shift_end, 1);
      assert.equal(ops[0].created_by_name, "Boss");
      const items = await repo.listBulkItems("00000000-0000-4000-8000-000000000001", [3]);
      assert.equal(items.length, 1, "scoped to the caller's outlets");
    });
  });
});
