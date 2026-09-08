/**
 * Stage 0C / C2 — the /hr API surface.
 *
 *   node --test routes/employee_master.test.js
 *
 * What this defends is the boundary, not the lifecycle logic: who may call
 * each action, that B3 still hides and guards the sensitive fields on this
 * new router too, and that the legacy Digisme employee sync can no longer
 * write the employee master whatever its own flag says.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-c2-"));
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

const USER_ID = 21;
const EMPLOYEE_ID = 501;
const HR_DESIGNATION = 7;
const OUTLET_DESIGNATION = 8;

/** Only the HR designation holds the C2 keys. */
const GRANTS = {
  [HR_DESIGNATION]: [
    P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT, P.EMPLOYEE_RESIGN, P.EMPLOYEE_REJOIN,
    P.VIEW_EMPLOYEE_LIFECYCLE,
  ],
  [OUTLET_DESIGNATION]: ["view_stores"],
};

const sessionState = {
  user_id: USER_ID, employee_id: EMPLOYEE_ID, status: 1, token_valid_from: null,
  must_change_password: 0, is_system_account: 0, employee_status: 1,
};

/** Records what the usecase was asked to do; the logic itself is tested elsewhere. */
const calls = [];
const usecase = {
  createEmployee: async (input, opts) => (calls.push(["create", input, opts]), { code: 200, employee_id: 1234 }),
  editEmployee: async (id, patch, opts) => (calls.push(["edit", id, patch, opts]), { code: 200, employee_id: id }),
  resignEmployee: async (id, input, opts) => (calls.push(["resign", id, input, opts]), { code: 200, employee_id: id }),
  rejoinEmployee: async (id, input, opts) => (calls.push(["rejoin", id, input, opts]), { code: 200, employee_id: id }),
  getLifecycleHistory: async (id) => ({
    employee_id: id, employee_name: "Someone", status: 1, is_active: true,
    current: { date_of_joining: "2022-03-01", designation_name: "Cashier" },
    periods: [{ period_no: 1, period_state: "open", joined_on: "2022-03-01", ended_on: null, needs_review: 0 }],
    events: [{ event_id: 1, event_type: "period_opened", reason: "initial_join" }],
    // Deliberately smuggled in, to prove B3's filter strips it on this router.
    salary: "50000", account_no: "1234567890", pan_no: "ABCDE1234F",
  }),
  getReviewList: async () => ({ total: 518, count: 1, items: [{ employee_id: 9, period_no: 1, warning_type: "missing_joining_date" }] }),
};

let server, port;

