/**
 * ONBOARDING / PENDING HR — THE BRANCH SCOPE ON BOTH OF ITS ENDPOINTS.
 *
 *   node --test routes/hr_onboarding_branch_scope.test.js
 *
 * ACCESS IS RIGHTS BASED; DATA IS STORE BASED. The dashboard at
 * `/hr/onboarding` is opened on a right - `view_hr_onboarding_dashboard`
 * beside `view_employees` - and NOT on a designation, a user type or HR
 * membership. Which employees it then shows is the EXISTING employee branch
 * scope, and nothing else. This file defends the second half, on the server,
 * for BOTH requests that screen makes:
 *
 *   GET /employee/employees             the population
 *   GET /hr/employees/status-summary    the onboarding state of that
 *                                       population
 *   GET /hr/employees/outlets           the branches it may be filtered by
 *
 * WHY BOTH, AND WHY HERE. A frontend filter is not a security boundary, and
 * neither is one of two endpoints. If the summary were scoped less tightly
 * than the list, a branch-scoped caller could ask it for another store and
 * learn that store's employee ids AND whose records are unfinished - a leak
 * the screen would never have to render to have caused. The two are scoped by
 * the same middleware here and that is asserted, not assumed.
 *
 * THE SCOPE IS THE REAL ONE. `test_support/employee_branch_scope` builds
 * `middlewares/employee_branch_scope.js` over an in-memory employee table, so
 * these tests fail if the rule breaks. `routes/employee_master.test.js` hands
 * its router an all-branches scope on purpose - its subject is the lifecycle
 * API - which is precisely why the branch-scoped case needs a file of its
 * own.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-onboarding-scope-"));
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

const buildPermissions = require("../middlewares/permissions");
const buildSensitive = require("../middlewares/sensitive");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");
const { buildScopeFor } = require("../test_support/employee_branch_scope");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");

/* ------------------------------------------------------------- the cast */

const KATHIRKAMAM = 2;
const MOOLAKULAM = 5;

/**
 * STORE MANAGER is the case the dashboard used to refuse outright. They hold
 * the dashboard right and the list right and NOT the all-branches key, which
 * is exactly how an administrator would grant this on the rights screen.
 */
const STORE_MANAGER = { designation: 21, employee: 901, store: KATHIRKAMAM };
/** The same store manager WITHOUT the dashboard right - refused the screen. */
const PLAIN_MANAGER = { designation: 22, employee: 902, store: KATHIRKAMAM };
/** HR: the dashboard right plus company-wide employee scope. */
const HR = { designation: 23, employee: 903, store: MOOLAKULAM };
/** HR without the sensitive key - the dashboard, minus how people are paid. */
const HR_NO_SENSITIVE = { designation: 24, employee: 904, store: MOOLAKULAM };
/** An administrator: `user_type = 2`, no keys at all, every branch. */
const ADMIN = { designation: 25, employee: 905, store: KATHIRKAMAM };

const GRANTS = {
  // The write keys too: a store manager onboards their own staff, which is
  // exactly why the branch rules on create and edit have to hold.
  [STORE_MANAGER.designation]: [
    P.VIEW_EMPLOYEES,
    P.VIEW_HR_ONBOARDING_DASHBOARD,
    P.EMPLOYEE_CREATE,
    P.EMPLOYEE_EDIT,
  ],
  [PLAIN_MANAGER.designation]: [P.VIEW_EMPLOYEES],
  [HR.designation]: [
    P.VIEW_EMPLOYEES,
    P.VIEW_HR_ONBOARDING_DASHBOARD,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
    P.VIEW_EMPLOYEE_SENSITIVE,
    P.EMPLOYEE_CREATE,
    P.EMPLOYEE_EDIT,
  ],
  [HR_NO_SENSITIVE.designation]: [
    P.VIEW_EMPLOYEES,
    P.VIEW_HR_ONBOARDING_DASHBOARD,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
  ],
  [ADMIN.designation]: [],
};

/** The employee table the branch resolver reads. Every actor is active. */
const EMPLOYEES = [
  { employee_id: STORE_MANAGER.employee, store_id: KATHIRKAMAM, status: 1 },
  { employee_id: PLAIN_MANAGER.employee, store_id: KATHIRKAMAM, status: 1 },
  { employee_id: HR.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: HR_NO_SENSITIVE.employee, store_id: MOOLAKULAM, status: 1 },
  { employee_id: ADMIN.employee, store_id: KATHIRKAMAM, status: 1 },
];

