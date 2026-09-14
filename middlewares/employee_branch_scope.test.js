/**
 * EMPLOYEE BRANCH SCOPE, end to end over the real routers.
 *
 *   node --test middlewares/employee_branch_scope.test.js
 *
 * A REAL Express app with the REAL authentication middleware, the REAL
 * permission middleware, the REAL branch-scope resolver and the REAL
 * `/employee` and `/hr` routers. Only the database is stood in for, by an
 * in-memory employee table that the stub usecases filter exactly as the SQL
 * does. Nothing about the authorization rule is re-implemented here.
 *
 * THE POINT IS THAT THE REQUEST IS REFUSED, not that a screen hides a button.
 * Every case below is an HTTP call carrying a signed token; a manager typing
 * another branch's employee id into the URL, or curling the API directly,
 * makes exactly these requests.
 *
 * The numbered cases are the ones the approved task requires.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-branch-"));
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

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");

const auth = require("./auth");
const buildPermissions = require("./permissions");
const buildSensitive = require("./sensitive");
const buildBranchScope = require("./employee_branch_scope");
const { branchRepo } = require("../test_support/employee_branch_scope");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");
const { accessScope } = require("../repository/employee_scope");

/* ------------------------------------------------------------- the world */

const KATHIRKAMAM = 1;
const MOOLAKULAM = 2;
const ECR = 3;

// Employees. The first group sign in; the second are acted on. Both are in one
// table because in production they are: an actor is an employee.
const KAT_EMPLOYEE = 201;
const MOO_EMPLOYEE = 202;
const ECR_EMPLOYEE = 203;
const NO_SUCH_EMPLOYEE = 999;

const EMPLOYEES = [
  // actors
  { employee_id: 100, employee_name: "Hema HR", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 101, employee_name: "Selva Manager", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 102, employee_name: "Mala Multi", store_ids: [KATHIRKAMAM, ECR], status: 1 },
  { employee_id: 103, employee_name: "Nila Nokeys", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 104, employee_name: "Bala Nobranch", store_id: null, status: 1 },
  { employee_id: 105, employee_name: "Anu Admin", store_id: MOOLAKULAM, status: 1 },
  // targets
  { employee_id: KAT_EMPLOYEE, employee_name: "Kavi Kathirkamam", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: MOO_EMPLOYEE, employee_name: "Mohan Moolakulam", store_id: MOOLAKULAM, status: 1 },
  { employee_id: ECR_EMPLOYEE, employee_name: "Esha ECR", store_id: ECR, status: 1 },
];

/* --------------------------------------------------------- designations */

const D = {
  HR: 1,
  MANAGER_VIEW: 2,
  MANAGER_EDIT: 3,
  NO_KEYS: 4,
  MULTI_VIEW: 5,
  ADMIN: 6,
};

const GRANTS = {
  // HR: company-wide, through the one key.
  [D.HR]: [
    P.VIEW_EMPLOYEES,
    P.EMPLOYEE_EDIT,
    P.EMPLOYEE_CREATE,
    P.ADD_EMPLOYEES,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
  ],
  [D.MANAGER_VIEW]: [P.VIEW_EMPLOYEES],
  // A store manager who onboards: `employee_create` is here so the create and
  // duplicate-check cases below are refused by the BRANCH rule rather than by
  // a missing key, which would have made them pass for the wrong reason.
  [D.MANAGER_EDIT]: [P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT, P.EMPLOYEE_CREATE, P.ADD_EMPLOYEES],
  [D.NO_KEYS]: [],
  [D.MULTI_VIEW]: [P.VIEW_EMPLOYEES],
  [D.ADMIN]: [],
};

/* ------------------------------------------------- the stub data layer  */

const byId = (id) => EMPLOYEES.find((e) => Number(e.employee_id) === Number(id)) || null;

