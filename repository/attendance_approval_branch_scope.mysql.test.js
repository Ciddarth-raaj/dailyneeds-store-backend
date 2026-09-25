/**
 * THE APPROVAL QUEUE'S OUTLET SCOPE, RUN AS REAL SQL - the employee 106 shape.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_approval_branch_scope.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a database, and the database it
 * names must be a SCRATCH one: the suite creates its seven tables, fills them
 * and drops them again. It never reads a table it did not create.
 *
 * WHY REAL SQL. `_approvalScope` is a WHERE clause, and the defect it had was
 * one of precedence between two predicates - the chain's authority and the
 * branch scope - that a string match on the SQL text cannot evaluate. These
 * cases execute `listApprovals` and `countApprovals` exactly as production
 * does and assert on the rows that come back.
 *
 * THE SHAPE. An employee OWNED by one outlet (the warehouse) and working
 * across all of them, whose Attendance Approver Setup names a First Level
 * approver sitting at a store and a Final approver sitting at head office.
 * Neither approver's own branch contains the employee's outlet. Before the
 * fix `r.outlet_id IN (<approver's branch>)` removed every one of that
 * employee's requests from both approvers' Attendance Approval and OT
 * Approval queues and counts - while `canApprove` still let them decide the
 * stage from Telegram.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_regularization");

const WAREHOUSE = 1;
const STORE_A = 5;
const HEAD_OFFICE = 7;
const STORE_B = 9;

const ROAMER = 106; // owned by the warehouse, works everywhere
const FIRST = 201; // First Level approver, sits at STORE_A, no approver role
const FINAL = 202; // Final approver, sits at HEAD_OFFICE, holds the HR role
const STRANGER_APPROVER = 203; // somebody else's approver
const UNMAPPED_MANAGER = 107; // warehouse, role chain OPERATIONS_MANAGER -> HR
const STORE_B_STAFF = 108;
const STORE_A_MANAGER = 204; // STORE_MANAGER role at STORE_A
const STORE_A_STAFF = 109;

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
  "attendance_day_calculation",
  "attendance_regularized_punch",
  "attendance_approval_step",
  "attendance_approval_request",
  "work_shift",
  "new_employee",
  "outlets",
];

/** One request and its chain. `steps` are [role, outlet, approver, level, decision]. */
const REQUESTS = [
  // 1. The roamer's missing-punch correction, waiting on the First approver.
  { id: 1, type: "REGULARIZATION", for: ROAMER, outlet: WAREHOUSE, stage: 1, source: "EMPLOYEE",
    steps: [["EMPLOYEE", null, FIRST, "FIRST", "PENDING"], ["EMPLOYEE", null, FINAL, "FINAL", "PENDING"]] },
  // 2. The roamer's OT claim: the First approver has approved, it waits on the Final.
  { id: 2, type: "OT", for: ROAMER, outlet: WAREHOUSE, stage: 2, source: "EMPLOYEE", ot: 95,
    steps: [["EMPLOYEE", null, FIRST, "FIRST", "APPROVED"], ["EMPLOYEE", null, FINAL, "FINAL", "PENDING"]] },
  // 3. An unmapped warehouse manager on the ROLE chain, now at the HR stage.
  { id: 3, type: "REGULARIZATION", for: UNMAPPED_MANAGER, outlet: WAREHOUSE, stage: 2, source: "ROLE",
    steps: [["OPERATIONS_MANAGER", null, null, null, "APPROVED"], ["HR", null, null, null, "PENDING"]] },
  // 4. Somebody at another store whose chain names somebody else - never ours.
  { id: 4, type: "REGULARIZATION", for: STORE_B_STAFF, outlet: STORE_B, stage: 1, source: "EMPLOYEE",
    steps: [["EMPLOYEE", null, STRANGER_APPROVER, "FINAL", "PENDING"]] },
  // 5. A STORE_B role chain at its Store Manager stage - STORE_A's manager may not see it.
  { id: 5, type: "OT", for: STORE_B_STAFF, outlet: STORE_B, stage: 1, source: "ROLE", ot: 30,
    steps: [["STORE_MANAGER", STORE_B, null, null, "PENDING"], ["OPERATIONS_MANAGER", null, null, null, "PENDING"], ["HR", null, null, null, "PENDING"]] },
  // 6. STORE_A's own role chain at its Store Manager stage - STORE_A's manager's.
  { id: 6, type: "OT", for: STORE_A_STAFF, outlet: STORE_A, stage: 1, source: "ROLE", ot: 45,
    steps: [["STORE_MANAGER", STORE_A, null, null, "PENDING"], ["OPERATIONS_MANAGER", null, null, null, "PENDING"], ["HR", null, null, null, "PENDING"]] },
  // 7. A misconfigured chain that names the requester as their OWN approver.
  { id: 7, type: "REGULARIZATION", for: FIRST, outlet: STORE_A, stage: 1, source: "EMPLOYEE",
    steps: [["EMPLOYEE", null, FIRST, "FINAL", "PENDING"]] },
];

