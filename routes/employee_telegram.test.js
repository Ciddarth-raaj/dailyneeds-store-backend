/**
 * THE EMPLOYEE TELEGRAM API - which key guards each endpoint, and which
 * employees a caller may reach with it.
 *
 *   node --test routes/employee_telegram.test.js
 *
 * TWO INDEPENDENT QUESTIONS, ASSERTED SEPARATELY, because they are separate
 * rules and a test that conflated them would pass while one of them was gone:
 *
 *   MAY THIS CALLER DO THIS AT ALL?   `employee_create` OR `employee_edit` to
 *                                     generate a link or disconnect;
 *                                     `view_employees` to read the status.
 *   WHICH EMPLOYEES MAY THEY TOUCH?   the REAL branch scope middleware, built
 *                                     over an in-memory employee table by
 *                                     `test_support/employee_branch_scope.js`
 *                                     - HR and administrators company-wide,
 *                                     everybody else their own store.
 *
 * THE OR MATTERS. Finishing Telegram setup for an employee who already exists
 * must not require the right to CREATE employees - that is the approved rule,
 * and `permissions.require(A, B)` is already OR (`keys.some`).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./employee_telegram");
const P = require("../constants/hr_permissions");
const { buildScopeFor } = require("../test_support/employee_branch_scope");

/* ------------------------------------------------- guard-shape inspection */

const tagging = {
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
  has: async () => true,
  actorFor: async () => ({ employeeId: 7, isAdmin: true, permissions: [] }),
  ADMIN_USER_TYPE: 2,
};

/** A branch scope that records that it ran, so its presence can be asserted. */
const taggingScope = () => {
  const seen = [];
  return {
    seen,
    requireEmployeeInScope: () => {
      const mw = (req, res, next) => {
        seen.push(req.params.employee_id);
        next();
      };
      mw.__scoped = true;
      return mw;
    },
    refuse: (res, outcome) => res.status(403).json({ code: 403, msg: outcome.reason }),
  };
};

function routesOf(usecase = {}, permissions = tagging, scope = taggingScope()) {
  const out = [];
  for (const layer of buildRoutes(usecase, permissions, scope).getRouter().stack) {
    if (!layer.route) continue;
    out.push({
      method: Object.keys(layer.route.methods)[0].toUpperCase(),
      path: layer.route.path,
      guard: layer.route.stack.map((s) => s.handle.__guard).find(Boolean) || null,
      scoped: layer.route.stack.some((s) => s.handle.__scoped === true),
      handler: layer.route.stack[layer.route.stack.length - 1].handle,
    });
  }
  return out;
}

function fakeRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}

const usecaseSpy = () => ({
  calls: [],
  async startLink(employeeId, opts) {
    this.calls.push(["startLink", employeeId, opts]);
    return { code: 200, link: "https://t.me/dnds_bot?start=e_abc", expires_in_minutes: 15 };
  },
  async getStatus(employeeId) {
    this.calls.push(["getStatus", employeeId]);
    return { code: 200, data: { status: "PENDING", connected: false } };
  },
  async disconnect(employeeId, opts) {
    this.calls.push(["disconnect", employeeId, opts]);
    return { code: 200, disconnected: true };
  },
});

/* ------------------------------------------------------------- the guards */

describe("the endpoints and their keys", () => {
  it("exposes exactly three routes", () => {
    assert.deepEqual(
      routesOf().map((r) => `${r.method} ${r.path}`).sort(),
      [
        "GET /employee/:employee_id/telegram",
        "POST /employee/:employee_id/telegram/disconnect",
        "POST /employee/:employee_id/telegram/link-token",
      ]
    );
  });

  it("link-token is employee_create OR employee_edit - NOT create alone", () => {
    const route = routesOf().find((r) => r.path.endsWith("/link-token"));
    assert.equal(route.guard.mode, "any");
    assert.deepEqual(route.guard.keys.sort(), [P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT].sort());
  });

  it("disconnect carries the same pair", () => {
    const route = routesOf().find((r) => r.path.endsWith("/disconnect"));
    assert.equal(route.guard.mode, "any");
    assert.deepEqual(route.guard.keys.sort(), [P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT].sort());
  });

  it("the status read is view_employees - the key every other status uses", () => {
    const route = routesOf().find((r) => r.method === "GET");
    assert.deepEqual(route.guard.keys, [P.VIEW_EMPLOYEES]);
  });

  it("EVERY route carries the branch scope, not just the writes", () => {
    for (const route of routesOf()) {
      assert.ok(route.scoped, `${route.method} ${route.path} must be branch-scoped`);
    }
  });

  it("refuses to be constructed without a branch scope at all", () => {
    assert.throws(() => buildRoutes({}, tagging, null), /branch scope is required/);
  });
});

/* ------------------------------------------------------------- the writes */

