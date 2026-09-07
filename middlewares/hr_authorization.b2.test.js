/**
 * Stage 0B / B2 — HR endpoints require the right permission, not merely a
 * session.
 *
 * B1 shut the door; B2 decides who holds which key. The app here is real
 * Express with the REAL auth middleware, the REAL permissions middleware and
 * the REAL HR routers over stub usecases, so the assertions are about the
 * wiring that actually ships.
 *
 * The half that matters most is the negative one: holding `view_employees`
 * must not open salary, documents or bank details. Every module is therefore
 * probed with a caller who holds exactly one key.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-b2-"));
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
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");

const USER_ID = 7;
const EMPLOYEE_ID = 1003;
const DESIGNATION = 4;

/**
 * The mapping under test: endpoint -> the ONE key that opens it.
 * Anything not listed here is either ungated on purpose (the two bootstrap
 * routes, asserted separately) or outside B2.
 */
const MAP = [
  // employee master
  ["GET", "/employee/employees", P.VIEW_EMPLOYEES],
  ["GET", "/employee/employee_id", P.VIEW_EMPLOYEES],
  ["GET", "/employee/store_id", P.VIEW_EMPLOYEES],
  ["GET", "/employee/filter", P.VIEW_EMPLOYEES],
  ["GET", "/employee/headcount", P.VIEW_EMPLOYEES],
  ["GET", "/employee/newjoiner", P.VIEW_EMPLOYEES],
  ["GET", "/employee/newjoinee", P.VIEW_EMPLOYEES],
  ["GET", "/employee/resignedemp", P.VIEW_EMPLOYEES],
  ["GET", "/employee/birthday", P.VIEW_EMPLOYEES],
  ["GET", "/employee/anniversary", P.VIEW_EMPLOYEES],
  ["POST", "/employee", P.ADD_EMPLOYEES],
  ["POST", "/employee/updatedata", P.ADD_EMPLOYEES],
  ["POST", "/employee/update-status", P.ADD_EMPLOYEES],
  ["POST", "/employee/sync", P.ADD_EMPLOYEES],
  ["GET", "/employee/bank", P.VIEW_BANKS],
  ["GET", "/employee/familydet", P.VIEW_FAMILY],
  // documents
  ["GET", "/document/employee_id", P.VIEW_DOCUMENTS],
  ["GET", "/document/document_id", P.VIEW_DOCUMENTS],
  ["GET", "/document/all", P.VIEW_DOCUMENTS],
  ["GET", "/document/withoutadhaar", P.VIEW_DOCUMENTS],
  ["GET", "/document/adhaar", P.VIEW_EMPLOYEE_SENSITIVE],
  ["POST", "/document/update-document", P.ADD_DOCUMENTS],
  ["POST", "/document/update-status", P.ADD_DOCUMENTS],
  // family
  ["GET", "/family", P.VIEW_FAMILY],
  ["GET", "/family/family_id", P.VIEW_FAMILY],
  ["GET", "/family/employee_name", P.VIEW_FAMILY],
  ["POST", "/family/create", P.ADD_FAMILY],
  ["POST", "/family/update-family", P.ADD_FAMILY],
  // salary
  ["GET", "/salary", P.VIEW_SALARY_ADVANCE],
  ["GET", "/salary/payment_id", P.VIEW_SALARY_ADVANCE],
  ["POST", "/salary/create", P.ADD_SALARY_ADVANCE],
  ["POST", "/salary/update-payment", P.ADD_SALARY_ADVANCE],
  ["POST", "/salary/update-status", P.ADD_SALARY_ADVANCE],
  ["POST", "/salary/update-paidstatus", P.ADD_SALARY_ADVANCE],
  // resignation
  ["GET", "/resignation", P.VIEW_RESIGNATION],
  ["GET", "/resignation/employee_name", P.VIEW_RESIGNATION],
  ["GET", "/resignation/get/resignation_id", P.VIEW_RESIGNATION],
  ["POST", "/resignation/create", P.ADD_RESIGNATION],
  ["POST", "/resignation/update-resignation", P.ADD_RESIGNATION],
  // designation
  ["GET", "/designation", P.VIEW_DESIGNATION],
  ["GET", "/designation/count", P.VIEW_DESIGNATION],
  ["GET", "/designation/budget", P.VIEW_DESIGNATION],
  ["GET", "/designation/designation_id", P.VIEW_DESIGNATION],
  ["POST", "/designation/create", P.ADD_DESIGNATION],
  ["POST", "/designation/update-designation", P.ADD_DESIGNATION],
  ["POST", "/designation/update-status", P.ADD_DESIGNATION],
  // department
  ["GET", "/department", P.VIEW_DEPARTMENT],
  ["GET", "/department/department_id", P.VIEW_DEPARTMENT],
  ["GET", "/department/product-department", P.VIEW_DEPARTMENT],
  ["POST", "/department/create", P.ADD_DEPARTMENT],
  ["POST", "/department/update-department", P.ADD_DEPARTMENT],
  ["POST", "/department/update-status", P.ADD_DEPARTMENT],
  ["POST", "/department/update-prodstatus", P.ADD_DEPARTMENT],
  ["POST", "/department/imageupload", P.ADD_DEPARTMENT],
  // shift
  ["GET", "/shift", P.VIEW_SHIFT],
  ["GET", "/shift/shift_id", P.VIEW_SHIFT],
  ["POST", "/shift/create", P.ADD_SHIFTS],
  ["POST", "/shift/update-shift", P.ADD_SHIFTS],
  ["POST", "/shift/update-status", P.ADD_SHIFTS],
  // outlet
  ["GET", "/outlet", P.VIEW_STORES],
  ["GET", "/outlet/outlet_id", P.VIEW_STORES],
  ["GET", "/outlet/id", P.VIEW_STORES],
  ["POST", "/outlet/create", P.ADD_STORES],
  ["POST", "/outlet/update-outlet", P.ADD_STORES],
  ["POST", "/outlet/update-status", P.ADD_STORES],
];

