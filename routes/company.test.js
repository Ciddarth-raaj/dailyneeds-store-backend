/**
 * Master → Company Details - the HTTP surface, through the REAL permissions
 * middleware (`middlewares/permissions.js`) with a fake designation lookup.
 *
 *   node --test routes/company.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");

const buildRoutes = require("./company");
const buildUsecase = require("../usecase/company");
const buildPermissions = require("../middlewares/permissions");
const P = require("../constants/hr_permissions");

const ADMIN = { user_type: 2, designation_id: 1 };
const HR = { user_type: 1, designation_id: 5 }; // granted manage_company_details
const EMPLOYEE = { user_type: 1, designation_id: 9 }; // payroll keys, not this one
const GRANTS = {
  5: ["view_employees", P.MANAGE_COMPANY_DETAILS],
  9: ["view_employees", "view_payroll", "view_salary", "process_payroll", "publish_payrun"],
};

const permissions = buildPermissions({
  getPermissionById: async (designationId) => (GRANTS[designationId] || []).map((permission_key) => ({ permission_key })),
});

function memoryRepo() {
  const rows = [];
  const calls = [];
  return {
    rows,
    calls,
    async list() { calls.push("list"); return rows; },
    async get(id) { calls.push("get"); return rows.filter((r) => r.company_id === id); },
    async create(values, { payslip_active }) {
      calls.push("create");
      const company_id = rows.length + 1;
      rows.push({ company_id, ...values, status: payslip_active ? 1 : 0 });
      if (payslip_active) rows.forEach((r) => { if (r.company_id !== company_id) r.status = 0; });
      return company_id;
    },
    async update(id, values, { payslip_active }) {
      calls.push("update");
      const row = rows.find((r) => r.company_id === id);
      if (!row) return false;
      Object.assign(row, values, { status: payslip_active ? 1 : 0 });
      if (payslip_active) rows.forEach((r) => { if (r.company_id !== id) r.status = 0; });
      return true;
    },
    async setPayslipCompany(id) {
      calls.push("setPayslipCompany");
      if (!rows.some((r) => r.company_id === id)) return false;
      rows.forEach((r) => { r.status = r.company_id === id ? 1 : 0; });
      return true;
    },
    async updateStatus(file) { calls.push("updateStatus"); rows.find((r) => r.company_id === file.company_id).status = file.status; },
  };
}

function appAs(decoded, repo) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (decoded) req.decoded = decoded;
    next();
  });
  app.use("/company", buildRoutes(buildUsecase(repo), permissions).getRouter());
  return app;
}

function request(app, { method = "GET", url, body = null }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === null ? null : JSON.stringify(body);
      const req = http.request(
        {
          port: server.address().port, path: url, method,
          headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {},
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            server.close();
            let parsed = text;
            try { parsed = JSON.parse(text); } catch (e) { /* not JSON */ }
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      req.on("error", (err) => { server.close(); reject(err); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const FORM = {
  company_name: "Daily Needs Departmental Store",
  reg_address: "188/1 Iyyanar Koil Street",
  contact_number: "0413 2223344",
  gst_number: "34AABCD1234E1Z5",
  pf_number: "TN/MAS/0012345",
  esi_number: "51000123450001001",
  payslip_active: true,
};

const EVERY_ROUTE = [
  { method: "GET", url: "/company" },
  { method: "GET", url: "/company/company_id?company_id=1" },
  { method: "POST", url: "/company", body: FORM },
  { method: "PUT", url: "/company/1", body: FORM },
  { method: "POST", url: "/company/1/payslip", body: {} },
  { method: "POST", url: "/company/update-status", body: { company_id: 1, status: 1 } },
];

test("every Company Details route is behind manage_company_details - in the source", () => {
  const src = fs.readFileSync(path.join(__dirname, "company.js"), "utf8");
  const routes = [...src.matchAll(/this\.router\.(get|post|put|delete)\(\s*"[^"]*",\s*(\w+)/g)];
  assert.equal(routes.length, 6);
  assert.ok(routes.every((m) => m[2] === "guard"), "every route passes the guard first");
  assert.match(src, /const guard = this\.permissions\.require\(P\.MANAGE_COMPANY_DETAILS\)/);
  // Company Details never reaches a published payslip.
  for (const f of ["routes/company.js", "usecase/company.js", "repository/company.js"]) {
    const code = fs.readFileSync(path.join(__dirname, "..", f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/payrun_payslip/.test(code), `${f} must not touch payrun_payslip`);
  }
});

test("an unauthorized user cannot read or edit Company Details, and the repository is never reached", async () => {
  for (const route of EVERY_ROUTE) {
    const repo = memoryRepo();
    const res = await request(appAs(EMPLOYEE, repo), route);
    assert.equal(res.status, 403, `${route.method} ${route.url}`);
    assert.deepEqual(repo.calls, [], `${route.method} ${route.url} reached the repository`);
    const anon = await request(appAs(null, repo), route);
    assert.equal(anon.status, 401);
  }
});

test("an administrator creates the company Active for Payslip and sees it as the payslip company", async () => {
  const repo = memoryRepo();
  const app = appAs(ADMIN, repo);
  const created = await request(app, { method: "POST", url: "/company", body: FORM });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.company_id, 1);
  const list = await request(app, { url: "/company" });
  assert.equal(list.status, 200);
  assert.equal(list.body.companies[0].company_name, FORM.company_name);
  assert.equal(list.body.companies[0].payslip_active, true);
  assert.deepEqual([list.body.payslip.configured, list.body.payslip.company.name], [true, FORM.company_name]);
});

test("a designation granted the key may edit; edits validate; a second active company replaces the first", async () => {
  const repo = memoryRepo();
  const app = appAs(HR, repo);
  await request(app, { method: "POST", url: "/company", body: FORM });
  const edited = await request(app, { method: "PUT", url: "/company/1", body: { ...FORM, reg_address: "New Address" } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(repo.rows[0].reg_address, "New Address");

  const bad = await request(app, { method: "PUT", url: "/company/1", body: { ...FORM, company_name: "" } });
  assert.equal(bad.status, 422);
  assert.deepEqual(bad.body.errors.map((e) => e.field), ["company_name"]);
  assert.equal(repo.rows[0].company_name, FORM.company_name, "nothing written");

  const missing = await request(app, { method: "PUT", url: "/company/99", body: FORM });
  assert.equal(missing.status, 404);

  await request(app, { method: "POST", url: "/company", body: { ...FORM, company_name: "Second Ltd" } });
  assert.deepEqual(repo.rows.map((r) => r.status), [0, 1], "only one active payslip company");
  const chosen = await request(app, { method: "POST", url: "/company/1/payslip", body: {} });
  assert.equal(chosen.status, 200);
  assert.deepEqual(repo.rows.map((r) => r.status), [1, 0]);
});

test("unknown body fields are refused", async () => {
  const repo = memoryRepo();
  const res = await request(appAs(ADMIN, repo), { method: "POST", url: "/company", body: { ...FORM, status: 1 } });
  assert.equal(res.status, 422);
  assert.deepEqual(repo.calls, []);
});

test("the Payroll status endpoint takes the month screen's read keys and is declared", () => {
  const src = fs.readFileSync(path.join(__dirname, "payrun_calculation.js"), "utf8");
  assert.match(
    src,
    /"\/payrun\/calculation\/payslip-company",\s*\n\s*this\.permissions\.requireAll\(P\.VIEW_EMPLOYEES, P\.VIEW_PAYROLL\)/
  );
});

/*
 * THE AUTH LAYER IN FRONT OF THE ROUTER. `middlewares/auth.js` skips the token
 * for anything in `unProtectedRoutes`; a /company entry there left
 * `req.decoded` unset, so the permission guard answered every save
 * (POST /company) with 401 "Unauthorized" - even for an administrator.
 */
test("no /company route is unprotected: the auth middleware always reads the token", async () => {
  const auth = require("../middlewares/auth");
  const open = Object.keys(auth.unProtectedRoutes).filter((k) => /^\/company(\/|$)/.test(k));
  assert.deepEqual(open, [], `still unprotected: ${open.join(", ")}`);

  const app = express();
  app.use(express.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => null } }));
  app.use("/company", buildRoutes(buildUsecase(memoryRepo()), permissions).getRouter());
  for (const route of EVERY_ROUTE) {
    const res = await request(app, route);
    // Refused by AUTHENTICATION (no token), not passed through to the guard.
    assert.equal(res.body.msg, "Access Denied", `${route.method} ${route.url}`);
  }
});