describe("the handlers", () => {
  it("passes the employee from the path and the actor from the session", async () => {
    const usecase = usecaseSpy();
    const route = routesOf(usecase).find((r) => r.path.endsWith("/link-token"));
    const res = fakeRes();

    await route.handler({ params: { employee_id: "7" }, body: {}, auth: { userId: 3 } }, res);

    assert.deepEqual(usecase.calls[0], ["startLink", 7, { actorUserId: 3 }]);
    assert.equal(res.body.code, 200);
  });

  it("returns the link and nothing else that matters - no hash, no ids", async () => {
    const usecase = usecaseSpy();
    const route = routesOf(usecase).find((r) => r.path.endsWith("/link-token"));
    const res = fakeRes();

    await route.handler({ params: { employee_id: "7" }, body: {}, auth: { userId: 3 } }, res);

    const dumped = JSON.stringify(res.body);
    assert.ok(!/token_hash|chat_id|telegram_user_id|primary_contact/.test(dumped));
  });

  it("refuses a body that names anything at all", async () => {
    const usecase = usecaseSpy();
    const route = routesOf(usecase).find((r) => r.path.endsWith("/link-token"));
    const res = fakeRes();

    await route.handler(
      { params: { employee_id: "7" }, body: { employee_id: 9, chat_id: 123 }, auth: {} },
      res
    );

    assert.equal(res.body.code, 422);
    assert.deepEqual(usecase.calls, [], "nothing reached the usecase");
  });

  it("refuses a malformed employee id before the usecase is called", async () => {
    const usecase = usecaseSpy();
    for (const bad of ["abc", "0", "-3", "1.5"]) {
      const route = routesOf(usecase).find((r) => r.method === "GET");
      const res = fakeRes();
      await route.handler({ params: { employee_id: bad }, query: {} }, res);
      assert.equal(res.body.code, 422, `${bad} must be refused`);
    }
    assert.deepEqual(usecase.calls, []);
  });

  it("reports a ValidationError as 422 and anything else as 500", async () => {
    const failing = {
      startLink: async () => {
        const err = new Error("This employee is not active");
        err.name = "ValidationError";
        throw err;
      },
    };
    const route = routesOf(failing).find((r) => r.path.endsWith("/link-token"));
    const res = fakeRes();
    await route.handler({ params: { employee_id: "9" }, body: {}, auth: {} }, res);
    assert.equal(res.body.code, 422);
    assert.match(res.body.msg, /not active/);

    const exploding = {
      startLink: async () => {
        throw new Error("mysql is down");
      },
    };
    const route2 = routesOf(exploding).find((r) => r.path.endsWith("/link-token"));
    const res2 = fakeRes();
    await route2.handler({ params: { employee_id: "7" }, body: {}, auth: {} }, res2);
    assert.equal(res2.body.code, 500);
    assert.ok(!/mysql/.test(JSON.stringify(res2.body)), "an internal error is not narrated");
  });
});

/* -------------------------------------------------------- the branch rule */

