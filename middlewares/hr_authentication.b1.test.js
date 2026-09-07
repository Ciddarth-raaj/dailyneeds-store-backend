/**
 * Stage 0B / B1 — HR endpoints require a session.
 *
 * Before B1 every endpoint listed here answered with no token at all:
 * `GET /employee/employees` returned the whole employee master, bank details,
 * PAN, Aadhaar and salary included, to anyone who could reach the API.
 *
 * B1 removes them from `unProtectedRoutes` and nothing else. Authorisation
 * (permission keys) is B2 and field filtering is B3, so the second half of
 * every case below is as important as the first: an authenticated caller must
 * still reach exactly the route it reached before, or this deploy is an
 * authorisation change in disguise.
 *
 * The app here is real Express with the REAL auth middleware; the HR routers
 * are stubs that record being reached, because B1 changes who gets through
 * the door, not what is behind it.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// The middleware resolves services/jwt at require time from the environment,
// so the keys must exist before it is loaded.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-b1-"));
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
const jwtService = require("../services/jwt");

const USER_ID = 7;
const EMPLOYEE_ID = 1003;

/**
 * Every HR endpoint B1 closes, exactly as the map listed them, with the one
 * method that was open. This list IS the specification: if an entry here is
 * still reachable without a token, B1 did not land.
 */
const HR_ENDPOINTS = [
  ["GET", "/employee/employees"],
  ["GET", "/employee/employee_id"],
  ["GET", "/employee/store_id"],
  ["GET", "/employee/filter"],
  ["GET", "/employee/headcount"],
  ["GET", "/employee/newjoiner"],
  ["GET", "/employee/newjoinee"],
  ["GET", "/employee/resignedemp"],
  ["GET", "/employee/birthday"],
  ["GET", "/employee/anniversary"],
  ["GET", "/employee/bank"],
  ["GET", "/employee/familydet"],
  ["POST", "/employee"],
  ["POST", "/employee/updatedata"],
  ["POST", "/employee/update-status"],
  ["GET", "/designation"],
  ["GET", "/designation/designation_id"],
  ["GET", "/designation/count"],
  ["GET", "/designation/budget"],
  ["POST", "/designation/create"],
  ["POST", "/designation/update-designation"],
  ["POST", "/designation/update-status"],
  ["GET", "/department"],
  ["GET", "/department/department_id"],
  ["GET", "/department/product-department"],
  ["POST", "/department/create"],
  ["POST", "/department/update-department"],
  ["POST", "/department/update-status"],
  ["POST", "/department/update-prodstatus"],
  ["POST", "/department/imageupload"],
  ["GET", "/shift"],
  ["GET", "/shift/shift_id"],
  ["POST", "/shift/create"],
  ["POST", "/shift/update-shift"],
  ["POST", "/shift/update-status"],
  ["GET", "/outlet"],
  ["GET", "/outlet/outlet_id"],
  ["GET", "/outlet/id"],
  ["POST", "/outlet/create"],
  ["POST", "/outlet/update-outlet"],
  ["POST", "/outlet/update-status"],
  ["GET", "/resignation"],
  ["GET", "/resignation/employee_name"],
  ["GET", "/resignation/get/resignation_id"],
  ["POST", "/resignation/create"],
  ["POST", "/resignation/update-resignation"],
  ["POST", "/resignation/resignation_id"],
  ["GET", "/family"],
  ["GET", "/family/family_id"],
  ["GET", "/family/employee_name"],
  ["POST", "/family/create"],
  ["POST", "/family/update-family"],
  ["GET", "/document/employee_id"],
  ["GET", "/document/document_id"],
  ["GET", "/document/all"],
  ["GET", "/document/adhaar"],
  ["GET", "/document/withoutadhaar"],
  ["POST", "/document/update-document"],
  ["POST", "/document/update-status"],
  ["GET", "/salary"],
  ["GET", "/salary/payment_id"],
  ["POST", "/salary/create"],
  ["POST", "/salary/update-payment"],
  ["POST", "/salary/update-status"],
  ["POST", "/salary/update-paidstatus"],
];

