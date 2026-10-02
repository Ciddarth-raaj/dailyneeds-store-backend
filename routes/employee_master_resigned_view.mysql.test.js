/**
 * HR -> EMPLOYEE MASTER -> "RESIGNED", END TO END OVER REAL SQL.
 *
 *   EMPLOYEE_DIRECTORY_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test routes/employee_master_resigned_view.mysql.test.js
 *
 * SKIPPED unless `EMPLOYEE_DIRECTORY_TEST_MYSQL` names a SCRATCH database: the
 * suite drops and creates its tables.
 *
 * THE DEFECT. The Employee Master page loads `GET /employee/employees` once and
 * filters `Number(status) !== 1` in the browser for "Resigned". That list
 * removed every employee whose NAME is in `resignation` - and both Resign
 * flows write a row there - so every leaver whose resignation was RECORDED
 * was missing from the Resigned view (31 in production, 1530 among them),
 * while leavers with no row were shown.
 *
 * THE FIX. `include_resigned=1`, sent by the Employee Master page only, lifts
 * the name exclusion for NON-ACTIVE rows. Without the flag nothing changes.
 *
 * Everything below is the production stack: JWT auth, the permission
 * middleware reading `permissions` from MySQL, the branch-scope middleware
 * over the real `repository/employee_branch.js`, `routes/employee.js`,
 * `routes/employee_master.js`, the real usecases and repositories, and the
 * real status-summary usecase. Only the session-state lookup is stubbed.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-resigned-view-"));
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
fs.writeFileSync(path.join(dir, "priv.key"), privateKey);
fs.writeFileSync(path.join(dir, "pub.key"), publicKey);
process.env.JWT_PRIVATE_KEY_PATH = path.join(dir, "priv.key");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({ legacy: path.join(dir, "pub.key") });
process.env.JWT_ACTIVE_KID = "legacy";
process.env.JWT_LEGACY_KID = "legacy";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const URL = process.env.EMPLOYEE_DIRECTORY_TEST_MYSQL;

const MOOLAKULAM = 5;
const KATHIRKAMAM = 6;
const D = { CASHIER: 4, STORE_MANAGER: 9, HR: 11 };

const SCHEMA = `
  SET FOREIGN_KEY_CHECKS = 0;
  DROP VIEW IF EXISTS v_employee_current_period;
  DROP TABLE IF EXISTS resignation, new_employee, outlets, designation, department, shift_master,
    permissions, employee_employment_period;
  SET FOREIGN_KEY_CHECKS = 1;
  CREATE TABLE outlets (outlet_id INT PRIMARY KEY, outlet_name VARCHAR(80)) ENGINE=InnoDB;
  CREATE TABLE designation (designation_id INT PRIMARY KEY, designation_name VARCHAR(80)) ENGINE=InnoDB;
  CREATE TABLE department (department_id INT PRIMARY KEY, department_name VARCHAR(80)) ENGINE=InnoDB;
  CREATE TABLE shift_master (shift_id INT PRIMARY KEY, shift_name VARCHAR(80), shift_code VARCHAR(20),
    status TINYINT DEFAULT 0) ENGINE=InnoDB;
  CREATE TABLE permissions (id INT AUTO_INCREMENT PRIMARY KEY, permission_key VARCHAR(100),
    designation_id INT, is_active TINYINT(1) DEFAULT 1) ENGINE=InnoDB;
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
  CREATE TABLE employee_employment_period (
    period_id BIGINT PRIMARY KEY, employee_id INT NOT NULL, period_no INT NOT NULL,
    period_state ENUM('open','closed') NOT NULL, joined_on DATE NULL, ended_on DATE NULL,
    end_reason_type VARCHAR(20) NULL
  ) ENGINE=InnoDB;

  INSERT INTO outlets VALUES (${MOOLAKULAM}, 'Moolakulam'), (${KATHIRKAMAM}, 'Kathirkamam');
  INSERT INTO designation VALUES (${D.CASHIER}, 'CASHIER'), (${D.STORE_MANAGER}, 'STORE MANAGER'),
    (${D.HR}, 'HR EXECUTIVE');
  INSERT INTO permissions (permission_key, designation_id) VALUES
    ('view_employees', ${D.HR}), ('employee_scope_all_branches', ${D.HR}),
    ('view_employees', ${D.STORE_MANAGER});

  INSERT INTO new_employee (employee_id, employee_name, store_id, designation_id, status,
                            resignation_date, date_of_joining) VALUES
    -- callers
    (100, 'Hema HR',            ${KATHIRKAMAM}, ${D.HR},            1, NULL, '2020-01-01'),
    (101, 'Moola Manager',      ${MOOLAKULAM},  ${D.STORE_MANAGER}, 1, NULL, '2020-01-01'),
    (102, 'Kath Manager',       ${KATHIRKAMAM}, ${D.STORE_MANAGER}, 1, NULL, '2020-01-01'),
    (103, 'Moola Cashier',      ${MOOLAKULAM},  ${D.CASHIER},       1, NULL, '2020-01-01'),
    (105, 'Anu Admin',          ${KATHIRKAMAM}, ${D.CASHIER},       1, NULL, '2020-01-01'),
    -- 1530: resigned through HR Resign - status 0, row with employee_id, closed period
    (1530, 'Sathiya Priya',     ${MOOLAKULAM},  ${D.CASHIER}, 0, '2026-09-08', '2026-01-10'),
    -- resigned through the legacy screen: a name-only row
    (1531, 'Legacy Leaver',     ${MOOLAKULAM},  ${D.CASHIER}, 0, '2025-05-05', '2022-01-01'),
    -- resigned through HR Resign at the other outlet
    (1532, 'Kath Leaver',       ${KATHIRKAMAM}, ${D.CASHIER}, 0, '2026-07-31', '2023-01-01'),
    -- left with NO resignation row - already shown today
    (1533, 'Unrecorded Leaver', ${MOOLAKULAM},  ${D.CASHIER}, 0, NULL,         '2021-01-01'),
    -- active staff
    (1540, 'Active Moola',      ${MOOLAKULAM},  ${D.CASHIER}, 1, NULL, '2024-01-01'),
    (1541, 'Active Kath',       ${KATHIRKAMAM}, ${D.CASHIER}, 1, NULL, '2024-01-01'),
    -- a NAMESAKE pair: active at Moolakulam, a leaver of the same name at Kathirkamam
    (1542, 'Kumar S',           ${MOOLAKULAM},  ${D.CASHIER}, 1, NULL, '2025-02-01'),
    (1543, 'Kumar S',           ${KATHIRKAMAM}, ${D.CASHIER}, 0, '2024-12-31', '2020-06-01'),
    -- VOIDED resignation rows: one person active again, one still inactive
    (1544, 'Voided Active',     ${MOOLAKULAM},  ${D.CASHIER}, 1, NULL, '2023-01-01'),
    (1545, 'Voided Inactive',   ${MOOLAKULAM},  ${D.CASHIER}, 0, '2026-03-31', '2023-01-01');

  INSERT INTO resignation (resignation_id, employee_id, period_id, employee_name, reason_type,
                           resignation_date, voided_at) VALUES
    (14, 1530, 102,  'Sathiya Priya',   'personal', '2026-09-08', NULL),
    (3,  NULL, NULL, 'Legacy Leaver',   'personal', '05-05-2025', NULL),
    (15, 1532, 110,  'Kath Leaver',     'personal', '2026-07-31', NULL),
    (4,  NULL, NULL, 'Kumar S',         'personal', '2024-12-31', NULL),
    (16, 1544, 120,  'Voided Active',   'personal', '2026-02-01', '2026-02-03 10:00:00'),
    (17, 1545, 121,  'Voided Inactive', 'personal', '2026-03-31', '2026-04-01 10:00:00');

  INSERT INTO employee_employment_period VALUES
    (102, 1530, 1, 'closed', '2026-01-10', '2026-09-08', 'resignation');
`;

const ACTIVE_ALL = [100, 101, 102, 103, 105, 1540, 1541];
const TODAY_HR = [100, 101, 102, 103, 105, 1533, 1540, 1541]; // the list before the fix

describe("Employee Master Resigned view, over real SQL", {
  skip: !URL && "EMPLOYEE_DIRECTORY_TEST_MYSQL is not set",
}, () => {
  let pool;
  let q;
  let server;
  let port;
  let jwtService;

  before(async () => {
    pool = require("mysql").createPool(
      `${URL}${URL.includes("?") ? "&" : "?"}connectionLimit=4&multipleStatements=true&dateStrings=true`
    );
    q = (sql, params = []) =>
      new Promise((resolve, reject) => pool.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));

    const express = require("express");
    const bodyParser = require("body-parser");
    const auth = require("../middlewares/auth");
    const buildPermissions = require("../middlewares/permissions");
    const buildSensitive = require("../middlewares/sensitive");
    const buildBranchScope = require("../middlewares/employee_branch_scope");
    const EmployeeBranchRepository = require("../repository/employee_branch");
    jwtService = require("../services/jwt");

    const permissions = buildPermissions(require("../repository/designation")(pool));
    const sensitive = buildSensitive(permissions);
    const branchScope = buildBranchScope(permissions, new EmployeeBranchRepository(pool));
    const employeeUsecase = require("../usecase/employee")(
      require("../repository/employee")(pool), null, null, require("../repository/resignation")(pool));
    const statusSummary = require("../usecase/employee_status_summary")(employeeUsecase);

    const app = express();
    app.use(bodyParser.json());
    app.use(auth.create({
      userUsecase: {
        getSessionState: async (userId) => ({
          user_id: userId, employee_id: userId, status: 1, token_valid_from: null,
          is_system_account: 0, employee_status: 1,
        }),
      },
    }));
    app.use("/employee",
      require("./employee")(employeeUsecase, permissions, sensitive, branchScope).getRouter());
    app.use("/hr",
      require("./employee_master")({}, permissions, sensitive, null, null, statusSummary, null, branchScope)
        .getRouter());
    server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    port = server.address().port;
  });

  after(async () => {
    if (server) server.close();
    await new Promise((resolve) => pool.end(resolve));
  });

  beforeEach(async () => {
    await q(SCHEMA);
  });

  const tokenFor = (employeeId, designationId, userType = 1) =>
    jwtService.sign({
      auth_ver: 2, sub: String(employeeId), id: employeeId, employee_id: employeeId,
      user_type: userType, designation_id: designationId,
      store_id: KATHIRKAMAM, // a stale token claim must change nothing
    }, "1d");
  const CALLERS = {
    hr: () => tokenFor(100, D.HR),
    admin: () => tokenFor(105, D.CASHIER, 2),
    moolaManager: () => tokenFor(101, D.STORE_MANAGER),
    kathManager: () => tokenFor(102, D.STORE_MANAGER),
    cashier: () => tokenFor(103, D.CASHIER),
  };

  async function get(url, token) {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: { "x-access-token": await token } });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = null; }
    return { status: res.status, body, text };
  }
  const ids = (res) => {
    assert.ok(Array.isArray(res.body), `expected a list, got ${res.status} ${res.text.slice(0, 200)}`);
    return res.body.map((r) => Number(r.employee_id)).sort((a, b) => a - b);
  };
  const refused = (res) => res.status === 403 || (res.body && res.body.code === 403);
  /** What the page does with the list for each status option. */
  const view = (rows, status) =>
    rows.filter((r) => (status === "active" ? Number(r.status) === 1 : Number(r.status) !== 1))
      .map((r) => Number(r.employee_id)).sort((a, b) => a - b);

  const LIST = "/employee/employees";
  const INCLUSIVE = "/employee/employees?include_resigned=1";

  /* =============================================== 1. the 1530 record ==== */
  it("1. a 1530-style leaver (status 0, own resignation row, closed period) is returned with the flag", async () => {
    const res = await get(INCLUSIVE, CALLERS.hr());
    assert.ok(ids(res).includes(1530));
    const row = res.body.find((r) => Number(r.employee_id) === 1530);
    assert.equal(Number(row.status), 0);
    assert.equal(row.store_name, "Moolakulam");
    assert.ok(view(res.body, "resigned").includes(1530), "and the page's Resigned filter keeps her");
  });

  /* =========================================== 2. no flag, no change ===== */
  it("2. without the flag the response is exactly today's population", async () => {
    assert.deepEqual(ids(await get(LIST, CALLERS.hr())), TODAY_HR);
    assert.deepEqual(ids(await get(`${LIST}?include_resigned=0`, CALLERS.hr())), TODAY_HR);
    assert.deepEqual(ids(await get(LIST, CALLERS.moolaManager())), [101, 103, 1533, 1540]);
  });

  /* ====================================== 3. every recorded leaver ======= */
  it("3. EVERY inactive employee is in the Resigned view, whatever kind of resignation row they have", async () => {
    const inactive = (await q("SELECT employee_id FROM new_employee WHERE NOT (status <=> 1) ORDER BY employee_id"))
      .map((r) => Number(r.employee_id));
    const res = await get(INCLUSIVE, CALLERS.hr());
    assert.deepEqual(view(res.body, "resigned"), inactive);
    // The ones the old list lost: own row (HR Resign), legacy name-only,
    // the other outlet, a namesake's row, a voided row.
    for (const id of [1530, 1531, 1532, 1543, 1545]) {
      assert.ok(!ids(await get(LIST, CALLERS.hr())).includes(id), `${id} was hidden before`);
    }
  });

  /* ==================================== 4. the Active view is unchanged == */
  it("4. the Active view is identical with and without the flag", async () => {
    for (const caller of [CALLERS.hr, CALLERS.admin, CALLERS.moolaManager, CALLERS.kathManager]) {
      const before = (await get(LIST, caller())).body;
      const after = (await get(INCLUSIVE, caller())).body;
      assert.deepEqual(view(after, "active"), view(before, "active"));
    }
    assert.deepEqual(view((await get(INCLUSIVE, CALLERS.hr())).body, "active"), ACTIVE_ALL);
  });

  /* ======================== 5 & 6. pickers and onboarding queue ========= */
  it("5/6. callers that send no flag - the pickers and the onboarding queue - get the same rows as before", async () => {
    // Pickers call the list with outlet / designation filters and no flag;
    // the onboarding queue calls the list and the status summary with none.
    const pick = await get(`${LIST}?store_ids[]=${MOOLAKULAM}&designation_ids[]=${D.CASHIER}`, CALLERS.hr());
    assert.deepEqual(ids(pick), [103, 1533, 1540]);
    const summary = await get("/hr/employees/status-summary", CALLERS.hr());
    assert.deepEqual(ids(summary), TODAY_HR);
  });

  /* ========================================= 7. namesakes stay safe ===== */
  it("7. a namesake pair: the leaver appears in Resigned, the active namesake's Active row is unchanged", async () => {
    const after = (await get(INCLUSIVE, CALLERS.hr())).body;
    assert.ok(view(after, "resigned").includes(1543), "the Kathirkamam leaver named Kumar S");
    assert.ok(!ids({ body: after, text: "" }).includes(1542), "the active Kumar S is hidden exactly as before");
    // And the leaver is still Kathirkamam's, not Moolakulam's.
    assert.ok(!ids(await get(INCLUSIVE, CALLERS.moolaManager())).includes(1543));
  });

  /* ===================================== 8. voided resignation rows ===== */
  it("8. voided rows follow today's rule (they still count by name): inactive shown, active unchanged", async () => {
    const after = ids(await get(INCLUSIVE, CALLERS.hr()));
    assert.ok(after.includes(1545), "inactive with a voided row: in Resigned");
    assert.ok(!after.includes(1544), "active with a voided row: the Active view is untouched");
  });

  /* ======================================== 9. outlet security ========== */
  it("9a. HR and admin see the full resigned population", async () => {
    const want = [1530, 1531, 1532, 1533, 1543, 1545];
    assert.deepEqual(view((await get(INCLUSIVE, CALLERS.hr())).body, "resigned"), want);
    assert.deepEqual(view((await get(INCLUSIVE, CALLERS.admin())).body, "resigned"), want);
  });

  it("9b. the Moolakulam manager sees Moolakulam's resigned employees, 1530 among them, and no others", async () => {
    const res = await get(INCLUSIVE, CALLERS.moolaManager());
    assert.deepEqual(view(res.body, "resigned"), [1530, 1531, 1533, 1545]);
    for (const row of res.body) assert.equal(Number(row.store_id), MOOLAKULAM);
  });

  it("9c. a manager from another outlet cannot see Moolakulam's resigned employees", async () => {
    const res = await get(INCLUSIVE, CALLERS.kathManager());
    for (const id of [1530, 1531, 1533, 1545]) assert.ok(!ids(res).includes(id), `${id} leaked`);
    for (const row of res.body) assert.equal(Number(row.store_id), KATHIRKAMAM);
    assert.ok(!res.text.includes("Sathiya"));
  });

  it("9d. explicitly requesting Moolakulam from another outlet is still refused, flag or not", async () => {
    assert.ok(refused(await get(`${INCLUSIVE}&store_ids[]=${MOOLAKULAM}`, CALLERS.kathManager())));
    assert.ok(refused(await get(`${LIST}?store_ids[]=${MOOLAKULAM}`, CALLERS.kathManager())));
    assert.ok(refused(await get(`/hr/employees/status-summary?include_resigned=1&store_ids[]=${MOOLAKULAM}`,
      CALLERS.kathManager())));
  });

  it("9e. permissions are unchanged: no view_employees, no list - with or without the flag", async () => {
    assert.ok(refused(await get(INCLUSIVE, CALLERS.cashier())));
    assert.ok(refused(await get(LIST, CALLERS.cashier())));
    assert.ok(refused(await get("/hr/employees/status-summary?include_resigned=1", CALLERS.cashier())));
  });

  it("9f. only 0 or 1 is accepted", async () => {
    for (const bad of ["true", "2", "yes"]) {
      const res = await get(`${LIST}?include_resigned=${bad}`, CALLERS.hr());
      assert.equal(res.body && res.body.code, 422, `${bad}: ${res.text.slice(0, 120)}`);
    }
  });

  /* ============================ 10. status summary matches the list ===== */
  it("10. the HR status summary covers exactly the rows the list returns, for every caller and both modes", async () => {
    for (const caller of [CALLERS.hr, CALLERS.admin, CALLERS.moolaManager, CALLERS.kathManager]) {
      for (const qs of ["", "?include_resigned=1"]) {
        const list = ids(await get(`${LIST}${qs}`, caller()));
        const summary = ids(await get(`/hr/employees/status-summary${qs}`, caller()));
        assert.deepEqual(summary, list, `status summary vs list, ${qs || "no flag"}`);
      }
    }
    const summary = (await get("/hr/employees/status-summary?include_resigned=1", CALLERS.hr())).body;
    assert.ok(summary.find((s) => Number(s.employee_id) === 1530), "1530 has a badge row");
  });

  /* ======================================== nothing was written ========= */
  it("reading the Resigned view writes nothing", async () => {
    const snap = () => q("CHECKSUM TABLE new_employee, resignation, employee_employment_period");
    const before = await snap();
    await get(INCLUSIVE, CALLERS.hr());
    await get("/hr/employees/status-summary?include_resigned=1", CALLERS.hr());
    assert.deepEqual(await snap(), before);
  });
});
