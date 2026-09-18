/**
 * Payrun Adjustments V1 - the HTTP surface, and the shape of the feature.
 *
 *   node --test routes/payrun_adjustment.test.js
 *
 * TWO KINDS OF TEST, for the reason `routes/payrun.test.js` gives: several of
 * the guarantees here are about what is ABSENT - no endpoint without a
 * permission, no write of a table this stage does not own, no path from an
 * import to a no-adjustment confirmation, no `confirmed_by` a browser could
 * send - and an absence cannot be demonstrated by exercising one path.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");

const buildRoutes = require("./payrun_adjustment");
const P = require("../constants/hr_permissions");

const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
/** Comments may NAME something to explain why it is absent; code may not. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const ROUTE_CODE = strip(read("routes/payrun_adjustment.js"));
const USECASE_CODE = strip(read("usecase/payrun_adjustment.js"));
const REPO_CODE = strip(read("repository/payrun_adjustment.js"));
const RULES_CODE = strip(read("utils/payrun_adjustments.js"));

/* ================================================= the shape of the feature */

test("NO layer of the adjustments stage writes a table it does not own", () => {
  for (const table of [
    "new_employee",
    "employee_salary",
    "attendance_monthly_payroll",
    "attendance_approval_request",
    "payrun_employee",
    "payrun_period",
    "payrun_employee_pay_type_audit",
  ]) {
    assert.ok(
      !new RegExp(`(UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+\`?${table}\`?(?![_a-z])`, "i").test(REPO_CODE),
      `the adjustments repository writes ${table}, which belongs to another stage`
    );
  }
  // The three it does own.
  assert.match(REPO_CODE, /INSERT INTO payrun_employee_adjustment\b/);
  assert.match(REPO_CODE, /INSERT INTO payrun_employee_adjustment_state\b/);
  assert.match(REPO_CODE, /INSERT INTO payrun_employee_adjustment_audit\b/);
});

test("the adjustments stage cannot initialize anybody", () => {
  for (const [name, code] of [["repository", REPO_CODE], ["usecase", USECASE_CODE], ["route", ROUTE_CODE]]) {
    assert.ok(
      !/insertSnapshots|INSERT\s+IGNORE\s+INTO\s+payrun_employee\b/i.test(code),
      `${name} can create a payrun snapshot - an adjustment must never initialize somebody`
    );
  }
});

test("no attendance is calculated anywhere in the adjustments stage", () => {
  for (const [name, code] of [
    ["repository", REPO_CODE],
    ["usecase", USECASE_CODE],
    ["route", ROUTE_CODE],
    ["rules", RULES_CODE],
  ]) {
    for (const forbidden of ["calculateMonth", "biomax_punch", "attendance_engine", "shiftResolution"]) {
      assert.ok(!new RegExp(forbidden, "i").test(code), `${name} reaches ${forbidden}`);
    }
  }
});

test("the calculation contract is declared in ONE place and the layers defer to it", () => {
  // The kinds are read from the catalogue; no layer decides for itself what is
  // an addition. A second answer to that question is the whole hazard here.
  assert.match(RULES_CODE, /COMPONENT_KIND\.ADDITION/);
  assert.match(RULES_CODE, /COMPONENT_KIND\.DEDUCTION/);
  assert.ok(
    !/INCENTIVE\s*\+\s*BONUS|incentive \+ bonus/i.test(USECASE_CODE),
    "the usecase adds components up by name instead of calling the contract"
  );
});

test("THE IMPORT CANNOT CONFIRM ANYBODY AS HAVING NO ADJUSTMENT", () => {
  /*
   * The single most important absence in this feature. `confirmNoAdjustment`
   * is reachable from exactly one route handler, and the import's usecase
   * methods never call it - so a file of blanks cannot sign anybody off.
   */
  const importSection = USECASE_CODE.slice(
    USECASE_CODE.indexOf("async preview"),
    USECASE_CODE.indexOf("async saveEmployee")
  );
  assert.ok(importSection.length > 0, "the import section was not found - update this test");
  assert.ok(
    !/confirmNoAdjustment/.test(importSection),
    "preview/confirm reach confirmNoAdjustment - an import must never confirm anybody"
  );
  assert.ok(
    !/confirmed_no_adjustment\s*[:=]\s*(1|true)/.test(importSection),
    "the import sets a confirmation flag directly"
  );
});