/** Applies exactly what `_branchClause` renders: null is unrestricted, [] is nothing. */
const inBranches = (row, storeIds) => {
  if (storeIds === null || storeIds === undefined) return true;
  if (!Array.isArray(storeIds) || storeIds.length === 0) return false;
  return storeIds.map(Number).includes(Number(row.store_id));
};

let lastEdit = null;
let lastCreate = null;
let lastUpdateData = null;
let lastDuplicateCheck = null;

const employeeUsecase = {
  // `get` receives the ACTOR, and the branch predicate is rendered from it by
  // the same `accessScope` the SQL uses - so this stub cannot agree with the
  // route while the query would not.
  async get(filters, actor) {
    const scope = accessScope(actor);
    if (scope.conditions.includes("1 = 0")) return [];
    const allowed = scope.conditions.length === 0 ? null : scope.params[0];
    return EMPLOYEES.filter((e) => inBranches(e, allowed)).filter((e) =>
      Array.isArray(filters && filters.store_ids) && filters.store_ids.length
        ? filters.store_ids.map(Number).includes(Number(e.store_id))
        : true
    );
  },
  async getEmployeeByFilter(filter, storeIds) {
    return EMPLOYEES.filter((e) => inBranches(e, storeIds)).filter((e) =>
      e.employee_name.toLowerCase().includes(String(filter).toLowerCase())
    );
  },
  async getEmployeeById(employeeId) {
    const row = byId(employeeId);
    return row ? [row] : [];
  },
  async getHeadCount(storeIds) {
    return [{ head_count: EMPLOYEES.filter((e) => inBranches(e, storeIds)).length }];
  },
  async getEmployeeByStore(storeId) {
    return [{ store_count: EMPLOYEES.filter((e) => Number(e.store_id) === Number(storeId)).length }];
  },
  async getFamilyDet(storeIds) {
    return EMPLOYEES.filter((e) => inBranches(e, storeIds));
  },
  async create(employee) {
    lastCreate = employee;
    return { code: 200 };
  },
  async updateEmployeeDetails(employee) {
    lastUpdateData = employee;
    return 200;
  },
  async updateStatus() {
    return 200;
  },
  async getDirectory() {
    return [];
  },
};

const employeeMasterUsecase = {
  async editEmployee(employeeId, body) {
    lastEdit = { employeeId, body };
    return { code: 200 };
  },
  async createEmployee(body) {
    lastCreate = body;
    return { code: 200 };
  },
  async getLifecycleHistory(employeeId) {
    return { code: 200, employee_id: employeeId, events: [] };
  },
  async resignEmployee() {
    return { code: 200 };
  },
  async findPossibleDuplicates(body, options) {
    lastDuplicateCheck = { body, options };
    return { code: 200, matches: [] };
  },
  async getReviewList() {
    return { code: 200, items: [] };
  },
};

/* ------------------------------------------------------------- the app  */

let server, port;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const sensitive = buildSensitive(permissions);
  const branchScope = buildBranchScope(permissions, branchRepo(EMPLOYEES));

  const app = express();
  app.use(bodyParser.json());
  app.use(
    auth.create({
      userUsecase: {
        getSessionState: async (userId) => ({
          user_id: userId,
          employee_id: userId,
          status: 1,
          token_valid_from: null,
          is_system_account: 0,
          employee_status: 1,
        }),
      },
    })
  );

  for (const mod of ["../routes/employee", "../routes/employee_master"]) {
    delete require.cache[require.resolve(mod)];
  }
  app.use(
    "/employee",
    require("../routes/employee")(employeeUsecase, permissions, sensitive, branchScope).getRouter()
  );
  app.use(
    "/hr",
    require("../routes/employee_master")(
      employeeMasterUsecase,
      permissions,
      sensitive,
      null,
      null,
      null,
      null,
      branchScope
    ).getRouter()
  );

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

/* ------------------------------------------------------------- callers  */