/** Grants per designation, as `permissions` rows including is_active. */
let GRANTS = [];
let permissions, server, port, reached;

/**
 * Stands in for usecase/designation.js#getPermissionById, applying exactly
 * what the repository SQL now does: rows for this designation, is_active = 1.
 */
const designationUsecase = {
  async getPermissionById(designationId, userType) {
    if (Number(userType) === 2) return GRANTS.map((g) => ({ permission_key: g.permission_key }));
    return GRANTS.filter(
      (g) => Number(g.designation_id) === Number(designationId) && Number(g.is_active) === 1
    ).map((g) => ({ permission_key: g.permission_key }));
  },
};

/** Every HR usecase method a router may call, answering harmlessly. */
const stubUsecase = () =>
  new Proxy(
    {},
    {
      get: () => async () => {
        reached = true;
        return { code: 200, reached: true };
      },
    }
  );

before(async () => {
  permissions = buildPermissions(designationUsecase);
  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionState } }));

  const mount = (prefix, mod, extra = []) => {
    delete require.cache[require.resolve(`../routes/${mod}`)];
    const r = require(`../routes/${mod}`)(stubUsecase(), permissions, ...extra);
    app.use(prefix, r.getRouter());
  };
  // Each router registers on its own module-level express Router, so they are
  // mounted one per app exactly as server.js does.
  // Stage 0B / B3 added a third constructor argument to these two routers.
  // It is passed here so this file keeps testing the wiring that ships; what
  // it asserts is unchanged, and B3 has its own tests.
  const sensitive = require("./sensitive")(permissions);
  mount("/employee", "employee", [sensitive]);
  mount("/document", "document", [sensitive]);
  mount("/family", "family");
  mount("/salary", "salary");
  mount("/resignation", "resignation");
  mount("/designation", "designation");
  mount("/department", "department");
  mount("/shift", "shift");
  mount("/outlet", "outlet", [(req, res, next) => next()]);

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const sessionState = {
  user_id: USER_ID,
  employee_id: EMPLOYEE_ID,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
};

const tokenFor = ({ userType = 1, designationId = DESIGNATION } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(USER_ID),
      id: USER_ID,
      employee_id: EMPLOYEE_ID,
      user_type: userType,
      designation_id: designationId,
      store_id: 2,
    },
    "1d"
  );

const call = async (method, p, token) => {
  reached = false;
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-access-token": token } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch (e) {}
  return { status: res.status, body, text, reached };
};

/** Denied by permissions = HTTP 403 with the middleware's message. */
const isPermissionDenied = (r) =>
  r.status === 403 && r.body && r.body.code === 403 && /do not have permission/i.test(r.body.msg || "");

/** Denied by authentication = the B1 shape (body code 403, HTTP 200). */
const isAuthDenied = (r) => r.status === 200 && r.body && r.body.code === 403;

const grant = (keys, designationId = DESIGNATION) => {
  GRANTS = keys.map((k) => ({ permission_key: k, designation_id: designationId, is_active: 1 }));
  permissions.invalidate();
};

