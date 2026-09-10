/**
 * The Work Shift master — the route surface and what guards it.
 *
 *   node --test routes/work_shift.test.js
 *
 * The router is built with a fake `permissions` object that records what it
 * asked for, so these are assertions about the real wiring rather than about
 * the source text: which key guards which endpoint, and that no endpoint is
 * left open.
 *
 * The assertion that matters is that the LEGACY shift master's keys are gone.
 * `view_shift` and `add_shifts` belong to `shift_master` and are granted to
 * designations with no payroll role at all, so they cannot be what opens the
 * new payroll/attendance master. /shift keeps them and is a separate router.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./work_shift");
const P = require("../constants/hr_permissions");

/** Records every guard the router installs. */
function makeHarness() {
  const guards = [];
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

  const router = buildRoutes({}, permissions).getRouter();

  for (const layer of router.stack) {
    if (!layer.route) continue;
    const method = Object.keys(layer.route.methods)[0].toUpperCase();
    const guard = layer.route.stack.map((s) => s.handle.__guard).find(Boolean);
    guards.push({ method, path: layer.route.path, guard });
  }

  return guards;
}

const guards = makeHarness();
const find = (method, path) =>
  guards.find((g) => g.method === method && g.path === path);

describe("the endpoints", () => {
  it("defines the three reads and the four writes", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      [
        "GET /",
        "GET /details",
        "GET /weekly-schedule",
        "POST /create",
        "POST /update",
        "POST /update-status",
        "POST /weekly-schedule",
      ]
    );
  });
});

describe("permissions", () => {
  it("every read requires view_work_shifts", () => {
    for (const path of ["/", "/details", "/weekly-schedule"]) {
      const { guard } = find("GET", path);
      assert.deepEqual(guard.keys, [P.VIEW_WORK_SHIFTS], `GET ${path}`);
    }
  });

  it("every write requires manage_work_shifts", () => {
    for (const path of ["/create", "/update", "/weekly-schedule", "/update-status"]) {
      const { guard } = find("POST", path);
      assert.deepEqual(guard.keys, [P.MANAGE_WORK_SHIFTS], `POST ${path}`);
    }
  });

  it("reading does not confer writing", () => {
    // One key each, never both on one endpoint: `require` is OR, so an
    // endpoint listing both would open to EITHER, which is weaker than
    // either key alone was meant to be.
    for (const { guard } of guards) {
      assert.equal(guard.keys.length, 1);
    }
    const read = find("GET", "/").guard.keys[0];
    const write = find("POST", "/create").guard.keys[0];
    assert.notEqual(read, write);
  });

  it("is not gated on the LEGACY shift master's keys", () => {
    for (const { method, path, guard } of guards) {
      assert.ok(
        !guard.keys.includes(P.VIEW_SHIFT) && !guard.keys.includes(P.ADD_SHIFTS),
        `${method} ${path} must not use view_shift / add_shifts`
      );
    }
  });

  it("uses only declared HR permission keys", () => {
    const declared = new Set(Object.values(P));
    for (const { guard } of guards) {
      for (const key of guard.keys) {
        assert.ok(declared.has(key), `${key} is not a declared HR permission`);
      }
    }
  });

  it("no endpoint is left unguarded", () => {
    for (const g of guards) {
      assert.ok(g.guard, `${g.method} ${g.path} has no permission guard`);
    }
  });
});