/* ---------------------------------------------------------- the doubles */

/** What the summary usecase was asked for. The rule is in the ASK. */
const summaryCalls = [];
const statusSummaryUsecase = {
  list: async (filters, options) => {
    summaryCalls.push({ filters, options });
    return [{ employee_id: 1, aadhaar_status: "VERIFIED", bank_status: "VERIFIED", bank_payroll_ready: true }];
  },
};

/**
 * THE COMPANY-WIDE OUTLET TABLE. Deliberately larger than any one caller's
 * scope, and containing a name a branch-scoped caller must never receive:
 * `/outlet/directory` returns all of this to anybody logged in, which is why
 * the employee screens may not use it.
 */
const OUTLETS = [
  { outlet_id: KATHIRKAMAM, outlet_name: "Kathirkamam" },
  { outlet_id: MOOLAKULAM, outlet_name: "Moolakulam" },
  { outlet_id: 9, outlet_name: "Villianur" },
];
const outletUsecase = { getDirectory: async () => OUTLETS.map((o) => ({ ...o })) };

/** What the employee list was asked for, and WITH WHICH ACTOR. */
const listCalls = [];
/** The writes the branch rules guard. The lifecycle itself is tested in C2. */
const masterUsecase = {
  createEmployee: async (input) => ({ code: 200, employee_id: 1234, input }),
  editEmployee: async (id) => ({ code: 200, employee_id: id }),
};

const employeeUsecase = {
  get: async (query, actor) => {
    listCalls.push({ query, actor });
    return { code: 200, list: [] };
  },
};

let server, port;

before(async () => {
  const authMiddleware = require("../middlewares/auth");
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const sensitive = buildSensitive(permissions);
  // THE REAL MIDDLEWARE over the fixture employee table - not a stub scope.
  const branchScope = buildScopeFor(permissions, EMPLOYEES);

  const app = express();
  app.use(bodyParser.json());
  app.use(
    authMiddleware.create({
      userUsecase: {
        getSessionState: async (userId) => ({
          user_id: userId,
          employee_id: userId,
          status: 1,
          token_valid_from: null,
          must_change_password: 0,
          is_system_account: 0,
          employee_status: 1,
        }),
      },
    })
  );

  delete require.cache[require.resolve("./employee_master")];
  delete require.cache[require.resolve("./employee")];
  const master = require("./employee_master")(
    masterUsecase, permissions, sensitive, null, null, statusSummaryUsecase, null, branchScope,
    outletUsecase
  );
  const employees = require("./employee")(employeeUsecase, permissions, sensitive, branchScope);
  app.use("/hr", master.getRouter());
  app.use("/employee", employees.getRouter());

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

/** A session for one of the actors above. `employee_id` IS the user id here. */
const tokenFor = (who, { userType = 1 } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(who.employee),
      id: who.employee,
      employee_id: who.employee,
      user_type: userType,
      designation_id: who.designation,
      store_id: who.store,
    },
    "1d"
  );

const call = async (p, who, opts) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    headers: { "x-access-token": await tokenFor(who, opts) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = text;
  }
  return { status: res.status, body, text };
};

/** The same, for a write. The branch rules apply to bodies as well as queries. */
const post = async (p, who, body, opts) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-access-token": await tokenFor(who, opts) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = text;
  }
  // These routes answer 200-with-a-code for some refusals and a real status
  // for others, so the status a test asserts is the one the CALLER sees.
  const status = parsed && parsed.code && res.status === 200 ? parsed.code : res.status;
  return { status, body: parsed, text };
};

const lastSummary = () => summaryCalls[summaryCalls.length - 1];
const lastList = () => listCalls[listCalls.length - 1];

/* ================= a store manager, narrowed to their own store ========= */