describe("B2 — authentication is still required (B1 unchanged)", () => {
  it("every mapped endpoint refuses an anonymous caller before any permission check", async () => {
    for (const [method, p] of MAP) {
      const r = await call(method, p);
      assert.ok(isAuthDenied(r), `${method} ${p}: ${r.text.slice(0, 100)}`);
      assert.equal(r.reached, false);
    }
  });

  it("a garbage token is still refused", async () => {
    const r = await call("GET", "/employee/employees", "not.a.token");
    assert.ok(isAuthDenied(r));
  });
});

describe("B2 — a session with no permissions is denied everywhere", () => {
  it("every mapped endpoint answers 403 for an authenticated caller holding nothing", async () => {
    grant([]);
    const token = await tokenFor();
    for (const [method, p] of MAP) {
      const r = await call(method, p, token);
      assert.ok(isPermissionDenied(r), `${method} ${p} was not permission-denied: ${r.text.slice(0, 120)}`);
      assert.equal(r.reached, false, `${method} ${p} reached the usecase without a permission`);
    }
  });
});

describe("B2 — the right key opens exactly its own endpoint", () => {
  for (const [method, p, key] of MAP) {
    it(`${method} ${p} is allowed with ${key}`, async () => {
      grant([key]);
      const token = await tokenFor();
      const r = await call(method, p, token);
      // Not permission-denied is the assertion. A route may still answer 422
      // for missing query parameters - it got past the gate, which is what
      // B2 is about; the handler's own validation is not B2's business.
      assert.equal(isPermissionDenied(r), false, `${method} ${p} denied while holding ${key}`);
      assert.equal(isAuthDenied(r), false, `${method} ${p} was refused authentication`);
    });
  }
});

describe("B2 — one module's permission does not grant another", () => {
  const CROSS = [
    [P.VIEW_EMPLOYEES, "GET", "/salary", "the staff directory does not open payroll"],
    [P.VIEW_EMPLOYEES, "GET", "/employee/bank", "the staff directory does not open bank details"],
    [P.VIEW_EMPLOYEES, "GET", "/document/adhaar", "the staff directory does not open Aadhaar"],
    [P.VIEW_EMPLOYEES, "POST", "/employee/updatedata", "read does not grant write"],
    [P.VIEW_EMPLOYEES, "POST", "/employee/sync", "read does not grant the Digisme sync"],
    [P.VIEW_DOCUMENTS, "GET", "/document/adhaar", "ordinary documents do not open Aadhaar"],
    [P.VIEW_DOCUMENTS, "POST", "/document/update-document", "viewing documents does not grant editing them"],
    [P.VIEW_SALARY_ADVANCE, "GET", "/employee/employees", "payroll does not open the staff directory"],
    [P.VIEW_DESIGNATION, "GET", "/department", "designation does not open department"],
    [P.VIEW_SHIFT, "GET", "/outlet", "shift does not open outlet"],
    [P.VIEW_STORES, "POST", "/outlet/create", "viewing outlets does not grant creating one"],
    [P.VIEW_FAMILY, "GET", "/employee/bank", "family does not open bank details"],
    [P.ADD_EMPLOYEES, "GET", "/employee/bank", "editing employees does not open bank details"],
  ];
  for (const [key, method, p, why] of CROSS) {
    it(`${key} does not open ${method} ${p} — ${why}`, async () => {
      grant([key]);
      const token = await tokenFor();
      const r = await call(method, p, token);
      assert.ok(isPermissionDenied(r), `${key} wrongly opened ${method} ${p}`);
      assert.equal(r.reached, false);
    });
  }
});

describe("B2 — admin bypass and the bootstrap routes", () => {
  it("user_type 2 holds every key without any grant row", async () => {
    GRANTS = [];
    permissions.invalidate();
    const token = await tokenFor({ userType: 2, designationId: null });
    for (const [method, p] of MAP) {
      const r = await call(method, p, token);
      assert.equal(isPermissionDenied(r), false, `admin was denied ${method} ${p}`);
    }
  });

  it("/employee/get-details works for an authenticated caller with NO HR permission", async () => {
    grant([]);
    const r = await call("GET", "/employee/get-details", await tokenFor());
    assert.equal(isPermissionDenied(r), false, "bootstrap must not need a permission");
    assert.equal(isAuthDenied(r), false, "bootstrap must not need re-authentication");
  });

  it("/designation/permissions works for an authenticated caller with NO HR permission", async () => {
    grant([]);
    const r = await call("GET", "/designation/permissions", await tokenFor());
    assert.equal(isPermissionDenied(r), false, "bootstrap must not need a permission");
    assert.equal(isAuthDenied(r), false);
  });

  it("both bootstrap routes still refuse an anonymous caller", async () => {
    for (const p of ["/employee/get-details", "/designation/permissions"]) {
      assert.ok(isAuthDenied(await call("GET", p)), p);
    }
  });
});

