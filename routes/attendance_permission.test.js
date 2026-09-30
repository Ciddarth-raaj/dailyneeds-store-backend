/**
 * The Permission routes' RIGHTS and OUTLET SCOPE, driven through the real
 * routers over a stub permission service and a stub branch scope.
 *
 *   - granting one named employee needs `grant_attendance_permission`; more
 *     than one, an outlet or everybody needs `grant_attendance_permission_bulk`
 *     as well;
 *   - revoking needs `revoke_attendance_permission`, reading needs
 *     `view_attendance_permissions`;
 *   - the usecase is handed the caller's scope, and an outlet outside it is
 *     refused before the usecase is reached;
 *   - requesting a Permission for yourself needs the self key; for somebody
 *     else, the for-others key AND the employee inside your scope;
 *   - the Approval Centre's PERMISSION tab and decision need the Permission
 *     keys on top of the generic ones.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildPermissionRoutes = require("./attendance_permission");
const buildApprovalRoutes = require("./attendance_regularization");
const P = require("../constants/hr_permissions");

function permissionsFor(keys, userType = 1) {
  const held = new Set(keys);
  const allowAll = Number(userType) === 2;
  const has = async (req, ...wanted) => allowAll || wanted.some((k) => held.has(k));
  const hasAll = async (req, ...wanted) => allowAll || (wanted.length > 0 && wanted.every((k) => held.has(k)));
  const deny = (res) => res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
  return {
    has,
    hasAll,
    require: (...wanted) => async (req, res, next) => ((await has(req, ...wanted)) ? next() : deny(res)),
    requireAll: (...wanted) => async (req, res, next) => ((await hasAll(req, ...wanted)) ? next() : deny(res)),
  };
}

/** A branch-scoped caller at outlet 3. */
const OWN_OUTLET = {
  listFilters: async (req, requested) => {
    const asked = Array.isArray(requested) ? requested.map(Number) : requested ? String(requested).split(",").map(Number) : [];
    if (asked.some((id) => id !== 3)) return { ok: false, reason: "OUT_OF_BRANCH" };
    return { ok: true, store_ids: [3] };
  },
  checkEmployee: async (req, id) => (Number(id) === 42 ? { ok: true } : { ok: false, reason: "OUT_OF_BRANCH" }),
  refuse: (res, outcome) => res.status(403).json({ code: 403, error: outcome.reason }),
  actorFor: async () => ({ branch_scope: { kind: "OWN_BRANCHES", store_ids: [3] } }),
};

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
  return res;
}

async function call(routes, method, path, req) {
  for (const layer of routes.getRouter().stack) {
    if (!layer.route || layer.route.path !== path) continue;
    if (Object.keys(layer.route.methods)[0].toUpperCase() !== method) continue;
    const res = fakeRes();
    for (const handler of layer.route.stack) {
      let advanced = false;
      // eslint-disable-next-line no-await-in-loop
      await handler.handle(req, res, () => {
        advanced = true;
      });
      if (res.ended || !advanced) return res;
    }
    return res;
  }
  throw new Error(`no route for ${method} ${path}`);
}

const spy = () => {
  const calls = [];
  const record = (name) => async (args) => {
    calls.push([name, args]);
    return { code: 200 };
  };
  return {
    calls,
    preview: record("preview"),
    apply: record("apply"),
    list: record("list"),
    revoke: record("revoke"),
    revokeBulkOperation: record("revokeBulkOperation"),
    listBulkOperations: record("listBulkOperations"),
    getBulkOperationItems: record("getBulkOperationItems"),
  };
};

const req = (body = {}, extra = {}) => ({ decoded: { employee_id: 9, id: 90, user_type: 1 }, body, query: {}, params: {}, ...extra });
const GRANT = { attendance_date: "2026-09-14", from_time: "19:00", to_shift_end: true, reason: "Deepavali early closing" };

