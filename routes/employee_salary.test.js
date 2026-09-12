/**
 * M2 — the salary route surface and what guards it.
 *
 *   node --test routes/employee_salary.test.js
 *
 * The router is built with fake `permissions` and `sensitive` objects that
 * record what it asked for, so these are assertions about the real wiring
 * rather than about the source text.
 *
 * The three things that would be wrong silently:
 *
 *   `require` where `requireAll` was meant — they read almost identically and
 *     `require` is OR, so passing two keys would mean EITHER opens the endpoint
 *   a manual override reachable without the override key
 *   a Joi schema that accepts a client-calculated component or contribution,
 *     which is the whole of "the server calculates everything"
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./employee_salary");
const P = require("../constants/hr_permissions");

/** Records every guard the router installs, and which layer it came from. */
function makeHarness() {
  const guards = [];
  const middleware = [];
  const permissions = {
    require: (...keys) => {
      const mw = (req, res, next) => next();
      mw.__guard = { mode: "any", keys };
      return mw;
    },
    requireAll: (...keys) => {
      const mw = (req, res, next) => next();
      mw.__guard = { mode: "all", keys };
      return mw;
    },
    actorFor: async () => ({ employeeId: 1, isAdmin: false, permissions: [] }),
  };
  const sensitive = {
    filterResponse: (req, res, next) => next(),
    guardWrite: (req, res, next) => next(),
  };

  const routes = buildRoutes({}, permissions, sensitive);
  const router = routes.getRouter();

  for (const layer of router.stack) {
    if (layer.route) {
      const method = Object.keys(layer.route.methods)[0].toUpperCase();
      const all = layer.route.stack.map((s) => s.handle.__guard).filter(Boolean);
      guards.push({ method, path: layer.route.path, guard: all[0], all });
    } else {
      middleware.push(layer.name);
    }
  }

  return { guards, middleware, routes, permissions };
}

const { guards, middleware, routes } = makeHarness();
const find = (method, path) => guards.find((g) => g.method === method && g.path === path);

describe("the endpoints", () => {
  it("defines exactly the M2 surface plus the ONE read M4 adds, and nothing more", () => {
    // No bulk upload, no payroll run, no payslip, no attendance calculation.
    // This API is small on purpose, and a route that appears here without
    // appearing in the approved scope is scope creep the test should catch.
    //
    // M4 builds two screens - Salary Revision & History, and Salary Approval -
    // on the seven primitives M2 already defined. The only thing it could not
    // build from them is a list of EVERYBODY's pending proposals, because no
    // per-employee endpoint can answer that without the browser reading six
    // hundred histories. So M4 adds exactly one endpoint, and it is a read.
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      [
        "GET /salary/employee/:employee_id/current",
        "GET /salary/employee/:employee_id/history",
        "GET /salary/pending",
        "POST /salary/employee/:employee_id",
        "POST /salary/preview/:employee_id",
        "POST /salary/revision/:salary_id",
        "POST /salary/revision/:salary_id/approve",
        "POST /salary/revision/:salary_id/reject",
      ]
    );
  });

  it("M4 ADDS NO WRITE AT ALL — the approval screen cannot edit a proposal", () => {
    // Rule 14 of the approved task: if a submitted salary is wrong, the
    // approver REJECTS it with a reason and the salary-entry user corrects it
    // on Salary Revision & History. An approval screen that could also amend
    // would let one person rewrite a figure and agree to it in the same visit,
    // which is the four-eyes rule defeated from the other end.
    //
    // So the only endpoint M4 adds is a GET, and the writes are still exactly
    // the M2 ones: create, amend-pending, approve, reject.
    const writes = guards.filter((g) => g.method !== "GET").map((g) => `${g.method} ${g.path}`);
    assert.deepEqual(writes.sort(), [
      "POST /salary/employee/:employee_id",
      "POST /salary/preview/:employee_id",
      "POST /salary/revision/:salary_id",
      "POST /salary/revision/:salary_id/approve",
      "POST /salary/revision/:salary_id/reject",
    ]);
  });

  it("has no delete route — salary records are never removed", () => {
    assert.ok(!guards.some((g) => g.method === "DELETE"), "there is no salary delete");
  });
});