describe("B2 — inactive permission rows are ignored", () => {
  it("a grant with is_active = 0 does not open its endpoint", async () => {
    GRANTS = [{ permission_key: P.VIEW_EMPLOYEES, designation_id: DESIGNATION, is_active: 0 }];
    permissions.invalidate();
    const r = await call("GET", "/employee/employees", await tokenFor());
    assert.ok(isPermissionDenied(r), "an inactive permission must not grant access");
  });

  it("the same key with is_active = 1 does open it", async () => {
    GRANTS = [{ permission_key: P.VIEW_EMPLOYEES, designation_id: DESIGNATION, is_active: 1 }];
    permissions.invalidate();
    const r = await call("GET", "/employee/employees", await tokenFor());
    assert.equal(isPermissionDenied(r), false);
  });

  it("the repository SQL is what enforces it, so the bootstrap and the check agree", () => {
    const repo = require("../repository/designation")({ query: () => {} });
    const sql = repo.getQuery(1);
    assert.match(sql, /FROM permissions WHERE designation_id = \? AND is_active = 1/);
  });
});

describe("B2 — a permission edit takes effect immediately", () => {
  it("revoking a key stops working before the cache TTL elapses", async () => {
    grant([P.VIEW_EMPLOYEES]);
    const token = await tokenFor();
    assert.equal(isPermissionDenied(await call("GET", "/employee/employees", token)), false, "granted first");

    // the grant is now cached; revoke it in the store only
    GRANTS = [];
    assert.equal(
      isPermissionDenied(await call("GET", "/employee/employees", token)),
      false,
      "still cached - this is exactly what invalidate() must fix"
    );

    permissions.invalidate(DESIGNATION);
    const after = await call("GET", "/employee/employees", token);
    assert.ok(isPermissionDenied(after), "after invalidate the revocation must be live");
  });

  it("invalidate accepts the id as a number or a string, since request bodies carry strings", async () => {
    grant([P.VIEW_EMPLOYEES]);
    const token = await tokenFor();
    await call("GET", "/employee/employees", token); // warm the cache
    GRANTS = [];
    permissions.invalidate(String(DESIGNATION));
    assert.ok(isPermissionDenied(await call("GET", "/employee/employees", token)));
  });

  it("the designation write routes call invalidate", () => {
    const src = fs.readFileSync(path.join(__dirname, "../routes/designation.js"), "utf8");
    const update = src.slice(src.indexOf('router.post("/update-designation"'), src.indexOf('router.get("/designation_id"'));
    assert.match(update, /this\.permissions\.invalidate\(/, "update-designation must invalidate");
    const create = src.slice(src.indexOf('router.post("/create"'));
    assert.match(create, /this\.permissions\.invalidate\(/, "create must invalidate");
  });
});

describe("B2 — require() is OR, requireAll() is AND", () => {
  it("each mapped endpoint is gated by exactly ONE key, so OR cannot weaken it", () => {
    const files = ["employee", "document", "family", "salary", "resignation", "designation", "department", "shift", "outlet"];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, `../routes/${f}.js`), "utf8");
      for (const m of src.matchAll(/this\.permissions\.require\(([^)]*)\)/g)) {
        assert.equal(m[1].split(",").length, 1, `${f}.js: require() called with more than one key: ${m[1]}`);
      }
    }
  });

  it("requireAll denies when only one of two keys is held, require allows", async () => {
    grant([P.VIEW_EMPLOYEES]);
    const req = { decoded: { designation_id: DESIGNATION, user_type: 1 } };
    assert.equal(await permissions.has(req, P.VIEW_EMPLOYEES, P.VIEW_BANKS), true, "OR: one is enough");
    assert.equal(await permissions.hasAll(req, P.VIEW_EMPLOYEES, P.VIEW_BANKS), false, "AND: both are needed");
    grant([P.VIEW_EMPLOYEES, P.VIEW_BANKS]);
    assert.equal(await permissions.hasAll(req, P.VIEW_EMPLOYEES, P.VIEW_BANKS), true);
  });

  it("an admin passes both, and hasAll with no keys is false", async () => {
    const admin = { decoded: { designation_id: null, user_type: 2 } };
    assert.equal(await permissions.hasAll(admin, P.VIEW_EMPLOYEES, P.VIEW_BANKS), true);
    assert.equal(await permissions.hasAll({ decoded: { designation_id: DESIGNATION, user_type: 1 } }), false);
  });
});