describe("DIRECT grant rights", () => {
  it("one named employee needs the grant key alone", async () => {
    const usecase = spy();
    const routes = buildPermissionRoutes(usecase, permissionsFor([P.GRANT_ATTENDANCE_PERMISSION]), null, OWN_OUTLET);
    const res = await call(routes, "POST", "/attendance/permissions/preview", req({ ...GRANT, target_mode: "EMPLOYEES", employee_ids: [42] }));
    assert.equal(res.statusCode, 200);
    assert.equal(usecase.calls[0][0], "preview");
    assert.deepEqual(usecase.calls[0][1].scope_store_ids, [3], "the caller's scope is handed down");
  });

  it("several employees, an outlet or everybody need the bulk key as well", async () => {
    for (const target of [
      { target_mode: "EMPLOYEES", employee_ids: [42, 43] },
      { target_mode: "OUTLETS", outlet_ids: [3] },
      { target_mode: "ALL" },
    ]) {
      const usecase = spy();
      const without = buildPermissionRoutes(usecase, permissionsFor([P.GRANT_ATTENDANCE_PERMISSION]), null, OWN_OUTLET);
      // eslint-disable-next-line no-await-in-loop
      const refused = await call(without, "POST", "/attendance/permissions/preview", req({ ...GRANT, ...target }));
      assert.equal(refused.statusCode, 403, JSON.stringify(target));
      assert.equal(usecase.calls.length, 0);
      const withBulk = buildPermissionRoutes(usecase, permissionsFor([P.GRANT_ATTENDANCE_PERMISSION, P.GRANT_ATTENDANCE_PERMISSION_BULK]), null, OWN_OUTLET);
      // eslint-disable-next-line no-await-in-loop
      const ok = await call(withBulk, "POST", "/attendance/permissions/preview", req({ ...GRANT, ...target }));
      assert.equal(ok.statusCode, 200, JSON.stringify(target));
    }
  });

  it("an outlet outside the caller's scope is refused before the usecase", async () => {
    const usecase = spy();
    const routes = buildPermissionRoutes(usecase, permissionsFor([P.GRANT_ATTENDANCE_PERMISSION, P.GRANT_ATTENDANCE_PERMISSION_BULK]), null, OWN_OUTLET);
    const res = await call(routes, "POST", "/attendance/permissions/apply", req({ ...GRANT, target_mode: "OUTLETS", outlet_ids: [5], fingerprint: "a".repeat(64) }));
    assert.equal(res.statusCode, 403);
    assert.equal(usecase.calls.length, 0);
  });

  it("fails closed without the branch scope", async () => {
    const usecase = spy();
    const routes = buildPermissionRoutes(usecase, permissionsFor([P.GRANT_ATTENDANCE_PERMISSION]), null, null);
    const res = await call(routes, "POST", "/attendance/permissions/preview", req({ ...GRANT, target_mode: "EMPLOYEES", employee_ids: [42] }));
    assert.equal(res.statusCode, 403);
  });

  it("apply needs the preview's fingerprint", async () => {
    const usecase = spy();
    const routes = buildPermissionRoutes(usecase, permissionsFor([P.GRANT_ATTENDANCE_PERMISSION]), null, OWN_OUTLET);
    const res = await call(routes, "POST", "/attendance/permissions/apply", req({ ...GRANT, target_mode: "EMPLOYEES", employee_ids: [42] }));
    assert.notEqual(res.statusCode, 200);
    assert.equal(usecase.calls.length, 0);
  });

  it("revoke needs the revoke key; the register needs the view key", async () => {
    const usecase = spy();
    const none = buildPermissionRoutes(usecase, permissionsFor([P.GRANT_ATTENDANCE_PERMISSION]), null, OWN_OUTLET);
    assert.equal((await call(none, "POST", "/attendance/permissions/:attendance_permission_id/revoke", req({ reason: "Changed plans" }, { params: { attendance_permission_id: "5" } }))).statusCode, 403);
    assert.equal((await call(none, "GET", "/attendance/permissions", req({}, { query: { from_date: "2026-09-01", to_date: "2026-09-30" } }))).statusCode, 403);
    const both = buildPermissionRoutes(usecase, permissionsFor([P.REVOKE_ATTENDANCE_PERMISSION, P.VIEW_ATTENDANCE_PERMISSIONS]), null, OWN_OUTLET);
    assert.equal((await call(both, "POST", "/attendance/permissions/:attendance_permission_id/revoke", req({ reason: "Changed plans" }, { params: { attendance_permission_id: "5" } }))).statusCode, 200);
    assert.equal((await call(both, "GET", "/attendance/permissions", req({}, { query: { from_date: "2026-09-01", to_date: "2026-09-30" } }))).statusCode, 200);
    assert.deepEqual(usecase.calls.map((c) => c[0]), ["revoke", "list"]);
    usecase.calls.forEach(([, args]) => assert.deepEqual(args.scope_store_ids, [3]));
  });
});