/** A signed session. `employeeId` doubles as the user id, as the stub state says. */
const tokenFor = (employeeId, designationId, userType = 1) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(employeeId),
      id: employeeId,
      employee_id: employeeId,
      user_type: userType,
      designation_id: designationId,
      // DELIBERATELY THE WRONG BRANCH IN THE TOKEN on every caller. The scope
      // must come from the live employee record, so a token claim that
      // disagrees with it has to change nothing at all.
      store_id: MOOLAKULAM,
    },
    "1d"
  );

const CALLERS = {
  admin: () => tokenFor(105, D.ADMIN, 2),
  hr: () => tokenFor(100, D.HR),
  managerView: () => tokenFor(101, D.MANAGER_VIEW),
  managerEdit: () => tokenFor(101, D.MANAGER_EDIT),
  noKeys: () => tokenFor(103, D.NO_KEYS),
  multi: () => tokenFor(102, D.MULTI_VIEW),
  noBranch: () => tokenFor(104, D.MANAGER_EDIT),
};

const call = async (method, url, token, body) => {
  // `jwtService.sign` is async, so the callers above hand over a promise.
  const accessToken = await token;
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: {
      "x-access-token": accessToken,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = null;
  }
  return { status: res.status, body: json, text };
};

const get = (url, token) => call("GET", url, token);
const post = (url, token, body) => call("POST", url, token, body);

/** A refusal, whichever of the two forms the API uses. */
const assertRefused = (res, what) => {
  const code = res.body && res.body.code;
  assert.ok(
    res.status === 403 || code === 403,
    `${what}: expected a refusal, got ${res.status} ${res.text.slice(0, 200)}`
  );
};

/* ======================================================================= */
/*  1-2. HR AND ADMIN VIEW EVERY BRANCH                                    */
/* ======================================================================= */

describe("HR and Admin are company-wide", () => {
  it("1. Admin + View Employee reads an employee in any branch", async () => {
    for (const id of [KAT_EMPLOYEE, MOO_EMPLOYEE, ECR_EMPLOYEE]) {
      const res = await get(`/employee/employee_id?employee_id=${id}`, CALLERS.admin());
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body[0].employee_id, id);
    }
  });

  it("2. HR + View Employee reads an employee in any branch", async () => {
    for (const id of [KAT_EMPLOYEE, MOO_EMPLOYEE, ECR_EMPLOYEE]) {
      const res = await get(`/employee/employee_id?employee_id=${id}`, CALLERS.hr());
      assert.equal(res.status, 200, res.text);
      assert.equal(res.body[0].employee_id, id);
    }
  });

  it("HR's own branch is Kathirkamam, so this is the KEY and not their branch", async () => {
    // Hema HR is assigned to Kathirkamam. Reading a Moolakulam employee above
    // therefore proves the all-branches key is doing the work.
    assert.equal(byId(100).store_id, KATHIRKAMAM);
  });

  it("18. HR still sees the whole company in the employee LIST", async () => {
    const res = await get("/employee/employees", CALLERS.hr());
    assert.equal(res.status, 200);
    const branches = new Set(res.body.map((e) => e.store_id));
    assert.ok(branches.has(KATHIRKAMAM) && branches.has(MOOLAKULAM) && branches.has(ECR));
  });

  it("18. and so does an administrator", async () => {
    const res = await get("/employee/employees", CALLERS.admin());
    assert.equal(res.status, 200);
    assert.equal(res.body.length, EMPLOYEES.length);
  });
});

/* ======================================================================= */
/*  3-6, 9, 16. VIEW EMPLOYEE IS BRANCH-SCOPED                             */
/* ======================================================================= */