test("nothing accepts an identity or a timestamp from the browser", () => {
  for (const claim of ["confirmed_by", "confirmed_at", "changed_by", "adjustment_state"]) {
    assert.ok(
      !new RegExp(`${claim}:\\s*Joi\\.`).test(ROUTE_CODE),
      `the route schema accepts ${claim} from a request body`
    );
  }
  // The actor is the server's, taken from the permission layer.
  assert.match(ROUTE_CODE, /this\.permissions\.actorFor\(req\)/);
});

test("every route declares a permission, and the writes take process_payroll", () => {
  /*
   * Every registration, and the 200 characters after it - which is where the
   * permission middleware has to be, since it is the argument right after the
   * path. A route that reached its handler without one would match here with
   * no `requireAll` in that window.
   */
  const registrations = [...ROUTE_CODE.matchAll(/this\.router\.(get|post)\(\s*"(\/payrun\/adjustments[^"]*)"/g)];
  assert.ok(registrations.length >= 7, `expected the whole surface, found ${registrations.length}`);
  for (const match of registrations) {
    const window = ROUTE_CODE.slice(match.index, match.index + 240);
    assert.ok(
      /this\.permissions\.requireAll\(/.test(window),
      `${match[2]} is mounted without requireAll`
    );
  }
  // WRITE is the pair, READ is the triple - declared once, at the top.
  assert.match(ROUTE_CODE, /const READ = \[P\.VIEW_EMPLOYEES, P\.VIEW_PAYROLL, P\.VIEW_SALARY\]/);
  assert.match(ROUTE_CODE, /const WRITE = \[P\.VIEW_EMPLOYEES, P\.PROCESS_PAYROLL\]/);
});

test("NO new permission key is invented", () => {
  const used = [...ROUTE_CODE.matchAll(/P\.([A-Z_]+)/g)].map((m) => m[1]);
  const allowed = ["VIEW_EMPLOYEES", "VIEW_PAYROLL", "VIEW_SALARY", "PROCESS_PAYROLL"];
  for (const key of new Set(used)) {
    assert.ok(allowed.includes(key), `the stage uses ${key}, which is not one of the four it reuses`);
    assert.ok(P[key], `${key} is not a declared permission`);
  }
  const migration = read(
    "migrations/mysql/migrations/sqls/20261022120000-payrun-adjustments-up.sql"
  ).replace(/^\s*--.*$/gm, "");
  assert.ok(
    !/INSERT\s+INTO\s+`?all_permissions`?/i.test(migration),
    "the migration declares a permission key; this stage reuses process_payroll"
  );
});

test("the branch scope is resolved on every endpoint, reads and writes alike", () => {
  const scopeCalls = (ROUTE_CODE.match(/this\._scope\(req, res/g) || []).length;
  assert.ok(scopeCalls >= 7, `only ${scopeCalls} endpoints resolve a branch scope`);
});

test("the sensitive filter and write guard are mounted", () => {
  assert.match(ROUTE_CODE, /this\.sensitive\.filterResponse/);
  assert.match(ROUTE_CODE, /this\.sensitive\.guardWrite/);
});

test("the locked month is enforced on every write path", () => {
  const writes = ["async confirm(", "async saveEmployee(", "async confirmNoAdjustment("];
  writes.forEach((entry) => {
    const start = USECASE_CODE.indexOf(entry);
    assert.ok(start > 0, `${entry} was not found - update this test`);
    const body = USECASE_CODE.slice(start, start + 2500);
    /*
     * Either the method reads the period itself, or it refuses on the
     * `month_locked` its own validation pass resolved - `confirm` does the
     * latter, because it has already read the month to validate the file and
     * reading it twice would be two answers.
     */
    assert.ok(
      /PERIOD_STATUS\.LOCKED/.test(body) || /month_locked/.test(body),
      `${entry} does not refuse a locked month`
    );
    assert.ok(/is locked/.test(body), `${entry} does not say the month is locked`);
  });
});

/* ========================================================== driving it */

/** A permission layer that grants a fixed set and records what was demanded. */
function fakePermissions(granted) {
  return {
    demanded: [],
    requireAll(...keys) {
      this.demanded.push(keys);
      return (req, res, next) => {
        if (keys.every((k) => granted.includes(k))) return next();
        res.json({ code: 403, msg: "Permission denied" });
      };
    },
    async actorFor() {
      return { employeeId: 77 };
    },
  };
}

const passthroughSensitive = {
  filterResponse: (req, res, next) => next(),
  guardWrite: (req, res, next) => next(),
};

const openScope = {
  async listFilters() {
    return { ok: true, store_ids: null };
  },
  refuse(res) {
    res.json({ code: 403, msg: "Out of scope" });
  },
};

function serve(usecase, permissions, scope = openScope) {
  const app = express();
  app.use(express.json());
  app.use("/", buildRoutes(usecase, permissions, passthroughSensitive, scope).getRouter());
  return http.createServer(app);
}

function request(server, method, url, body) {
  return new Promise((resolve, reject) => {
    server.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          port,
          method,
          path: url,
          headers: payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data || "{}") });
            } catch (err) {
              resolve({ status: res.statusCode, body: data });
            }
          });
        }
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const ALL_KEYS = [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY, P.PROCESS_PAYROLL];