before(async () => {
  const authMiddleware = require("../middlewares/auth");
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const sensitive = buildSensitive(permissions);

  const app = express();
  app.use(bodyParser.json());
  app.use(authMiddleware.create({ userUsecase: { getSessionState: async () => ({ ...sessionState }) } }));
  delete require.cache[require.resolve("./employee_master")];
  const routes = require("./employee_master")(usecase, permissions, sensitive);
  app.use("/hr", routes.getRouter());

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = ({ designationId = HR_DESIGNATION, userType = 1 } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2, sub: String(USER_ID), id: USER_ID, employee_id: EMPLOYEE_ID,
      user_type: userType, designation_id: designationId, store_id: 2,
    },
    "1d"
  );

const call = async (method, p, token, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-access-token": await token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text };
};

const CREATE_BODY = {
  employee_name: "New Hire", date_of_joining: "2026-01-05",
  store_id: 2, designation_id: 3, department_id: 4,
};

/* ================================================== authentication ====== */
describe("the /hr surface is authenticated", () => {
  it("refuses an anonymous caller on every action (B1)", async () => {
    for (const [method, p, body] of [
      ["POST", "/hr/employee", CREATE_BODY],
      ["POST", "/hr/employee/1/edit", { employee_name: "x" }],
      ["POST", "/hr/employee/1/resign", { resignation_date: "2026-01-01" }],
      ["POST", "/hr/employee/1/rejoin", { date_of_joining: "2026-01-01" }],
      ["GET", "/hr/employee/1/lifecycle", null],
      ["GET", "/hr/lifecycle/review", null],
    ]) {
      const r = await call(method, p, null, body);
      assert.equal(r.body.code, 403, `${method} ${p}`);
      assert.equal(r.body.msg, "Access Denied");
    }
  });
});

/* ==================================================== authorisation ===== */
describe("9/10/11. each action needs its own permission", () => {
  const DENIED = "You do not have permission to perform this action";

  it("an outlet user holding none of the C2 keys is refused everywhere", async () => {
    const token = tokenFor({ designationId: OUTLET_DESIGNATION });
    for (const [method, p, body] of [
      ["POST", "/hr/employee", CREATE_BODY],
      ["POST", "/hr/employee/1/edit", { employee_name: "x" }],
      ["POST", "/hr/employee/1/resign", { resignation_date: "2026-01-01" }],
      ["POST", "/hr/employee/1/rejoin", { date_of_joining: "2026-01-01" }],
      ["GET", "/hr/employee/1/lifecycle", null],
      ["GET", "/hr/lifecycle/review", null],
    ]) {
      const r = await call(method, p, token, body);
      assert.equal(r.status, 403, `${method} ${p}`);
      assert.equal(r.body.msg, DENIED);
    }
  });

  it("the HR designation may use all four actions", async () => {
    const token = tokenFor();
    assert.equal((await call("POST", "/hr/employee", token, CREATE_BODY)).body.code, 200);
    assert.equal((await call("POST", "/hr/employee/9/edit", token, { employee_name: "x" })).body.code, 200);
    assert.equal((await call("POST", "/hr/employee/9/resign", token, { resignation_date: "2026-01-01" })).body.code, 200);
    assert.equal((await call("POST", "/hr/employee/9/rejoin", token, { date_of_joining: "2026-02-01" })).body.code, 200);
  });

  it("admin (user_type 2) keeps its bypass", async () => {
    const token = tokenFor({ designationId: OUTLET_DESIGNATION, userType: 2 });
    assert.equal((await call("POST", "/hr/employee", token, CREATE_BODY)).body.code, 200);
    assert.equal((await call("GET", "/hr/employee/9/lifecycle", token)).status, 200);
  });

  it("each route names a distinct key, so one grant cannot open all four", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_master.js"), "utf8");
    for (const key of ["EMPLOYEE_CREATE", "EMPLOYEE_EDIT", "EMPLOYEE_RESIGN", "EMPLOYEE_REJOIN", "VIEW_EMPLOYEE_LIFECYCLE"]) {
      assert.match(src, new RegExp(`P\\.${key}`), `${key} must gate a route`);
    }
    // and no designation id is hard-coded anywhere in the routes
    assert.ok(!/designation_id\s*===\s*\d/.test(src), "authority must come from permissions, never a designation id");
  });
});

/* =============================================================== B3 ===== */
describe("8/37. B3 remains authoritative on this router", () => {
  it("strips sensitive fields from the lifecycle response", async () => {
    const r = await call("GET", "/hr/employee/9/lifecycle", tokenFor());
    for (const field of ["salary", "account_no", "pan_no"]) {
      assert.ok(!new RegExp(`"${field}"`, "i").test(r.text), `${field} must not reach an unauthorised caller`);
    }
    assert.equal(r.body.employee_id, 9, "the rest of the response is intact");
    assert.equal(r.body.periods.length, 1);
  });

  it("refuses a create whose body mentions a sensitive field", async () => {
    const r = await call("POST", "/hr/employee", tokenFor(), { ...CREATE_BODY, salary: "90000" });
    assert.equal(r.status, 403);
    assert.equal(r.body.msg, "You do not have permission to perform this action");
    assert.ok(!calls.some((c) => c[0] === "create" && c[1] && c[1].salary), "the usecase never saw it");
  });

  it("refuses an edit that tries to set a bank account", async () => {
    const r = await call("POST", "/hr/employee/9/edit", tokenFor(), { account_no: "999" });
    assert.equal(r.status, 403);
  });

  it("the router applies both halves of the B3 middleware", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_master.js"), "utf8");
    assert.match(src, /router\.use\(this\.sensitive\.filterResponse\)/);
    assert.match(src, /router\.use\(this\.sensitive\.guardWrite\)/);
  });
});