describe("View Employee is confined to the caller's branches", () => {
  it("3. Store Manager + View Employee + same branch is allowed", async () => {
    const res = await get(`/employee/employee_id?employee_id=${KAT_EMPLOYEE}`, CALLERS.managerView());
    assert.equal(res.status, 200);
    assert.equal(res.body[0].employee_id, KAT_EMPLOYEE);
    // AND THE EMPLOYEE'S OWN STATUS COMES BACK. This endpoint used to answer
    // with `status` taken from the joined `shift_master` table because of a
    // `SELECT *` collision, so an active employee read as 0 and the profile
    // drew "Resigned" over somebody who works here - visible only to a caller
    // without `view_employee_lifecycle`, which is exactly this caller.
    assert.equal(res.body[0].status, 1, "the employee master's status, not a joined table's");
  });

  it("4. Store Manager + View Employee + different branch is denied", async () => {
    const res = await get(`/employee/employee_id?employee_id=${MOO_EMPLOYEE}`, CALLERS.managerView());
    assertRefused(res, "Kathirkamam manager reading a Moolakulam employee");
    assert.ok(!res.text.includes("Mohan"), "and no part of the record comes back");
  });

  it("5. a caller WITHOUT View Employee is denied even in their own branch", async () => {
    const res = await get(`/employee/employee_id?employee_id=${KAT_EMPLOYEE}`, CALLERS.noKeys());
    assertRefused(res, "no view_employees");
    // The permission check is unchanged and still refuses first: holding a
    // branch never grants a key.
    assert.ok(!res.text.includes("Kavi"));
  });

  it("6. a multi-branch user sees their branches and no others", async () => {
    const ok = await Promise.all(
      [KAT_EMPLOYEE, ECR_EMPLOYEE].map((id) =>
        get(`/employee/employee_id?employee_id=${id}`, CALLERS.multi())
      )
    );
    for (const res of ok) assert.equal(res.status, 200);

    const denied = await get(`/employee/employee_id?employee_id=${MOO_EMPLOYEE}`, CALLERS.multi());
    assertRefused(denied, "multi-branch user reaching a third branch");
  });

  it("9. the detail API called directly for another branch is denied", async () => {
    // No browser, no screen - the request a curl makes.
    const res = await get(`/employee/employee_id?employee_id=${MOO_EMPLOYEE}`, CALLERS.managerView());
    assertRefused(res, "direct detail API");
  });

  it("16. a MANIPULATED employee id cannot bypass the rule, and cannot be probed", async () => {
    const foreign = await get(
      `/employee/employee_id?employee_id=${MOO_EMPLOYEE}`,
      CALLERS.managerView()
    );
    const missing = await get(
      `/employee/employee_id?employee_id=${NO_SUCH_EMPLOYEE}`,
      CALLERS.managerView()
    );
    assertRefused(foreign, "another branch's id");
    assertRefused(missing, "an id that does not exist");
    // THE SAME ANSWER FOR BOTH. A different one would let a manager enumerate
    // which employee ids exist in branches they cannot see.
    assert.equal(foreign.status, missing.status);
    assert.deepEqual(foreign.body, missing.body);
  });
});

/* ======================================================================= */
/*  7-8. LISTS, SEARCH AND COUNTS                                          */
/* ======================================================================= */

