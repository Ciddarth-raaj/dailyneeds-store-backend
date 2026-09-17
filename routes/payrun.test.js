/**
 * Payrun Initialization - the HTTP surface.
 *
 *   node --test routes/payrun.test.js
 *
 * TWO KINDS OF TEST, for the reason `routes/employee_bulk_update.test.js`
 * gives: several of the guarantees here are about what is ABSENT - no route
 * without a permission, no write of the employee master anywhere in the
 * feature, no way for a request body to carry a salary figure - and an absence
 * cannot be demonstrated by exercising one path. The rest drives the router
 * with fakes.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");

const buildRoutes = require("./payrun");
const P = require("../constants/hr_permissions");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTE_CODE = strip(read("routes/payrun.js"));
const USECASE_CODE = strip(read("usecase/payrun.js"));
const REPO_CODE = strip(read("repository/payrun.js"));
const RULES_CODE = strip(read("utils/payrun_eligibility.js"));

/* ================================================= the shape of the feature */

test("NO layer of the payrun writes the employee master", () => {
  for (const [name, code] of [
    ["repository", REPO_CODE],
    ["usecase", USECASE_CODE],
    ["route", ROUTE_CODE],
  ]) {
    assert.ok(
      !/\bUPDATE\s+new_employee\b/i.test(code),
      `${name} contains an UPDATE of new_employee - a payrun pay type is a fact about one month`
    );
    assert.ok(!/\bINSERT\s+INTO\s+new_employee\b/i.test(code), `${name} inserts into new_employee`);
  }
});

test("the payrun writes NOTHING it does not own", () => {
  for (const table of ["employee_salary", "attendance_monthly_payroll", "attendance_approval_request", "biomax_punch"]) {
    assert.ok(
      !new RegExp(`(UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+\`?${table}\``, "i").test(REPO_CODE),
      `the payrun writes ${table}, which belongs to another module`
    );
  }
  // The three it does own.
  assert.match(REPO_CODE, /INSERT IGNORE INTO payrun_employee/);
  assert.match(REPO_CODE, /UPDATE payrun_employee/);
  assert.match(REPO_CODE, /INSERT INTO payrun_employee_pay_type_audit/);
});

test("no attendance is calculated or recalculated anywhere in the payrun", () => {
  for (const [name, code] of [["repository", REPO_CODE], ["usecase", USECASE_CODE], ["rules", RULES_CODE], ["route", ROUTE_CODE]]) {
    assert.ok(
      !/calculateRange|calculateMonth|recalculate|computeMonthlyAttendancePayroll|attendance_engine/i.test(code),
      `${name} reaches into the attendance engine; payroll must CONSUME the calculated month`
    );
  }
  // What it does instead: it reads the stored month and its finality.
  assert.match(REPO_CODE, /FROM attendance_monthly_payroll/);
  assert.match(RULES_CODE, /is_final/);
});

