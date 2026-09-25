/**
 * The BULK approval endpoints' HTTP boundary: who reaches the usecase, with
 * what, and what the client can NOT decide.
 *
 *   node --test routes/attendance_approval_bulk.test.js
 *
 * The gates are the single endpoints' own. Approve / Reject need
 * `approve_attendance_regularization`, and on the Shift tab
 * `approve_shift_change_request` too, exactly as the decision route; Revoke
 * is `user_type` 2 only, exactly as the revoke route, with the same
 * session-safe 403. Every per-record rule is the usecase's
 * (usecase/attendance_approval_bulk.test.js, repository/attendance_approval_bulk.mysql.test.js).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./attendance_regularization");
const P = require("../constants/hr_permissions");

function fakeRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.ended = true; return res; };
  return res;
}
async function run(routes, method, path, req) {
  for (const layer of routes.getRouter().stack) {
    if (!layer.route || layer.route.path !== path || !layer.route.methods[method]) continue;
    const res = fakeRes();
    for (const handler of layer.route.stack) {
      let advanced = false;
      // eslint-disable-next-line no-await-in-loop
      await handler.handle(req, res, () => { advanced = true; });
      if (res.ended || !advanced) return res;
    }
    return res;
  }
  throw new Error(`no route for ${method} ${path}`);
}

/** Holds exactly the keys given; an administrator holds everything. */
const holding = (...keys) => {
  const has = async (req, ...asked) => Number(req.decoded && req.decoded.user_type) === 2 || asked.some((k) => keys.includes(k));
  const hasAll = async (req, ...asked) => Number(req.decoded && req.decoded.user_type) === 2 || (asked.length > 0 && asked.every((k) => keys.includes(k)));
  const gate = (check) => (...asked) => async (req, res, next) => ((await check(req, ...asked)) ? next() : res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" }));
  return { has, hasAll, require: gate(has), requireAll: gate(hasAll) };
};
const spy = () => {
  const calls = { bulkAction: [], listBulkTargets: [] };
  return {
    calls,
    MAX_BULK_ITEMS: 100,
    bulkAction: async (args) => { calls.bulkAction.push(args); return { code: 200, summary: { requested: args.items.length, succeeded: args.items.length, skipped: 0, failed: 0 }, results: [] }; },
    listBulkTargets: async (args) => { calls.listBulkTargets.push(args); return { items: [], total: 0, truncated: false }; },
  };
};
const BULK = "/attendance/approvals/bulk";
const TARGETS = "/attendance/approvals/bulk-targets";
const post = (usecase, perms, decoded, body) => run(buildRoutes(usecase, perms, null, null), "post", BULK, { decoded, body, params: {}, query: {} });
const APPROVER = { id: 12, employee_id: 33, user_type: 1, designation_id: 4 };
const ADMIN = { id: 5, employee_id: 900, user_type: 2 };
const items = [{ request_id: 71, current_stage_no: 1 }, { request_id: 72 }];

describe("POST /attendance/approvals/bulk", () => {
  it("401 without a session", async () => {
    const usecase = spy();
    const res = await post(usecase, holding(), undefined, { action: "APPROVE", request_type: "OT", items });
    assert.equal(res.statusCode, 401);
    assert.equal(usecase.calls.bulkAction.length, 0);
  });

  it("9. Approve / Reject without the approval key: the decision route's 403, and nothing is actioned", async () => {
    for (const action of ["APPROVE", "REJECT"]) {
      const usecase = spy();
      /* eslint-disable-next-line no-await-in-loop */
      const res = await post(usecase, holding(P.VIEW_ATTENDANCE_APPROVALS), APPROVER, { action, request_type: "OT", items, reason: "not worked" });
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.msg, "You do not have permission to perform this action");
      assert.equal(usecase.calls.bulkAction.length, 0);
    }
  });

  it("the Shift tab needs the Shift approval key as well, exactly as the single decision does", async () => {
    const usecase = spy();
    const refused = await post(usecase, holding(P.APPROVE_ATTENDANCE_REGULARIZATION), APPROVER, { action: "APPROVE", request_type: "SHIFT_CHANGE", items });
    assert.equal(refused.statusCode, 403);
    const allowed = await post(usecase, holding(P.APPROVE_ATTENDANCE_REGULARIZATION, P.APPROVE_SHIFT_CHANGE_REQUEST), APPROVER, { action: "APPROVE", request_type: "SHIFT_CHANGE", items });
    assert.equal(allowed.statusCode, 200);
    assert.equal(usecase.calls.bulkAction.length, 1);
  });

  it("9. Revoke is administrators only - a holder of every key is refused with the session-safe 403", async () => {
    const usecase = spy();
    const everything = { has: async () => true, hasAll: async () => true, require: () => (q, s, n) => n(), requireAll: () => (q, s, n) => n() };
    const res = await post(usecase, everything, APPROVER, { action: "REVOKE", request_type: "OT", items, reason: "approved by mistake" });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "ADMIN_ONLY");
    assert.equal(res.body.msg, "You do not have permission to perform this action", "worded so the web app does not sign the user out");
    assert.equal(usecase.calls.bulkAction.length, 0);
  });

  it("the actor comes from the TOKEN, never the body; only ids and the state the screen saw are passed on", async () => {
    const usecase = spy();
    const res = await post(usecase, holding(P.APPROVE_ATTENDANCE_REGULARIZATION), APPROVER, { action: "APPROVE", request_type: "OT", items });
    assert.equal(res.statusCode, 200);
    const [call] = usecase.calls.bulkAction;
    assert.equal(call.actor.employee_id, 33);
    assert.equal(call.actor.user_type, 1);
    assert.equal(call.actor.user_id, 12);
    assert.deepEqual(call.revoke_actor, { employee_id: 33, user_id: 12, user_type: 1 });
    assert.deepEqual(call.items, items);

    const admin = spy();
    await post(admin, holding(), ADMIN, { action: "REVOKE", request_type: "OT", items: [{ request_id: 71, status: "APPROVED" }], reason: "approved by mistake" });
    assert.deepEqual(admin.calls.bulkAction[0].revoke_actor, { employee_id: 900, user_id: 5, user_type: 2 });
  });

  it("refuses anything the client should not decide: an employee, a decision, minutes, an actor, an unknown action", async () => {
    for (const extra of [{ employee_id: 1 }, { decision: "APPROVED" }, { approved_ot_minutes: 60 }, { actor: { user_type: 2 } }]) {
      const usecase = spy();
      /* eslint-disable-next-line no-await-in-loop */
      const res = await post(usecase, holding(P.APPROVE_ATTENDANCE_REGULARIZATION), APPROVER, { action: "APPROVE", request_type: "OT", items, ...extra });
      assert.equal(res.statusCode, 400, JSON.stringify(extra));
      assert.equal(usecase.calls.bulkAction.length, 0);
    }
    for (const body of [
      { action: "DELETE", request_type: "OT", items },
      { action: "APPROVE", request_type: "OT", items: [] },
      { action: "APPROVE", request_type: "OT", items: Array.from({ length: 101 }, (_, i) => ({ request_id: i + 1 })) },
      { action: "APPROVE", request_type: "OT", items: [{ request_id: 71, employee_id: 5 }] },
    ]) {
      const usecase = spy();
      /* eslint-disable-next-line no-await-in-loop */
      const res = await post(usecase, holding(P.APPROVE_ATTENDANCE_REGULARIZATION), APPROVER, body);
      assert.equal(res.statusCode, 400);
      assert.equal(usecase.calls.bulkAction.length, 0);
    }
  });
});