describe("the list, the search and the counts carry the same scope", () => {
  it("7. the employee list returns only the caller's branch", async () => {
    const res = await get("/employee/employees", CALLERS.managerView());
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0, "their own branch is not empty");
    for (const row of res.body) {
      assert.equal(row.store_id, KATHIRKAMAM, `${row.employee_name} is not in this branch`);
    }
    assert.ok(!res.text.includes("Mohan"), "no Moolakulam employee appears anywhere in the body");
  });

  it("7. a multi-branch user's list spans exactly their branches", async () => {
    const res = await get("/employee/employees", CALLERS.multi());
    assert.equal(res.status, 200);
    const branches = new Set(res.body.map((e) => Number(e.store_id)));
    assert.deepEqual([...branches].sort(), [KATHIRKAMAM, ECR]);
  });

  it("7. asking for ANOTHER branch is refused, not silently narrowed", async () => {
    const res = await get(`/employee/employees?store_ids[]=${MOOLAKULAM}`, CALLERS.managerView());
    assertRefused(res, "a store_ids filter naming another branch");
  });

  it("7. asking for their OWN branch is honoured", async () => {
    const res = await get(`/employee/employees?store_ids[]=${KATHIRKAMAM}`, CALLERS.managerView());
    assert.equal(res.status, 200);
    for (const row of res.body) assert.equal(row.store_id, KATHIRKAMAM);
  });

  it("8. search / autocomplete returns only the caller's branch", async () => {
    // A search whose term matches an employee in EVERY branch.
    const res = await get("/employee/filter?filter=a", CALLERS.managerView());
    assert.equal(res.status, 200);
    for (const row of res.body) assert.equal(row.store_id, KATHIRKAMAM);
    assert.ok(!res.text.includes("Mohan"));
    assert.ok(!res.text.includes("Esha"));
  });

  it("8. HR's search still spans the company", async () => {
    const res = await get("/employee/filter?filter=a", CALLERS.hr());
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("Mohan"));
  });

  it("a COUNT does not leak the branches the list hides", async () => {
    const scoped = await get("/employee/headcount", CALLERS.managerView());
    const wide = await get("/employee/headcount", CALLERS.hr());
    assert.equal(scoped.status, 200);
    assert.ok(
      scoped.body[0].head_count < wide.body[0].head_count,
      "a branch count must be smaller than the company count"
    );
  });

  it("a per-branch count for ANOTHER branch is refused", async () => {
    const own = await get(`/employee/store_id?store_id=${KATHIRKAMAM}`, CALLERS.managerView());
    assert.equal(own.status, 200);
    const other = await get(`/employee/store_id?store_id=${MOOLAKULAM}`, CALLERS.managerView());
    assertRefused(other, "a headcount for another branch");
  });
});

/* ======================================================================= */
/*  10-15, 17. EDIT EMPLOYEE                                               */
/* ======================================================================= */

describe("Edit Employee is confined to the caller's branches", () => {
  const edit = (id, token, body = { employee_name: "Renamed" }) =>
    post(`/hr/employee/${id}/edit`, token, body);

  it("10. Admin + Edit Employee edits any branch", async () => {
    for (const id of [KAT_EMPLOYEE, MOO_EMPLOYEE]) {
      lastEdit = null;
      const res = await edit(id, CALLERS.admin());
      assert.equal(res.status, 200);
      assert.equal(lastEdit.employeeId, id);
    }
  });

  it("11. HR + Edit Employee edits any branch", async () => {
    lastEdit = null;
    const res = await edit(MOO_EMPLOYEE, CALLERS.hr());
    assert.equal(res.status, 200);
    assert.equal(lastEdit.employeeId, MOO_EMPLOYEE);
  });

  it("12. Store Manager + Edit Employee + same branch is allowed", async () => {
    lastEdit = null;
    const res = await edit(KAT_EMPLOYEE, CALLERS.managerEdit());
    assert.equal(res.status, 200);
    assert.equal(lastEdit.employeeId, KAT_EMPLOYEE);
  });

  it("13. Store Manager + Edit Employee + different branch is 403", async () => {
    lastEdit = null;
    const res = await edit(MOO_EMPLOYEE, CALLERS.managerEdit());
    assert.equal(res.status, 403, "a real 403, not a 200 carrying a code");
    assert.equal(lastEdit, null, "and nothing reached the usecase");
  });

  it("14. a caller WITHOUT Edit Employee is denied in their own branch", async () => {
    lastEdit = null;
    const res = await edit(KAT_EMPLOYEE, CALLERS.managerView());
    assertRefused(res, "view-only caller editing");
    assert.equal(lastEdit, null);
  });

  it("15. the edit API called directly for another branch is 403", async () => {
    lastEdit = null;
    const res = await post(`/hr/employee/${MOO_EMPLOYEE}/edit`, CALLERS.managerEdit(), {
      primary_contact_number: "9000000000",
    });
    assert.equal(res.status, 403);
    assert.equal(lastEdit, null);
  });

  it("15. and so is every other write that names an employee", async () => {
    for (const [method, url, body] of [
      ["POST", `/hr/employee/${MOO_EMPLOYEE}/resign`, { resignation_date: "2026-01-01" }],
      ["POST", `/hr/employee/${MOO_EMPLOYEE}/joining-date`, { date_of_joining: "2026-01-01" }],
      ["POST", `/hr/employee/${MOO_EMPLOYEE}/rejoin`, { date_of_joining: "2026-01-01" }],
      ["POST", "/employee/update-status", { employee_id: MOO_EMPLOYEE, status: 0 }],
      [
        "POST",
        "/employee/updatedata",
        { employee_id: MOO_EMPLOYEE, employee_details: { employee_name: "x" } },
      ],
    ]) {
      lastEdit = null;
      lastUpdateData = null;
      const res = await call(method, url, CALLERS.managerEdit(), body);
      assertRefused(res, `${method} ${url}`);
      assert.equal(lastEdit, null);
      assert.equal(lastUpdateData, null);
    }
  });

  it("15. reads that name an employee are refused the same way", async () => {
    const res = await get(`/hr/employee/${MOO_EMPLOYEE}/lifecycle`, CALLERS.managerEdit());
    assertRefused(res, "another branch's lifecycle history");
  });

  it("the same writes SUCCEED for an employee in the caller's own branch", async () => {
    lastUpdateData = null;
    const res = await post("/employee/updatedata", CALLERS.managerEdit(), {
      employee_id: KAT_EMPLOYEE,
      employee_details: { employee_name: "Kavi K" },
    });
    assert.equal(res.status, 200);
    assert.ok(lastUpdateData, "the write went through");
  });
});