/* ========================================================= validation === */
describe("the API refuses what it cannot honour", () => {
  it("5. a create must not carry an employee_id", async () => {
    const r = await call("POST", "/hr/employee", tokenFor(), { ...CREATE_BODY, employee_id: 4242 });
    assert.equal(r.body.code, 422, "an id offered by the client is a schema error, not a silent drop");
  });

  it("a create without a joining date is refused by the schema", async () => {
    const { date_of_joining, ...noDate } = CREATE_BODY;
    const r = await call("POST", "/hr/employee", tokenFor(), noDate);
    assert.equal(r.body.code, 422);
  });

  it("the acting employee is passed through for the lifecycle event's actor", async () => {
    calls.length = 0;
    await call("POST", "/hr/employee/9/resign", tokenFor(), { resignation_date: "2026-01-01" });
    const resign = calls.find((c) => c[0] === "resign");
    assert.equal(resign[3].actorEmployeeId, EMPLOYEE_ID);
  });

  it("a non-numeric employee_id is rejected before the usecase", async () => {
    const r = await call("POST", "/hr/employee/abc/edit", tokenFor(), { employee_name: "x" });
    assert.equal(r.body.code, 422);
  });
});

/* ================================================= the Digisme guard ==== */
describe("31/32. the legacy Digisme employee sync cannot overwrite local data", () => {
  const reload = (env) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    delete require.cache[require.resolve("../config/lifecycle")];
    const cfg = require("../config/lifecycle");
    process.env = saved;
    delete require.cache[require.resolve("../config/lifecycle")];
    return cfg;
  };

  it("local-master mode is ON by default, so a lost .env fails safe", () => {
    const cfg = reload({ LOCAL_EMPLOYEE_MASTER: "" });
    assert.equal(cfg.localEmployeeMaster, true);
  });

  it("32. the Digisme employee sync remains paused by default", () => {
    const cfg = reload({ DIGISME_EMPLOYEE_SYNC: "" });
    assert.equal(cfg.digisme.employeeSync, false);
  });

  it("31. and turning the sync back on still cannot write the employee master", async () => {
    // The guard is checked independently of DIGISME_EMPLOYEE_SYNC, at the
    // same choke point both callers reach, so the cron and POST /employee/sync
    // are covered by one check.
    const saved = { ...process.env };
    process.env.DIGISME_EMPLOYEE_SYNC = "on";
    process.env.LOCAL_EMPLOYEE_MASTER = "on";
    for (const m of ["../config/lifecycle", "../services/synker"]) delete require.cache[require.resolve(m)];
    const buildSynker = require("../services/synker");

    let bulkCreateCalls = 0;
    const noop = async () => ({});
    const synker = buildSynker(
      {}, {}, {}, { bulkCreate: noop }, {}, {}, { bulkCreate: noop }, { bulkCreate: noop },
      { bulkCreate: async () => { bulkCreateCalls += 1; return {}; } },
      {}, {}
    );
    let fetched = false;
    synker._fetchDigismeEmployees = async () => {
      fetched = true;
      return [];
    };

    const res = await synker.syncDigismeEmployees();
    assert.equal(res.code, 423);
    assert.equal(res.localEmployeeMaster, true);
    assert.equal(bulkCreateCalls, 0, "no employee row was written");
    assert.equal(fetched, false, "Digisme was not even contacted");

    process.env = saved;
    for (const m of ["../config/lifecycle", "../services/synker"]) delete require.cache[require.resolve(m)];
  });

  it("the guard sits at the choke point both entry points reach", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "services/synker.js"), "utf8");
    const fn = src.slice(src.indexOf("async syncDigismeEmployees()"), src.indexOf("async reconcileEmployeeLifecycle()"));
    assert.ok(
      fn.indexOf("localEmployeeMaster") < fn.indexOf("_fetchDigismeEmployees"),
      "the local-master guard must precede the fetch and every write"
    );
    assert.equal((src.match(/lifecycleConfig\.localEmployeeMaster/g) || []).length, 1, "one guard, one place");
  });

  it("no unrelated sync was disabled", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "services/synker.js"), "utf8");
    for (const job of ["product_sync", "stock_holding_report_sync"]) {
      assert.match(src, new RegExp(`cronService\\.register\\(\\s*"${job}"`), `${job} must still be registered`);
    }
    // The guard's single occurrence is inside syncDigismeEmployees and
    // nowhere else, so no other sync can be affected by it.
    const employeeFn = src.slice(
      src.indexOf("async syncDigismeEmployees()"),
      src.indexOf("async reconcileEmployeeLifecycle()")
    );
    assert.ok(employeeFn.includes("lifecycleConfig.localEmployeeMaster"));
    const everythingElse = src.replace(employeeFn, "");
    assert.ok(!/localEmployeeMaster/.test(everythingElse), "no other sync is gated by the employee guard");
  });
});