const query = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("approval queue outlet scope, as SQL (employee 106 shape)", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let repo;

  before(async () => {
    pool = require("mysql").createPool(URL);
    for (const t of TABLES) await query(pool, `DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await query(pool, ddl);
    await query(pool, "INSERT INTO outlets VALUES ?", [[[WAREHOUSE, "Warehouse"], [STORE_A, "Store A"], [HEAD_OFFICE, "Head Office"], [STORE_B, "Store B"]]]);
    await query(pool, "INSERT INTO new_employee VALUES ?", [[
      [ROAMER, "Roaming Operations", WAREHOUSE, 20],
      [UNMAPPED_MANAGER, "Warehouse Manager", WAREHOUSE, 21],
      [STORE_B_STAFF, "Store B Staff", STORE_B, 22],
      [FIRST, "First Approver", STORE_A, 23],
      [FINAL, "Final Approver", HEAD_OFFICE, 24],
      [STRANGER_APPROVER, "Other Approver", STORE_B, 23],
      [STORE_A_MANAGER, "Store A Manager", STORE_A, 2],
      [STORE_A_STAFF, "Store A Staff", STORE_A, 22],
    ]]);
    for (const r of REQUESTS) {
      await query(
        pool,
        `INSERT INTO attendance_approval_request
           (attendance_approval_request_id, request_type, requested_for_employee_id, requested_by_employee_id,
            attendance_date, outlet_id, reason, candidate_ot_minutes, status, current_stage_no, total_stages, chain_source)
         VALUES (?, ?, ?, ?, '2026-09-20', ?, 'forgot to punch out', ?, 'PENDING', ?, ?, ?)`,
        [r.id, r.type, r.for, r.for, r.outlet, r.ot || 0, r.stage, r.steps.length, r.source]
      );
      await query(
        pool,
        `INSERT INTO attendance_approval_step
           (attendance_approval_request_id, stage_no, approver_role, outlet_id, approver_employee_id, approval_level, decision)
         VALUES ?`,
        [r.steps.map(([role, outlet, approver, level, decision], i) => [r.id, i + 1, role, outlet, approver, level, decision])]
      );
    }
    repo = buildRepo(pool);
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await query(pool, `DROP TABLE IF EXISTS ${t}`);
    await new Promise((resolve) => pool.end(resolve));
  });

  /** The scope `listApprovals` builds for a branch-scoped (OWN_BRANCHES) actor. */
  const scope = (actor, overrides = {}) => ({
    status: "PENDING",
    is_admin: false,
    filter_outlet_ids: null,
    filter_employee_id: null,
    filter_designation_id: null,
    ...actor,
    ...overrides,
  });
  const firstApprover = { actor_employee_id: FIRST, approver_roles: [], outlet_id: STORE_A, permitted_outlet_ids: [STORE_A] };
  const finalApprover = { actor_employee_id: FINAL, approver_roles: ["HR"], outlet_id: HEAD_OFFICE, permitted_outlet_ids: [HEAD_OFFICE] };
  const ids = (rows) => rows.map((r) => Number(r.attendance_approval_request_id)).sort((a, b) => a - b);

  it("Attendance Approval: the First approver sees the roamer's correction from another branch, and counts it", async () => {
    const f = scope(firstApprover, { request_type: ["REGULARIZATION", "REGULARIZATION_WITH_OT"], limit: 50 });
    assert.deepEqual(ids(await repo.listApprovals(f)), [1]);
    assert.equal(await repo.countApprovals(f), 1);
  });

  it("OT Approval: the Final approver sees the roamer's OT at the Final stage, and counts it", async () => {
    const f = scope(finalApprover, { request_type: ["OT"], limit: 50 });
    const rows = await repo.listApprovals(f);
    assert.deepEqual(ids(rows), [2]);
    assert.equal(Number(rows[0].current_stage_approver_employee_id), FINAL);
    assert.equal(await repo.countApprovals(f), 1);
  });

  it("the stage decides whose queue it is in: the First approver does not see the OT waiting on the Final", async () => {
    assert.deepEqual(ids(await repo.listApprovals(scope(firstApprover, { request_type: ["OT"], limit: 50 }))), []);
  });

  it("history: the First approver still sees the OT they approved, from another branch", async () => {
    const f = scope(firstApprover, { request_type: ["OT"], status: "ALL", limit: 50 });
    assert.deepEqual(ids(await repo.listApprovals(f)), [2]);
    assert.equal(await repo.countApprovals(f), 1);
  });

  it("a company-wide role stage is not hidden by the approver's own branch (role chain, HR stage)", async () => {
    const f = scope(finalApprover, { request_type: ["REGULARIZATION", "REGULARIZATION_WITH_OT"], limit: 50 });
    assert.deepEqual(ids(await repo.listApprovals(f)), [3]);
  });

  it("the exception is the chain and nothing else: another approver's request elsewhere stays hidden", async () => {
    const reg = scope(firstApprover, { request_type: ["REGULARIZATION", "REGULARIZATION_WITH_OT"], status: "ALL", limit: 50 });
    assert.ok(!ids(await repo.listApprovals(reg)).includes(4));
    const storeManager = scope(
      { actor_employee_id: STORE_A_MANAGER, approver_roles: ["STORE_MANAGER"], outlet_id: STORE_A, permitted_outlet_ids: [STORE_A] },
      { request_type: ["OT"], status: "ALL", limit: 50 }
    );
    assert.deepEqual(ids(await repo.listApprovals(storeManager)), [6], "their own outlet's #6 only - STORE_B's Store Manager stage (#5) is STORE_B's");
  });

  it("a Store Manager stays OUTLET-SPECIFIC while PENDING: their own outlet's stage, never another's", async () => {
    const storeManager = { actor_employee_id: STORE_A_MANAGER, approver_roles: ["STORE_MANAGER"], outlet_id: STORE_A, permitted_outlet_ids: [STORE_A] };
    const f = scope(storeManager, { request_type: ["OT"], limit: 50 });
    assert.deepEqual(ids(await repo.listApprovals(f)), [6], "STORE_A's stage yes, STORE_B's (#5) no");
    assert.equal(await repo.countApprovals(f), 1);
    // Even with an empty branch scope the role cannot reach another outlet's stage.
    const unscoped = scope({ ...storeManager, permitted_outlet_ids: [] }, { request_type: ["OT"], limit: 50 });
    assert.deepEqual(ids(await repo.listApprovals(unscoped)), [6]);
  });

  it("nobody sees their OWN request, even on a chain that names them as its approver", async () => {
    const f = scope(firstApprover, { request_type: ["REGULARIZATION", "REGULARIZATION_WITH_OT"], limit: 50 });
    assert.ok(!ids(await repo.listApprovals(f)).includes(7));
    const history = scope(firstApprover, { request_type: ["REGULARIZATION", "REGULARIZATION_WITH_OT"], status: "ALL", limit: 50 });
    assert.ok(!ids(await repo.listApprovals(history)).includes(7));
  });

  it("an EMPTY branch scope still fails closed for everything the chain does not address to the actor", async () => {
    const f = scope({ ...firstApprover, permitted_outlet_ids: [] }, { request_type: ["REGULARIZATION", "REGULARIZATION_WITH_OT"], status: "ALL", limit: 50 });
    assert.deepEqual(ids(await repo.listApprovals(f)), [1]);
  });

  it("an outlet the user CHOSE still narrows: filtering to their own branch hides the roamer's row", async () => {
    const f = scope(firstApprover, { request_type: ["REGULARIZATION", "REGULARIZATION_WITH_OT"], filter_outlet_ids: [STORE_A], limit: 50 });
    assert.deepEqual(ids(await repo.listApprovals(f)), []);
    assert.equal(await repo.countApprovals(f), 0);
  });

  it("nobody sees their own request, whatever the scope", async () => {
    const f = scope({ actor_employee_id: ROAMER, approver_roles: [], outlet_id: WAREHOUSE, permitted_outlet_ids: [WAREHOUSE] }, { request_type: ["REGULARIZATION", "REGULARIZATION_WITH_OT"], status: "ALL", limit: 50 });
    assert.deepEqual(ids(await repo.listApprovals(f)), []);
  });
});
