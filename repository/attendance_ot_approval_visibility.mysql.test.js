/**
 * OT APPROVALS VISIBILITY, AS REAL SQL - the Employee 945 shape.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_ot_approval_visibility.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * Employee 945's Attendance showed 22 minutes of calculated OT on 4 Sep 2026
 * while OT Approvals showed only an automatically raised 6 Oct request. These
 * cases run the production `listApprovals` / `countApprovals` and prove what
 * the queue does and does not hide: no date restriction, every status tab
 * with its own rows, the employee filter, paging past the first 200 rows -
 * and that a WITHDRAWN (cancelled) system OT is the one record no tab shows.
 * A date that never had a request (4 Sep, before the automatic-OT cutover)
 * is absent from every tab because there is nothing to show; the attendance
 * read explains that (see utils/attendance_ot_auto_gate.js).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");
const REVOCATION_MIGRATION = path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20261103120000-attendance-approval-revocation-up.sql");
const OUTCOME_MIGRATION = path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20261106120000-attendance-approval-revocation-outcome-up.sql");

const OUTLET = 3;
const E945 = 945;
const OTHERS = 250; // employees 2001.. with one approved OT each, all dated after 945's

const SCHEMA = [
  `CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80))`,
  `CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80),
     store_id INT NULL, designation_id INT NULL)`,
  `CREATE TABLE work_shift (work_shift_id INT PRIMARY KEY, shift_code VARCHAR(20), shift_name VARCHAR(80))`,
  `CREATE TABLE attendance_approval_request (
     attendance_approval_request_id BIGINT UNSIGNED PRIMARY KEY,
     request_type ENUM('REGULARIZATION','OT','REGULARIZATION_WITH_OT','SHIFT_CHANGE') NOT NULL,
     requested_for_employee_id INT NOT NULL, requested_by_employee_id INT NOT NULL,
     attendance_date DATE NOT NULL, outlet_id INT NULL, reason VARCHAR(500) NOT NULL,
     candidate_ot_minutes INT NOT NULL DEFAULT 0, approved_ot_minutes INT NULL,
     status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
     current_stage_no INT NOT NULL DEFAULT 1, total_stages INT NOT NULL,
     finalization_state VARCHAR(20) NOT NULL DEFAULT 'NOT_REQUIRED',
     closure_reason VARCHAR(64) NULL, auto_created TINYINT(1) NOT NULL DEFAULT 0,
     chain_source VARCHAR(16) NULL, requested_work_shift_id INT NULL, base_work_shift_id INT NULL,
     created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), decided_at TIMESTAMP(3) NULL)`,
  `CREATE TABLE attendance_approval_step (
     attendance_approval_step_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL, stage_no INT NOT NULL,
     approver_role VARCHAR(32) NOT NULL, outlet_id INT NULL,
     approver_employee_id INT NULL, approval_level VARCHAR(16) NULL,
     decision ENUM('PENDING','APPROVED','REJECTED','SKIPPED') NOT NULL DEFAULT 'PENDING',
     decided_by_employee_id INT NULL, decided_at TIMESTAMP(3) NULL, remarks VARCHAR(500) NULL,
     acted_as_admin_override TINYINT(1) NOT NULL DEFAULT 0)`,
  `CREATE TABLE attendance_regularized_punch (attendance_regularized_punch_id BIGINT PRIMARY KEY,
     attendance_approval_request_id BIGINT UNSIGNED NOT NULL, punch_time DATETIME NOT NULL)`,
  `CREATE TABLE attendance_day_calculation (employee_id INT NOT NULL, attendance_date DATE NOT NULL,
     work_shift_id INT NULL, shift_snapshot JSON NULL, effective_punches JSON NULL,
     nrm_minutes INT NULL, worked_minutes INT NULL, shortage_minutes INT NULL,
     candidate_ot_minutes INT NULL, status VARCHAR(32) NULL,
     base_nrm_minutes INT NULL, regular_minutes INT NULL)`,
];
const TABLES = [
  "attendance_approval_revocation",
  "attendance_day_calculation",
  "attendance_regularized_punch",
  "attendance_approval_step",
  "attendance_approval_request",
  "work_shift",
  "new_employee",
  "outlets",
];


const query = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("OT Approvals visibility, as SQL (Employee 945 shape)", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;
  const admin = (overrides = {}) => ({
    request_type: ["OT"],
    status: "ALL",
    approver_roles: [],
    outlet_id: 1,
    actor_employee_id: 1,
    is_admin: true,
    filter_outlet_ids: null,
    filter_employee_id: null,
    filter_designation_id: null,
    permitted_outlet_ids: null,
    limit: 200,
    offset: 0,
    ...overrides,
  });
  const ids = (rows) => rows.map((r) => Number(r.attendance_approval_request_id)).sort((a, b) => a - b);

  before(async () => {
    pool = require("mysql").createPool(URL);
    for (const t of TABLES) await query(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await query(pool, ddl);
    await query(pool, fs.readFileSync(REVOCATION_MIGRATION, "utf8"));
    await query(pool, fs.readFileSync(OUTCOME_MIGRATION, "utf8"));
    await query(pool, "INSERT INTO outlets VALUES (?, 'Outlet 3')", [OUTLET]);
    const people = [[E945, "Mritunjay Kharwar", OUTLET, 11]];
    for (let i = 0; i < OTHERS; i += 1) people.push([2001 + i, `Staff ${i}`, OUTLET, 11]);
    await query(pool, "INSERT INTO new_employee VALUES ?", [people]);

    const requests = [
      // 945: the automatically raised 6 Oct OT, pending its first stage.
      [1, E945, "2026-10-06", "PENDING", 1, 30],
      // 945: an approved OT and a rejected OT, both September.
      [2, E945, "2026-09-20", "APPROVED", 1, 15],
      [3, E945, "2026-09-21", "REJECTED", 1, 40],
      // 945: a system OT WITHDRAWN when its eligible OT went away.
      [4, E945, "2026-09-25", "CANCELLED", 1, 25],
    ];
    for (let i = 0; i < OTHERS; i += 1) requests.push([100 + i, 2001 + i, "2026-09-28", "APPROVED", 1, 60]);
    await query(
      pool,
      `INSERT INTO attendance_approval_request
         (attendance_approval_request_id, requested_for_employee_id, attendance_date, status, auto_created, candidate_ot_minutes,
          request_type, requested_by_employee_id, outlet_id, reason, current_stage_no, total_stages, chain_source)
       VALUES ?`,
      [requests.map(([id, emp, date, status, auto, ot]) => [id, emp, date, status, auto, ot, "OT", emp, OUTLET, "System OT", 1, 1, "ROLE"])]
    );
    await query(
      pool,
      `INSERT INTO attendance_approval_step
         (attendance_approval_request_id, stage_no, approver_role, outlet_id, approver_employee_id, decision)
       VALUES ?`,
      [requests.map(([id, , , status]) => [
        id, 1, "STORE_MANAGER", OUTLET, null,
        status === "PENDING" ? "PENDING" : status === "APPROVED" ? "APPROVED" : status === "REJECTED" ? "REJECTED" : "SKIPPED",
      ])]
    );
    repo = buildRepo(pool);
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await query(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((resolve) => pool.end(resolve));
  });

  it("each status tab has its own rows, with no date restriction", async () => {
    const mine = (status) => admin({ status, filter_employee_id: E945 });
    assert.deepEqual(ids(await repo.listApprovals(mine("PENDING"))), [1]);
    assert.deepEqual(ids(await repo.listApprovals(mine("APPROVED"))), [2]);
    assert.deepEqual(ids(await repo.listApprovals(mine("REJECTED"))), [3]);
    assert.deepEqual(ids(await repo.listApprovals(mine("ALL"))), [1, 2, 3]);
  });

  it("a WITHDRAWN system OT is on no tab; a date that never had a request (4 Sep) is on none either", async () => {
    for (const status of ["PENDING", "APPROVED", "REJECTED", "ALL"]) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await repo.listApprovals(admin({ status, filter_employee_id: E945 }));
      assert.ok(!ids(rows).includes(4), `${status}: withdrawn`);
      assert.ok(!rows.some((r) => r.attendance_date === "2026-09-04"), `${status}: 4 Sep`);
    }
  });

  it("the employee filter is applied in SQL: every one of 945's rows, whatever the page", async () => {
    const f = admin({ filter_employee_id: E945 });
    assert.equal(await repo.countApprovals(f), 3);
    assert.ok((await repo.listApprovals(f)).every((r) => Number(r.requested_for_employee_id) === E945));
  });

  it("PAGING: the unfiltered All tab has more than one page, and 945's September rows are only on the second", async () => {
    const f = admin();
    const total = await repo.countApprovals(f);
    assert.equal(total, OTHERS + 3);
    const first = await repo.listApprovals(f);
    assert.equal(first.length, 200, "the first page is capped");
    assert.ok(!ids(first).includes(2) && !ids(first).includes(3), "older September rows fall past the first page");
    const second = await repo.listApprovals(admin({ offset: 200 }));
    assert.equal(first.length + second.length, total);
    assert.ok(ids(second).includes(2) && ids(second).includes(3));
    assert.equal(new Set([...ids(first), ...ids(second)]).size, total, "no row is on two pages");
  });
});
