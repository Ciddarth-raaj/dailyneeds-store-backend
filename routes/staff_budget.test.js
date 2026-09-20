/**
 * The Staff Budget Master - the route surface and what guards it.
 *
 *   node --test routes/staff_budget.test.js
 *
 * The router is built with a fake `permissions` object that records what each
 * endpoint asked for, so these are assertions about the real wiring rather
 * than about the source text: which key guards which endpoint, and that NO
 * endpoint is left open. Hiding the menu entry is not a control; this is.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./staff_budget");
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
const find = (method, path) => guards.find((g) => g.method === method && g.path === path);

describe("the endpoints", () => {
  it("defines the four reads and the four writes", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      [
        "GET /",
        "GET /history",
        "GET /masters",
        "GET /rates",
        "POST /",
        "POST /bulk",
        "POST /rates",
        "POST /remove",
      ]
    );
  });
});

describe("what guards them", () => {
  it("leaves nothing open", () => {
    for (const g of guards) {
      assert.ok(g.guard, `${g.method} ${g.path} has no permission guard`);
      assert.ok(g.guard.keys.length > 0, `${g.method} ${g.path} requires no key`);
    }
  });

  it("gates every read on view_staff_budget", () => {
    for (const path of ["/", "/masters", "/history", "/rates"]) {
      assert.deepEqual(find("GET", path).guard, {
        mode: "any",
        keys: [P.VIEW_STAFF_BUDGET],
      });
    }
  });

  it("gates every write on edit_staff_budget", () => {
    for (const path of ["/", "/bulk", "/remove", "/rates"]) {
      assert.deepEqual(find("POST", path).guard, {
        mode: "any",
        keys: [P.EDIT_STAFF_BUDGET],
      });
    }
  });

  it("never lets a read key authorise a write", () => {
    const writes = guards.filter((g) => g.method === "POST");
    assert.equal(writes.length, 4);
    for (const write of writes) {
      assert.ok(
        !write.guard.keys.includes(P.VIEW_STAFF_BUDGET),
        `${write.path} accepts the read key`
      );
    }
  });

  it("asks for exactly one key per endpoint, so OR cannot weaken the check", () => {
    for (const g of guards) {
      assert.equal(g.guard.keys.length, 1, `${g.method} ${g.path} passes more than one key`);
    }
  });

  it("exposes no endpoint that resolves a rate's masters by itself", () => {
    // A production write choosing which designation or shift real money
    // attaches to is the failure this feature must not have. Rates are picked
    // by a person on the rate screen and stored as ids.
    for (const g of guards) {
      assert.ok(
        !/standard|resolve|auto/i.test(g.path),
        `${g.method} ${g.path} looks like an automatic rate-resolution endpoint`
      );
    }
  });

  it("does not borrow the legacy store-budget keys", () => {
    for (const g of guards) {
      assert.ok(!g.guard.keys.includes("view_store_budget"));
      assert.ok(!g.guard.keys.includes("add_store_budger"));
    }
  });
});