describe("a store manager holding the dashboard right", () => {
  it("IS SERVED BOTH ENDPOINTS - the screen is not HR-only", () => {
    // The access rule is the right, and this designation holds it. Nothing
    // about being a store manager refuses them here, which is the whole
    // change: the refusal used to be the bug.
    assert.ok(GRANTS[STORE_MANAGER.designation].includes(P.VIEW_HR_ONBOARDING_DASHBOARD));
    assert.ok(!GRANTS[STORE_MANAGER.designation].includes(P.EMPLOYEE_SCOPE_ALL_BRANCHES));
  });

  it("gets a status summary NARROWED TO THEIR OWN STORE, unasked", () => {
    return call("/hr/employees/status-summary", STORE_MANAGER).then((r) => {
      assert.equal(r.status, 200);
      // The caller named no branch. The scope supplies one anyway - and it is
      // a LIST, never `null`, because `null` means "no restriction".
      assert.deepEqual(lastSummary().filters.store_ids, [KATHIRKAMAM]);
    });
  });

  it("gets an employee list carrying the SAME scope into the query", async () => {
    const r = await call("/employee/employees", STORE_MANAGER);
    assert.equal(r.status, 200);
    const scope = lastList().actor.branch_scope;
    assert.equal(scope.kind, EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES);
    assert.deepEqual(scope.store_ids, [KATHIRKAMAM]);
  });

  it("CANNOT OBTAIN ANOTHER STORE THROUGH THE STATUS SUMMARY", async () => {
    const before = summaryCalls.length;
    const r = await call(`/hr/employees/status-summary?store_ids[]=${MOOLAKULAM}`, STORE_MANAGER);
    // Refused outright rather than quietly narrowed: a request that NAMES
    // another branch is told no, so it can never be handed its own store's
    // rows under another store's heading.
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "OUT_OF_BRANCH");
    assert.equal(summaryCalls.length, before, "the usecase was never reached");
  });

  it("cannot obtain another store through the employee list either", async () => {
    const before = listCalls.length;
    const r = await call(`/employee/employees?store_ids[]=${MOOLAKULAM}`, STORE_MANAGER);
    assert.equal(r.status, 403);
    assert.equal(listCalls.length, before, "the usecase was never reached");
  });

  it("asking for their OWN store is honoured - narrowing is not widening", async () => {
    const r = await call(`/hr/employees/status-summary?store_ids[]=${KATHIRKAMAM}`, STORE_MANAGER);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().filters.store_ids, [KATHIRKAMAM]);
  });

  it("CANNOT RETRIEVE A FOREIGN OUTLET NAME FROM THE PAGE'S OUTLET SOURCE", async () => {
    // THE POINT OF THE ENDPOINT. The company has three outlets and this
    // caller is authorised for one, so one is what crosses the wire - the
    // other two names are never sent and there is nothing for the browser to
    // hide. A client-side filter over the company-wide directory would have
    // passed a rendering test and failed this one.
    const r = await call("/hr/employees/outlets", STORE_MANAGER);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ outlet_id: KATHIRKAMAM, outlet_name: "Kathirkamam" }]);
    // Asserted against the RAW RESPONSE TEXT, because the leak being tested
    // is the bytes in the body and not the shape they parse into.
    assert.ok(!r.text.includes("Moolakulam"), "a foreign outlet name must not be sent");
    assert.ok(!r.text.includes("Villianur"), "a foreign outlet name must not be sent");
    assert.ok(!r.text.includes(`"outlet_id":${MOOLAKULAM}`), "nor a foreign outlet id");
  });

  it("is told nothing sensitive - the payment route stays its own right", async () => {
    const r = await call("/hr/employees/status-summary", STORE_MANAGER);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().options, {
      disclosePfEsiApplicability: false,
      disclosePaymentRoute: false,
    });
  });
});

/* ================= the same manager, without the right ================== */

describe("a store manager WITHOUT the dashboard right", () => {
  it("is refused the screen by the client rule, on the right alone", () => {
    // The screen's access rule is a right and the backend's list right is a
    // different one, so this designation still reads employees - as Employee
    // Master - and still does not open the queue.
    assert.ok(!GRANTS[PLAIN_MANAGER.designation].includes(P.VIEW_HR_ONBOARDING_DASHBOARD));
    assert.ok(GRANTS[PLAIN_MANAGER.designation].includes(P.VIEW_EMPLOYEES));
  });

  it("STILL GETS NO FOREIGN OUTLET NAME - the outlet source is scoped too", async () => {
    const r = await call("/hr/employees/outlets", PLAIN_MANAGER);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ outlet_id: KATHIRKAMAM, outlet_name: "Kathirkamam" }]);
  });

  it("STILL GETS NO MORE DATA THAN THEIR OWN STORE from either endpoint", async () => {
    // Belt to that brace: whatever the client decides to draw, the server's
    // narrowing does not depend on the dashboard right at all.
    const summary = await call("/hr/employees/status-summary", PLAIN_MANAGER);
    assert.equal(summary.status, 200);
    assert.deepEqual(lastSummary().filters.store_ids, [KATHIRKAMAM]);

    const list = await call("/employee/employees", PLAIN_MANAGER);
    assert.equal(list.status, 200);
    assert.deepEqual(lastList().actor.branch_scope.store_ids, [KATHIRKAMAM]);
  });
});