describe("the REAL branch scope decides which employees are reachable", () => {
  // Kathirkamam is store 2, Moolakulam is store 1.
  const EMPLOYEES = [
    { employee_id: 100, store_id: 1, status: 1 }, // the store manager
    { employee_id: 200, store_id: 1, status: 1 }, // their own staff
    { employee_id: 300, store_id: 2, status: 1 }, // another store's staff
    { employee_id: 400, store_id: 1, status: 1 }, // HR
  ];

  /** A permission object where the caller holds `keys` and nothing else. */
  const permissionsFor = (keys, { isAdmin = false } = {}) => ({
    ADMIN_USER_TYPE: 2,
    has: async (req, ...asked) => isAdmin || asked.some((k) => keys.includes(k)),
    hasAll: async (req, ...asked) => isAdmin || asked.every((k) => keys.includes(k)),
    actorFor: async () => ({ isAdmin, permissions: keys }),
    require: (...asked) => async (req, res, next) => {
      if (isAdmin || asked.some((k) => keys.includes(k))) return next();
      return res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
    },
  });

  /** Runs the route's whole middleware chain, as Express would. */
  const call = async (usecase, permissions, scope, { path, method = "POST", req }) => {
    const router = buildRoutes(usecase, permissions, scope).getRouter();
    const layer = router.stack.find(
      (l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]
    );
    const res = fakeRes();
    const stack = layer.route.stack.map((s) => s.handle);
    let i = 0;
    const next = async () => {
      const handler = stack[i++];
      if (!handler) return;
      await handler(req, res, next);
    };
    await next();
    return res;
  };

  const LINK = "/employee/:employee_id/telegram/link-token";

  it("a store manager MAY generate a link for their own store's employee", async () => {
    const usecase = usecaseSpy();
    const permissions = permissionsFor([P.EMPLOYEE_EDIT]);
    const res = await call(usecase, permissions, buildScopeFor(permissions, EMPLOYEES), {
      path: LINK,
      req: { params: { employee_id: "200" }, body: {}, decoded: { user_type: 1 }, auth: { employeeId: 100, userId: 5 } },
    });

    assert.equal(res.body.code, 200);
    assert.deepEqual(usecase.calls[0].slice(0, 2), ["startLink", 200]);
  });

  it("A STORE MANAGER MAY NOT TOUCH ANOTHER STORE'S EMPLOYEE", async () => {
    const usecase = usecaseSpy();
    const permissions = permissionsFor([P.EMPLOYEE_EDIT]);
    const res = await call(usecase, permissions, buildScopeFor(permissions, EMPLOYEES), {
      path: LINK,
      req: { params: { employee_id: "300" }, body: {}, decoded: { user_type: 1 }, auth: { employeeId: 100, userId: 5 } },
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(usecase.calls, [], "the usecase is never reached");
  });

  it("a non-existent employee is refused the SAME WAY, so ids cannot be probed", async () => {
    const usecase = usecaseSpy();
    const permissions = permissionsFor([P.EMPLOYEE_EDIT]);
    const scope = buildScopeFor(permissions, EMPLOYEES);

    const missing = await call(usecase, permissions, scope, {
      path: LINK,
      req: { params: { employee_id: "999" }, body: {}, decoded: { user_type: 1 }, auth: { employeeId: 100 } },
    });
    const otherStore = await call(usecase, permissions, scope, {
      path: LINK,
      req: { params: { employee_id: "300" }, body: {}, decoded: { user_type: 1 }, auth: { employeeId: 100 } },
    });

    assert.equal(missing.statusCode, otherStore.statusCode);
    assert.deepEqual(missing.body, otherStore.body);
  });

  it("HR - the all-branches key - reaches every store", async () => {
    const usecase = usecaseSpy();
    const permissions = permissionsFor([P.EMPLOYEE_EDIT, P.EMPLOYEE_SCOPE_ALL_BRANCHES]);
    const res = await call(usecase, permissions, buildScopeFor(permissions, EMPLOYEES), {
      path: LINK,
      req: { params: { employee_id: "300" }, body: {}, decoded: { user_type: 1 }, auth: { employeeId: 400, userId: 6 } },
    });

    assert.equal(res.body.code, 200);
    assert.deepEqual(usecase.calls[0].slice(0, 2), ["startLink", 300]);
  });

  it("an administrator reaches every store", async () => {
    const usecase = usecaseSpy();
    const permissions = permissionsFor([], { isAdmin: true });
    const res = await call(usecase, permissions, buildScopeFor(permissions, EMPLOYEES), {
      path: LINK,
      req: { params: { employee_id: "300" }, body: {}, decoded: { user_type: 2 }, auth: { employeeId: 400, userId: 1 } },
    });

    assert.equal(res.body.code, 200);
  });

  it("A CALLER WITH NEITHER KEY IS REFUSED, in or out of scope", async () => {
    const usecase = usecaseSpy();
    const permissions = permissionsFor([P.VIEW_EMPLOYEES]);
    const res = await call(usecase, permissions, buildScopeFor(permissions, EMPLOYEES), {
      path: LINK,
      req: { params: { employee_id: "200" }, body: {}, decoded: { user_type: 1 }, auth: { employeeId: 100 } },
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(usecase.calls, []);
  });

  it("employee_create alone is enough - and so is employee_edit alone", async () => {
    for (const key of [P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT]) {
      const usecase = usecaseSpy();
      const permissions = permissionsFor([key]);
      const res = await call(usecase, permissions, buildScopeFor(permissions, EMPLOYEES), {
        path: LINK,
        req: { params: { employee_id: "200" }, body: {}, decoded: { user_type: 1 }, auth: { employeeId: 100 } },
      });
      assert.equal(res.body.code, 200, `${key} alone must be enough`);
    }
  });

  it("the status read is refused out of scope as well", async () => {
    const usecase = usecaseSpy();
    const permissions = permissionsFor([P.VIEW_EMPLOYEES]);
    const res = await call(usecase, permissions, buildScopeFor(permissions, EMPLOYEES), {
      path: "/employee/:employee_id/telegram",
      method: "GET",
      req: { params: { employee_id: "300" }, query: {}, decoded: { user_type: 1 }, auth: { employeeId: 100 } },
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(usecase.calls, []);
  });

  it("a caller whose own branch cannot be resolved is refused - it FAILS CLOSED", async () => {
    const usecase = usecaseSpy();
    const permissions = permissionsFor([P.EMPLOYEE_EDIT]);
    const res = await call(usecase, permissions, buildScopeFor(permissions, EMPLOYEES), {
      path: LINK,
      // A login with no employee record behind it - a break-glass or system
      // account. It is not an administrator, so it has no branch and no way to
      // acquire one.
      req: { params: { employee_id: "200" }, body: {}, decoded: { user_type: 1 }, auth: {} },
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(usecase.calls, []);
  });
});
