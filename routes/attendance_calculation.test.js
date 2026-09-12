/**
 * Attendance v2 - the calculated attendance router: what guards what, and the
 * self-only read.
 *
 *   node --test routes/attendance_calculation.test.js
 *
 * Two kinds of test. The guard-introspection ones build the router with a
 * fake `permissions` that tags each middleware, then walk `router.stack`, the
 * way routes/attendance_raw.test.js does. The handler ones invoke the real
 * handlers with a stub req/res, through the REAL permissions middleware
 * (middlewares/permissions.js) against a fake designation usecase - so
 * "Employee A cannot read Employee B" and "an employee cannot edit a shift"
 * are proved against the code that actually decides them, not against a
 * fake that always says no.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./attendance_calculation");
const buildPermissions = require("../middlewares/permissions");
const P = require("../constants/hr_permissions");

/* ------------------------------------------------------- guard mapping */

function guardsOf(routes) {
  const guards = [];
  for (const layer of routes.getRouter().stack) {
    if (!layer.route) continue;
    const method = Object.keys(layer.route.methods)[0].toUpperCase();
    const guard = layer.route.stack.map((s) => s.handle.__guard).find(Boolean) || null;
    guards.push({ method, path: layer.route.path, guard });
  }
  return guards;
}

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
};

const guards = guardsOf(buildRoutes({}, tagging, null));
const find = (method, path) => guards.find((g) => g.method === method && g.path === path);

describe("the endpoints and their guards", () => {
  it("adds the self-only read and the single-date shift edit beside the existing five", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      [
        "GET /attendance/calculated",
        "GET /attendance/calculated/break-override/:employee_id",
        "GET /attendance/calculated/date-shift/options",
        "GET /attendance/calculated/recalculate-runs",
        "GET /attendance/me",
        "GET /attendance/payroll/monthly",
        "POST /attendance/calculated/break-override",
        "POST /attendance/calculated/date-shift",
        "POST /attendance/calculated/recalculate",
        "POST /attendance/calculated/recalculate-bulk",
      ]
    );
  });

  it("bulk recalculation and its run history are behind recalculate_attendance", () => {
    assert.deepEqual(find("POST", "/attendance/calculated/recalculate-bulk").guard, {
      mode: "any",
      keys: [P.RECALCULATE_ATTENDANCE],
    });
    assert.deepEqual(find("GET", "/attendance/calculated/recalculate-runs").guard, {
      mode: "any",
      keys: [P.RECALCULATE_ATTENDANCE],
    });
  });

  it("/attendance/me needs an employee identity and NO permission key", () => {
    assert.deepEqual(find("GET", "/attendance/me").guard, { mode: "self", keys: [] });
  });

  it("the HR read of another employee still needs view_calculated_attendance", () => {
    assert.deepEqual(find("GET", "/attendance/calculated").guard, {
      mode: "any",
      keys: [P.VIEW_CALCULATED_ATTENDANCE],
    });
  });

  it("the single-date shift edit and its options need edit_attendance_date_shift, its own key", () => {
    assert.deepEqual(find("POST", "/attendance/calculated/date-shift").guard, {
      mode: "any",
      keys: [P.EDIT_ATTENDANCE_DATE_SHIFT],
    });
    assert.deepEqual(find("GET", "/attendance/calculated/date-shift/options").guard, {
      mode: "any",
      keys: [P.EDIT_ATTENDANCE_DATE_SHIFT],
    });
    assert.equal(P.EDIT_ATTENDANCE_DATE_SHIFT, "edit_attendance_date_shift");
    assert.notEqual(P.EDIT_ATTENDANCE_DATE_SHIFT, P.CORRECT_EMPLOYEE_SHIFT_ASSIGNMENT);
    assert.notEqual(P.EDIT_ATTENDANCE_DATE_SHIFT, P.VIEW_CALCULATED_ATTENDANCE);
  });

  it("there is NO self-service shift edit: nothing under /attendance/me writes", () => {
    guards
      .filter((g) => g.path.startsWith("/attendance/me"))
      .forEach((g) => assert.equal(g.method, "GET", `${g.method} ${g.path} must not exist`));
  });
});

/* ------------------------------------------------------ handler tests */