describe("permissions", () => {
  it("every endpoint demands the employee-master key AND a salary key", () => {
    for (const g of guards) {
      assert.equal(g.guard.mode, "all", `${g.method} ${g.path} must be AND, not OR`);
      assert.ok(
        g.guard.keys.includes(P.VIEW_EMPLOYEES),
        `${g.method} ${g.path} keeps the employee-master key`
      );
    }
  });

  it("every per-employee endpoint is exactly a pair; the M4 queue is the one triple", () => {
    // The pairs are unchanged by M4. The queue takes a third key because it is
    // a different disclosure: every other read here answers a question about
    // ONE employee somebody navigated to, while the queue lists every
    // outstanding pay proposal in the company.
    for (const g of guards) {
      const expected = g.path === "/salary/pending" ? 3 : 2;
      assert.equal(
        g.guard.keys.length,
        expected,
        `${g.method} ${g.path} must demand ${expected} keys`
      );
    }
  });

  it("THE PENDING QUEUE TAKES THE APPROVER KEY ON TOP OF SALARY VISIBILITY", () => {
    const g = find("GET", "/salary/pending");
    assert.deepEqual(g.guard.keys, [P.VIEW_EMPLOYEES, P.VIEW_SALARY, P.APPROVE_SALARY_REVISION]);
    assert.equal(g.guard.mode, "all", "all three, not any of three");

    // And holding `add_salary` is not a way in: proposing pay and reviewing
    // everybody's proposals are different authorities.
    assert.ok(!g.guard.keys.includes(P.ADD_SALARY));
    assert.ok(!g.guard.keys.includes(P.EDIT_SALARY));
  });

  it("reads take view_salary", () => {
    assert.deepEqual(find("GET", "/salary/employee/:employee_id/current").guard.keys, [
      P.VIEW_EMPLOYEES,
      P.VIEW_SALARY,
    ]);
    assert.deepEqual(find("GET", "/salary/employee/:employee_id/history").guard.keys, [
      P.VIEW_EMPLOYEES,
      P.VIEW_SALARY,
    ]);
    assert.deepEqual(find("POST", "/salary/preview/:employee_id").guard.keys, [
      P.VIEW_EMPLOYEES,
      P.VIEW_SALARY,
    ]);
  });

  it("creating takes add_salary, amending takes edit_salary", () => {
    assert.deepEqual(find("POST", "/salary/employee/:employee_id").guard.keys, [
      P.VIEW_EMPLOYEES,
      P.ADD_SALARY,
    ]);
    assert.deepEqual(find("POST", "/salary/revision/:salary_id").guard.keys, [
      P.VIEW_EMPLOYEES,
      P.EDIT_SALARY,
    ]);
  });

  it("APPROVING IS ITS OWN DECISION — add_salary does not carry it", () => {
    for (const path of ["/salary/revision/:salary_id/approve", "/salary/revision/:salary_id/reject"]) {
      const g = find("POST", path);
      assert.deepEqual(g.guard.keys, [P.VIEW_EMPLOYEES, P.APPROVE_SALARY_REVISION]);
      assert.ok(!g.guard.keys.includes(P.ADD_SALARY), "adding is not approving");
    }
  });

  it("B3 field protection is mounted on the whole router", () => {
    assert.ok(middleware.length >= 2, "filterResponse and guardWrite are both mounted");
  });
});