/* ================= all-branch scope, and the administrator ============== */

describe("a caller holding employee_scope_all_branches", () => {
  it("reaches every branch on both endpoints", async () => {
    const summary = await call("/hr/employees/status-summary", HR);
    assert.equal(summary.status, 200);
    // `null` - no restriction - and NOT `[]`, which would be no branch.
    assert.equal(lastSummary().filters.store_ids, undefined);

    const list = await call("/employee/employees", HR);
    assert.equal(list.status, 200);
    assert.equal(lastList().actor.branch_scope.kind, EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES);
  });

  it("receives EVERY outlet, because every branch is theirs", async () => {
    const r = await call("/hr/employees/outlets", HR);
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.map((o) => o.outlet_name),
      ["Kathirkamam", "Moolakulam", "Villianur"]
    );
  });

  it("may still narrow to one branch by asking", async () => {
    const r = await call(`/hr/employees/status-summary?store_ids[]=${KATHIRKAMAM}`, HR);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().filters.store_ids, [KATHIRKAMAM]);
  });
});

describe("an administrator", () => {
  it("reaches every branch through the user_type bypass, holding no key", async () => {
    assert.deepEqual(GRANTS[ADMIN.designation], []);

    const summary = await call("/hr/employees/status-summary", ADMIN, { userType: 2 });
    assert.equal(summary.status, 200);
    assert.equal(lastSummary().filters.store_ids, undefined);

    const list = await call("/employee/employees", ADMIN, { userType: 2 });
    assert.equal(list.status, 200);
    assert.equal(lastList().actor.branch_scope.kind, EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES);
  });

  it("receives every outlet as well", async () => {
    const r = await call("/hr/employees/outlets", ADMIN, { userType: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, OUTLETS.length);
  });

  it("is not restricted by their own employee record's branch", async () => {
    const r = await call(`/hr/employees/status-summary?store_ids[]=${MOOLAKULAM}`, ADMIN, {
      userType: 2,
    });
    // An administrator whose employee row sits in Kathirkamam may still ask
    // about Moolakulam - the bypass is by user type, not by branch.
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().filters.store_ids, [MOOLAKULAM]);
  });
});

/* ================= sensitive disclosure stays independent =============== */

describe("the sensitive payment data is a separate right from the screen", () => {
  it("is disclosed to a holder of view_employee_sensitive", async () => {
    const r = await call("/hr/employees/status-summary", HR);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().options, {
      disclosePfEsiApplicability: true,
      disclosePaymentRoute: true,
    });
  });

  it("is WITHHELD from a dashboard holder who lacks it, company-wide reach and all", async () => {
    // The clean statement of independence: same screen, same company-wide
    // employee scope, no sensitive key - so the Cash -> Bank data is not
    // disclosed. Opening the queue and being told how somebody is paid are
    // two rights and collapsing them would widen the second silently.
    const r = await call("/hr/employees/status-summary", HR_NO_SENSITIVE);
    assert.equal(r.status, 200);
    assert.deepEqual(lastSummary().options, {
      disclosePfEsiApplicability: false,
      disclosePaymentRoute: false,
    });
    assert.equal(lastSummary().filters.store_ids, undefined, "their reach is unaffected");
  });
});

/* ================= the outlet source is the SCOPE, not the population === */