describe("REQUESTED Permission rights", () => {
  const approvals = (keys) => {
    const calls = [];
    const usecase = {
      raisePermissionRequest: async (args) => {
        calls.push(args);
        return { attendance_approval_request_id: 1 };
      },
      getRequest: async () => ({ attendance_approval_request_id: 5, request_type: "PERMISSION", status: "PENDING" }),
      decide: async () => ({ code: 200 }),
      listApprovals: async () => ({ rows: [] }),
    };
    return { calls, routes: buildApprovalRoutes(usecase, permissionsFor(keys), null, OWN_OUTLET) };
  };
  const BODY = { attendance_date: "2026-09-14", windows: [{ from_time: "20:00", to_shift_end: true }], reason: "Family function" };

  it("for yourself: the self key, and the employee is the token's", async () => {
    const { routes, calls } = approvals([P.RAISE_ATTENDANCE_PERMISSION_REQUEST]);
    const res = await call(routes, "POST", "/attendance/me/permission-request", req(BODY));
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].actor.employee_id, 9);
    assert.equal(calls[0].requested_for_employee_id, undefined);
    const none = approvals([]);
    assert.equal((await call(none.routes, "POST", "/attendance/me/permission-request", req(BODY))).statusCode, 403);
    const named = await call(routes, "POST", "/attendance/me/permission-request", req({ ...BODY, employee_id: 42 }));
    assert.notEqual(named.statusCode, 200, "no field names anybody else");
  });

  it("for somebody else: the for-others key AND the employee inside your scope", async () => {
    const { routes, calls } = approvals([P.RAISE_ATTENDANCE_PERMISSION_FOR_OTHERS]);
    assert.equal((await call(routes, "POST", "/attendance/permission-request", req({ ...BODY, employee_id: 42 }))).statusCode, 200);
    assert.equal(calls[0].requested_for_employee_id, 42);
    assert.equal((await call(routes, "POST", "/attendance/permission-request", req({ ...BODY, employee_id: 77 }))).statusCode, 403);
    assert.equal(calls.length, 1, "the out-of-scope employee never reached the usecase");
  });

  it("the Approval Centre's PERMISSION tab and decision need the Permission keys on top of the generic ones", async () => {
    const generic = approvals([P.VIEW_ATTENDANCE_APPROVALS, P.APPROVE_ATTENDANCE_REGULARIZATION]);
    const list = await call(generic.routes, "GET", "/attendance/approvals", req({}, { query: { request_type: "PERMISSION" } }));
    assert.equal(list.statusCode, 403);
    const decide = await call(generic.routes, "POST", "/attendance/regularization/:request_id/decision", req({ decision: "APPROVED" }, { params: { request_id: "5" } }));
    assert.equal(decide.statusCode, 403);

    const full = approvals([P.VIEW_ATTENDANCE_APPROVALS, P.APPROVE_ATTENDANCE_REGULARIZATION, P.VIEW_ATTENDANCE_PERMISSIONS, P.APPROVE_ATTENDANCE_PERMISSION]);
    assert.equal((await call(full.routes, "GET", "/attendance/approvals", req({}, { query: { request_type: "PERMISSION" } }))).statusCode, 200);
    assert.equal((await call(full.routes, "POST", "/attendance/regularization/:request_id/decision", req({ decision: "APPROVED" }, { params: { request_id: "5" } }))).statusCode, 200);
  });
});