test("every route carries a permission, and every one is requireAll (AND, not OR)", () => {
  const routes = ROUTE_CODE.split(/this\.router\.(?=get\(|post\()/).slice(1);
  assert.ok(routes.length >= 4, "expected the four payrun endpoints");
  routes.forEach((route) => {
    assert.ok(
      /this\.permissions\.requireAll\(/.test(route),
      `a payrun route has no requireAll permission check:\n${route.slice(0, 160)}`
    );
    assert.ok(!/permissions\.require\(/.test(route), "require(...) is OR and would weaken the check");
  });
});

test("the keys are the ones decided, and reading the month takes the salary key", () => {
  assert.match(
    ROUTE_CODE,
    /"\/payrun\/month",\s*\n\s*this\.permissions\.requireAll\(P\.VIEW_EMPLOYEES, P\.VIEW_PAYROLL, P\.VIEW_SALARY\)/,
    "the month shows an approved gross per employee, so it takes view_salary"
  );
  assert.match(
    ROUTE_CODE,
    /"\/payrun\/initialize",\s*\n\s*this\.permissions\.requireAll\(P\.VIEW_EMPLOYEES, P\.PROCESS_PAYROLL\)/
  );
  assert.match(
    ROUTE_CODE,
    /"\/payrun\/pay-type",\s*\n\s*this\.permissions\.requireAll\(P\.VIEW_EMPLOYEES, P\.CHANGE_PAYRUN_PAY_TYPE\)/
  );
  assert.equal(P.CHANGE_PAYRUN_PAY_TYPE, "change_payrun_pay_type");
});

test("exactly ONE new permission key is introduced by this feature", () => {
  const declared = fs.readFileSync(
    path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20261021120000-payrun-initialization-up.sql"),
    "utf8"
  );
  const keys = (declared.match(/SELECT '([a-z_]+)' AS `permission_key`/g) || []).map((m) =>
    m.replace(/.*'([a-z_]+)'.*/, "$1")
  );
  assert.deepEqual(keys, ["change_payrun_pay_type"]);
  // And it is declared, granted to nobody - there is no INSERT INTO permissions.
  assert.ok(!/INSERT\s+INTO\s+`permissions`/i.test(declared));
});

test("no request body can carry a salary, an attendance reference or a status", () => {
  const body = ROUTE_CODE.match(/Joi\.validate\(req\.body, \{[\s\S]*?\}\)/g) || [];
  assert.ok(body.length >= 2);
  body.forEach((schema) => {
    ["monthly_gross", "salary_id", "basic", "attendance_monthly_payroll_id", "status", "initialized_by"].forEach((field) => {
      assert.ok(!schema.includes(field), `a request body may not carry ${field}`);
    });
  });
});

test("the branch scope is applied to the writes, not only to the reads", () => {
  const writes = ROUTE_CODE.split(/this\.router\./).slice(1).filter((r) => r.startsWith("post("));
  assert.equal(writes.length, 2);
  writes.forEach((route) => assert.match(route, /await this\._scope\(req, res/));
});

/* ============================================== driving the actual router == */

const okPermissions = () => ({
  require: () => (req, res, next) => next(),
  requireAll: () => (req, res, next) => next(),
  actorFor: async () => ({ userId: 1, employeeId: 2 }),
});

/** A permission layer that refuses, exactly as the real one does (403 + msg). */
const denyPermissions = () => ({
  require: () => (req, res) =>
    res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" }),
  requireAll: () => (req, res) =>
    res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" }),
  actorFor: async () => ({ userId: 1, employeeId: 2 }),
});

const fakeSensitive = () => ({
  filterResponse: (req, res, next) => next(),
  guardWrite: (req, res, next) => next(),
});

const fakeScope = () => ({
  listFilters: async () => ({ ok: true, store_ids: null }),
  refuse: (res, outcome) => res.status(403).json({ code: 403, msg: outcome.reason }),
});

/** A usecase that records what it was asked, and shouts if it is reached at all. */
function spyUsecase() {
  const calls = [];
  return {
    calls,
    async getMonth(args) {
      calls.push(["getMonth", args]);
      return { rows: [], summary: {} };
    },
    async initialize(args) {
      calls.push(["initialize", args]);
      return { initialized_count: 1, results: [] };
    },
    async changePayType(args) {
      calls.push(["changePayType", args]);
      return { pay_type: args.pay_type };
    },
    async getPayTypeAudit(args) {
      calls.push(["getPayTypeAudit", args]);
      return [];
    },
  };
}

/** One request against a real Express app carrying the real router. */
function request(app, { method = "GET", url, body = null }) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === null ? null : JSON.stringify(body);
      const req = http.request(
        {
          port: server.address().port,
          path: url,
          method,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            server.close();
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch (err) {
              parsed = text;
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

function appWith(permissions, usecase) {
  const app = express();
  app.use(express.json());
  app.use("/", buildRoutes(usecase, permissions, fakeSensitive(), fakeScope()).getRouter());
  return app;
}

test("an unauthorized user cannot initialize, and the usecase is never reached", async () => {
  const usecase = spyUsecase();
  const res = await request(appWith(denyPermissions(), usecase), {
    method: "POST",
    url: "/payrun/initialize",
    body: { year: 2026, month: 8, employee_ids: [42] },
  });
  assert.equal(res.status, 403);
  assert.equal(usecase.calls.length, 0, "a refused request must not reach the usecase at all");
});

test("an unauthorized user cannot change a pay type", async () => {
  const usecase = spyUsecase();
  const res = await request(appWith(denyPermissions(), usecase), {
    method: "POST",
    url: "/payrun/pay-type",
    body: { year: 2026, month: 8, employee_id: 42, pay_type: "CASH" },
  });
  assert.equal(res.status, 403);
  assert.equal(usecase.calls.length, 0);
});

test("an unauthorized user cannot read the month", async () => {
  const usecase = spyUsecase();
  const res = await request(appWith(denyPermissions(), usecase), {
    url: "/payrun/month?year=2026&month=8",
  });
  assert.equal(res.status, 403);
  assert.equal(usecase.calls.length, 0);
});

test("HOLD is refused by the schema, before any rule is consulted", async () => {
  const usecase = spyUsecase();
  const res = await request(appWith(okPermissions(), usecase), {
    method: "POST",
    url: "/payrun/pay-type",
    body: { year: 2026, month: 8, employee_id: 42, pay_type: "HOLD" },
  });
  assert.ok(res.status >= 400);
  assert.equal(usecase.calls.length, 0);
});

test("a body that smuggles a gross is refused outright, not merely ignored", async () => {
  const usecase = spyUsecase();
  const res = await request(appWith(okPermissions(), usecase), {
    method: "POST",
    url: "/payrun/initialize",
    body: { year: 2026, month: 8, employee_ids: [42], monthly_gross: 999999 },
  });
  assert.ok(res.status >= 400, "Joi runs without allowUnknown, so an unknown key is a refusal");
  assert.equal(usecase.calls.length, 0);
});

test("an authorized initialize reaches the usecase with the SERVER's actor and scope", async () => {
  const usecase = spyUsecase();
  const res = await request(appWith(okPermissions(), usecase), {
    method: "POST",
    url: "/payrun/initialize",
    body: { year: 2026, month: 8, employee_ids: [42, 43] },
  });
  assert.equal(res.status, 200);
  const [name, args] = usecase.calls[0];
  assert.equal(name, "initialize");
  assert.deepEqual(args.employee_ids, [42, 43]);
  assert.equal(args.actor.employeeId, 2);
  assert.equal(args.store_ids, null);
});
