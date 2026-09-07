/**
 * The operational employee directory — GET /employee/directory.
 *
 * B2 put `view_employees` in front of /employee/employees, which is right:
 * that route returns the whole employee record. The accounts sheet only ever
 * needed a name for a dropdown, so taking the HR permission away from outlet
 * staff emptied it. The fix is a route that returns less, not a permission
 * handed back.
 *
 * What these tests defend is that "less" stays less. The response is asserted
 * key by key, not merely spot-checked for a salary: a future join that added
 * `designation_name` would be invisible to a test that only looked for the
 * fields we already know are sensitive.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-dir-"));
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
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");

const USER_ID = 7;
const EMPLOYEE_ID = 1003;
const OWN_STORE = 2;
const OTHER_STORE = 9;
const NO_KEYS_DESIGNATION = 4; // an accounts / outlet user: no HR permission at all

/**
 * The employee master, as rows. Only the two directory columns are ever
 * selected from it by the route under test; the rest are here so a leak has
 * something to leak.
 */
const EMPLOYEES = [
  { employee_id: 11, employee_name: "Zara Own", store_id: OWN_STORE, status: 1, salary: 50000, account_no: "1", pan_no: "P", aadhaar_card_no: "A", primary_contact_number: "9", designation_id: 3 },
  { employee_id: 12, employee_name: "Amit Own", store_id: OWN_STORE, status: 1, salary: 60000, account_no: "2", pan_no: "Q", aadhaar_card_no: "B", primary_contact_number: "8", designation_id: 3 },
  { employee_id: 13, employee_name: "Inactive Own", store_id: OWN_STORE, status: 0, salary: 70000, account_no: "3", pan_no: "R", aadhaar_card_no: "C", primary_contact_number: "7", designation_id: 3 },
  { employee_id: 14, employee_name: "Other Branch", store_id: OTHER_STORE, status: 1, salary: 80000, account_no: "4", pan_no: "S", aadhaar_card_no: "D", primary_contact_number: "6", designation_id: 3 },
];

/** Stands in for the repository query, applying exactly what its SQL does. */
const employeeUsecase = new Proxy(
  {},
  {
    get: (_t, name) => async (arg) => {
      if (name === "getDirectory") {
        return EMPLOYEES.filter((e) => e.status === 1 && Number(e.store_id) === Number(arg))
          .map((e) => ({ employee_id: e.employee_id, employee_name: e.employee_name }))
          .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
      }
      return [{ reached: String(name) }];
    },
  }
);

const sessionState = {
  user_id: USER_ID,
  employee_id: EMPLOYEE_ID,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
};

let server, port, permissions;

before(async () => {
  // No designation holds anything: the directory must work regardless.
  permissions = buildPermissions({ getPermissionById: async () => [] });
  const sensitive = buildSensitive(permissions);

  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionState } }));
  delete require.cache[require.resolve("../routes/employee")];
  const routes = require("../routes/employee")(employeeUsecase, permissions, sensitive);
  app.use("/employee", routes.getRouter());

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = ({ userType = 1, storeId = OWN_STORE } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(USER_ID),
      id: USER_ID,
      employee_id: EMPLOYEE_ID,
      user_type: userType,
      designation_id: NO_KEYS_DESIGNATION,
      store_id: storeId,
    },
    "1d"
  );

const call = async (p, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    headers: { "content-type": "application/json", ...(token ? { "x-access-token": await token } : {}) },
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

describe("the directory is authenticated, but needs no HR permission", () => {
  it("refuses an anonymous caller (B1)", async () => {
    const r = await call("/employee/directory", null);
    assert.equal(r.status, 200);
    assert.equal(r.body.code, 403);
    assert.equal(r.body.msg, "Access Denied");
  });

  it("answers a signed-in user who holds no HR permission at all", async () => {
    const r = await call("/employee/directory", tokenFor());
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body), `expected a list, got ${r.text.slice(0, 80)}`);
    assert.ok(r.body.length > 0);
  });

  it("and /employee/employees still refuses that same caller (B2 intact)", async () => {
    const r = await call("/employee/employees", tokenFor());
    assert.equal(r.status, 403);
    assert.equal(r.body.msg, "You do not have permission to perform this action");
  });
});

