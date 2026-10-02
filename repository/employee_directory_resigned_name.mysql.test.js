/**
 * THE EMPLOYEE DIRECTORY AND THE NAME-KEYED `resignation` TABLE, AS REAL SQL.
 *
 *   EMPLOYEE_DIRECTORY_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/employee_directory_resigned_name.mysql.test.js
 *
 * SKIPPED unless `EMPLOYEE_DIRECTORY_TEST_MYSQL` names a SCRATCH database: the
 * suite drops and creates its tables.
 *
 * THE DEFECT. `GET /employee/employees` - the list behind HR Employee Master,
 * the HR Onboarding queue, the status summary and every `useEmployees` picker -
 * excluded every row whose `employee_name` appeared ANYWHERE in `resignation`.
 * The table is keyed by name, so an ACTIVE employee vanished whenever:
 *
 *   - a different, earlier employee with the same name had resigned,
 *   - they had been resigned and then rejoined through HR (Resign writes a
 *     row, Rejoin sets status = 1 and leaves the row), or
 *   - a resignation of theirs had been voided.
 *
 * The search (`getEmployeeByFilter`) has no such exclusion, so the same
 * employee was findable by search and missing from the list.
 *
 * What runs here is the production code path of the route: the REAL branch
 * scope middleware over the REAL `repository/employee_branch.js`, then
 * `listFilters` -> `actorFor` -> `EmployeeUsecase.get`, exactly as
 * `routes/employee.js` calls them, against MySQL. Only the permission lookup
 * is stubbed, to say which caller holds `employee_scope_all_branches`.
 */
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const P = require("../constants/hr_permissions");
const buildEmployeeBranchScope = require("../middlewares/employee_branch_scope");

const URL = process.env.EMPLOYEE_DIRECTORY_TEST_MYSQL;

const OUTLET_A = 7; // the reported employee's outlet
const OUTLET_B = 8; // another outlet