/* ======================================================================= */
/*  17. BRANCH TRANSFER                                                     */
/* ======================================================================= */

describe("branch transfer", () => {
  it("17. a scoped caller cannot move an employee OUT of their branch", async () => {
    lastEdit = null;
    const res = await post(`/hr/employee/${KAT_EMPLOYEE}/edit`, CALLERS.managerEdit(), {
      store_id: MOOLAKULAM,
    });
    assert.equal(res.status, 403);
    assert.equal(lastEdit, null, "the transfer never reached the usecase");
  });

  it("17. nor through the legacy updatedata route", async () => {
    lastUpdateData = null;
    const res = await post("/employee/updatedata", CALLERS.managerEdit(), {
      employee_id: KAT_EMPLOYEE,
      employee_details: { store_id: MOOLAKULAM },
    });
    assertRefused(res, "a legacy transfer");
    assert.equal(lastUpdateData, null);
  });

  it("17. an edit that does not name a branch is not a transfer and still works", async () => {
    lastEdit = null;
    const res = await post(`/hr/employee/${KAT_EMPLOYEE}/edit`, CALLERS.managerEdit(), {
      employee_name: "Kavi K",
    });
    assert.equal(res.status, 200);
    assert.ok(lastEdit);
  });

  it("17. naming their OWN branch is a no-op transfer and is allowed", async () => {
    lastEdit = null;
    const res = await post(`/hr/employee/${KAT_EMPLOYEE}/edit`, CALLERS.managerEdit(), {
      store_id: KATHIRKAMAM,
    });
    assert.equal(res.status, 200);
    assert.ok(lastEdit);
  });

  it("17. HR retains the transfer capability it has today", async () => {
    lastEdit = null;
    const res = await post(`/hr/employee/${KAT_EMPLOYEE}/edit`, CALLERS.hr(), {
      store_id: MOOLAKULAM,
    });
    assert.equal(res.status, 200);
    assert.equal(lastEdit.body.store_id, MOOLAKULAM);
  });

  it("17. and a scoped caller cannot CREATE into another branch either", async () => {
    const body = (storeId) => ({
      employee_name: "New Person",
      date_of_joining: "2026-01-01",
      store_id: storeId,
      designation_id: 3,
      department_id: 1,
    });

    lastCreate = null;
    const refused = await post("/hr/employee", CALLERS.managerEdit(), body(MOOLAKULAM));
    assertRefused(refused, "creating into another branch");
    assert.equal(lastCreate, null);

    // And the SAME caller creating into their OWN branch succeeds - so the
    // refusal above is the branch rule and not a missing `employee_create`.
    lastCreate = null;
    const allowed = await post("/hr/employee", CALLERS.managerEdit(), body(KATHIRKAMAM));
    assert.equal(allowed.status, 200);
    assert.equal(lastCreate.store_id, KATHIRKAMAM);
  });
});

