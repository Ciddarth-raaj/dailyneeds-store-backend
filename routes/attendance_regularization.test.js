/**
 * Attendance v2 - the regularization router's self-only raise.
 *
 *   node --test routes/attendance_regularization.test.js
 *
 * The self route is proved through the REAL usecase (usecase/
 * attendance_regularization.js) over a fake repository, so the duplicate
 * pending request and the forced actor are the real behaviour, not a stub.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./attendance_regularization");
const buildUsecase = require("../usecase/attendance_regularization");
const P = require("../constants/hr_permissions");

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

const guards = guardsOf(buildRoutes({}, tagging, null));
const find = (method, path) => guards.find((g) => g.method === method && g.path === path);

describe("the endpoints and their guards", () => {
  it("adds the self-only raise beside the existing four", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      [
        "GET /attendance/approvals",
        "GET /attendance/approvals/count",
        "GET /attendance/regularization/:request_id",
        "GET /attendance/regularization/pending",
        "POST /attendance/me/ot-request",
        "POST /attendance/me/regularization",
        "POST /attendance/regularization",
        "POST /attendance/regularization/:request_id/decision",
      ]
    );
  });

  it("the approval screens' list and count are behind view_attendance_approvals", () => {
    assert.deepEqual(find("GET", "/attendance/approvals").guard, { mode: "any", keys: [P.VIEW_ATTENDANCE_APPROVALS] });
    assert.deepEqual(find("GET", "/attendance/approvals/count").guard, { mode: "any", keys: [P.VIEW_ATTENDANCE_APPROVALS] });
  });

  it("the self raises need an employee identity and no permission key; the HR raise is unchanged", () => {
    assert.deepEqual(find("POST", "/attendance/me/regularization").guard, { mode: "self", keys: [] });
    assert.deepEqual(find("POST", "/attendance/me/ot-request").guard, { mode: "self", keys: [] });
    assert.deepEqual(find("POST", "/attendance/regularization").guard, {
      mode: "any",
      keys: [P.RAISE_ATTENDANCE_REGULARIZATION],
    });
  });
});

/* ------------------------------------------------------ handler tests */

async function invoke(routes, method, path, req) {
  const layer = routes
    .getRouter()
    .stack.find((l) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()]);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  for (const handle of layer.route.stack.map((s) => s.handle)) {
    // eslint-disable-next-line no-await-in-loop
    const proceeded = await new Promise((resolve) => {
      const maybe = handle(req, res, () => resolve(true));
      Promise.resolve(maybe).then(() => resolve(false));
    });
    if (!proceeded) break;
  }
  return res;
}

const EMPLOYEE_A = 101;
const EMPLOYEE_B = 202;

/** A missing-punch day for A: one punch. The proposed punch completes it. */
const oddDay = (employee_id) => ({
  employee_id,
  attendance_date: "2026-09-14",
  shift_snapshot: { work_shift_id: 7, snapshot_hash: "abc" },
  punch_count: 1,
  candidate_ot_minutes: 0,
  worked_minutes: 0,
  is_final: false,
});

function wire(state = {}) {
  const calls = { created: [], ranges: [] };
  const repo = {
    getApprovalIdentity: async (id) => ({
      employee_id: id,
      employee_name: `Employee ${id}`,
      outlet_id: 3,
      designation_id: 11,
      designation_name: "SALES ASSOCIATE",
      approver_role: null,
      requester_class: null,
    }),
    findOpenRequest: async () => state.openRequest || null,
    createRequest: async ({ request, chain, punch }) => {
      calls.created.push({ request, chain, punch });
      return { attendance_approval_request_id: 501, total_stages: chain.length };
    },
  };
  const calculation = {
    calculateRange: async (args) => {
      calls.ranges.push(args);
      return [oddDay(args.employee_id)];
    },
    attendanceDateForPunchTime: async () => "2026-09-14",
    calculateProposedDay: async ({ employee_id }) => ({
      ...oddDay(employee_id),
      punch_count: 2,
      status: "FINAL",
      worked_minutes: 660,
      candidate_ot_minutes: 0,
    }),
  };
  const usecase = buildUsecase(repo, calculation);
  return { routes: buildRoutes(usecase, tagging, null), calls };
}

const selfReq = (body, decoded = { id: 1, employee_id: EMPLOYEE_A, designation_id: 5, user_type: 1 }) => ({
  decoded,
  query: {},
  body,
});

const goodBody = {
  attendance_date: "2026-09-14",
  punch_time: "2026-09-14 22:05:00",
  reason: "Forgot to punch out at closing",
};

describe("POST /attendance/me/regularization", () => {
  it("raises the request FOR the caller, BY the caller, whatever else is sent", async () => {
    const { routes, calls } = wire();
    const res = await invoke(routes, "POST", "/attendance/me/regularization", selfReq(goodBody));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.attendance_approval_request_id, 501);
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].request.requested_for_employee_id, EMPLOYEE_A);
    assert.equal(calls.created[0].request.requested_by_employee_id, EMPLOYEE_A);
    assert.equal(calls.created[0].punch.punch_time, "2026-09-14 22:05:00");
    // The day it recalculated was the caller's, not anybody else's.
    calls.ranges.forEach((r) => assert.equal(r.employee_id, EMPLOYEE_A));
  });

  it("cannot be pointed at Employee B: requested_for_employee_id is refused outright", async () => {
    const { routes, calls } = wire();
    const res = await invoke(routes, "POST", "/attendance/me/regularization", selfReq({
      ...goodBody,
      requested_for_employee_id: EMPLOYEE_B,
    }));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.msg, /"requested_for_employee_id" is not allowed/);
    assert.equal(calls.created.length, 0);
  });

  it("has no field for an existing punch id, so a Biomax punch can never be named", async () => {
    const { routes, calls } = wire();
    const res = await invoke(routes, "POST", "/attendance/me/regularization", selfReq({
      ...goodBody,
      punch_id: 77,
    }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.created.length, 0);
  });

  it("requires a reason (backend validation, not the screen)", async () => {
    const { routes, calls } = wire();
    for (const reason of [undefined, "", "abc"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await invoke(routes, "POST", "/attendance/me/regularization", selfReq({ ...goodBody, reason }));
      assert.equal(res.statusCode, 400, `reason=${JSON.stringify(reason)}`);
    }
    assert.equal(calls.created.length, 0);
  });

  it("requires the missing punch time", async () => {
    const { routes, calls } = wire();
    const { punch_time, ...withoutTime } = goodBody;
    const res = await invoke(routes, "POST", "/attendance/me/regularization", selfReq(withoutTime));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.created.length, 0);
  });

  it("refuses a duplicate while a request for the date is still pending, and says which one", async () => {
    const { routes, calls } = wire({
      openRequest: { attendance_approval_request_id: 480, status: "PENDING" },
    });
    const res = await invoke(routes, "POST", "/attendance/me/regularization", selfReq(goodBody));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.msg, /already an open request for 2026-09-14 \(#480\)/);
    assert.equal(calls.created.length, 0);
  });

  it("a system account cannot raise one; an unauthenticated call cannot either", async () => {
    const { routes, calls } = wire();
    const sys = await invoke(routes, "POST", "/attendance/me/regularization", selfReq(goodBody, {
      id: 1, employee_id: null, designation_id: null, user_type: 1, is_system_account: true,
    }));
    assert.equal(sys.statusCode, 403);
    const anon = await invoke(routes, "POST", "/attendance/me/regularization", { query: {}, body: goodBody });
    assert.equal(anon.statusCode, 401);
    assert.equal(calls.created.length, 0);
  });
});