describe("what the directory returns", () => {
  it("only active employees of the caller's own outlet", async () => {
    const r = await call("/employee/directory", tokenFor());
    assert.deepEqual(
      r.body.map((e) => e.employee_id),
      [12, 11],
      "Amit before Zara, and neither the inactive nor the other-branch employee"
    );
  });

  it("excludes inactive employees", async () => {
    const r = await call("/employee/directory", tokenFor());
    assert.ok(!r.body.some((e) => e.employee_id === 13));
    assert.ok(!r.text.includes("Inactive Own"));
  });

  it("excludes employees of other outlets", async () => {
    const r = await call("/employee/directory", tokenFor());
    assert.ok(!r.body.some((e) => e.employee_id === 14));
    assert.ok(!r.text.includes("Other Branch"));
  });

  it("returns EXACTLY two keys per row, whatever they are called", async () => {
    const r = await call("/employee/directory", tokenFor());
    for (const row of r.body) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ["employee_id", "employee_name"],
        `unexpected keys: ${Object.keys(row).join(", ")}`
      );
    }
  });

  it("leaks no sensitive field, checked against the raw response text", async () => {
    const r = await call("/employee/directory", tokenFor());
    for (const field of [
      "salary", "payment_type", "bank_name", "ifsc", "account_no", "pan_no",
      "aadhaar_card_no", "aadhaar_card_name", "aadhaar_card_image", "uan",
      "pf", "pf_number", "esi", "esi_number",
      "primary_contact_number", "permanent_address", "dob", "designation_id",
    ]) {
      assert.ok(!new RegExp(`"${field}"`, "i").test(r.text), `${field} must not appear`);
    }
  });
});

describe("the outlet comes from the token, never from the caller", () => {
  it("a normal user's store_id parameter is ignored", async () => {
    const r = await call(`/employee/directory?store_id=${OTHER_STORE}`, tokenFor());
    assert.deepEqual(r.body.map((e) => e.employee_id), [12, 11], "still their own outlet");
    assert.ok(!r.text.includes("Other Branch"));
  });

  it("neither a non-numeric nor a negative one changes anything", async () => {
    for (const bad of ["abc", "-1", "0", "9 OR 1=1"]) {
      const r = await call(`/employee/directory?store_id=${encodeURIComponent(bad)}`, tokenFor());
      assert.deepEqual(r.body.map((e) => e.employee_id), [12, 11], `store_id=${bad}`);
    }
  });

  it("a user with no outlet gets an empty list, not everybody", async () => {
    const r = await call("/employee/directory", tokenFor({ storeId: null }));
    assert.deepEqual(r.body, []);
  });
});

describe("admin (user_type 2)", () => {
  it("may name a store, because the accounts screens work across branches", async () => {
    const r = await call(`/employee/directory?store_id=${OTHER_STORE}`, tokenFor({ userType: 2 }));
    assert.deepEqual(r.body.map((e) => e.employee_id), [14]);
  });

  it("gets their own outlet when they name none", async () => {
    const r = await call("/employee/directory", tokenFor({ userType: 2 }));
    assert.deepEqual(r.body.map((e) => e.employee_id), [12, 11]);
  });

  it("still gets only the two columns", async () => {
    const r = await call(`/employee/directory?store_id=${OTHER_STORE}`, tokenFor({ userType: 2 }));
    for (const row of r.body) {
      assert.deepEqual(Object.keys(row).sort(), ["employee_id", "employee_name"]);
    }
  });
});

describe("the repository query is narrow by construction", () => {
  it("names its two columns and filters on status and store", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "repository", "employee.js"), "utf8");
    const sql = source.match(/SELECT employee_id, employee_name FROM new_employee[^"]*/);
    assert.ok(sql, "the directory query must select the two columns by name");
    assert.ok(!/\*/.test(sql[0]), "no SELECT *");
    assert.match(sql[0], /WHERE status = 1 AND store_id = \?/);
  });
});