/** The most sensitive of them, called out so a partial removal is obvious. */
const SENSITIVE = ["/employee/employees", "/employee/bank", "/document/adhaar", "/salary"];

let server, port, reached;

/** A session state the middleware accepts: active user, active employee. */
const sessionState = {
  user_id: USER_ID,
  employee_id: EMPLOYEE_ID,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
};

before(async () => {
  const app = express();
  app.use(bodyParser.json());
  app.use(
    auth.create({
      userUsecase: { getSessionState: async () => sessionState },
    })
  );
  // Stub HR routers: reaching one means the middleware let the request in.
  app.all("*", (req, res) => {
    reached = { method: req.method, path: req.path, auth: req.auth || null };
    res.json({ code: 200, reached: true });
  });
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const call = async (method, p, token) => {
  reached = null;
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-access-token": token } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, reached };
};

/** A v2 token of the shape usecase/user.js#_issueSession mints. */
const employeeToken = () =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(USER_ID),
      id: USER_ID,
      employee_id: EMPLOYEE_ID,
      user_type: 1,
      designation_id: 4,
      store_id: 2,
    },
    "1d"
  );

describe("B1 — the map itself", () => {
  it("carries no employee, designation, department, shift, outlet, resignation, family, document or salary entry", () => {
    const hr = /^\/(employee|designation|department|shift|outlet|resignation|family|document|salary)(\/|$)/;
    const left = Object.keys(auth.unProtectedRoutes).filter((k) => hr.test(k));
    assert.deepEqual(left, [], `still unprotected: ${left.join(", ")}`);
  });

  it("still carries the non-HR entries — B1 closes HR only", () => {
    const keys = Object.keys(auth.unProtectedRoutes);
    assert.ok(keys.length > 50, `expected the rest of the map intact, found ${keys.length} entries`);
    for (const kept of ["/user", "/user/login", "/product", "/indent", "/store", "/asset"]) {
      assert.ok(keys.includes(kept), `${kept} must stay unprotected in B1`);
    }
  });

  it("POST /user and the login route are untouched", () => {
    assert.equal(auth.unProtectedRoutes["/user"].methods.post, true);
    // The map declares "/user/login" twice; the later `{ post: true }` wins,
    // which matches the deployed login route (Stage 0A / A7 moved credentials
    // into the POST body). Pre-existing, asserted here so B1 is shown not to
    // have changed it.
    assert.equal(auth.unProtectedRoutes["/user/login"].methods.post, true);
    for (const p of ["/user/setup-password", "/user/forgot-password", "/user/reset-password"]) {
      assert.equal(auth.unProtectedRoutes[p].methods.post, true, p);
    }
  });
});

describe("B1 — unauthenticated HR requests are rejected", () => {
  for (const [method, p] of HR_ENDPOINTS) {
    it(`${method} ${p} without a token is refused and never reaches the route`, async () => {
      const r = await call(method, p);
      assert.equal(r.body.code, 403, `${method} ${p} answered ${JSON.stringify(r.body).slice(0, 120)}`);
      assert.equal(r.reached, null, `${method} ${p} reached the route without a token`);
    });
  }

  it("a garbage token is refused too (not merely a missing header)", async () => {
    for (const p of SENSITIVE) {
      const r = await call("GET", p, "not.a.token");
      assert.equal(r.body.code, 403, p);
      assert.equal(r.reached, null, p);
    }
  });

  it("no rejected response carries employee data", async () => {
    for (const p of SENSITIVE) {
      const r = await call("GET", p);
      const body = JSON.stringify(r.body);
      for (const field of ["account_no", "ifsc", "pan_no", "aadhaar", "salary", "employee_name"]) {
        assert.equal(body.includes(field), false, `${p} rejection leaked ${field}`);
      }
    }
  });
});