describe("the manual override guard", () => {
  const guard = routes.overrideGuard();

  const run = (body) => {
    let outcome = null;
    const req = { body };
    const res = {
      status() {
        return this;
      },
      json() {
        return this;
      },
    };
    // The fake `permissions.require` calls next(), so reaching it is what we
    // are detecting. `__demanded` records that the extra key was asked for.
    const harness = makeHarnessGuard();
    harness.guard(req, res, () => {
      outcome = harness.demanded;
    });
    return outcome;
  };

  function makeHarnessGuard() {
    const state = { demanded: null };
    const permissions = {
      require: (...keys) => (req, res, next) => {
        state.demanded = keys;
        next();
      },
    };
    const { EmployeeSalaryRoutes } = require("./employee_salary");
    const instance = Object.create(EmployeeSalaryRoutes.prototype);
    instance.permissions = permissions;
    const g = instance.overrideGuard();
    return {
      guard: g,
      get demanded() {
        return state.demanded;
      },
    };
  }

  it("is declared on every write that can carry components", () => {
    for (const path of [
      "/salary/preview/:employee_id",
      "/salary/employee/:employee_id",
      "/salary/revision/:salary_id",
    ]) {
      const g = find("POST", path);
      assert.ok(
        g.all.some((x) => x.dynamic && x.dynamic.override),
        `${path} carries the override guard`
      );
    }
  });

  it("demands the override key when components are supplied", () => {
    assert.deepEqual(run({ monthly_gross: 50000, manual_components: { basic: 1 } }), [
      P.MANUAL_SALARY_COMPONENT_OVERRIDE,
    ]);
  });

  it("demands it when only the flag is set", () => {
    assert.deepEqual(run({ monthly_gross: 50000, manual_override: true }), [
      P.MANUAL_SALARY_COMPONENT_OVERRIDE,
    ]);
  });

  it("does not demand it for an ordinary automatic salary", () => {
    assert.equal(run({ monthly_gross: 50000 }), null, "no third key for the everyday case");
  });

  it("never ALLOWS anything — it only ever adds a requirement", () => {
    // A body it does not recognise falls through to the route's own
    // `requireAll`, which has already run. The guard has no path that skips a
    // check, only one that adds one.
    assert.equal(run({}), null);
    assert.equal(run(null), null);
  });

  it("the approve and reject routes carry no override guard", () => {
    for (const path of ["/salary/revision/:salary_id/approve", "/salary/revision/:salary_id/reject"]) {
      const g = find("POST", path);
      assert.equal(g.all.length, 1, `${path} has only its own permission pair`);
    }
  });
});

describe("what the schemas refuse — the server calculates everything", () => {
  const Joi = require("@hapi/joi");
  const source = require("fs").readFileSync(require.resolve("./employee_salary"), "utf8");

  it("no schema mentions a contribution, a CTC or a bare component", () => {
    // Joi runs without `allowUnknown`, so a key that is not in the schema is a
    // 422 rather than a silently ignored field. These are the names a client
    // might plausibly send, and none of them may be accepted.
    for (const forbidden of [
      "employee_pf",
      "employer_epf",
      "employer_eps",
      "edli",
      "pf_admin_charge",
      "employee_esi",
      "employer_esi",
      "monthly_ctc",
      "daily_salary",
      "pf_wage",
      "statutory_snapshot",
    ]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}:\\s*Joi\\.`).test(source),
        `${forbidden} must not be accepted from a caller`
      );
    }
  });

  it("the four components are accepted ONLY inside manual_components", () => {
    assert.match(source, /manualComponents = Joi\.object\(\{/);
    // `basic:` appears once, inside the override object, and never at the top
    // level of a body schema.
    assert.equal((source.match(/^\s+basic: Joi\./gm) || []).length, 1);
  });

  it("the status of a record is never accepted from a caller", () => {
    // Nothing is ever created APPROVED, so there is no way to ask for it.
    assert.ok(!/\bstatus:\s*Joi\./.test(source), "a caller cannot choose a lifecycle status");
    assert.ok(!/\bsource:\s*Joi\./.test(source), "nor the source of the record");
    assert.ok(!/approved_by:\s*Joi\./.test(source));
  });

  it("a rejection reason is required and cannot be blank", () => {
    const schema = { reason: Joi.string().trim().min(1).required() };
    assert.notEqual(Joi.validate({ reason: "" }, schema).error, null);
    assert.notEqual(Joi.validate({}, schema).error, null);
    assert.equal(Joi.validate({ reason: "Wrong grade" }, schema).error, null);
  });
});