/* ======================================================================= */
/*  THE DUPLICATE CHECK SEARCHES WIDE AND ANSWERS NARROW                    */
/* ======================================================================= */

describe("the duplicate check", () => {
  const check = (token) =>
    post("/hr/employee/check-duplicate", token, { employee_name: "Someone" });

  it("is NOT narrowed for a scoped caller - it is answered narrowly instead", async () => {
    lastDuplicateCheck = null;
    const res = await check(CALLERS.managerEdit());
    assert.equal(res.status, 200, "a scoped caller may still run the check");
    // The route hands over which branches may be DESCRIBED. It passes no
    // filter to the query: `visibleStoreIds`, not `storeIds`.
    assert.deepEqual(lastDuplicateCheck.options, { visibleStoreIds: [KATHIRKAMAM] });
  });

  it("HR and administrators are unrestricted", async () => {
    for (const caller of [CALLERS.hr, CALLERS.admin]) {
      lastDuplicateCheck = null;
      const res = await check(caller());
      assert.equal(res.status, 200);
      assert.equal(
        lastDuplicateCheck.options.visibleStoreIds,
        null,
        "null is no boundary, not an empty one"
      );
    }
  });

  it("a caller whose branch cannot be resolved is still refused", async () => {
    lastDuplicateCheck = null;
    const res = await check(CALLERS.noBranch());
    assertRefused(res, "a branchless caller running the duplicate check");
    assert.equal(lastDuplicateCheck, null);
  });
});

/* ======================================================================= */
/*  FAIL CLOSED                                                             */
/* ======================================================================= */

describe("it fails closed", () => {
  it("a caller with NO branch assigned gets nothing, not everything", async () => {
    const list = await get("/employee/employees", CALLERS.noBranch());
    assertRefused(list, "the list for a branchless caller");
    assert.ok(!list.text.includes("Kavi"), "and no employee is disclosed with the refusal");

    const detail = await get(
      `/employee/employee_id?employee_id=${KAT_EMPLOYEE}`,
      CALLERS.noBranch()
    );
    assertRefused(detail, "a detail read for a branchless caller");

    const edit = await post(`/hr/employee/${KAT_EMPLOYEE}/edit`, CALLERS.noBranch(), {
      employee_name: "x",
    });
    assert.equal(edit.status, 403);
  });

  it("the refusal names the fault, so it can be corrected", async () => {
    const res = await get("/employee/employees", CALLERS.noBranch());
    assert.equal(res.body.error, "NO_BRANCH_ASSIGNED");
    assert.match(res.body.msg, /branch/i);
  });

  it("THE TOKEN'S store_id IS IGNORED - the branch comes from the record", async () => {
    // Every token in this file claims Moolakulam. If the scope were built from
    // the claim, the Kathirkamam manager would be reading Moolakulam and
    // refused their own branch - the exact reverse of what happens.
    const own = await get(`/employee/employee_id?employee_id=${KAT_EMPLOYEE}`, CALLERS.managerView());
    const claimed = await get(
      `/employee/employee_id?employee_id=${MOO_EMPLOYEE}`,
      CALLERS.managerView()
    );
    assert.equal(own.status, 200, "their real branch is readable");
    assertRefused(claimed, "the branch their stale token claims is not");
  });

  it("an anonymous caller is still refused by authentication, before any of this", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/employee/employees`);
    const body = await res.json();
    assert.equal(body.code, 403);
  });
});