describe("GET /attendance/approvals/bulk-targets", () => {
  const get = (usecase, perms, decoded, query) => run(buildRoutes(usecase, perms, null, null), "get", TARGETS, { decoded, query, params: {} });

  it("is behind the list's own view key, and the Shift view key on the Shift tab", async () => {
    const usecase = spy();
    assert.equal((await get(usecase, holding(), APPROVER, { request_type: "OT", status: "PENDING", action: "APPROVE" })).statusCode, 403);
    assert.equal((await get(usecase, holding(P.VIEW_ATTENDANCE_APPROVALS), APPROVER, { request_type: "SHIFT_CHANGE", status: "PENDING", action: "APPROVE" })).statusCode, 403);
    const ok = await get(usecase, holding(P.VIEW_ATTENDANCE_APPROVALS), APPROVER, { request_type: "OT", status: "PENDING", action: "APPROVE", outlet_ids: "3,4", employee_id: "7" });
    assert.equal(ok.statusCode, 200);
    const [call] = usecase.calls.listBulkTargets;
    assert.deepEqual([call.request_type, call.status, call.action, call.outlet_ids, call.employee_id], ["OT", "PENDING", "APPROVE", [3, 4], 7]);
    assert.equal(call.actor.employee_id, 33, "the actor is the token's");
  });
});
