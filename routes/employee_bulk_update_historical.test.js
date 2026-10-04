/**
 * Bulk update CONFIRM re-checks the historical joining-date key on EVERY
 * request - it trusts neither the earlier preview, nor the browser, nor the
 * request body.
 *
 *   node --test routes/employee_bulk_update_historical.test.js
 *
 * Real Express, the real auth and permissions middleware, the real branch
 * scope, the real bulk router and the REAL bulk usecase. Only the database
 * (repository) and the C2 employee master underneath are fakes, and the fake
 * master records every joining-date write it is asked to make.
 *
 * The scenario that matters: an HR user previews a file with a historical
 * joining-date correction while holding
 * `employee_joining_date_historical_correction`, the key is revoked on the
 * Designation screen, and the same user then confirms the same file - with the
 * preview echoed back, with a reason, and even with a capability flag in the
 * body. Nothing may be written.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-bulk-historical-"));
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
const bulkUsecaseFactory = require("../usecase/employee_bulk_update");

const USER_ID = 31;
const EMPLOYEE_ID = 601;
const HR_DESIGNATION = 40;
const TODAY = "2026-10-04";
const REASON = "Corrected from the 2024 joining register";

/** Mutable on purpose: the test revokes the key between preview and confirm. */
const GRANTS = {
  [HR_DESIGNATION]: [
    P.VIEW_EMPLOYEES,
    P.EMPLOYEE_EDIT,
    P.EMPLOYEE_SCOPE_ALL_BRANCHES,
    P.EMPLOYEE_JOINING_DATE_HISTORICAL_CORRECTION,
  ],
};

const MASTERS = {
  outlet: [{ id: 1, name: "ECR", active: 1 }],
  department: [{ id: 10, name: "Operations", active: 1 }],
  designation: [{ id: 20, name: "Cashier", active: 1 }],
};
const EMPLOYEES = [
  {
    employee_id: 1865, employee_name: "Kumar", store_id: 1, department_id: 10,
    designation_id: 20, employment_type: "Permanent", grade: "B", status: 1,
    date_of_joining: "2024-06-01",
  },
  { employee_id: EMPLOYEE_ID, employee_name: "HR User", store_id: 1, status: 1 },
];

const bulkRepo = {
  getMasters: async () => JSON.parse(JSON.stringify(MASTERS)),
  getEmployeesForExport: async () => EMPLOYEES.map((e) => ({ ...e })),
  getCurrentValues: async (ids) => EMPLOYEES.filter((e) => ids.includes(e.employee_id)).map((e) => ({ ...e })),
  recordBulkUpdate: async () => 1,
};

/** C2, faked: records every write. The window itself is tested in C2's own suite. */
const joiningWrites = [];
const master = {
  today: () => TODAY,
  editEmployee: async (id, patch) => ({ code: 200, employee_id: id, fields_changed: Object.keys(patch) }),
  correctJoiningDate: async (id, input, opts) => {
    joiningWrites.push({ id, input, opts });
    return { code: 200, employee_id: id };
  },
};

let server;
let port;
let permissions;

before(async () => {
  permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });
  const app = express();
  app.use(bodyParser.json());
  app.use(
    require("../middlewares/auth").create({
      userUsecase: {
        getSessionState: async () => ({
          user_id: USER_ID, employee_id: EMPLOYEE_ID, status: 1, token_valid_from: null,
          must_change_password: 0, is_system_account: 0, employee_status: 1,
        }),
      },
    })
  );
  const routes = require("./employee_bulk_update")(
    bulkUsecaseFactory(bulkRepo, master),
    permissions,
    buildSensitive(permissions),
    require("../test_support/employee_branch_scope").allBranchesScope(permissions)
  );
  app.use("/hr", routes.getRouter());
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const token = () =>
  jwtService.sign(
    {
      auth_ver: 2, sub: String(USER_ID), id: USER_ID, employee_id: EMPLOYEE_ID,
      user_type: 1, designation_id: HR_DESIGNATION, store_id: 1,
    },
    "1d"
  );

const post = async (p, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/hr${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-access-token": await token() },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
};

const HEADERS = ["Employee ID", "Employee Name", "Date of Joining"];
// Stored 2024-06-01; 2024-05-01 is far older than today - 30.
const FILE = {
  headers: HEADERS,
  rows: [{ "Employee ID": "1865", "Employee Name": "", "Date of Joining": "01/05/2024" }],
  filename: "bulk.xlsx",
};
const echo = (preview) =>
  preview.rows.map((r) => ({ row_number: r.row_number, expected_before: r.expected_before }));

const revoke = () => {
  GRANTS[HR_DESIGNATION] = GRANTS[HR_DESIGNATION].filter(
    (k) => k !== P.EMPLOYEE_JOINING_DATE_HISTORICAL_CORRECTION
  );
  // What the Designation screen's save does (routes/designation.js).
  permissions.invalidate(HR_DESIGNATION);
};

describe("bulk confirm re-checks the historical-correction key itself", () => {
  let preview;

  it("with the key, the preview offers the historical correction", async () => {
    const r = await post("/employees/bulk/preview", FILE);
    assert.equal(r.status, 200);
    preview = r.body;
    assert.equal(preview.rows[0].valid, true);
    assert.equal(preview.rows[0].changes[0].historical_correction, true);
    assert.equal(preview.requires_correction_reason, true);
  });

  it("after the key is revoked, confirming that same preview - with a reason - writes nothing", async () => {
    revoke();
    const r = await post("/employees/bulk/confirm", {
      ...FILE,
      expected_before: echo(preview),
      joining_date_correction_reason: REASON,
    });
    assert.equal(r.body.applied, false);
    assert.equal(r.body.code, 409, "revalidation now finds the row an error");
    assert.equal(r.body.rows[0].errors[0], "Joining date cannot be more than 30 days before today.");
    assert.equal(joiningWrites.length, 0, "no joining date reached C2");
  });

  it("a capability flag in the request body is refused outright, before the usecase", async () => {
    for (const flag of [
      { mayCorrectHistorically: true },
      { capabilities: { mayCorrectHistorically: true } },
      { historical_correction: true },
    ]) {
      const r = await post("/employees/bulk/confirm", {
        ...FILE,
        expected_before: echo(preview),
        joining_date_correction_reason: REASON,
        ...flag,
      });
      assert.equal(r.body.code, 422, JSON.stringify(flag));
      assert.equal(r.body.applied, undefined);
    }
    assert.equal(joiningWrites.length, 0);
  });

  it("and with the key granted again, the same confirm is applied - so it was the key that decided", async () => {
    GRANTS[HR_DESIGNATION].push(P.EMPLOYEE_JOINING_DATE_HISTORICAL_CORRECTION);
    permissions.invalidate(HR_DESIGNATION);
    const r = await post("/employees/bulk/confirm", {
      ...FILE,
      expected_before: echo(preview),
      joining_date_correction_reason: REASON,
    });
    assert.equal(r.body.applied, true);
    assert.equal(joiningWrites.length, 1);
    assert.equal(joiningWrites[0].opts.mayCorrectHistorically, true);
    assert.equal(joiningWrites[0].input.correction_reason, REASON);
  });
});
