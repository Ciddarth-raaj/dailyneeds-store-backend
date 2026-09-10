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
  it("defines exactly the two reads and the bulk write", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      [
        "GET /work-shift-assignments",
        "GET /work-shift-assignments/employee/:employee_id",
        "POST /work-shift-assignments/bulk",
      ]
    );
  });
});

describe("permissions", () => {
  it("the read requires view_employees AND view_shift", () => {
    const { guard } = find("GET", "/work-shift-assignments");
    assert.equal(guard.mode, "all");
    assert.deepEqual(guard.keys, [P.VIEW_EMPLOYEES, P.VIEW_SHIFT]);
  });

  it("the profile's single-employee read requires the same pair", () => {
    // Reading one employee's shift is the same join as reading the list of
    // them, so it cannot be a weaker decision.
    const { guard } = find("GET", "/work-shift-assignments/employee/:employee_id");
    assert.equal(guard.mode, "all");
    assert.deepEqual(guard.keys, [P.VIEW_EMPLOYEES, P.VIEW_SHIFT]);
  });

  it("the write requires employee_edit AND view_shift", () => {
    const { guard } = find("POST", "/work-shift-assignments/bulk");
    assert.equal(guard.mode, "all");
    assert.deepEqual(guard.keys, [P.EMPLOYEE_EDIT, P.VIEW_SHIFT]);
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

describe("B3 field protection", () => {
  it("mounts filterResponse and guardWrite on the assignment endpoints", () => {
    assert.ok(middleware.includes("filterResponse"), "filterResponse is mounted");
    assert.ok(middleware.includes("guardWrite"), "guardWrite is mounted");
  });
});
