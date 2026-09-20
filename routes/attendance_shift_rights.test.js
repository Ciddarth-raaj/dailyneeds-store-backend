/**
 * THE SHIFT-SPECIFIC RIGHTS, ENFORCED SERVER-SIDE.
 *
 *   node --test routes/attendance_shift_rights.test.js
 *
 * `view_shift_change_requests` and `approve_shift_change_request` are declared
 * by the feature and granted to nobody by its migration. This file is what
 * makes them mean something: it drives the REAL router - every middleware on
 * the route, in order - over a permission stub that answers from an explicit
 * key set, and proves that a caller holding only the generic Attendance/OT
 * keys cannot list, count, read or decide a SHIFT_CHANGE, while Attendance and
 * OT behave exactly as they did before.
 *
 * The keys are the PERMISSION TO USE THE FUNCTION. They are not the AUTHORITY
 * to act on a stage - `canApprove` inside the usecase still decides that - so
 * one test here holds both keys and is still refused by the chain.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./attendance_regularization");
const P = require("../constants/hr_permissions");

const ADMIN_USER_TYPE = 2;

/**
 * The repo's own permission middleware, reduced to its decisions: `has` is
 * OR, `hasAll` is AND, and `user_type` 2 is allowed everything. Anything that
 * diverges from `middlewares/permissions.js` here would make these tests lie,
 * so it deliberately mirrors that file rather than inventing a shape.
 */
function permissionsFor(keys, userType = 1) {
  const held = new Set(keys);
  const allowAll = Number(userType) === ADMIN_USER_TYPE;
  const has = async (req, ...wanted) => allowAll || wanted.some((k) => held.has(k));
  const hasAll = async (req, ...wanted) =>
    allowAll || (wanted.length > 0 && wanted.every((k) => held.has(k)));
  const deny = (res) =>
    res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
  return {
    has,
    hasAll,
    require: (...wanted) => async (req, res, next) =>
      (await has(req, ...wanted)) ? next() : deny(res),
    requireAll: (...wanted) => async (req, res, next) =>
      (await hasAll(req, ...wanted)) ? next() : deny(res),
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.ended = true;
    return res;
  };
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}

/** Run every handler on the matching route, in order, until one responds. */
async function call(routes, method, path, req) {
  for (const layer of routes.getRouter().stack) {
    if (!layer.route) continue;
    if (Object.keys(layer.route.methods)[0].toUpperCase() !== method) continue;
    if (layer.route.path !== path) continue;
    const res = fakeRes();
    for (const handler of layer.route.stack) {
      let advanced = false;
      // eslint-disable-next-line no-await-in-loop
      await handler.handle(req, res, () => {
        advanced = true;
      });
      if (res.ended) return res;
      if (!advanced) return res;
    }
    return res;
  }
  throw new Error(`no route for ${method} ${path}`);
}

const STORED = {
  71: { attendance_approval_request_id: 71, request_type: "SHIFT_CHANGE", status: "PENDING" },
  72: { attendance_approval_request_id: 72, request_type: "OT", status: "PENDING" },
  73: { attendance_approval_request_id: 73, request_type: "REGULARIZATION", status: "PENDING" },
};

/** A usecase that records what it was asked, so "never reached" is provable. */
function usecaseSpy(overrides = {}) {
  const calls = [];
  return {
    calls,
    getRequest: async (id) => STORED[Number(id)] || null,
    listApprovals: async (args) => {
      calls.push(["listApprovals", args.request_type]);
      return { rows: [], total: 0 };
    },
    countPending: async (args) => {
      calls.push(["countPending", args.request_type]);
      return { count: 0 };
    },
    listPending: async () => {
      calls.push(["listPending"]);
      return { rows: [] };
    },
    decide: async (args) => {
      calls.push(["decide", args.request_id, args.decision, args.source]);
      return { code: 200, status: "APPROVED" };
    },
    ...overrides,
  };
}

const req = (permissions, extra = {}) => ({
  decoded: { employee_id: 9001, user_type: 1, designation_id: 5 },
  query: {},
  body: {},
  params: {},
  ...extra,
  __permissions: permissions,
});

const GENERIC_VIEW = [P.VIEW_ATTENDANCE_APPROVALS];
const GENERIC_APPROVE = [P.VIEW_ATTENDANCE_APPROVALS, P.APPROVE_ATTENDANCE_REGULARIZATION];
const SHIFT_VIEW = [P.VIEW_ATTENDANCE_APPROVALS, P.VIEW_SHIFT_CHANGE_REQUESTS];
const SHIFT_APPROVE = [
  P.VIEW_ATTENDANCE_APPROVALS,
  P.APPROVE_ATTENDANCE_REGULARIZATION,
  P.APPROVE_SHIFT_CHANGE_REQUEST,
];

const build = (keys, usecase, userType = 1) =>
  buildRoutes(usecase, permissionsFor(keys, userType), null, null);

