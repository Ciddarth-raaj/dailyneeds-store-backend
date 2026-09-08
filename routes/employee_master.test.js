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
process.env.AADHAAR_ENCRYPTION_KEY = "0".repeat(63) + "1";
process.env.AADHAAR_FINGERPRINT_KEY = "test-fingerprint-key-at-least-32-chars-long";

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
const PF_DESIGNATION = 9; // holds view_aadhaar_full and nothing else
const FINANCE_DESIGNATION = 10; // holds the two bank keys plus sensitive access

/** Only the HR designation holds the C2 keys. */
const GRANTS = {
  [HR_DESIGNATION]: [
    P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT, P.EMPLOYEE_RESIGN, P.EMPLOYEE_REJOIN,
    P.VIEW_EMPLOYEE_LIFECYCLE,
  ],
  [OUTLET_DESIGNATION]: ["view_stores"],
  // Reading a full Aadhaar takes BOTH: sensitive access, and the specific key.
  [PF_DESIGNATION]: [P.VIEW_EMPLOYEE_SENSITIVE, P.VIEW_AADHAAR_FULL],
  // Running the paid check and accepting a near-miss name are both above
  // ordinary HR, and both also need sensitive access to see the result.
  [FINANCE_DESIGNATION]: [
    P.VIEW_EMPLOYEE_SENSITIVE, P.VERIFY_EMPLOYEE_BANK, P.CONFIRM_BANK_NAME_MISMATCH,
    P.VIEW_EMPLOYEE_LIFECYCLE,
  ],
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

const aadhaarCalls = [];
const aadhaarUsecase = {
  initiate: async (input, opts) => {
    aadhaarCalls.push(["initiate", input, opts]);
    return { code: 200, verification_token: "a".repeat(64), aadhaar_last4: "2229", expires_in_seconds: 600 };
  },
  verifyOtp: async (input, opts) => {
    aadhaarCalls.push(["verify-otp", input, opts]);
    return {
      code: 200,
      verification_id: 55,
      aadhaar_last4: "2229",
      duplicate: false,
      next_action: "create",
      demographics: { employee_name: "Ramesh Kumar", dob: "1990-02-01", gender: "M" },
    };
  },
  getIdentity: async (id) => ({ employee_id: id, aadhaar_last4: "4321", verified_at: "2026-01-01" }),
  revealFullNumber: async (id, opts) => {
    aadhaarCalls.push(["reveal", id, opts]);
    return { employee_id: id, aadhaar_number: "222222222229", aadhaar_last4: "2229" };
  },
};

const bankCalls = [];
const bankUsecase = {
  verify: async (id, opts) => {
    bankCalls.push(["verify", id, opts]);
    return {
      code: 200, employee_id: id, status: "VERIFIED",
      account_last4: "6789", ifsc: "HDFC0001234", name_at_bank: "RAMESH KUMAR",
      name_match_verdict: "MATCH",
    };
  },
  getStatus: async (id) => {
    bankCalls.push(["status", id]);
    return { employee_id: id, status: "VERIFIED", account_last4: "6789", ifsc: "HDFC0001234" };
  },
  confirmNameMismatch: async (id, opts) => {
    bankCalls.push(["confirm", id, opts]);
    return { code: 200, employee_id: id, status: "VERIFIED", confirmed: true };
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

  const app = express();
  app.use(bodyParser.json());
  app.use(authMiddleware.create({ userUsecase: { getSessionState: async () => ({ ...sessionState }) } }));
  delete require.cache[require.resolve("./employee_master")];
  const routes = require("./employee_master")(usecase, permissions, sensitive, aadhaarUsecase, bankUsecase);
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

/* ============================================================== Aadhaar == */
describe("the Aadhaar surface", () => {
  const AADHAAR = "222222222229"; // shape only; the usecase is stubbed here
  const INITIATE_BODY = { aadhaar_number: AADHAAR, consent_given: true };
  const TOKEN = "a".repeat(64);

  it("is refused to an anonymous caller, at both steps", async () => {
    for (const [p, body] of [
      ["/hr/aadhaar/initiate", INITIATE_BODY],
      ["/hr/aadhaar/verify-otp", { verification_token: TOKEN, otp: "123456" }],
    ]) {
      const r = await call("POST", p, null, body);
      assert.equal(r.body.code, 403, p);
      assert.equal(r.body.msg, "Access Denied");
    }
  });

  it("B3 refuses the initiate body from a caller without edit_employee_sensitive", async () => {
    // aadhaar_number is a sensitive field, so guardWrite refuses the request
    // before the route body ever runs - the same mechanism, not a new one.
    aadhaarCalls.length = 0;
    const r = await call("POST", "/hr/aadhaar/initiate", tokenFor(), INITIATE_BODY);
    assert.equal(r.status, 403);
    assert.equal(r.body.msg, "You do not have permission to perform this action");
    assert.ok(!aadhaarCalls.some((c) => c[0] === "initiate"), "the usecase never saw the number");
  });

  it("an outlet user is refused even before B3", async () => {
    const r = await call("POST", "/hr/aadhaar/initiate", tokenFor({ designationId: OUTLET_DESIGNATION }), INITIATE_BODY);
    assert.equal(r.status, 403);
  });

  it("admin may initiate, and the actor and IP are recorded", async () => {
    aadhaarCalls.length = 0;
    const r = await call("POST", "/hr/aadhaar/initiate", tokenFor({ userType: 2 }), INITIATE_BODY);
    assert.equal(r.body.code, 200);
    const initiate = aadhaarCalls.find((c) => c[0] === "initiate");
    assert.equal(initiate[2].actorEmployeeId, EMPLOYEE_ID);
    assert.ok("ip" in initiate[2]);
  });

  it("initiate answers with an opaque session token and the last four, never the number", async () => {
    const r = await call("POST", "/hr/aadhaar/initiate", tokenFor({ userType: 2 }), INITIATE_BODY);
    assert.equal(r.body.verification_token.length, 64);
    assert.equal(r.body.aadhaar_last4, "2229");
    assert.ok(!r.text.includes(AADHAAR), "the twelve digits are not echoed back");
  });

  it("consent is required by the schema", async () => {
    const r = await call("POST", "/hr/aadhaar/initiate", tokenFor({ userType: 2 }), { aadhaar_number: AADHAAR });
    assert.equal(r.body.code, 422);
  });

  it("verify-otp needs both the session token and the OTP", async () => {
    const token = tokenFor({ userType: 2 });
    assert.equal((await call("POST", "/hr/aadhaar/verify-otp", token, { otp: "123456" })).body.code, 422);
    assert.equal((await call("POST", "/hr/aadhaar/verify-otp", token, { verification_token: TOKEN })).body.code, 422);
  });

  it("verify-otp returns the demographics and the duplicate decision, and no OTP", async () => {
    aadhaarCalls.length = 0;
    const r = await call("POST", "/hr/aadhaar/verify-otp", tokenFor({ userType: 2 }), {
      verification_token: TOKEN,
      otp: "123456",
    });
    assert.equal(r.body.code, 200);
    assert.equal(r.body.verification_id, 55);
    assert.equal(r.body.next_action, "create");
    assert.equal(r.body.demographics.employee_name, "Ramesh Kumar");
    assert.ok(!/"otp"/.test(r.text), "the OTP is never echoed back");
    const call_ = aadhaarCalls.find((c) => c[0] === "verify-otp");
    assert.equal(call_[2].actorEmployeeId, EMPLOYEE_ID, "who exchanged the OTP is recorded");
  });

  it("the OTP is never written to the route's log line", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_master.js"), "utf8");
    const route = src.slice(src.indexOf('router.post("/aadhaar/verify-otp"'), src.indexOf('router.get(\n      "/employee/:employee_id/aadhaar"'));
    assert.ok(!/logger|console\.log\(req\.body/.test(route), "no logging of the OTP body");
  });

  it("the display record is available to HR and carries no number", async () => {
    const r = await call("GET", "/hr/employee/9/aadhaar", tokenFor());
    assert.equal(r.status, 200);
    assert.equal(r.body.aadhaar_last4, "4321");
    assert.ok(!/"aadhaar_number"/.test(r.text));
  });

  it("the FULL number needs its own permission, which HR does not hold", async () => {
    const r = await call("GET", "/hr/employee/9/aadhaar/full", tokenFor());
    assert.equal(r.status, 403);
    assert.equal(r.body.msg, "You do not have permission to perform this action");
  });

  it("and sensitive access ALONE is not enough either", async () => {
    // A designation with view_employee_sensitive but not view_aadhaar_full
    // may see that an Aadhaar exists; it may not read the twelve digits.
    GRANTS[OUTLET_DESIGNATION] = ["view_stores", P.VIEW_EMPLOYEE_SENSITIVE];
    try {
      const r = await call("GET", "/hr/employee/9/aadhaar/full", tokenFor({ designationId: OUTLET_DESIGNATION }));
      assert.equal(r.status, 403);
    } finally {
      GRANTS[OUTLET_DESIGNATION] = ["view_stores"];
    }
  });

  it("a designation holding both keys may read it, and nothing else", async () => {
    const token = tokenFor({ designationId: PF_DESIGNATION });
    const full = await call("GET", "/hr/employee/9/aadhaar/full", token);
    assert.equal(full.status, 200);
    assert.equal(full.body.aadhaar_number, "222222222229");
    // but that key alone opens no lifecycle action
    assert.equal((await call("POST", "/hr/employee", token, CREATE_BODY)).status, 403);
    assert.equal((await call("POST", "/hr/employee/9/resign", token, { resignation_date: "2026-01-01" })).status, 403);
  });

  it("every full-number read records who read it", async () => {
    aadhaarCalls.length = 0;
    await call("GET", "/hr/employee/9/aadhaar/full", tokenFor({ designationId: PF_DESIGNATION }));
    const reveal = aadhaarCalls.find((c) => c[0] === "reveal");
    assert.equal(reveal[2].actorEmployeeId, EMPLOYEE_ID);
  });

  it("the create schema accepts a verification id and still refuses an employee_id", async () => {
    const r = await call("POST", "/hr/employee", tokenFor(), { ...CREATE_BODY, aadhaar_verification_id: 55 });
    assert.equal(r.body.code, 200);
    const bad = await call("POST", "/hr/employee", tokenFor(), { ...CREATE_BODY, employee_id: 1 });
    assert.equal(bad.body.code, 422);
  });

  it("a deployment without Aadhaar configured answers 503, not 500", async () => {
    const permissionsAll = buildPermissions({
      getPermissionById: async () => [
        { permission_key: P.EMPLOYEE_CREATE, is_active: 1 },
        { permission_key: P.VIEW_EMPLOYEE_LIFECYCLE, is_active: 1 },
      ],
    });
    delete require.cache[require.resolve("./employee_master")];
    const routes = require("./employee_master")(usecase, permissionsAll, buildSensitive(permissionsAll), null);
    const app = express();
    app.use(bodyParser.json());
    app.use(require("../middlewares/auth").create({ userUsecase: { getSessionState: async () => ({ ...sessionState }) } }));
    app.use("/hr", routes.getRouter());
    const s = await new Promise((r) => {
      const srv = app.listen(0, "127.0.0.1", () => r(srv));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/hr/employee/9/aadhaar`, {
        headers: { "x-access-token": await tokenFor() },
      });
      assert.equal((await res.json()).code, 503);
    } finally {
      s.close();
      delete require.cache[require.resolve("./employee_master")];
    }
  });
});

/* ================================================================= bank == */
describe("the bank verification surface", () => {
  it("is refused to an anonymous caller on all three routes", async () => {
    for (const [method, p] of [
      ["POST", "/hr/employee/9/bank/verify"],
      ["GET", "/hr/employee/9/bank/verification"],
      ["POST", "/hr/employee/9/bank/confirm-name"],
    ]) {
      const r = await call(method, p, null, method === "POST" ? {} : null);
      assert.equal(r.body.code, 403, p);
      assert.equal(r.body.msg, "Access Denied");
    }
  });

  it("HR alone may not spend a paid check, nor override a name", async () => {
    // The HR designation holds every lifecycle key and still does not hold
    // these two: running a chargeable external call and accepting a name that
    // did not match are separate decisions from editing an employee.
    bankCalls.length = 0;
    const token = tokenFor();
    for (const p of ["/hr/employee/9/bank/verify", "/hr/employee/9/bank/confirm-name"]) {
      const r = await call("POST", p, token, {});
      assert.equal(r.status, 403, p);
      assert.equal(r.body.msg, "You do not have permission to perform this action");
    }
    assert.equal(bankCalls.length, 0, "no provider call was reached");
  });

  it("verify_employee_bank without sensitive access is still refused", async () => {
    // requireAll, not require: the check returns a name and an IFSC, which B3
    // would strip anyway, so a caller who cannot read the answer must not be
    // able to spend the call.
    GRANTS[OUTLET_DESIGNATION] = ["view_stores", P.VERIFY_EMPLOYEE_BANK];
    try {
      const r = await call("POST", "/hr/employee/9/bank/verify", tokenFor({ designationId: OUTLET_DESIGNATION }), {});
      assert.equal(r.status, 403);
    } finally {
      GRANTS[OUTLET_DESIGNATION] = ["view_stores"];
    }
  });

  it("a finance designation holding both keys may verify, and the actor is recorded", async () => {
    bankCalls.length = 0;
    const r = await call("POST", "/hr/employee/9/bank/verify", tokenFor({ designationId: FINANCE_DESIGNATION }), {});
    assert.equal(r.body.code, 200);
    assert.equal(r.body.status, "VERIFIED");
    const verify = bankCalls.find((c) => c[0] === "verify");
    assert.equal(verify[1], 9, "the employee id comes from the path, not the body");
    assert.equal(verify[2].actorEmployeeId, EMPLOYEE_ID);
  });

  it("the account number is never in the response - only the last four", async () => {
    const r = await call("POST", "/hr/employee/9/bank/verify", tokenFor({ designationId: FINANCE_DESIGNATION }), {});
    assert.ok(!/"account_no"/.test(r.text), "no full account number");
    assert.ok(!/"account_fingerprint"/.test(r.text), "no fingerprint either");
    assert.equal(r.body.account_last4, "6789");
  });

  it("the route accepts no account number in the body; it reads what was saved", () => {
    const src = fs.readFileSync(path.join(__dirname, "employee_master.js"), "utf8");
    const route = src.slice(
      src.indexOf('"/employee/:employee_id/bank/verify"'),
      src.indexOf('"/employee/:employee_id/bank/verification"')
    );
    assert.ok(!/account_no|account_number/.test(route), "the account number never crosses this boundary");
    assert.match(route, /this\.bank\.verify\(Number\(req\.params\.employee_id\)/);
  });

  it("the status is readable by HR, and B3 still strips the IFSC from it", async () => {
    const r = await call("GET", "/hr/employee/9/bank/verification", tokenFor());
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "VERIFIED");
    assert.equal(r.body.account_last4, "6789", "the display value survives");
    assert.ok(!/"ifsc"/i.test(r.text), "the IFSC is a sensitive field and HR does not hold that key");
  });

  it("reading the status never calls the provider", () => {
    const uc = fs.readFileSync(path.join(__dirname, "..", "usecase/employee_bank.js"), "utf8");
    const getStatus = uc.slice(uc.indexOf("async getStatus("), uc.indexOf("async verify("));
    assert.ok(!/provider|sandbox/i.test(getStatus.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
      "getStatus must be read-only");
  });

  it("confirming a name mismatch takes its own key and records the actor", async () => {
    bankCalls.length = 0;
    const r = await call("POST", "/hr/employee/9/bank/confirm-name", tokenFor({ designationId: FINANCE_DESIGNATION }), {
      note: "matches the passbook",
    });
    assert.equal(r.body.code, 200);
    const confirm = bankCalls.find((c) => c[0] === "confirm");
    assert.equal(confirm[2].actorEmployeeId, EMPLOYEE_ID);
    assert.equal(confirm[2].note, "matches the passbook");
  });

  it("admin (user_type 2) keeps its bypass here too", async () => {
    const token = tokenFor({ designationId: OUTLET_DESIGNATION, userType: 2 });
    assert.equal((await call("POST", "/hr/employee/9/bank/verify", token, {})).body.code, 200);
  });

  it("a deployment without the bank usecase answers 503, not 500", async () => {
    const permissionsAll = buildPermissions({
      getPermissionById: async () => [
        { permission_key: P.VERIFY_EMPLOYEE_BANK, is_active: 1 },
        { permission_key: P.VIEW_EMPLOYEE_SENSITIVE, is_active: 1 },
      ],
    });
    delete require.cache[require.resolve("./employee_master")];
    const routes = require("./employee_master")(usecase, permissionsAll, buildSensitive(permissionsAll), null, null);
    const app = express();
    app.use(bodyParser.json());
    app.use(require("../middlewares/auth").create({ userUsecase: { getSessionState: async () => ({ ...sessionState }) } }));
    app.use("/hr", routes.getRouter());
    const s = await new Promise((r) => {
      const srv = app.listen(0, "127.0.0.1", () => r(srv));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${s.address().port}/hr/employee/9/bank/verify`, {
        method: "POST",
        headers: { "x-access-token": await tokenFor(), "content-type": "application/json" },
        body: "{}",
      });
      assert.equal((await res.json()).code, 503);
    } finally {
      s.close();
      delete require.cache[require.resolve("./employee_master")];
    }
  });
});

/* ============================================== the permission layering == */
describe("permission layering after the C2 bank grant", () => {
  const DENIED = "You do not have permission to perform this action";

  // HR Executive as the migrations leave it: the C2 lifecycle keys (from
  // `add_employees`), the two bank keys (from this migration), and the
  // sensitive-field access an administrator grants so the answers are
  // readable. NOT view_aadhaar_full.
  const HR_EXEC = 30;
  const HR_EXEC_KEYS = [
    P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT, P.EMPLOYEE_RESIGN, P.EMPLOYEE_REJOIN,
    P.VIEW_EMPLOYEE_LIFECYCLE,
    P.VERIFY_EMPLOYEE_BANK, P.CONFIRM_BANK_NAME_MISMATCH,
    P.VIEW_EMPLOYEE_SENSITIVE, P.EDIT_EMPLOYEE_SENSITIVE,
  ];

  // Every other designation, with the ordinary keys each really holds.
  const OTHERS = {
    21: ["view_stores", "view_employees"],            // Store Manager
    22: ["view_employees"],                            // Supervisor
    23: ["view_employees", "view_salary_advance"],     // Accounts
    24: ["view_stores", "view_shift"],                 // Operations
    25: ["view_stores"],                               // Procurement
    26: [],                                            // Loader
    27: ["view_stores"],                               // Cashier
  };

  before(() => {
    GRANTS[HR_EXEC] = HR_EXEC_KEYS;
    for (const [id, keys] of Object.entries(OTHERS)) GRANTS[id] = keys;
  });
  after(() => {
    delete GRANTS[HR_EXEC];
    for (const id of Object.keys(OTHERS)) delete GRANTS[id];
  });

  const hr = () => tokenFor({ designationId: HR_EXEC });

  it("1/2/11/12. HR Executive may verify a bank account and confirm a near-miss name", async () => {
    const verify = await call("POST", "/hr/employee/9/bank/verify", hr(), {});
    assert.equal(verify.body.code, 200);
    assert.equal(verify.body.status, "VERIFIED");

    const confirm = await call("POST", "/hr/employee/9/bank/confirm-name", hr(), { note: "passbook checked" });
    assert.equal(confirm.body.code, 200);
  });

  it("HR Executive keeps all four lifecycle actions and the review queue", async () => {
    assert.equal((await call("POST", "/hr/employee", hr(), CREATE_BODY)).body.code, 200);
    assert.equal((await call("POST", "/hr/employee/9/edit", hr(), { employee_name: "x" })).body.code, 200);
    assert.equal((await call("POST", "/hr/employee/9/resign", hr(), { resignation_date: "2026-01-01" })).body.code, 200);
    assert.equal((await call("POST", "/hr/employee/9/rejoin", hr(), { date_of_joining: "2026-02-01" })).body.code, 200);
    assert.equal((await call("GET", "/hr/employee/9/lifecycle", hr())).status, 200);
    assert.equal((await call("GET", "/hr/lifecycle/review", hr())).status, 200);
  });

  it("9. and the Aadhaar flow: initiate, verify OTP, and the masked record", async () => {
    const AADHAAR = "222222222229";
    const initiate = await call("POST", "/hr/aadhaar/initiate", hr(), {
      aadhaar_number: AADHAAR,
      consent_given: true,
    });
    assert.equal(initiate.body.code, 200, "edit_employee_sensitive lets the body through B3");
    const otp = await call("POST", "/hr/aadhaar/verify-otp", hr(), {
      verification_token: initiate.body.verification_token,
      otp: "123456",
    });
    assert.equal(otp.body.code, 200);

    const masked = await call("GET", "/hr/employee/9/aadhaar", hr());
    assert.equal(masked.status, 200);
    assert.equal(masked.body.aadhaar_last4, "4321");
    assert.ok(!/"aadhaar_number"/.test(masked.text), "still only the last four");
  });

  it("3/10. HR Executive still cannot read a full Aadhaar", async () => {
    // Sensitive access is not the same decision as reading twelve digits.
    const r = await call("GET", "/hr/employee/9/aadhaar/full", hr());
    assert.equal(r.status, 403);
    assert.equal(r.body.msg, DENIED);
    assert.ok(!HR_EXEC_KEYS.includes(P.VIEW_AADHAAR_FULL), "the key is not in HR Executive's set at all");
  });

  it("4/5/6/7/13. no other designation may reach any of it", async () => {
    for (const id of Object.keys(OTHERS)) {
      const token = tokenFor({ designationId: Number(id) });
      for (const [method, p, body] of [
        ["POST", "/hr/employee/9/bank/verify", {}],
        ["POST", "/hr/employee/9/bank/confirm-name", {}],
        ["GET", "/hr/employee/9/bank/verification", null],
        ["POST", "/hr/aadhaar/initiate", { aadhaar_number: "222222222229", consent_given: true }],
        ["POST", "/hr/aadhaar/verify-otp", { verification_token: "a".repeat(64), otp: "123456" }],
        ["GET", "/hr/employee/9/aadhaar", null],
        ["GET", "/hr/employee/9/aadhaar/full", null],
        ["POST", "/hr/employee", CREATE_BODY],
        ["POST", "/hr/employee/9/resign", { resignation_date: "2026-01-01" }],
        ["GET", "/hr/employee/9/lifecycle", null],
      ]) {
        const r = await call(method, p, token, body);
        assert.equal(r.status, 403, `designation ${id}: ${method} ${p}`);
        assert.equal(r.body.msg, DENIED, `designation ${id}: ${method} ${p}`);
      }
    }
  });

  it("the bank keys alone are not enough - requireAll is what gates them", async () => {
    // If an administrator grants the two bank keys without
    // view_employee_sensitive, the routes stay shut: a caller who cannot
    // read the name at the bank must not be able to spend the call.
    GRANTS[28] = [P.VERIFY_EMPLOYEE_BANK, P.CONFIRM_BANK_NAME_MISMATCH];
    try {
      const token = tokenFor({ designationId: 28 });
      assert.equal((await call("POST", "/hr/employee/9/bank/verify", token, {})).status, 403);
      assert.equal((await call("POST", "/hr/employee/9/bank/confirm-name", token, {})).status, 403);
    } finally {
      delete GRANTS[28];
    }
  });

  it("8. the admin bypass is unchanged by the grant", async () => {
    // user_type 2 holds no key in the table and reaches everything, which is
    // why the migration grants an administrator nothing.
    const admin = tokenFor({ designationId: 26, userType: 2 }); // Loader: no keys at all
    assert.equal((await call("POST", "/hr/employee/9/bank/verify", admin, {})).body.code, 200);
    assert.equal((await call("POST", "/hr/employee/9/bank/confirm-name", admin, {})).body.code, 200);
    assert.equal((await call("GET", "/hr/employee/9/aadhaar/full", admin)).status, 200);
    assert.equal(GRANTS[26].length, 0, "and it came from no grant");
  });
});

describe("the Sandbox KYC and bank migration", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20260908160000-c2-sandbox-kyc-and-bank-up.sql"),
    "utf8"
  );
  /** The statements alone; the comments are free to explain what is elsewhere. */
  const statements = sql.replace(/^\s*--.*$/gm, "");

  it("1/2. declares the two new keys and grants them to HR Executive", () => {
    assert.match(sql, /'verify_employee_bank'/);
    assert.match(sql, /'confirm_bank_name_mismatch'/);
    const grant = statements.slice(statements.indexOf("INSERT INTO `permissions`"));
    assert.ok(grant, "the migration must grant the keys");
    assert.match(grant, /'verify_employee_bank' AS `permission_key`/);
    assert.match(grant, /UNION ALL SELECT 'confirm_bank_name_mismatch'/);
    assert.match(grant, /UPPER\(TRIM\(`designation_name`\)\) = 'HR EXECUTIVE'/);
  });

  it("4/5/6/7. and to nobody else - no other designation is named, and none is inferred", () => {
    const grant = statements.slice(statements.indexOf("INSERT INTO `permissions`"));
    for (const other of [
      "Store Manager", "Supervisor", "Accounts", "Operations",
      "Procurement", "Loader", "Cashier", "Manager", "Admin",
    ]) {
      assert.ok(
        !new RegExp(other, "i").test(grant),
        `${other} must not appear in the grant`
      );
    }
    // Not derived from add_employees either: that set is wider than the
    // people who should be able to spend a paid check.
    assert.ok(!/add_employees/.test(grant), "the grant must not be inferred from add_employees");
    // And no literal designation id, which would grant these to whatever
    // designation happens to hold that number in a restored copy.
    assert.ok(
      !/designation_id`?\s*(=|IN)\s*\(?\s*\d/.test(grant),
      "the designation must be named, never a hard-coded id"
    );
  });

  it("3. does not grant view_aadhaar_full to HR Executive, or to anyone", () => {
    // Onboarding needs the last four. Reading all twelve digits is a
    // statutory-filing decision an administrator makes deliberately.
    assert.ok(!/view_aadhaar_full/.test(statements), "this migration must not touch view_aadhaar_full");
    const aadhaarSql = fs.readFileSync(
      path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20260908140000-c2-aadhaar-identity-up.sql"),
      "utf8"
    );
    assert.match(aadhaarSql, /'view_aadhaar_full'/, "it is still declared");
    assert.ok(
      !/INSERT INTO `permissions`/.test(aadhaarSql.replace(/^\s*--.*$/gm, "")),
      "and still granted to nobody"
    );
  });

  it("the down migration removes only these two keys", () => {
    const down = fs
      .readFileSync(
        path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20260908160000-c2-sandbox-kyc-and-bank-down.sql"),
        "utf8"
      )
      .replace(/^\s*--.*$/gm, "");
    const deletes = down.match(/DELETE FROM[^;]+;/g) || [];
    assert.equal(deletes.length, 2, "two deletes: one per permission table");
    for (const d of deletes) {
      assert.match(d, /IN \('verify_employee_bank','confirm_bank_name_mismatch'\)/);
    }
    for (const key of ["employee_create", "employee_resign", "add_employees", "view_employee_sensitive", "view_aadhaar_full"]) {
      assert.ok(!new RegExp(key).test(down), `${key} must survive the down migration`);
    }
  });

  it("stores a fingerprint and a last four, never a full account number", () => {
    assert.match(sql, /`account_fingerprint`\s+CHAR\(64\)/);
    assert.match(sql, /`account_last4`/);
    assert.ok(!/`account_no`/.test(statements), "the account number stays where it already lives");
  });

  it("one verification row per employee, and an append-only attempt log", () => {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `employee_bank_verification`/);
    assert.match(sql, /UNIQUE KEY `uq_bank_verification_employee` \(`employee_id`\)/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `employee_bank_verification_attempt`/);
  });

  it("gives the Aadhaar session a token, a status and an attempt count", () => {
    assert.match(sql, /`session_token`\s+CHAR\(64\)/);
    assert.match(sql, /`otp_attempts`/);
    assert.match(sql, /'initiated'/);
    assert.match(sql, /'consumed'/);
  });

  it("writes no employee row and deletes nothing", () => {
    // `ON DELETE RESTRICT` is a constraint, not a deletion; a DELETE statement
    // is what must not be here.
    assert.ok(!/DELETE\s+FROM/i.test(statements), "the up migration must delete nothing");
    for (const forbidden of ["INSERT INTO `new_employee`", "UPDATE `new_employee`"]) {
      assert.ok(!statements.includes(forbidden), `must not touch ${forbidden}`);
    }
  });
});

describe("the Aadhaar migration", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20260908140000-c2-aadhaar-identity-up.sql"),
    "utf8"
  );

  it("keeps the number out of new_employee entirely", () => {
    assert.ok(!/ALTER TABLE `new_employee`/.test(sql), "no Aadhaar column is added to the employee master");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `employee_aadhaar_identity`/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS `employee_aadhaar_verification`/);
  });

  it("makes the fingerprint unique, which is the duplicate-person control", () => {
    assert.match(sql, /UNIQUE KEY `uq_aadhaar_identity_fingerprint` \(`aadhaar_fingerprint`\)/);
    assert.match(sql, /UNIQUE KEY `uq_aadhaar_identity_employee` \(`employee_id`\)/);
  });

  it("stores ciphertext, IV and tag - never a plaintext column", () => {
    assert.match(sql, /`aadhaar_ciphertext`\s+VARBINARY/);
    assert.match(sql, /`aadhaar_iv`\s+VARBINARY/);
    assert.match(sql, /`aadhaar_auth_tag`\s+VARBINARY/);
    assert.ok(!/aadhaar_number/.test(sql), "there is no plaintext column at all");
  });

  it("declares view_aadhaar_full and grants it to nobody", () => {
    assert.match(sql, /'view_aadhaar_full'/);
    assert.ok(!/INSERT INTO `permissions`/.test(sql), "no designation is granted the key by the migration");
  });
});
