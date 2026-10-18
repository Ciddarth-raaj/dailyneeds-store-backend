/**
 * THE LEGACY WRITE ENDPOINTS CANNOT BYPASS THE EMPLOYEE LIFECYCLE.
 *
 *   node --test routes/legacy_lifecycle_bypass.test.js
 *
 * Employee Master -> Resign / Rejoin is the only way an employee leaves or
 * comes back: Resign records the exit (and with it the F&F month), Rejoin
 * applies the rehire assessment (CONDITIONAL / NO need management approval).
 * The legacy resignation create / edit / delete and `/employee/update-status`
 * changed `new_employee.status` and the login directly, outside both.
 *
 * Proved here at the HTTP surface, with the REAL auth / permission / branch
 * middleware and - for /resignation - the REAL usecase and repositories over a
 * database that records every statement: every legacy write is refused (410)
 * for any caller, the administrator included, and NOT ONE INSERT, UPDATE or
 * DELETE reaches the database. The historical records stay readable.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-legacy-bypass-"));
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
const express = require("express");
const bodyParser = require("body-parser");
const auth = require("../middlewares/auth");
const buildPermissions = require("../middlewares/permissions");
const buildSensitive = require("../middlewares/sensitive");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");
const { buildScopeFor } = require("../test_support/employee_branch_scope");

const ECR = 2;
const HR = { designation: 81, employee: 921 }; // every legacy key, all branches
const READER = { designation: 82, employee: 922 }; // view_resignation only
const ADMIN = { designation: 83, employee: 923, userType: 2 }; // the administrator bypass
const GRANTS = {
  [HR.designation]: [P.VIEW_EMPLOYEES, P.ADD_EMPLOYEES, P.VIEW_RESIGNATION, P.ADD_RESIGNATION, P.EMPLOYEE_SCOPE_ALL_BRANCHES],
  [READER.designation]: [P.VIEW_RESIGNATION],
};
// 2095 left through Resign and was assessed NOT fit for rehire; 300 is active.
const EMPLOYEES = [
  { employee_id: HR.employee, store_id: ECR, status: 1 },
  { employee_id: READER.employee, store_id: ECR, status: 1 },
  { employee_id: ADMIN.employee, store_id: ECR, status: 1 },
  { employee_id: 2095, store_id: ECR, status: 0 },
  { employee_id: 300, store_id: ECR, status: 1 },
];

/* Every statement the real repositories send. Reads get a historical row. */
let statements = [];
const HISTORY = [{ resignation_id: 41, employee_id: 2095, employee_name: "PREETHA .S", reason_type: "Personal", reason: "Relocating", resignation_date: "2026-08-16" }];
const db = {
  query(sql, params, cb) {
    const done = typeof params === "function" ? params : cb;
    statements.push(String(sql));
    const write = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
    setImmediate(() => done(null, write ? { affectedRows: 1, insertId: 99 } : HISTORY));
  },
};
const writes = () => statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s));

/* The employee router's usecase: any call at all is recorded. */
let employeeCalls = [];
const employeeUsecase = new Proxy({}, { get: (_, name) => async () => (employeeCalls.push(String(name)), 200) });

let server;
let port;
let current = HR;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({
    userUsecase: {
      getSessionState: async () => ({
        user_id: 7, employee_id: current.employee, status: 1, token_valid_from: null,
        must_change_password: 0, is_system_account: 0, employee_status: 1,
      }),
    },
  }));
  const resignationUsecase = require("../usecase/resignation")(
    require("../repository/resignation")(db),
    require("../repository/employee")(db),
    require("../repository/user")(db)
  );
  app.use("/resignation", require("./resignation")(resignationUsecase, permissions).getRouter());
  app.use("/employee", require("./employee")(employeeUsecase, permissions, buildSensitive(permissions), buildScopeFor(permissions, EMPLOYEES)).getRouter());
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});
after(() => server && server.close());
beforeEach(() => {
  statements = [];
  employeeCalls = [];
});