describe("the generic view key alone cannot reach SHIFT_CHANGE", () => {
  it("1. cannot LIST shift changes, and the usecase is never asked", async () => {
    const usecase = usecaseSpy();
    const routes = build(GENERIC_VIEW, usecase);
    const res = await call(routes, "GET", "/attendance/approvals", req(null, {
      query: { request_type: "SHIFT_CHANGE" },
    }));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(usecase.calls, []);
  });

  it("2. cannot COUNT shift changes", async () => {
    const usecase = usecaseSpy();
    const routes = build(GENERIC_VIEW, usecase);
    const res = await call(routes, "GET", "/attendance/approvals/count", req(null, {
      query: { request_type: "SHIFT_CHANGE" },
    }));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(usecase.calls, []);
  });

  it("3. cannot fetch a SHIFT_CHANGE DETAIL directly - the type comes from the stored row, not the caller", async () => {
    const usecase = usecaseSpy();
    const routes = build(GENERIC_VIEW, usecase);
    const res = await call(routes, "GET", "/attendance/regularization/:request_id", req(null, {
      params: { request_id: "71" },
      // A client asserting a type it does not have cannot help itself: the
      // route reads no request_type at all.
      query: { request_type: "OT" },
    }));
    assert.equal(res.statusCode, 403);
  });

  it("an unknown id is a 404 whether or not the caller holds the Shift key", async () => {
    for (const keys of [GENERIC_VIEW, SHIFT_VIEW]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(build(keys, usecaseSpy()), "GET", "/attendance/regularization/:request_id", req(null, {
        params: { request_id: "999" },
      }));
      assert.equal(res.statusCode, 404);
    }
  });
});

describe("the generic approval key alone cannot decide a SHIFT_CHANGE", () => {
  it("4. approve and reject are both refused, and `decide` is never called", async () => {
    for (const decision of ["APPROVED", "REJECTED"]) {
      const usecase = usecaseSpy();
      const routes = build(GENERIC_APPROVE, usecase);
      // eslint-disable-next-line no-await-in-loop
      const res = await call(routes, "POST", "/attendance/regularization/:request_id/decision", req(null, {
        params: { request_id: "71" },
        body: { decision },
      }));
      assert.equal(res.statusCode, 403);
      assert.deepEqual(usecase.calls, []);
    }
  });

  it("the VIEW key is not the DECIDE key: holding view_shift_change_requests still cannot decide", async () => {
    const usecase = usecaseSpy();
    const routes = build([...SHIFT_VIEW, P.APPROVE_ATTENDANCE_REGULARIZATION], usecase);
    const res = await call(routes, "POST", "/attendance/regularization/:request_id/decision", req(null, {
      params: { request_id: "71" },
      body: { decision: "APPROVED" },
    }));
    assert.equal(res.statusCode, 403);
    assert.deepEqual(usecase.calls, []);
  });
});

describe("both Shift rights, and the authority check that still follows", () => {
  it("5. can list, count, read and decide Shift", async () => {
    const usecase = usecaseSpy();
    const viewRoutes = build(SHIFT_VIEW, usecase);
    const list = await call(viewRoutes, "GET", "/attendance/approvals", req(null, {
      query: { request_type: "SHIFT_CHANGE" },
    }));
    assert.equal(list.statusCode, 200);
    const count = await call(viewRoutes, "GET", "/attendance/approvals/count", req(null, {
      query: { request_type: "SHIFT_CHANGE" },
    }));
    assert.equal(count.statusCode, 200);
    const detail = await call(viewRoutes, "GET", "/attendance/regularization/:request_id", req(null, {
      params: { request_id: "71" },
    }));
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.request.request_type, "SHIFT_CHANGE");

    const decideUsecase = usecaseSpy();
    const decideRoutes = build(SHIFT_APPROVE, decideUsecase);
    const decided = await call(decideRoutes, "POST", "/attendance/regularization/:request_id/decision", req(null, {
      params: { request_id: "71" },
      body: { decision: "APPROVED" },
    }));
    assert.equal(decided.statusCode, 200);
    assert.deepEqual(decideUsecase.calls, [["decide", 71, "APPROVED", "WEB"]]);
  });

  it("6. the keys are not the authority: the right rights at the WRONG STAGE are still refused by the chain", async () => {
    const forbidden = Object.assign(new Error("This stage is with the Store Manager"), {
      name: "ForbiddenError",
    });
    const usecase = usecaseSpy({
      decide: async () => {
        throw forbidden;
      },
    });
    const routes = build(SHIFT_APPROVE, usecase);
    const res = await call(routes, "POST", "/attendance/regularization/:request_id/decision", req(null, {
      params: { request_id: "71" },
      body: { decision: "APPROVED" },
    }));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.msg, "This stage is with the Store Manager");
  });
});