describe("the outlets endpoint answers about the scope, never about the rows", () => {
  it("is stable - it asks the branch scope and never the employee population", () => {
    // ITEM 2 IN CODE. A dropdown derived from the employees currently on
    // screen loses an authorised branch the moment that branch has no
    // matching row - an empty store, an active search, another status filter
    // selected. So the endpoint reads `listFilters(req, null)`, which is the
    // caller's authorised branches, and consults the outlet table only for a
    // name. Nothing in its path touches an employee row or a query filter.
    const src = require("fs").readFileSync(require("path").join(__dirname, "employee_master.js"), "utf8");
    const route = src.slice(src.indexOf('router.get("/employees/outlets"'));
    const body = route.slice(0, route.indexOf("\n    });"));
    assert.match(body, /listFilters\(req, null\)/, "the scope, with no requested filter");
    assert.match(body, /this\.outlets\.getDirectory\(\)/, "names only");
    assert.ok(!/status-?summary|employeeUsecase|req\.query/.test(body),
      "the answer must not depend on the employee population or on a query filter");
  });

  it("returns an authorised branch even when it holds no employees", async () => {
    // Villianur has no employee in the fixture table at all, and HR still
    // gets it: it is a branch they may filter by, and saying otherwise would
    // tell them the store does not exist.
    assert.ok(!EMPLOYEES.some((e) => Number(e.store_id) === 9), "nobody works at Villianur here");
    const r = await call("/hr/employees/outlets", HR);
    assert.ok(
      r.body.some((o) => Number(o.outlet_id) === 9),
      "an authorised branch with no employees is still a branch"
    );
  });

  it("`[]` authorised branches is no outlet, never every outlet", async () => {
    // An actor with no resolvable branch FAILS CLOSED. The dangerous bug
    // would be collapsing `[]` (no branch) into `null` (no restriction) and
    // handing them the company.
    const NOBODY = { designation: STORE_MANAGER.designation, employee: 999, store: null };
    const r = await call("/hr/employees/outlets", NOBODY);
    assert.equal(r.status, 403, "an unresolvable branch is refused, not widened");
    assert.ok(!r.text.includes("Kathirkamam"));
  });
});

/* ================= the permission model, pinned ========================= */

/**
 * ONE COHERENT MODEL, AND A TEST THAT SAYS SO, because the three concerns are
 * easy to collapse into each other by accident and the collapse is invisible
 * until somebody is wrongly let in or wrongly refused.
 *
 *   ACCESS     `view_hr_onboarding_dashboard` - may you open the work queue.
 *              Checked in the browser, because the screen is the thing being
 *              opened; there is no server resource that IS the screen.
 *   THE DATA   `view_employees` - may you read employees at all. Every one of
 *              the three endpoints behind this screen requires it, because
 *              each returns employees or something about them.
 *   SCOPE      `employee_branch_scope` - WHICH employees. Never a permission
 *              key, never an access decision.
 *   SENSITIVE  `view_employee_sensitive` - the payment route and the PF/ESI
 *              applicability columns, independently of all of the above.
 *
 * WHY THE OUTLETS ENDPOINT TAKES `view_employees` AND NOT THE DASHBOARD KEY.
 * It is the EMPLOYEE outlet source, shared by Employee Master, New Employee,
 * the employee profile and Employee Shift Assignment - none of which hold the
 * dashboard right and all of which need their branch dropdown narrowed. Gating
 * it on the dashboard key would break those four screens to no benefit, and
 * would make the dashboard key a data permission, which is exactly the
 * collapse this model avoids. It is consistent with its two siblings, which
 * take `view_employees` for the same reason.
 *
 * AND WHY A DASHBOARD-RIGHT HOLDER IS NOT BROKEN BY THAT. A caller with the
 * dashboard right but without `view_employees` cannot use the screen under
 * ANY model: the employee list refuses them and the queue is empty. The
 * outlet endpoint is not what stops them, and granting it to them alone would
 * hand them a list of branch names and nothing to put in it.
 */
describe("the HR Onboarding permission model", () => {
  it("gates all three of the screen's endpoints on `view_employees`", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "employee_master.js"), "utf8");
    for (const route of ["/employees/status-summary", "/employees/outlets"]) {
      const at = src.indexOf(`router.get("${route}"`);
      assert.ok(at > -1, `${route} exists`);
      const decl = src.slice(at, at + 200);
      assert.match(decl, /this\.permissions\.require\(P\.VIEW_EMPLOYEES\)/, `${route} takes view_employees`);
    }
    const emp = require("fs").readFileSync(require("path").join(__dirname, "employee.js"), "utf8");
    const at = emp.indexOf('router.get("/employees"');
    assert.match(emp.slice(at, at + 200), /this\.permissions\.require\(P\.VIEW_EMPLOYEES\)/);
  });

  it("gates NONE of them on the dashboard right - that right is the screen's", () => {
    // The dashboard right must not become a data permission. If it appeared
    // on one of these endpoints, Employee Master and New Employee would start
    // requiring HR's work-queue right to draw a branch dropdown.
    const src = require("fs").readFileSync(require("path").join(__dirname, "employee_master.js"), "utf8");
    const at = src.indexOf('router.get("/employees/outlets"');
    const route = src.slice(at, src.indexOf("\n    });", at));
    assert.ok(
      !/VIEW_HR_ONBOARDING_DASHBOARD/.test(route),
      "the shared employee outlet source must not require the dashboard right"
    );
  });

  it("gates none of them on the branch-scope key - scope is not access", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "employee_master.js"), "utf8");
    assert.ok(
      !/require\(P\.EMPLOYEE_SCOPE_ALL_BRANCHES\)/.test(src),
      "the all-branches key must never be used as a permission gate"
    );
  });

  it("a dashboard-right holder WITHOUT `view_employees` is refused the data", async () => {
    // The honest consequence of the model, asserted rather than assumed: the
    // right opens the screen, it does not read employees.
    const DASH_ONLY = { designation: 26, employee: 906, store: KATHIRKAMAM };
    GRANTS[DASH_ONLY.designation] = [P.VIEW_HR_ONBOARDING_DASHBOARD];
    EMPLOYEES.push({ employee_id: DASH_ONLY.employee, store_id: KATHIRKAMAM, status: 1 });

    for (const path of ["/hr/employees/status-summary", "/hr/employees/outlets", "/employee/employees"]) {
      const r = await call(path, DASH_ONLY);
      assert.equal(r.status, 403, `${path} must refuse them`);
    }
  });
});