const call = async (who, method, url, body) => {
  current = who;
  const token = await jwtService.sign(
    { auth_ver: 2, sub: "7", id: 7, employee_id: who.employee, user_type: who.userType || 1, designation_id: who.designation, store_id: ECR },
    "1d"
  );
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { "Content-Type": "application/json", "x-access-token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const LEGACY_WRITES = [
  ["POST", "/resignation/create", { employee_name: "PREETHA .S", reason_type: "Personal", reason: "x", resignation_date: "2026-08-16" }],
  ["POST", "/resignation/resignation_id?resignation_id=41", null],
  ["POST", "/resignation/update-resignation", { resignation_id: 41, resignation_details: { resignation_date: "2026-09-01" } }],
  ["POST", "/employee/update-status", { employee_id: 2095, status: 1 }],
  ["POST", "/employee/update-status", { employee_id: 300, status: 0 }],
];

describe("legacy write endpoints cannot bypass Resign / Rejoin or the rehire assessment", () => {
  for (const who of [HR, ADMIN]) {
    for (const [method, url, body] of LEGACY_WRITES) {
      it(`${who === ADMIN ? "the administrator" : "HR with every legacy key"}: ${url} ${body ? JSON.stringify(body) : ""} is refused and writes NOTHING`, async () => {
        const res = await call(who, method, url, body);
        assert.equal(res.status, 200);
        assert.equal(res.body.code, 410, JSON.stringify(res.body));
        assert.match(res.body.msg, /Resign|Rejoin/);
        assert.deepEqual(writes(), [], "no INSERT / UPDATE / DELETE reached the database");
        assert.deepEqual(employeeCalls, [], "the employee usecase was never called");
      });
    }
  }

  it("re-activating an exited employee assessed NOT fit for rehire (2095) through every legacy door fails; the codes say where to go", async () => {
    const outcomes = [];
    for (const [method, url, body] of LEGACY_WRITES.filter(([, , b]) => !b || b.employee_id !== 300)) {
      outcomes.push((await call(HR, method, url, body)).body.error);
    }
    assert.deepEqual(outcomes, [
      "LEGACY_RESIGNATION_READ_ONLY", "LEGACY_RESIGNATION_READ_ONLY", "LEGACY_RESIGNATION_READ_ONLY", "EMPLOYEE_STATUS_VIA_LIFECYCLE",
    ]);
    assert.deepEqual(writes(), []);
  });

  it("permissions are still checked first: a reader without add_resignation / add_employees gets 403", async () => {
    assert.equal((await call(READER, "POST", "/resignation/create", LEGACY_WRITES[0][2])).status, 403);
    assert.equal((await call(READER, "POST", "/employee/update-status", { employee_id: 2095, status: 1 })).status, 403);
    assert.deepEqual(writes(), []);
  });

  it("historical resignation records stay READABLE, and reading writes nothing", async () => {
    for (const url of ["/resignation", "/resignation/get/resignation_id?resignation_id=41"]) {
      const res = await call(READER, "GET", url);
      assert.equal(res.status, 200, url);
      assert.ok(JSON.stringify(res.body).includes("PREETHA .S"), url);
    }
    assert.ok(statements.length > 0 && statements.every((s) => /^\s*SELECT\b/i.test(s)), statements.join("\n"));
  });
});

describe("no reachable code path changes employee status outside the lifecycle", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const sources = (d) => fs.readdirSync(path.join(__dirname, "..", d))
    .filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))
    .map((f) => [`${d}/${f}`, read(`${d}/${f}`)]);

  it("no route or usecase calls employeeRepo.updateStatus / userRepo.updateStatus any more", () => {
    for (const [file, src] of [...sources("routes"), ...sources("usecase")]) {
      assert.ok(!/(employeeRepo|userRepo)\.updateStatus\(/.test(src), file);
      assert.ok(!/employeeUsecase\.updateStatus\(/.test(src), file);
    }
  });

  it("the only reachable writes of new_employee.status are Resign and Rejoin in the employee lifecycle", () => {
    const writers = [...sources("repository")]
      .filter(([, src]) => /UPDATE new_employee SET status/.test(src))
      .map(([file]) => file)
      .sort();
    // employee.js#updateStatus remains only as an unreferenced repository method (proved above).
    assert.deepEqual(writers, ["repository/employee.js", "repository/employee_master.js"]);
    const master = read("repository/employee_master.js");
    assert.equal((master.match(/UPDATE new_employee SET status/g) || []).length, 2, "markResigned + markRejoined");
  });
});