const SCHEMA = `
  SET FOREIGN_KEY_CHECKS = 0;
  DROP TABLE IF EXISTS resignation, new_employee, outlets, designation, department, shift_master;
  SET FOREIGN_KEY_CHECKS = 1;
  CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80)) ENGINE=InnoDB;
  CREATE TABLE designation (designation_id INT PRIMARY KEY, designation_name VARCHAR(80)) ENGINE=InnoDB;
  CREATE TABLE department (department_id INT PRIMARY KEY, department_name VARCHAR(80)) ENGINE=InnoDB;
  CREATE TABLE shift_master (shift_id INT PRIMARY KEY, shift_name VARCHAR(80), shift_code VARCHAR(20),
    status TINYINT DEFAULT 0) ENGINE=InnoDB;
  CREATE TABLE new_employee (
    employee_id INT PRIMARY KEY, employee_name VARCHAR(100) NOT NULL, father_name VARCHAR(100), dob DATE,
    gender VARCHAR(10), marital_status VARCHAR(20), employee_image VARCHAR(200), marriage_date DATE,
    spouse_name VARCHAR(100), permanent_address TEXT, residential_address TEXT,
    primary_contact_number VARCHAR(20), alternate_contact_number VARCHAR(20), email_id VARCHAR(100),
    blood_group VARCHAR(10), qualification VARCHAR(100), introducer_name VARCHAR(100),
    introducer_details VARCHAR(200), salary INT, bank_name VARCHAR(100), ifsc VARCHAR(20),
    account_no VARCHAR(40), esi_number VARCHAR(40), pf_number VARCHAR(40), uan VARCHAR(40),
    uniform_qty INT, store_id INT NULL, department_id INT, designation_id INT, shift_id INT,
    previous_experience VARCHAR(100), additional_course VARCHAR(100), date_of_joining DATE NULL,
    pan_no VARCHAR(20), payment_type INT NULL, status TINYINT DEFAULT 1, resignation_date DATE NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB;
  CREATE TABLE resignation (
    resignation_id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT NULL, period_id BIGINT NULL,
    employee_name VARCHAR(45), reason_type VARCHAR(45), resignation_date VARCHAR(45), reason LONGTEXT,
    voided_at TIMESTAMP NULL DEFAULT NULL, voided_by INT NULL
  ) ENGINE=InnoDB;

  INSERT INTO outlets VALUES (${OUTLET_A}, 'Outlet A'), (${OUTLET_B}, 'Outlet B');
  INSERT INTO designation VALUES (3, 'SALES EXECUTIVE'), (9, 'STORE MANAGER'), (11, 'HR EXECUTIVE');
  INSERT INTO department VALUES (1, 'Retail');
  INSERT INTO shift_master VALUES (1, 'General', 'G', 1);

  INSERT INTO new_employee
    (employee_id, employee_name, store_id, designation_id, department_id, shift_id, date_of_joining,
     payment_type, status, resignation_date)
  VALUES
    -- the reported employee: active, valid outlet, nothing wrong with the record
    (1530, 'Sathiya Priya',     ${OUTLET_A}, 3, 1, 1, '2026-09-20', 2, 1, NULL),
    -- a NAMESAKE who resigned earlier through the legacy screen
    (1412, 'Sathiya Priya',     ${OUTLET_B}, 3, 1, 1, '2024-06-01', 1, 0, '2025-03-31'),
    -- a nearby working employee: same outlet, same designation
    (1529, 'Nearby Worker',     ${OUTLET_A}, 3, 1, 1, '2026-09-18', 2, 1, NULL),
    -- an active employee carrying only legacy NULLs in the lifecycle fields
    (1531, 'Legacy Nulls',      ${OUTLET_A}, 3, 1, NULL, NULL, NULL, 1, NULL),
    -- just onboarded: Employee ID allocated, Aadhaar / bank / salary all still pending
    (1600, 'Onboarding Pending', ${OUTLET_A}, 3, 1, NULL, '2026-10-01', NULL, 1, NULL),
    -- genuinely resigned: inactive with a resignation row - must stay hidden as before
    (1200, 'Murugan K',         ${OUTLET_A}, 3, 1, 1, '2023-01-01', 1, 0, '2026-05-31'),
    -- resigned and REJOINED through HR: active again, C2 row left behind
    (1300, 'Kavitha R',         ${OUTLET_A}, 3, 1, 1, '2026-08-01', 2, 1, NULL),
    -- a resignation recorded and then VOIDED
    (1301, 'Divya S',           ${OUTLET_A}, 3, 1, 1, '2025-01-01', 2, 1, NULL),
    -- inactive WITHOUT a resignation row: unchanged by this fix, still listed (the
    -- screen's own Active/Inactive filter decides whether it is shown)
    (1302, 'Inactive No Row',   ${OUTLET_A}, 3, 1, 1, '2024-01-01', 2, 0, NULL),
    -- someone at the other outlet
    (1700, 'Other Branch',      ${OUTLET_B}, 3, 1, 1, '2026-01-01', 2, 1, NULL),
    -- the callers
    (2001, 'Manager A',         ${OUTLET_A}, 9, 1, 1, '2022-01-01', 2, 1, NULL),
    (2002, 'Manager B',         ${OUTLET_B}, 9, 1, 1, '2022-01-01', 2, 1, NULL),
    (2003, 'HR Person',         ${OUTLET_B}, 11, 1, 1, '2022-01-01', 2, 1, NULL);

  INSERT INTO resignation (employee_id, period_id, employee_name, reason_type, resignation_date, voided_at) VALUES
    (NULL, NULL, 'Sathiya Priya', 'personal', '2025-03-31', NULL),
    (NULL, NULL, 'Murugan K',     'personal', '2026-05-31', NULL),
    (1300, 41,   'Kavitha R',     'personal', '2026-06-30', NULL),
    (1301, 42,   'Divya S',       'personal', '2025-12-31', '2026-01-02 10:00:00');
`;