describe("B1 — authenticated HR requests still reach the route", () => {
  let token;
  before(async () => {
    token = await employeeToken();
  });

  for (const [method, p] of HR_ENDPOINTS) {
    it(`${method} ${p} with a valid session reaches the route unchanged`, async () => {
      const r = await call(method, p, token);
      assert.equal(r.body.reached, true, `${method} ${p} was blocked for an authenticated caller`);
      assert.equal(r.reached.path, p);
      assert.equal(r.reached.method, method);
    });
  }

  it("a plain employee (user_type 1, no permissions) still gets through — B1 adds no authorisation", async () => {
    const r = await call("GET", "/employee/employees", token);
    assert.equal(r.body.reached, true);
    assert.equal(r.reached.auth.employeeId, EMPLOYEE_ID);
    assert.equal(r.reached.auth.isSystemAccount, false);
  });

  it("the resolved identity is the Stage 0A shape, not a new one", async () => {
    const r = await call("GET", "/salary", token);
    const a = r.reached.auth;
    assert.equal(a.userId, USER_ID);
    assert.equal(a.employeeId, EMPLOYEE_ID);
    assert.equal(a.authVersion, 2);
    assert.equal(a.isSystemAccount, false);
    assert.equal(a.mustChangePassword, false);
    assert.equal(a.designationId, 4);
    assert.equal(a.storeId, 2);
    // B1 adds no field of its own to the identity.
    assert.deepEqual(
      Object.keys(a).filter(
        (k) =>
          ![
            "userId",
            "employeeId",
            "userType",
            "designationId",
            "storeId",
            "isSystemAccount",
            "mustChangePassword",
            "issuedAt",
            "authVersion",
            "legacy",
          ].includes(k)
      ),
      []
    );
  });
});

describe("B1 — behaviour that must not change", () => {
  it("POST /user/login is still reachable with no token", async () => {
    const r = await call("POST", "/user/login");
    assert.equal(r.body.reached, true, "login must not require a session");
  });

  it("POST /user is still reachable with no token", async () => {
    const r = await call("POST", "/user");
    assert.equal(r.body.reached, true);
  });

  it("/employee/get-details and /designation/permissions were already protected and still are", async () => {
    for (const p of ["/employee/get-details", "/designation/permissions"]) {
      const anon = await call("GET", p);
      assert.equal(anon.body.code, 403, p);
      const token = await employeeToken();
      const authed = await call("GET", p, token);
      assert.equal(authed.body.reached, true, p);
    }
  });

  it("both stay on the password-change allow-list, so a flagged session keeps its bootstrap", async () => {
    // Deployment B posture: enforcement on, session flagged for a change.
    const app = express();
    app.use(bodyParser.json());
    app.use(
      auth.create({
        config: {
          ...require("../config/auth"),
          password: { ...require("../config/auth").password, enforcePasswordChange: true },
        },
        userUsecase: { getSessionState: async () => ({ ...sessionState, must_change_password: 1 }) },
      })
    );
    app.all("*", (req, res) => res.json({ code: 200, reached: true }));
    const s = await new Promise((r) => {
      const srv = app.listen(0, "127.0.0.1", () => r(srv));
    });
    try {
      const token = await jwtService.sign(
        { auth_ver: 2, sub: String(USER_ID), id: USER_ID, employee_id: EMPLOYEE_ID, user_type: 1, pwc: true },
        "1d"
      );
      const p = s.address().port;
      const get = async (route) =>
        (await (await fetch(`http://127.0.0.1:${p}${route}`, { headers: { "x-access-token": token } })).json());
      assert.equal((await get("/employee/get-details")).reached, true);
      assert.equal((await get("/designation/permissions")).reached, true);
      // an ordinary HR route is confined, as it was for any other route
      assert.equal((await get("/employee/employees")).error, "PASSWORD_CHANGE_REQUIRED");
    } finally {
      s.close();
    }
  });
});
