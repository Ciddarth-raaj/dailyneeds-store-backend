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

/** EVERY guard on a route, in order - a route may carry more than one. */
function allGuardsOf(routes, method, path) {
  for (const layer of routes.getRouter().stack) {
    if (!layer.route) continue;
    if (Object.keys(layer.route.methods)[0].toUpperCase() !== method) continue;
    if (layer.route.path !== path) continue;
    return layer.route.stack.map((s) => s.handle.__guard).filter(Boolean);
  }
  return [];
}

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
  it("adds the self-only raise beside the existing four, and the one-day shift request beside them", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      [
        "GET /attendance/approvals",
        // BULK: the ids a "select all matching" would action, and the thin
        // loop over the single-record actions (routes/attendance_approval_bulk.test.js).
        "GET /attendance/approvals/bulk-targets",
        "GET /attendance/approvals/count",
        "GET /attendance/me/shift-change/options",
        "GET /attendance/regularization/:request_id",
        "GET /attendance/regularization/pending",
        // ADMIN REVOKE: its own endpoint, administrators only - checked in the
        // handler on user_type, not by a grantable key (see
        // usecase/attendance_approval_revoke.test.js for the refusals).
        "POST /attendance/approvals/:request_id/revoke",
        "POST /attendance/approvals/bulk",
        "POST /attendance/me/ot-request",
        // PERMISSION: for yourself (self + key), or for an employee in your
        // outlet scope (for-others key + scope check in the handler).
        "POST /attendance/me/permission-request",
        "POST /attendance/me/regularization",
        "POST /attendance/me/shift-change",
        "POST /attendance/permission-request",
        "POST /attendance/regularization",
        "POST /attendance/regularization/:request_id/decision",
        // LOCKED-PERIOD CORRECTION: the separate authorisation, Payroll's
        // list and the manual settlement.
        "GET /attendance/locked-period-corrections",
        "POST /attendance/regularization/:request_id/locked-period-authorisation",
        "POST /attendance/locked-period-corrections/requests/:request_id/settle",
      ].sort()
    );
  });

  it("the approval screens' list and count are behind view_attendance_approvals", () => {
    assert.deepEqual(find("GET", "/attendance/approvals").guard, { mode: "any", keys: [P.VIEW_ATTENDANCE_APPROVALS] });
    assert.deepEqual(find("GET", "/attendance/approvals/count").guard, { mode: "any", keys: [P.VIEW_ATTENDANCE_APPROVALS] });
  });

  it("the one-day shift request carries BOTH guards: self, so it can only ever be your own attendance, and the key, which reaches the endpoint", () => {
    const routes = buildRoutes({}, tagging, null);
    assert.deepEqual(allGuardsOf(routes, "POST", "/attendance/me/shift-change"), [
      { mode: "self", keys: [] },
      { mode: "any", keys: [P.RAISE_SHIFT_CHANGE_REQUEST] },
    ]);
    assert.deepEqual(allGuardsOf(routes, "GET", "/attendance/me/shift-change/options"), [
      { mode: "self", keys: [] },
      { mode: "any", keys: [P.RAISE_SHIFT_CHANGE_REQUEST] },
    ]);
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

/** A complete FINAL day for A, with 45 minutes of overtime the engine found. */
const otDay = (employee_id) => ({
  employee_id,
  attendance_date: "2026-09-14",
  shift_snapshot: { work_shift_id: 7, snapshot_hash: "abc" },
  punch_count: 2,
  candidate_ot_minutes: 45,
  worked_minutes: 705,
  status: "FINAL",
  is_final: true,
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
    findRequestsForDates: async () => state.requestsForDate || [],
    createRequest: async ({ request, chain, punch }) => {
      calls.created.push({ request, chain, punch });
      return { attendance_approval_request_id: 501, total_stages: chain.length };
    },
  };
  const calculation = {
    calculateRange: async (args) => {
      calls.ranges.push(args);
      // `otDay` is a COMPLETE day with overtime on it - what the OT route
      // needs, and deliberately the engine's own figure rather than
      // anything the caller could have influenced.
      return [state.otDay ? otDay(args.employee_id) : oddDay(args.employee_id)];
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

/**
 * THE OT REQUEST, from the router down.
 *
 * The employee is the token's and the minutes are the engine's - neither is
 * a field on this endpoint, and both are proved here rather than trusted to
 * the screen that happens to omit them today.
 */
describe("POST /attendance/me/ot-request", () => {
  const otBody = { attendance_date: "2026-09-14", reason: "Stock count ran late" };

  it("submits against the CALLER and stores the engine's own OT minutes", async () => {
    const { routes, calls } = wire({ otDay: true });
    const res = await invoke(routes, "POST", "/attendance/me/ot-request", selfReq(otBody));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].request.requested_for_employee_id, EMPLOYEE_A);
    assert.equal(calls.created[0].request.requested_by_employee_id, EMPLOYEE_A);
    assert.equal(calls.created[0].request.request_type, "OT");
    assert.equal(calls.created[0].request.candidate_ot_minutes, 45, "the engine's figure");
    assert.equal(calls.created[0].punch, null, "an OT request carries no punch");
    calls.ranges.forEach((r) => assert.equal(r.employee_id, EMPLOYEE_A));
  });

  it("cannot be pointed at Employee B, however the payload is dressed up", async () => {
    for (const extra of [
      { requested_for_employee_id: EMPLOYEE_B },
      { employee_id: EMPLOYEE_B },
    ]) {
      const { routes, calls } = wire({ otDay: true });
      // eslint-disable-next-line no-await-in-loop
      const res = await invoke(routes, "POST", "/attendance/me/ot-request", selfReq({ ...otBody, ...extra }));
      assert.equal(res.statusCode, 400, JSON.stringify(extra));
      assert.equal(calls.created.length, 0);
    }
  });

  it("has no field for a duration: minutes sent by a client are refused outright", async () => {
    for (const extra of [
      { candidate_ot_minutes: 600 },
      { approved_ot_minutes: 600 },
      { ot_minutes: 600 },
    ]) {
      const { routes, calls } = wire({ otDay: true });
      // eslint-disable-next-line no-await-in-loop
      const res = await invoke(routes, "POST", "/attendance/me/ot-request", selfReq({ ...otBody, ...extra }));
      assert.equal(res.statusCode, 400, JSON.stringify(extra));
      assert.match(res.body.msg, /is not allowed/);
      assert.equal(calls.created.length, 0);
    }
  });

  it("requires a reason, exactly as the correction request does", async () => {
    const { routes, calls } = wire({ otDay: true });
    for (const reason of [undefined, "", "abc"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await invoke(routes, "POST", "/attendance/me/ot-request", selfReq({ ...otBody, reason }));
      assert.equal(res.statusCode, 400, `reason=${JSON.stringify(reason)}`);
    }
    assert.equal(calls.created.length, 0);
  });

  it("refuses a second OT request for a date that already has one", async () => {
    const { routes, calls } = wire({
      otDay: true,
      requestsForDate: [
        { attendance_approval_request_id: 480, request_type: "OT", status: "PENDING", attendance_date: "2026-09-14" },
      ],
    });
    const res = await invoke(routes, "POST", "/attendance/me/ot-request", selfReq(otBody));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.msg, /already pending \(#480\)/);
    assert.equal(calls.created.length, 0);
  });

  it("refuses OT while an attendance correction on the date is still open", async () => {
    const { routes, calls } = wire({
      otDay: true,
      requestsForDate: [
        { attendance_approval_request_id: 481, request_type: "REGULARIZATION", status: "PENDING", attendance_date: "2026-09-14" },
      ],
    });
    const res = await invoke(routes, "POST", "/attendance/me/ot-request", selfReq(otBody));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.msg, /open attendance request \(#481\); OT can be requested once it is decided/);
    assert.equal(calls.created.length, 0);
  });

  it("refuses an incomplete day - its overtime is a guess until the punch is corrected", async () => {
    const { routes, calls } = wire();
    const res = await invoke(routes, "POST", "/attendance/me/ot-request", selfReq(otBody));
    assert.equal(res.statusCode, 400);
    assert.match(res.body.msg, /not a complete attendance day/);
    assert.equal(calls.created.length, 0);
  });

  it("a system account cannot raise one; an unauthenticated call cannot either", async () => {
    const { routes, calls } = wire({ otDay: true });
    const sys = await invoke(routes, "POST", "/attendance/me/ot-request", selfReq(otBody, {
      id: 1, employee_id: null, designation_id: null, user_type: 1, is_system_account: true,
    }));
    assert.equal(sys.statusCode, 403);
    const anon = await invoke(routes, "POST", "/attendance/me/ot-request", { query: {}, body: otBody });
    assert.equal(anon.statusCode, 401);
    assert.equal(calls.created.length, 0);
  });
});

/**
 * A MISSED BREAK (lunch OUT + IN) through the existing HR raise. Manager/HR
 * only: it takes `raise_attendance_regularization_for_others`, and the self
 * route has no field for it at all.
 */
describe("POST /attendance/regularization - a missed break", () => {
  const breakBody = {
    requested_for_employee_id: EMPLOYEE_B,
    attendance_date: "2026-09-12",
    break_out_time: "2026-09-12 14:00:00",
    break_in_time: "2026-09-12 15:00:00",
    reason: "Took lunch 2-3pm, forgot to punch",
  };
  // The outlet scope: EMPLOYEE_B is in the caller's outlet, 303 is not.
  const scope = {
    checkEmployee: async (req, id) =>
      Number(id) === 303 ? { ok: false, reason: "OUT_OF_BRANCH", msg: "Not in your branch" } : { ok: true },
    refuse: (res, outcome) => res.status(403).json({ code: 403, msg: outcome.msg }),
  };
  const wireHr = (held, branchScope = scope) => {
    const raised = [];
    const usecase = {
      raiseRequest: async (args) => {
        raised.push(args);
        return { attendance_approval_request_id: 900, regularization_kind: "MISSED_BREAK" };
      },
    };
    const permissions = {
      require: () => (req, res, next) => next(),
      has: async (req, key) => held.includes(key),
    };
    return { routes: buildRoutes(usecase, permissions, null, branchScope), raised };
  };
  const hrReq = (body) => ({ decoded: { id: 2, employee_id: 7, user_type: 1 }, query: {}, body });

  it("passes the OUT and IN to the same raiseRequest when the caller holds the for-others key", async () => {
    const { routes, raised } = wireHr([P.RAISE_ATTENDANCE_REGULARIZATION_FOR_OTHERS]);
    const res = await invoke(routes, "POST", "/attendance/regularization", hrReq(breakBody));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(raised.length, 1);
    assert.equal(raised[0].requested_for_employee_id, EMPLOYEE_B);
    assert.equal(raised[0].break_out_time, "2026-09-12 14:00:00");
    assert.equal(raised[0].break_in_time, "2026-09-12 15:00:00");
    assert.equal(raised[0].punch_time, null);
  });

  it("is refused without raise_attendance_regularization_for_others, even for yourself", async () => {
    const { routes, raised } = wireHr([]);
    const res = await invoke(routes, "POST", "/attendance/regularization", hrReq({ ...breakBody, requested_for_employee_id: 7 }));
    assert.equal(res.statusCode, 403);
    assert.equal(raised.length, 0);
  });

  it("applies the outlet scope to somebody else's attendance, missing punch and lunch alike", async () => {
    const { routes, raised } = wireHr([P.RAISE_ATTENDANCE_REGULARIZATION_FOR_OTHERS]);
    const lunch = await invoke(routes, "POST", "/attendance/regularization", hrReq({ ...breakBody, requested_for_employee_id: 303 }));
    assert.equal(lunch.statusCode, 403);
    assert.match(lunch.body.msg, /Not in your branch/);
    const missing = await invoke(routes, "POST", "/attendance/regularization", hrReq({
      requested_for_employee_id: 303,
      attendance_date: "2026-09-14",
      punch_time: "2026-09-14 22:05:00",
      reason: "Forgot to punch out at closing",
    }));
    assert.equal(missing.statusCode, 403);
    assert.equal(raised.length, 0);
  });

  it("fails closed when no outlet scope is wired", async () => {
    const { routes, raised } = wireHr([P.RAISE_ATTENDANCE_REGULARIZATION_FOR_OTHERS], null);
    const res = await invoke(routes, "POST", "/attendance/regularization", hrReq(breakBody));
    assert.equal(res.statusCode, 403);
    assert.equal(raised.length, 0);
  });

  it("refuses an employee who alters the HR request to file lunch punches for themselves without the key", async () => {
    const { routes, raised } = wireHr([P.RAISE_ATTENDANCE_REGULARIZATION]);
    const res = await invoke(routes, "POST", "/attendance/regularization", hrReq({ ...breakBody, requested_for_employee_id: undefined }));
    assert.equal(res.statusCode, 403);
    assert.match(res.body.msg, /raise_attendance_regularization_for_others/);
    assert.equal(raised.length, 0);
  });

  it("refuses half a pair, and a missing punch and a break in one body", async () => {
    const { routes, raised } = wireHr([P.RAISE_ATTENDANCE_REGULARIZATION_FOR_OTHERS]);
    const { break_in_time, ...half } = breakBody;
    assert.equal((await invoke(routes, "POST", "/attendance/regularization", hrReq(half))).statusCode, 400);
    assert.equal(
      (await invoke(routes, "POST", "/attendance/regularization", hrReq({ ...breakBody, punch_time: "2026-09-12 22:05:00" })))
        .statusCode,
      400
    );
    assert.equal(raised.length, 0);
  });

  it("the plain missing-punch raise is unchanged", async () => {
    const { routes, raised } = wireHr([]);
    const res = await invoke(routes, "POST", "/attendance/regularization", hrReq({
      attendance_date: "2026-09-14",
      punch_time: "2026-09-14 22:05:00",
      reason: "Forgot to punch out at closing",
    }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(raised[0].punch_time, "2026-09-14 22:05:00");
    assert.equal(raised[0].break_out_time, null);
  });

  it("the self route has no field for a break", async () => {
    const { routes, calls } = wire();
    const res = await invoke(routes, "POST", "/attendance/me/regularization", selfReq({
      attendance_date: "2026-09-12",
      break_out_time: "2026-09-12 14:00:00",
      break_in_time: "2026-09-12 15:00:00",
      reason: "Took lunch 2-3pm, forgot to punch",
    }));
    assert.equal(res.statusCode, 400);
    assert.equal(calls.created.length, 0);
  });
});


/**
 * LOCKED-PERIOD CORRECTION routes: the key, the outlet scope, the settlement.
 */
describe("locked-period correction routes", () => {
  const allGuards = guardsOf(buildRoutes({}, tagging, null));
  const g = (m, p) => allGuards.find((x) => x.method === m && x.path === p);
  it("authorise needs correct_locked_attendance; settle needs process_payroll", () => {
    assert.deepEqual(g("POST", "/attendance/regularization/:request_id/locked-period-authorisation").guard, { mode: "any", keys: [P.CORRECT_LOCKED_ATTENDANCE] });
    assert.deepEqual(g("POST", "/attendance/locked-period-corrections/requests/:request_id/settle").guard, { mode: "any", keys: [P.PROCESS_PAYROLL] });
  });

  const scope = {
    checkEmployee: async (req, id) => (Number(id) === 303 ? { ok: false, msg: "Not in your branch" } : { ok: true }),
    refuse: (res, o) => res.status(403).json({ code: 403, msg: o.msg }),
    resolve: async () => ({ kind: "OWN_BRANCHES", store_ids: [3] }),
  };
  const wireLocked = (held, employeeFor = 202) => {
    const calls = { authorised: [], raised: [], settled: [] };
    const usecase = {
      requestEmployeeId: async (id) => (Number(id) === 901 ? 303 : employeeFor),
      authoriseLockedCorrection: async (args) => { calls.authorised.push(args); return { status: "AUTHORISED" }; },
      raiseRequest: async (args) => { calls.raised.push(args); return { attendance_approval_request_id: 1 }; },
      listLockedCorrections: async () => ({
        corrections: [
          { attendance_locked_period_correction_event_id: 1, employee_id: 202, store_id: 3 },
          { attendance_locked_period_correction_event_id: 2, employee_id: 303, store_id: 9 },
        ],
        outstanding: [
          { attendance_approval_request_id: 900, employee_id: 202, store_id: 3, net_difference: -66.66 },
          { attendance_approval_request_id: 901, employee_id: 303, store_id: 9, net_difference: 10 },
        ],
      }),
      settleLockedCorrection: async (args) => { calls.settled.push(args); return { code: 200, adjustment_status: "SETTLED" }; },
    };
    const permissions = { require: () => (req, res, next) => next(), has: async (req, ...keys) => keys.some((k) => held.includes(k)) };
    return { routes: buildRoutes(usecase, permissions, null, scope), calls };
  };
  const req = (body = {}, params = {}, query = {}) => ({ decoded: { id: 2, employee_id: 8, user_type: 1 }, body, params, query });

  it("authorise: in scope -> passes the reason through; out of scope -> 403; no reason -> 400", async () => {
    const ok = wireLocked([P.CORRECT_LOCKED_ATTENDANCE]);
    const res = await invoke(ok.routes, "POST", "/attendance/regularization/:request_id/locked-period-authorisation", req({ reason: "Verified with CCTV" }, { request_id: "900" }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(ok.calls.authorised[0].request_id, 900);
    assert.equal(ok.calls.authorised[0].reason, "Verified with CCTV");
    const out = wireLocked([P.CORRECT_LOCKED_ATTENDANCE], 303);
    assert.equal((await invoke(out.routes, "POST", "/attendance/regularization/:request_id/locked-period-authorisation", req({ reason: "Verified with CCTV" }, { request_id: "900" }))).statusCode, 403);
    assert.equal(out.calls.authorised.length, 0);
    assert.equal((await invoke(ok.routes, "POST", "/attendance/regularization/:request_id/locked-period-authorisation", req({}, { request_id: "900" }))).statusCode, 400);
  });

  it("the raise passes allow_locked_period only to holders of the for-others key", async () => {
    const hr = wireLocked([P.RAISE_ATTENDANCE_REGULARIZATION_FOR_OTHERS]);
    await invoke(hr.routes, "POST", "/attendance/regularization", req({ requested_for_employee_id: 202, attendance_date: "2026-09-12", punch_time: "2026-09-12 22:04:00", reason: "Forgot to punch out" }));
    assert.equal(hr.calls.raised[0].allow_locked_period, true);
    const plain = wireLocked([]);
    await invoke(plain.routes, "POST", "/attendance/regularization", req({ attendance_date: "2026-09-12", punch_time: "2026-09-12 22:04:00", reason: "Forgot to punch out" }));
    assert.equal(plain.calls.raised[0].allow_locked_period, false);
  });

  it("Payroll's list is filtered to the caller's outlet scope, and refused without a payroll key", async () => {
    const payroll = wireLocked([P.VIEW_PAYROLL]);
    const res = await invoke(payroll.routes, "GET", "/attendance/locked-period-corrections", req());
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.corrections.map((c) => c.attendance_locked_period_correction_event_id), [1]);
    assert.deepEqual(res.body.outstanding.map((o) => o.attendance_approval_request_id), [900], "outstanding is scoped too");
    assert.equal(res.body.pending_adjustment_count, 1, "the count is the in-scope outstanding nets");
    const nobody = wireLocked([]);
    assert.equal((await invoke(nobody.routes, "GET", "/attendance/locked-period-corrections", req())).statusCode, 403);
  });

  it("settle: per REQUEST, validated, scoped, passed through", async () => {
    const w = wireLocked([P.PROCESS_PAYROLL]);
    const body = { applied_payroll_year: 2026, applied_payroll_month: 10, applied_note: "Shortage recovery in October" };
    const path = "/attendance/locked-period-corrections/requests/:request_id/settle";
    assert.equal((await invoke(w.routes, "POST", path, req(body, { request_id: "900" }))).statusCode, 200);
    assert.equal(w.calls.settled[0].request_id, 900);
    assert.equal(w.calls.settled[0].applied_payroll_month, 10);
    assert.equal((await invoke(w.routes, "POST", path, req(body, { request_id: "901" }))).statusCode, 403, "out of scope");
    assert.equal((await invoke(w.routes, "POST", path, req({ applied_payroll_year: 2026 }, { request_id: "900" }))).statusCode, 400);
  });
});