describe("Employee directory vs the name-keyed resignation table, as SQL", {
  skip: !URL && "EMPLOYEE_DIRECTORY_TEST_MYSQL is not set",
}, () => {
  let pool;
  let q;
  let employeeRepo;
  let employeeUsecase;
  let branchScope;

  before(async () => {
    pool = require("mysql").createPool(
      `${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=4&multipleStatements=true`
    );
    q = (sql, params = []) =>
      new Promise((resolve, reject) => pool.query(sql, params, (err, res) => (err ? reject(err) : resolve(res))));

    employeeRepo = require("./employee")(pool);
    employeeUsecase = require("../usecase/employee")(employeeRepo, null, null, require("./resignation")(pool));

    // Only "who holds employee_scope_all_branches" is stubbed. The resolver,
    // the guards and the branch repository are the production ones.
    const permissions = {
      ADMIN_USER_TYPE: 2,
      has: async (req, key) => (req.__keys || []).includes(key),
      hasAll: async () => false,
      actorFor: async (req) => ({
        userId: req.auth.userId,
        employeeId: req.auth.employeeId,
        userType: req.decoded.user_type,
        isAdmin: Number(req.decoded.user_type) === 2,
        permissions: req.__keys || [],
      }),
    };
    branchScope = buildEmployeeBranchScope(permissions, new (require("./employee_branch"))(pool));
  });

  after(async () => {
    await new Promise((resolve) => pool.end(resolve));
  });

  beforeEach(async () => {
    await q(SCHEMA);
  });

  const caller = (employeeId, { hr = false, admin = false } = {}) => ({
    decoded: { user_type: admin ? 2 : 1 },
    auth: { userId: employeeId, employeeId },
    __keys: hr ? [P.EMPLOYEE_SCOPE_ALL_BRANCHES] : [],
    query: {},
  });

  /** `GET /employee/employees`, as the route runs it. */
  async function list(req, requested) {
    const scoped = await branchScope.listFilters(req, requested);
    if (!scoped.ok) return { refused: scoped.reason };
    const actor = await branchScope.actorFor(req);
    const rows = await employeeUsecase.get(requested ? { store_ids: requested } : {}, actor);
    return { ids: rows.map((r) => r.employee_id).sort((a, b) => a - b), rows };
  }

  const MANAGER_A = () => caller(2001);
  const MANAGER_B = () => caller(2002);
  const HR = () => caller(2003, { hr: true });

  /* ============================================= 1. legitimate access ==== */
  it("1530 IS LISTED for the manager of her own outlet", async () => {
    const { ids, rows } = await list(MANAGER_A());
    assert.ok(ids.includes(1530), `1530 missing from ${ids}`);
    const row = rows.find((r) => r.employee_id === 1530);
    assert.equal(row.employee_name, "Sathiya Priya");
    assert.equal(row.store_id, OUTLET_A);
    assert.equal(row.status, 1);
  });

  it("1530 IS LISTED for HR (all branches) and for an administrator", async () => {
    assert.ok((await list(HR())).ids.includes(1530));
    assert.ok((await list(caller(2003, { admin: true }))).ids.includes(1530));
  });

  it("1530 is listed when her outlet is picked as the filter", async () => {
    assert.ok((await list(MANAGER_A(), [OUTLET_A])).ids.includes(1530));
    assert.ok((await list(HR(), [OUTLET_A])).ids.includes(1530));
  });

  /* ================================================ 2. no access ========= */
  it("1530 STAYS HIDDEN from a manager of another outlet", async () => {
    const { ids } = await list(MANAGER_B());
    assert.ok(!ids.includes(1530));
    assert.ok(ids.every((id) => [1412, 1700, 2002, 2003].includes(id)), `leaked ${ids}`);
  });

  it("naming her outlet from another outlet is refused, not narrowed", async () => {
    assert.deepEqual(await list(MANAGER_B(), [OUTLET_A]), { refused: "OUT_OF_BRANCH" });
  });

  it("a manager whose own record is inactive, or has no branch, sees nobody", async () => {
    await q("UPDATE new_employee SET status = 0 WHERE employee_id = 2001");
    assert.deepEqual(await list(MANAGER_A()), { refused: "EMPLOYEE_INACTIVE" });
    await q("UPDATE new_employee SET status = 1, store_id = NULL WHERE employee_id = 2001");
    assert.deepEqual(await list(MANAGER_A()), { refused: "NO_BRANCH_ASSIGNED" });
  });

  /* ======================================= 3. null / legacy fields ======= */
  it("an active employee with NULL joining date, payment type and shift is listed", async () => {
    assert.ok((await list(MANAGER_A())).ids.includes(1531));
    assert.ok((await list(HR())).ids.includes(1531));
  });

  it("an active employee is not hidden by a name-keyed resignation row", async () => {
    const { ids } = await list(MANAGER_A());
    assert.ok(ids.includes(1300), "rejoined through HR - row left by C2 Resign");
    assert.ok(ids.includes(1301), "voided resignation");
  });

  /* ======================================== 4. onboarding pending ======== */
  it("an onboarding-pending employee is listed for its outlet and for HR, and not elsewhere", async () => {
    // Pending HR work is a DERIVED flag on the status summary, not a filter
    // on who exists: the list must carry them so HR can chase them.
    assert.ok((await list(MANAGER_A())).ids.includes(1600));
    assert.ok((await list(HR())).ids.includes(1600));
    assert.ok(!(await list(MANAGER_B())).ids.includes(1600));
  });

  it("the HR status summary population (no actor, outlet filter) includes 1530", async () => {
    // `EmployeeStatusSummaryUsecase.list` calls `employees.get(filters)` with
    // the route's already-narrowed store_ids and no actor.
    const rows = await employeeUsecase.get({ store_ids: [OUTLET_A] });
    assert.ok(rows.map((r) => r.employee_id).includes(1530));
  });

  /* =========================================== 5. nothing else moves ===== */
  it("A GENUINELY RESIGNED employee is still excluded, exactly as before", async () => {
    for (const req of [MANAGER_A(), HR()]) {
      const { ids } = await list(req);
      assert.ok(!ids.includes(1200), "Murugan K resigned and is inactive");
      assert.ok(!ids.includes(1412), "the namesake who resigned is still excluded");
    }
  });

  it("the full list for each caller is exactly the expected population", async () => {
    assert.deepEqual((await list(MANAGER_A())).ids, [1300, 1301, 1302, 1529, 1530, 1531, 1600, 2001]);
    assert.deepEqual((await list(MANAGER_B())).ids, [1700, 2002, 2003]);
    assert.deepEqual(
      (await list(HR())).ids,
      [1300, 1301, 1302, 1529, 1530, 1531, 1600, 1700, 2001, 2002, 2003]
    );
  });

  it("with no resignation rows at all, the population is unchanged", async () => {
    await q("DELETE FROM resignation");
    const { ids } = await list(MANAGER_A());
    // Murugan K reappears ONLY because there is no row - inactive rows were
    // always listed when nobody had resigned; the screen filters them.
    assert.deepEqual(ids, [1200, 1300, 1301, 1302, 1529, 1530, 1531, 1600, 2001]);
  });

  it("the search finds 1530 for her outlet, not for another, and is unchanged", async () => {
    const own = await employeeRepo.getEmployeeByFilter("Sathiya", [OUTLET_A]);
    assert.deepEqual(own.map((r) => r.employee_id), [1530]);
    const other = await employeeRepo.getEmployeeByFilter("Sathiya", [OUTLET_B]);
    assert.deepEqual(other.map((r) => r.employee_id), [], "the inactive namesake is not a search hit");
    const byId = await employeeRepo.getEmployeeByFilter("1530", null);
    assert.deepEqual(byId.map((r) => r.employee_id), [1530]);
  });

  it("the detail read and edit guards let her outlet in and keep others out", async () => {
    assert.equal((await branchScope.checkEmployee(MANAGER_A(), 1530)).ok, true);
    assert.equal((await branchScope.checkEmployee(HR(), 1530)).ok, true);
    assert.equal((await branchScope.checkEmployee(MANAGER_B(), 1530)).ok, false);
  });
});
