/**
 * The designation and department PICKERS — GET /designation/directory and
 * GET /department/directory.
 *
 *   node --test middlewares/employee_master_pickers.test.js
 *
 * The Employee Master permissions task made `employee_edit` grantable on its
 * own, which is the point: a Store Manager may correct an employee's record
 * without being handed the rest of HR. But two of the fields that editor
 * writes are `department_id` and `designation_id`, and their dropdowns were
 * reading `GET /department` and `GET /designation` — routes behind
 * `view_department` and `view_designation`, the permissions for ADMINISTERING
 * those masters. A manager therefore got an editable field with nothing in it.
 *
 * Same answer as `GET /outlet/directory` and `GET /employee/directory` before
 * it: return less rather than hand back the permission. What these tests
 * defend is that "less" stays less — the response is asserted key by key, so a
 * later `SELECT *` or an added join cannot quietly put a permission set or a
 * login flag into a dropdown feed.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-em-pickers-"));
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

/** The designation this whole task exists for: View + Edit, nothing else. */
const STORE_MANAGER = 21;
/** HR, who administers the masters as well. */
const HR_EXECUTIVE = 9;
/** Holds nothing at all. */
const OUTLET_STAFF = 4;

const GRANTS = {
  [STORE_MANAGER]: [P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT],
  [HR_EXECUTIVE]: [P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT, P.VIEW_DESIGNATION, P.VIEW_DEPARTMENT],
  [OUTLET_STAFF]: [],
};

/** Every column `SELECT *` would return, so a leak has something to leak. */
const DESIGNATIONS = [
  { designation_id: 21, designation_name: "Store Manager", status: 1, login_access: 1, online_portal: 1 },
  { designation_id: 4, designation_name: "Assistant", status: 1, login_access: 0, online_portal: 0 },
  { designation_id: 9, designation_name: "HR Executive", status: 1, login_access: 1, online_portal: 1 },
];

const DEPARTMENTS = [
  { department_id: 3, department_name: "Operations", status: 1, department_image: "https://x/op.png" },
  { department_id: 1, department_name: "Accounts", status: 1, department_image: "https://x/ac.png" },
];

/** Applies exactly what each repository query's SQL does. */
const designationUsecase = {
  async getDirectory() {
    return DESIGNATIONS.map((d) => ({
      designation_id: d.designation_id,
      designation_name: d.designation_name,
    })).sort((a, b) => a.designation_name.localeCompare(b.designation_name));
  },
  async get() {
    return DESIGNATIONS;
  },
};

const departmentUsecase = {
  async getDirectory() {
    return DEPARTMENTS.map((d) => ({
      department_id: d.department_id,
      department_name: d.department_name,
    })).sort((a, b) => a.department_name.localeCompare(b.department_name));
  },
  async get() {
    return DEPARTMENTS;
  },
};

const sessionState = {
  user_id: USER_ID,
  employee_id: EMPLOYEE_ID,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
};

let server, port;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });

  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionState } }));

  // Both routers keep module-level `router` objects, so a stale require would
  // stack this suite's routes onto another's.
  delete require.cache[require.resolve("../routes/designation")];
  delete require.cache[require.resolve("../routes/department")];
  app.use("/designation", require("../routes/designation")(designationUsecase, permissions).getRouter());
  app.use("/department", require("../routes/department")(departmentUsecase, permissions).getRouter());

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = ({ designationId = STORE_MANAGER, userType = 1 } = {}) =>
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

const call = async (p, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    headers: token ? { "x-access-token": await token } : {},
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = undefined;
  }
  return { status: res.status, body, text };
};

/* ================================ the dropdowns are populated again ===== */

describe("a Store Manager with View + Edit can fill the Employment editor", () => {
  it("reads every designation from the picker", async () => {
    const r = await call("/designation/directory", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 3);
    assert.deepEqual(
      r.body.map((d) => d.designation_id).sort((a, b) => a - b),
      [4, 9, 21]
    );
  });

  it("reads every department from the picker", async () => {
    const r = await call("/department/directory", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.map((d) => d.department_id).sort((a, b) => a - b),
      [1, 3]
    );
  });

  it("and genuinely holds neither master permission", async () => {
    // Without this the two cases above could pass for the wrong reason - the
    // designation having been granted the key at some point.
    assert.ok(!GRANTS[STORE_MANAGER].includes(P.VIEW_DESIGNATION));
    assert.ok(!GRANTS[STORE_MANAGER].includes(P.VIEW_DEPARTMENT));

    const d = await call("/designation", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(d.status, 403);
    assert.equal(d.body.msg, "You do not have permission to perform this action");

    const dept = await call("/department", tokenFor({ designationId: STORE_MANAGER }));
    assert.equal(dept.status, 403);
    assert.equal(dept.body.msg, "You do not have permission to perform this action");
  });
});

/* ================================================ "less" stays less ===== */

describe("the pickers carry nothing but an id and a name", () => {
  it("no status, no login_access, no online_portal on a designation", async () => {
    const r = await call("/designation/directory", tokenFor());
    for (const row of r.body) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ["designation_id", "designation_name"],
        "a designation picker row must be exactly two keys"
      );
    }
  });

  it("no status and no image on a department", async () => {
    const r = await call("/department/directory", tokenFor());
    for (const row of r.body) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ["department_id", "department_name"],
        "a department picker row must be exactly two keys"
      );
    }
  });

  it("the gated routes still return the full record to somebody who may have it", async () => {
    // The pickers ADD a narrow read; they do not replace or weaken the
    // administrative ones.
    const d = await call("/designation", tokenFor({ designationId: HR_EXECUTIVE }));
    assert.equal(d.status, 200);
    assert.ok(Object.keys(d.body[0]).includes("login_access"));

    const dept = await call("/department", tokenFor({ designationId: HR_EXECUTIVE }));
    assert.equal(dept.status, 200);
    assert.ok(Object.keys(dept.body[0]).includes("department_image"));
  });
});

/* ============================================ still behind a session ==== */

describe("a picker is not public", () => {
  it("no token is refused", async () => {
    // A refusal is a body-level `code`, not an HTTP status: that is the
    // convention `util/api.js` reads to redirect to login, so asserting on
    // `r.status` here would pass against an actual list of designations.
    for (const p of ["/designation/directory", "/department/directory"]) {
      const r = await call(p, null);
      assert.ok(
        r.body && r.body.code && r.body.code !== 200,
        `${p} must not answer an anonymous caller`
      );
      assert.ok(!Array.isArray(r.body), `${p} must not return rows without a session`);
    }
  });

  it("a signed-in user holding no permission at all still gets the pickers", async () => {
    // Deliberate, and the same posture as /outlet/directory: these are names
    // already visible on any employee row, and a dropdown is not a disclosure
    // decision worth its own key.
    const r = await call("/designation/directory", tokenFor({ designationId: OUTLET_STAFF }));
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 3);
  });
});