/* ================================================ directory intact ====== */
describe("33/34/35/43. /employee/directory is unchanged by C2", () => {
  it("C2 touched neither the directory route nor its query", () => {
    const routes = fs.readFileSync(path.join(__dirname, "employee.js"), "utf8");
    assert.match(routes, /router\.get\("\/directory"/);
    const repo = fs.readFileSync(path.join(__dirname, "..", "repository/employee.js"), "utf8");
    assert.match(repo, /SELECT employee_id, employee_name FROM new_employee WHERE status = 1 AND store_id = \?/);
  });

  it("so its active/inactive behaviour follows status, which is what C2 sets", () => {
    // The directory filters on status = 1 and the caller's own outlet. C2's
    // resign sets status = 0 and its rejoin sets it back to 1, so a resigned
    // employee leaves the dropdown and a rejoined one returns without the
    // directory needing to know anything about periods.
    const master = fs.readFileSync(path.join(__dirname, "..", "repository/employee_master.js"), "utf8");
    assert.match(master, /SET status = \?, resignation_date = \?/);
    assert.match(master, /SET status = \?, resignation_date = NULL, date_of_joining = \?/);
    const uc = fs.readFileSync(path.join(__dirname, "..", "usecase/employee_master.js"), "utf8");
    assert.match(uc, /fields\.status = STATUS\.ACTIVE/);
  });

  it("and no permission was handed back to make it work", () => {
    const migration = fs.readFileSync(
      path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20260908120000-c2-local-employee-master-up.sql"),
      "utf8"
    );
    assert.ok(!/view_employees/.test(migration), "view_employees must not be granted by C2");
  });
});

/* ================================================ the migration ========= */
describe("the C2 migration", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20260908120000-c2-local-employee-master-up.sql"),
    "utf8"
  );

  it("declares the five keys and grants them only where add_employees already is", () => {
    for (const key of ["employee_create", "employee_edit", "employee_resign", "employee_rejoin", "view_employee_lifecycle"]) {
      assert.match(sql, new RegExp(`'${key}'`), `${key} must be declared`);
    }
    assert.match(sql, /permission_key` = 'add_employees' AND `is_active` = TRUE/);
  });

  it("removes no existing permission and writes no employee row", () => {
    assert.ok(!/DELETE/i.test(sql), "the up migration must delete nothing");
    for (const forbidden of ["INSERT INTO `new_employee`", "UPDATE `new_employee`", "employee_employment_period", "employee_lifecycle_event"]) {
      assert.ok(!sql.includes(forbidden), `must not touch ${forbidden}`);
    }
  });

  it("38. leaves the 518 historical review rows alone", () => {
    assert.ok(!/needs_review/.test(sql), "no historical warning row is altered");
  });

  it("seeds AUTO_INCREMENT from the real maximum rather than a literal", () => {
    assert.match(sql, /MAX\(`employee_id`\)/);
    assert.ok(!/AUTO_INCREMENT = \d/.test(sql), "no hard-coded next id");
  });
});