/** Run the whole stack for a route - guards then handler - like Express would. */
async function invoke(routes, method, path, req) {
  const layer = routes
    .getRouter()
    .stack.find((l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
  assert.ok(layer, `${method} ${path} exists`);

  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const stack = layer.route.stack.map((s) => s.handle);
  for (const handle of stack) {
    // eslint-disable-next-line no-await-in-loop
    const proceeded = await new Promise((resolve) => {
      const maybe = handle(req, res, () => resolve(true));
      Promise.resolve(maybe).then(() => resolve(false));
    });
    if (!proceeded) break;
  }
  return res;
}

/** The REAL permission middleware over a fake designation -> keys table. */
const permissionsFor = (byDesignation) =>
  buildPermissions({
    getPermissionById: async (designationId) =>
      (byDesignation[designationId] || []).map((permission_key) => ({ permission_key })),
  });

function fakeUsecase() {
  const calls = { ranges: [], edits: [] };
  return {
    calls,
    calculateRange: async (args) => {
      calls.ranges.push(args);
      return [{ employee_id: args.employee_id, attendance_date: args.from_date, status: "FINAL" }];
    },
    setDateShift: async (args) => {
      calls.edits.push(args);
      return { changed: true, ...args };
    },
    listDateShiftOptions: async () => [{ work_shift_id: 8, shift_code: "MORN", shift_name: "Morning" }],
  };
}

const EMPLOYEE_A = 101;
const EMPLOYEE_B = 202;
const STAFF_DESIGNATION = 5; // holds nothing
const HR_DESIGNATION = 6; // holds the read key
const EDITOR_DESIGNATION = 7; // holds the edit key

const staffReq = (extra = {}) => ({
  decoded: { id: 1, employee_id: EMPLOYEE_A, designation_id: STAFF_DESIGNATION, user_type: 1 },
  query: {},
  body: {},
  ...extra,
});

const permissions = permissionsFor({
  [HR_DESIGNATION]: [P.VIEW_CALCULATED_ATTENDANCE],
  [EDITOR_DESIGNATION]: [P.EDIT_ATTENDANCE_DATE_SHIFT],
});

describe("GET /attendance/me - self only", () => {
  it("serves the caller's own employee id, taken from the token", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "GET", "/attendance/me", staffReq({
      query: { from_date: "2026-09-01", to_date: "2026-09-30" },
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.code, 200);
    assert.equal(res.body.employee_id, EMPLOYEE_A);
    assert.deepEqual(usecase.calls.ranges, [
      { employee_id: EMPLOYEE_A, from_date: "2026-09-01", to_date: "2026-09-30" },
    ]);
  });

  it("Employee A cannot retrieve Employee B: an employee_id in the query is REJECTED, not read", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "GET", "/attendance/me", staffReq({
      query: { employee_id: String(EMPLOYEE_B), from_date: "2026-09-01", to_date: "2026-09-30" },
    }));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.msg, /"employee_id" is not allowed/);
    assert.equal(usecase.calls.ranges.length, 0, "nothing was calculated for anybody");
  });

  it("a system account, which has no employee, is refused", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "GET", "/attendance/me", staffReq({
      decoded: { id: 1, employee_id: null, designation_id: null, user_type: 1, is_system_account: true },
      query: { from_date: "2026-09-01", to_date: "2026-09-30" },
    }));
    assert.equal(res.statusCode, 403);
    assert.equal(usecase.calls.ranges.length, 0);
  });

  it("an unauthenticated call is refused", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "GET", "/attendance/me", { query: { from_date: "2026-09-01", to_date: "2026-09-30" } });
    assert.equal(res.statusCode, 401);
  });

  it("a staff designation with NO permission keys at all can still read its own month", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "GET", "/attendance/me", staffReq({
      query: { from_date: "2026-09-01", to_date: "2026-09-30" },
    }));
    assert.equal(res.statusCode, 200);
  });
});

describe("GET /attendance/calculated - the HR read of another employee", () => {
  it("Employee A, holding no key, cannot read Employee B through the HR route either", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "GET", "/attendance/calculated", staffReq({
      query: { employee_id: String(EMPLOYEE_B), from_date: "2026-09-01", to_date: "2026-09-30" },
    }));
    assert.equal(res.statusCode, 403);
    assert.equal(usecase.calls.ranges.length, 0);
  });

  it("a holder of view_calculated_attendance can", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "GET", "/attendance/calculated", staffReq({
      decoded: { id: 2, employee_id: 303, designation_id: HR_DESIGNATION, user_type: 1 },
      query: { employee_id: String(EMPLOYEE_B), from_date: "2026-09-01", to_date: "2026-09-30" },
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(usecase.calls.ranges[0].employee_id, EMPLOYEE_B);
  });
});

describe("POST /attendance/calculated/date-shift - the single-date shift edit", () => {
  const body = { employee_id: EMPLOYEE_A, attendance_date: "2026-09-15", work_shift_id: 8 };

  it("an employee cannot edit a shift - not even their own", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "POST", "/attendance/calculated/date-shift", staffReq({ body }));
    assert.equal(res.statusCode, 403);
    assert.equal(usecase.calls.edits.length, 0);
  });

  it("holding the READ key is not enough to edit", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "POST", "/attendance/calculated/date-shift", staffReq({
      decoded: { id: 2, employee_id: 303, designation_id: HR_DESIGNATION, user_type: 1 },
      body,
    }));
    assert.equal(res.statusCode, 403);
    assert.equal(usecase.calls.edits.length, 0);
  });

  it("an authorized user edits ONE date, and the actor is recorded from the token", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "POST", "/attendance/calculated/date-shift", staffReq({
      decoded: { id: 3, employee_id: 404, designation_id: EDITOR_DESIGNATION, user_type: 1 },
      body,
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(usecase.calls.edits, [
      { employee_id: EMPLOYEE_A, attendance_date: "2026-09-15", work_shift_id: 8, actor_employee_id: 404 },
    ]);
  });

  it("the body is exactly employee, date and shift - no effective-from, no range, no reason", async () => {
    const usecase = fakeUsecase();
    const routes = buildRoutes(usecase, permissions, null);
    for (const extra of [{ effective_from: "2026-09-15" }, { effective_to: "2026-09-20" }, { reason: "x" }, { employee_ids: [1, 2] }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await invoke(routes, "POST", "/attendance/calculated/date-shift", staffReq({
        decoded: { id: 3, employee_id: 404, designation_id: EDITOR_DESIGNATION, user_type: 1 },
        body: { ...body, ...extra },
      }));
      assert.equal(res.statusCode, 400, `${Object.keys(extra)[0]} must be refused`);
    }
    assert.equal(usecase.calls.edits.length, 0);
  });

  it("an unknown shift is a 404", async () => {
    const usecase = fakeUsecase();
    usecase.setDateShift = async () => {
      const err = new Error("No work shift exists for id 8");
      err.name = "NotFoundError";
      throw err;
    };
    const routes = buildRoutes(usecase, permissions, null);
    const res = await invoke(routes, "POST", "/attendance/calculated/date-shift", staffReq({
      decoded: { id: 3, employee_id: 404, designation_id: EDITOR_DESIGNATION, user_type: 1 },
      body,
    }));
    assert.equal(res.statusCode, 404);
  });
});