describe("Attendance and OT are untouched", () => {
  it("7. the Attendance list and count still work on the generic key alone", async () => {
    const usecase = usecaseSpy();
    const routes = build(GENERIC_VIEW, usecase);
    const list = await call(routes, "GET", "/attendance/approvals", req(null, {
      query: { request_type: "REGULARIZATION" },
    }));
    assert.equal(list.statusCode, 200);
    const count = await call(routes, "GET", "/attendance/approvals/count", req(null, {
      query: { request_type: "REGULARIZATION" },
    }));
    assert.equal(count.statusCode, 200);
    assert.deepEqual(usecase.calls, [
      ["listApprovals", "REGULARIZATION"],
      ["countPending", "REGULARIZATION"],
    ]);
  });

  it("8. the OT list and count still work on the generic key alone", async () => {
    const usecase = usecaseSpy();
    const routes = build(GENERIC_VIEW, usecase);
    const list = await call(routes, "GET", "/attendance/approvals", req(null, {
      query: { request_type: "OT" },
    }));
    assert.equal(list.statusCode, 200);
    const count = await call(routes, "GET", "/attendance/approvals/count", req(null, {
      query: { request_type: "OT" },
    }));
    assert.equal(count.statusCode, 200);
    assert.deepEqual(usecase.calls, [["listApprovals", "OT"], ["countPending", "OT"]]);
  });

  it("9. an Attendance and an OT decision need no Shift key, and the detail route serves both", async () => {
    for (const id of [72, 73]) {
      const usecase = usecaseSpy();
      const routes = build(GENERIC_APPROVE, usecase);
      // eslint-disable-next-line no-await-in-loop
      const detail = await call(routes, "GET", "/attendance/regularization/:request_id", req(null, {
        params: { request_id: String(id) },
      }));
      assert.equal(detail.statusCode, 200);
      // eslint-disable-next-line no-await-in-loop
      const res = await call(routes, "POST", "/attendance/regularization/:request_id/decision", req(null, {
        params: { request_id: String(id) },
        body: { decision: "APPROVED" },
      }));
      assert.equal(res.statusCode, 200);
      assert.deepEqual(usecase.calls, [["decide", id, "APPROVED", "WEB"]]);
    }
  });
});

describe("13. the administrator bypass still comes from the permission framework", () => {
  it("user_type 2 holding NO key reaches Shift list, detail and decision", async () => {
    const usecase = usecaseSpy();
    const routes = build([], usecase, ADMIN_USER_TYPE);
    const adminReq = (extra) => ({
      decoded: { employee_id: 1, user_type: ADMIN_USER_TYPE, designation_id: null },
      query: {},
      body: {},
      params: {},
      ...extra,
    });
    const list = await call(routes, "GET", "/attendance/approvals", adminReq({
      query: { request_type: "SHIFT_CHANGE" },
    }));
    assert.equal(list.statusCode, 200);
    const detail = await call(routes, "GET", "/attendance/regularization/:request_id", adminReq({
      params: { request_id: "71" },
    }));
    assert.equal(detail.statusCode, 200);
    const decided = await call(routes, "POST", "/attendance/regularization/:request_id/decision", adminReq({
      params: { request_id: "71" },
      body: { decision: "APPROVED" },
    }));
    assert.equal(decided.statusCode, 200);
  });
});

/**
 * 10. THE LEGACY GENERIC QUEUE.
 *
 * `GET /attendance/regularization/pending` predates the unified approval
 * centre: it takes no request-type filter and is reached with
 * `view_attendance_approvals` alone. Its query is therefore what has to
 * exclude SHIFT_CHANGE, because there is no key on that route to enforce.
 */
describe("10. the legacy pending queue does not leak Shift rows", () => {
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();
  const buildRegRepo = require("../repository/attendance_regularization");

  function fakeDb(answers = () => []) {
    const log = [];
    const connection = {
      query: (sql, params, cb) => {
        log.push({ sql: norm(sql), params });
        cb(null, answers(norm(sql), params, log.length));
      },
      beginTransaction: (cb) => cb(null),
      commit: (cb) => cb(null),
      rollback: (cb) => cb(),
      release: () => {},
    };
    return { log, db: { query: connection.query, getConnection: (cb) => cb(null, connection) } };
  }

  it("the SQL excludes SHIFT_CHANGE, so the rows can never reach the handler", async () => {
    const { db, log } = fakeDb(() => []);
    await buildRegRepo(db).listPendingFor({
      approver_roles: ["STORE_MANAGER"],
      outlet_id: 3,
      actor_employee_id: 11,
    });
    assert.match(log[0].sql, /r\.request_type <> 'SHIFT_CHANGE'/);
    // and the exclusion sits in the WHERE, not in an OR branch that some
    // other predicate could satisfy around it.
    assert.match(log[0].sql, /WHERE r\.status = 'PENDING' AND s\.decision = 'PENDING' AND r\.request_type <> 'SHIFT_CHANGE'/);
  });

  it("the unified Shift queue is still the one that enforces the key", async () => {
    const usecase = usecaseSpy();
    const res = await call(build(SHIFT_VIEW, usecase), "GET", "/attendance/approvals", req(null, {
      query: { request_type: "SHIFT_CHANGE" },
    }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(usecase.calls, [["listApprovals", "SHIFT_CHANGE"]]);
  });
});