test("a caller without process_payroll may READ the month but not write it", async () => {
  const usecase = {
    describe: () => ({ code: 200 }),
    getMonth: async () => ({ summary: {}, rows: [] }),
    confirmNoAdjustment: async () => {
      throw new Error("a read-only caller reached a write");
    },
  };

  const readOnly = [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY];
  const ok = await request(
    serve(usecase, fakePermissions(readOnly)),
    "GET",
    "/payrun/adjustments/month?year=2026&month=8"
  );
  assert.equal(ok.body.code, 200);

  const denied = await request(
    serve(usecase, fakePermissions(readOnly)),
    "POST",
    "/payrun/adjustments/no-adjustment",
    { year: 2026, month: 8, employee_ids: [1] }
  );
  assert.equal(denied.body.code, 403);
});

test("a caller without view_salary cannot read the month at all", async () => {
  const usecase = { getMonth: async () => ({ summary: {}, rows: [] }) };
  const res = await request(
    serve(usecase, fakePermissions([P.VIEW_EMPLOYEES, P.VIEW_PAYROLL])),
    "GET",
    "/payrun/adjustments/month?year=2026&month=8"
  );
  assert.equal(res.body.code, 403);
});

test("a body that names an unknown component is refused before the usecase", async () => {
  const usecase = {
    saveEmployee: async () => {
      throw new Error("the usecase was reached with an unknown component");
    },
  };
  const res = await request(serve(usecase, fakePermissions(ALL_KEYS)), "POST", "/payrun/adjustments/employee", {
    year: 2026,
    month: 8,
    employee_id: 5,
    amounts: { LOAN_RECOVERY: 500 },
  });
  assert.ok(res.body.code >= 400, `expected a refusal, got ${JSON.stringify(res.body)}`);
});

test("a body that tries to name its own confirmer is refused", async () => {
  const usecase = {
    confirmNoAdjustment: async () => {
      throw new Error("a browser-supplied confirmer reached the usecase");
    },
  };
  const res = await request(
    serve(usecase, fakePermissions(ALL_KEYS)),
    "POST",
    "/payrun/adjustments/no-adjustment",
    { year: 2026, month: 8, employee_ids: [1], confirmed_by: 1 }
  );
  assert.ok(res.body.code >= 400);
});

test("an impossible month is refused", async () => {
  const usecase = {
    getMonth: async () => {
      throw new Error("month 13 reached the usecase");
    },
  };
  const res = await request(
    serve(usecase, fakePermissions(ALL_KEYS)),
    "GET",
    "/payrun/adjustments/month?year=2026&month=13"
  );
  assert.ok(res.body.code >= 400);
});

test("an out-of-scope caller is refused and the usecase is never reached", async () => {
  const usecase = {
    getMonth: async () => {
      throw new Error("an out-of-scope caller reached the usecase");
    },
  };
  const closedScope = {
    async listFilters() {
      return { ok: false };
    },
    refuse(res) {
      res.json({ code: 403, msg: "Out of scope" });
    },
  };
  const res = await request(
    serve(usecase, fakePermissions(ALL_KEYS), closedScope),
    "GET",
    "/payrun/adjustments/month?year=2026&month=8"
  );
  assert.equal(res.body.code, 403);
});

test("the actor the usecase receives is the SERVER's, not the body's", async () => {
  let seen = null;
  const usecase = {
    confirmNoAdjustment: async (args) => {
      seen = args;
      return { confirmed_count: 1 };
    },
  };
  await request(serve(usecase, fakePermissions(ALL_KEYS)), "POST", "/payrun/adjustments/no-adjustment", {
    year: 2026,
    month: 8,
    employee_ids: [3],
  });
  assert.deepEqual(seen.actor, { employeeId: 77 });
  assert.deepEqual(seen.employee_ids, [3]);
});