/* ========== the employee screens share this outlet source ============== */

/**
 * EMPLOYEE MASTER, NEW EMPLOYEE, THE EMPLOYEE PROFILE AND EMPLOYEE SHIFT
 * ASSIGNMENT all draw a branch dropdown, and all four now read
 * `GET /hr/employees/outlets` instead of the company-wide
 * `/outlet/directory`. The stakes rise across them:
 *
 *   the list        a FILTER. A foreign name is a disclosure.
 *   new employee    the outlet IS the branch the employee is created into.
 *   the profile     changing it is a BRANCH TRANSFER.
 *
 * So these assert the SERVER's answer for each shape, not what React drew.
 * A dropdown is UX; `checkTargetBranch` is the boundary, and it is asserted
 * below for both the create and the transfer.
 */
describe("the employee screens' outlet source and branch writes", () => {
  it("serves a branch-scoped user only their own outlet, whatever the screen", async () => {
    // One endpoint, one answer, for all four screens - which is the point of
    // sharing it. `view_employees` is what each of those screens already has.
    const r = await call("/hr/employees/outlets", STORE_MANAGER);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, [{ outlet_id: KATHIRKAMAM, outlet_name: "Kathirkamam" }]);
    assert.ok(!r.text.includes("Moolakulam") && !r.text.includes("Villianur"));
  });

  it("serves an all-branch user every outlet, for the same screens", async () => {
    const r = await call("/hr/employees/outlets", HR);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map((o) => o.outlet_id).sort((a, b) => a - b), [KATHIRKAMAM, MOOLAKULAM, 9]);
  });

  it("REFUSES A CREATE INTO A FOREIGN BRANCH - the dropdown is not the guard", async () => {
    // New Employee with a hand-edited `store_id`. The form cannot offer
    // Moolakulam any more; this proves it would not matter if it did.
    const r = await post("/hr/employee", STORE_MANAGER, {
      employee_name: "Someone",
      date_of_joining: "2026-01-01",
      store_id: MOOLAKULAM,
      designation_id: 3,
      department_id: 4,
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "OUT_OF_BRANCH_TRANSFER");
  });

  it("ALLOWS A CREATE INTO THEIR OWN BRANCH - the rule narrows, it does not block", async () => {
    const r = await post("/hr/employee", STORE_MANAGER, {
      employee_name: "Someone",
      date_of_joining: "2026-01-01",
      store_id: KATHIRKAMAM,
      designation_id: 3,
      department_id: 4,
    });
    // A real 200, not merely "not 403" - a 500 would also be "not 403" and
    // would hide the rule having refused for the wrong reason.
    assert.equal(r.status, 200);
    assert.equal(r.body.employee_id, 1234);
  });

  it("REFUSES A TRANSFER OUT OF SCOPE from the employee profile", async () => {
    // Employment Details naming another branch for an employee the caller
    // may otherwise edit. `store_id` on the edit body is a transfer.
    const r = await post(`/hr/employee/${STORE_MANAGER.employee}/edit`, STORE_MANAGER, {
      store_id: MOOLAKULAM,
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "OUT_OF_BRANCH_TRANSFER");
  });

  it("an all-branch user keeps the transfer capability", async () => {
    const r = await post(`/hr/employee/${HR.employee}/edit`, HR, { store_id: MOOLAKULAM });
    assert.equal(r.status, 200);
    assert.equal(r.body.employee_id, HR.employee);
  });
});
