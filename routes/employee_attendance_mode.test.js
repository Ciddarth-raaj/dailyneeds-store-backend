/**
 * Attendance Calculation Type - WHO may read and change it.
 *
 *   node --test routes/employee_attendance_mode.test.js
 *
 * The real `routes/employee_master` router, the real permission middleware
 * and the real employee branch scope, over stub usecases. The setting must be
 * guarded exactly like the Employment Details save: `employee_edit` to write,
 * `view_employees` to read, and the employee must be inside the caller's
 * branches either way. No new key exists that could widen it.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-attmode-"));
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

const auth = require("../middlewares/auth");
const buildPermissions = require("../middlewares/permissions");
const buildSensitive = require("../middlewares/sensitive");
const buildBranchScope = require("../middlewares/employee_branch_scope");
const { branchRepo } = require("../test_support/employee_branch_scope");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");

const KATHIRKAMAM = 1;
const MOOLAKULAM = 2;
const KAT_EMPLOYEE = 201;
const MOO_EMPLOYEE = 202;

const EMPLOYEES = [
  { employee_id: 100, employee_name: "Hema HR", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 101, employee_name: "Selva Manager", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: 103, employee_name: "Nila Nokeys", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: KAT_EMPLOYEE, employee_name: "Kavi Kathirkamam", store_id: KATHIRKAMAM, status: 1 },
  { employee_id: MOO_EMPLOYEE, employee_name: "Mohan Moolakulam", store_id: MOOLAKULAM, status: 1 },
];

const D = { HR: 1, MANAGER_VIEW: 2, MANAGER_EDIT: 3, NO_KEYS: 4 };
const GRANTS = {
  [D.HR]: [P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [D.MANAGER_VIEW]: [P.VIEW_EMPLOYEES],
  [D.MANAGER_EDIT]: [P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT],
  [D.NO_KEYS]: [],
};

let changes = [];
let reads = [];
const attendanceModeUsecase = {
  async getMode(employeeId) {
    reads.push(employeeId);
    return { code: 200, employee_id: employeeId, current_mode: "SHIFT_BASED", history: [] };
  },
  async changeMode(payload) {
    changes.push(payload);
    return { code: 200, ...payload };
  },
};

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
  delete require.cache[require.resolve("./employee_master")];
  app.use(
    "/hr",
    require("./employee_master")(
      {},
      permissions,
      sensitive,
      null,
      null,
      null,
      null,
      branchScope,
      null,
      attendanceModeUsecase
    ).getRouter()
  );
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = (employeeId, designationId, userType = 1) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(employeeId),
      id: employeeId,
      employee_id: employeeId,
      user_type: userType,
      designation_id: designationId,
      store_id: KATHIRKAMAM,
    },
    "1d"
  );

const CALLERS = {
  hr: () => tokenFor(100, D.HR),
  managerEdit: () => tokenFor(101, D.MANAGER_EDIT),
  managerView: () => tokenFor(101, D.MANAGER_VIEW),
  noKeys: () => tokenFor(103, D.NO_KEYS),
};

const call = async (method, url, token, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: {
      "x-access-token": await token,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = null;
  }
  return { status: res.status, body: parsed, text };
};

const url = (id) => `/hr/employee/${id}/attendance-calculation-mode`;
const BODY = { calculation_mode: "PRESENT_ABSENT_ONLY", effective_from: "2026-10-01" };

const assertRefused = (res, what) => {
  const code = res.body && res.body.code;
  assert.ok(res.status === 403 || code === 403, `${what}: expected a refusal, got ${res.status} ${res.text.slice(0, 200)}`);
};

describe("changing the Attendance Calculation Type", () => {
  it("HR holding Edit Employee may change it for any branch", async () => {
    changes = [];
    const res = await call("POST", url(MOO_EMPLOYEE), CALLERS.hr(), BODY);
    assert.equal(res.status, 200);
    assert.equal(res.body.code, 200);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].employee_id, MOO_EMPLOYEE);
    assert.equal(changes[0].actor_employee_id, 100, "the actor comes from the session");
  });

  it("a Store Manager holding Edit Employee may change it in their own branch", async () => {
    changes = [];
    const res = await call("POST", url(KAT_EMPLOYEE), CALLERS.managerEdit(), BODY);
    assert.equal(res.status, 200);
    assert.equal(changes.length, 1);
  });

  it("CROSS-OUTLET: the same manager is refused for another branch's employee, and nothing is written", async () => {
    changes = [];
    const res = await call("POST", url(MOO_EMPLOYEE), CALLERS.managerEdit(), BODY);
    assert.equal(res.status, 403);
    assert.equal(changes.length, 0);
  });

  it("UNAUTHORISED: a caller without Edit Employee is refused, even in their own branch", async () => {
    for (const caller of [CALLERS.managerView(), CALLERS.noKeys()]) {
      changes = [];
      const res = await call("POST", url(KAT_EMPLOYEE), caller, BODY);
      assertRefused(res, "no employee_edit");
      assert.equal(changes.length, 0);
    }
  });

  it("an unauthenticated request is refused", async () => {
    changes = [];
    const res = await fetch(`http://127.0.0.1:${port}${url(KAT_EMPLOYEE)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(BODY),
    });
    // Body-level codes on HTTP 200 are this API's convention for a 403.
    const body = await res.json();
    assert.ok([401, 403].includes(res.status) || [401, 403].includes(body.code), JSON.stringify(body));
    assert.equal(changes.length, 0);
  });

  it("the body is strict: no employee_id, no unknown mode, a date is required", async () => {
    for (const body of [
      { ...BODY, employee_id: MOO_EMPLOYEE },
      { ...BODY, calculation_mode: "HOUSEKEEPING" },
      { calculation_mode: "PRESENT_ABSENT_ONLY" },
      { ...BODY, effective_from: "01/10/2026" },
    ]) {
      changes = [];
      const res = await call("POST", url(KAT_EMPLOYEE), CALLERS.hr(), body);
      assert.equal(res.body.code, 422, JSON.stringify(body));
      assert.equal(changes.length, 0);
    }
  });
});

describe("reading the Attendance Calculation Type", () => {
  it("a view-only caller may read it in their own branch", async () => {
    reads = [];
    const res = await call("GET", url(KAT_EMPLOYEE), CALLERS.managerView());
    assert.equal(res.status, 200);
    assert.deepEqual(reads, [KAT_EMPLOYEE]);
  });

  it("but not for another branch's employee", async () => {
    reads = [];
    const res = await call("GET", url(MOO_EMPLOYEE), CALLERS.managerView());
    assert.equal(res.status, 403);
    assert.deepEqual(reads, []);
  });

  it("and a caller with no keys may not read it at all", async () => {
    reads = [];
    const res = await call("GET", url(KAT_EMPLOYEE), CALLERS.noKeys());
    assertRefused(res, "no view_employees");
    assert.deepEqual(reads, []);
  });
});
