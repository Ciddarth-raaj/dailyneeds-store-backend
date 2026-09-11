/**
 * Employee Shift Assignment — the route surface and what guards it.
 *
 *   node --test routes/employee_work_shift.test.js
 *
 * The router is built with fake `permissions` and `sensitive` objects that
 * record what it asked for, so these are assertions about the real wiring
 * rather than about the source text: which keys guard which endpoint, whether
 * the check is AND or OR, and that B3's field protection is mounted.
 *
 * `requireAll` versus `require` is the assertion that matters most. They read
 * almost identically at a glance and `require` is OR — passing two keys to it
 * would mean EITHER key opens the endpoint, which is weaker than either key
 * alone was meant to be.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./employee_work_shift");
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
      const guard = layer.route.stack.map((s) => s.handle.__guard).find(Boolean);
      guards.push({ method, path: layer.route.path, guard });
    } else {
      middleware.push(layer.name);
    }
  }

  return { guards, middleware, sensitive };
}

const { guards, middleware } = makeHarness();
const find = (method, path) =>
  guards.find((g) => g.method === method && g.path === path);

describe("the endpoints", () => {
  it("defines exactly the three reads and the bulk write", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      [
        "GET /work-shift-assignments",
        "GET /work-shift-assignments/employee/:employee_id",
        "GET /work-shift-assignments/options",
        "POST /work-shift-assignments/bulk",
      ]
    );
  });

  it("M1: the options read is declared BEFORE the :employee_id read, so 'options' is never an id", () => {
    const order = guards.map((g) => `${g.method} ${g.path}`);
    assert.ok(
      order.indexOf("GET /work-shift-assignments/options") <
        order.indexOf("GET /work-shift-assignments/employee/:employee_id")
    );
  });
});

describe("M1: the shift options dropdown", () => {
  it("is open to employee_create (a store manager's initial shift) OR a shift key", () => {
    const { guard } = find("GET", "/work-shift-assignments/options");
    assert.equal(guard.mode, "any");
    assert.deepEqual(guard.keys, [
      P.EMPLOYEE_CREATE,
      P.ASSIGN_EMPLOYEE_SHIFT,
      P.VIEW_SHIFT_ASSIGNMENTS,
      P.VIEW_WORK_SHIFTS,
    ]);
  });

  it("returns identity and timing only, one row per ACTIVE shift, never configuration", async () => {
    const { EmployeeWorkShiftUsecase } = require("../usecase/employee_work_shift");
    const usecase = new EmployeeWorkShiftUsecase({
      listActiveWorkShiftOptions: async () => [
        { work_shift_id: 2, shift_code: "GS1", shift_name: "General", in_time: "09:00:00", out_time: "18:00:00" },
        { work_shift_id: 2, shift_code: "GS1", shift_name: "General", in_time: "09:00:00", out_time: "18:00:00" },
        { work_shift_id: 5, shift_code: "N1", shift_name: "Night", in_time: null, out_time: null },
      ],
    });
    const res = await usecase.activeOptions();
    assert.equal(res.code, 200);
    assert.deepEqual(
      res.data.map((r) => Object.keys(r).sort()),
      [["shift_code", "shift_name", "timing", "work_shift_id"], ["shift_code", "shift_name", "timing", "work_shift_id"]]
    );
    assert.equal(res.data[0].work_shift_id, 2);
    assert.match(String(res.data[0].timing), /9:00/);
    assert.equal(res.data[1].timing, null);
  });

  it("the repository selects only active shifts and no configuration column", () => {
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../repository/employee_work_shift"), "utf8");
    const fn = src.slice(src.indexOf("async listActiveWorkShiftOptions"), src.indexOf("async getActiveWorkShift"));
    assert.match(fn, /WHERE ws\.active = 1/);
    for (const forbidden of ["grace", "overtime", "ot_", "deduction", "cutoff", "shift_master"]) {
      assert.ok(!fn.toLowerCase().includes(forbidden), `${forbidden} must not be selected for a dropdown`);
    }
    // The legacy column, as opposed to `work_shift_id`.
    assert.ok(!/(?<!work_)shift_id/.test(fn), "the legacy shift_id is never read here");
  });
});

describe("permissions", () => {
  it("the read requires view_employees AND view_shift_assignments", () => {
    const { guard } = find("GET", "/work-shift-assignments");
    assert.equal(guard.mode, "all");
    assert.deepEqual(guard.keys, [P.VIEW_EMPLOYEES, P.VIEW_SHIFT_ASSIGNMENTS]);
  });

  it("M1 review fix: the profile's single-employee read needs view_employees ONLY", () => {
    // Shift is part of Employment Details now, so whoever may view the
    // employee may see the shift that employee is on. Requiring
    // `view_shift_assignments` as well - an HR/administrator key - left the
    // field unreadable for most of the people the section was built for.
    const { guard } = find("GET", "/work-shift-assignments/employee/:employee_id");
    assert.deepEqual(guard.keys, [P.VIEW_EMPLOYEES]);
    assert.ok(
      !guard.keys.includes(P.VIEW_SHIFT_ASSIGNMENTS),
      "the roster key is no longer demanded to read one employee's own shift"
    );
  });

  it("M1 review fix: view-only access does NOT thereby open the roster", () => {
    // The single read was relaxed; the list was not. Seeing one person's
    // shift and reading the whole company's roster are different facts.
    const { guard } = find("GET", "/work-shift-assignments");
    assert.equal(guard.mode, "all");
    assert.deepEqual(guard.keys, [P.VIEW_EMPLOYEES, P.VIEW_SHIFT_ASSIGNMENTS]);
  });

  it("M1 review fix: assignment is UNCHANGED - still employee_edit AND assign_employee_shift", () => {
    // The read was the only thing the review asked to relax. If this ever
    // starts passing with `view_employees` in it, the write has been
    // weakened by accident.
    const { guard } = find("POST", "/work-shift-assignments/bulk");
    assert.equal(guard.mode, "all");
    assert.deepEqual(guard.dynamic.single, [P.EMPLOYEE_EDIT, P.ASSIGN_EMPLOYEE_SHIFT]);
    assert.ok(!guard.keys.includes(P.VIEW_EMPLOYEES), "a read key never opens a write");
  });

  it("M1 review fix: the single read still uses the NEW work shift master only", () => {
    // `default_work_shift_id` / `work_shift`, never the legacy `shift_id`.
    const fs = require("fs");
    const src = fs.readFileSync(require.resolve("../repository/employee_work_shift"), "utf8");
    const fn = src.slice(
      src.indexOf("async getEmployeeWorkShift"),
      src.indexOf("async getWorkShiftWorkingTimes")
    );
    assert.ok(fn.includes("default_work_shift_id"), "the NEW column is what is read");
    assert.ok(!/(?<!work_)(?<!default_work_)shift_id\b/.test(fn), "the legacy shift_id is never revived here");
  });

  it("the write always requires employee_edit and a Work Shift assign key", () => {
    const { guard } = find("POST", "/work-shift-assignments/bulk");
    assert.equal(guard.mode, "all");
    assert.deepEqual(guard.dynamic.single, [P.EMPLOYEE_EDIT, P.ASSIGN_EMPLOYEE_SHIFT]);
    assert.deepEqual(guard.dynamic.bulk, [P.EMPLOYEE_EDIT, P.BULK_ASSIGN_EMPLOYEE_SHIFT]);
  });

  it("no work shift endpoint is gated on the LEGACY shift master's keys", () => {
    // The whole point of the change: `view_shift` is held by designations
    // with no payroll role, so it must not be what opens the roster.
    for (const { guard } of guards) {
      assert.ok(!guard.keys.includes(P.VIEW_SHIFT), "view_shift no longer guards this router");
      assert.ok(!guard.keys.includes(P.ADD_SHIFTS), "add_shifts no longer guards this router");
    }
  });

  it("uses only permission keys that already exist", () => {
    const declared = new Set(Object.values(P));
    for (const { guard } of guards) {
      for (const key of guard.keys) {
        assert.ok(declared.has(key), `${key} is not a declared HR permission`);
      }
    }
  });

  it("no endpoint is left unguarded", () => {
    for (const g of guards) assert.ok(g.guard, `${g.method} ${g.path} has no permission guard`);
  });
});

describe("one is not many", () => {
  /**
   * Runs the real assign guard against a body and reports which keys it
   * actually demanded. `requireAll` is the genuine AND form, so what this
   * records is the check the route would run, not a description of it.
   */
  //
  // Built ONCE: `routes/employee_work_shift.js` keeps its Express router at
  // module scope, so building the routes again would register every endpoint
  // on it a second time.
  let demanded = null;
  const recorder = buildRoutes(
    {},
    {
      require: () => (req, res, next) => next(),
      requireAll: (...keys) => (req, res, next) => {
        demanded = keys;
        next();
      },
    },
    null
  );

  function keysDemandedFor(body) {
    demanded = null;
    recorder.assignGuard()({ body }, {}, () => {});
    return demanded;
  }

  it("one employee id demands assign_employee_shift", () => {
    assert.deepEqual(keysDemandedFor({ employee_ids: [7], work_shift_id: 1 }), [
      P.EMPLOYEE_EDIT,
      P.ASSIGN_EMPLOYEE_SHIFT,
    ]);
  });

  it("two or more demand bulk_assign_employee_shift", () => {
    assert.deepEqual(keysDemandedFor({ employee_ids: [7, 8], work_shift_id: 1 }), [
      P.EMPLOYEE_EDIT,
      P.BULK_ASSIGN_EMPLOYEE_SHIFT,
    ]);
    assert.deepEqual(
      keysDemandedFor({ employee_ids: [1, 2, 3, 4, 5], work_shift_id: 1 }),
      [P.EMPLOYEE_EDIT, P.BULK_ASSIGN_EMPLOYEE_SHIFT]
    );
  });

  it("holding one key does not confer the other", () => {
    // The two are separate decisions, so neither branch may name both: a
    // caller who may fix one roster is not thereby allowed to re-roster the
    // whole company, and vice versa.
    const single = keysDemandedFor({ employee_ids: [7] });
    const bulk = keysDemandedFor({ employee_ids: [7, 8] });
    assert.ok(!single.includes(P.BULK_ASSIGN_EMPLOYEE_SHIFT));
    assert.ok(!bulk.includes(P.ASSIGN_EMPLOYEE_SHIFT));
  });

  it("a malformed body asks for the STRICTER key, never the weaker one", () => {
    // Joi refuses all of these a moment later. What matters here is that an
    // unparseable `employee_ids` cannot be read as "just one, let it through".
    for (const body of [{}, { employee_ids: [] }, { employee_ids: "7" }, { employee_ids: null }]) {
      assert.deepEqual(
        keysDemandedFor(body),
        [P.EMPLOYEE_EDIT, P.BULK_ASSIGN_EMPLOYEE_SHIFT],
        `${JSON.stringify(body)} demands the bulk key`
      );
    }
  });
});

describe("B3 field protection", () => {
  it("mounts filterResponse and guardWrite on the assignment endpoints", () => {
    assert.ok(middleware.includes("filterResponse"), "filterResponse is mounted");
    assert.ok(middleware.includes("guardWrite"), "guardWrite is mounted");
  });
});
