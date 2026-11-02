/**
 * The OT Auto-Approval API: its guard, its validation, and who saved it.
 *
 *   node --test routes/attendance_ot_auto_approval.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./attendance_ot_auto_approval");
const P = require("../constants/hr_permissions");

const tagging = {
  require: (...keys) => {
    const mw = (req, res, next) => next();
    mw.__guard = { mode: "any", keys };
    return mw;
  },
};
const layersOf = (routes) =>
  routes.getRouter().stack.filter((l) => l.route).map((l) => ({
    method: Object.keys(l.route.methods)[0].toUpperCase(),
    path: l.route.path,
    guard: l.route.stack.map((s) => s.handle.__guard).find(Boolean) || null,
    handler: l.route.stack[l.route.stack.length - 1].handle,
  }));
const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

describe("OT Auto-Approval routes", () => {
  it("exactly GET and PUT, each behind manage_ot_auto_approval", () => {
    const layers = layersOf(buildRoutes({}, tagging));
    assert.deepEqual(layers.map((l) => `${l.method} ${l.path}`).sort(), [
      "GET /attendance/ot/auto-approval",
      "PUT /attendance/ot/auto-approval",
    ]);
    layers.forEach((l) => assert.deepEqual(l.guard, { mode: "any", keys: [P.MANAGE_OT_AUTO_APPROVAL] }));
    assert.equal(P.MANAGE_OT_AUTO_APPROVAL, "manage_ot_auto_approval");
  });

  it("a save passes the switch, the cap and the token's employee - never a body employee", async () => {
    const calls = [];
    const put = layersOf(
      buildRoutes({ setOtAutoApproval: async (a) => { calls.push(a); return { code: 200, auto_approve: a.auto_approve }; } }, tagging)
    ).find((l) => l.method === "PUT");
    const r = res();
    await put.handler({ body: { auto_approve: false, max_minutes: null }, decoded: { employee_id: 12 } }, r);
    assert.equal(r.body.code, 200);
    assert.deepEqual(calls, [{ auto_approve: false, max_minutes: null, actor: { employee_id: 12 } }]);

    const bad = res();
    await put.handler({ body: { auto_approve: true, max_minutes: 60, employee_id: 99 }, decoded: { employee_id: 12 } }, bad);
    assert.notEqual(bad.statusCode, 200, "an unknown field is refused");
    const zero = res();
    await put.handler({ body: { auto_approve: true, max_minutes: 0 }, decoded: { employee_id: 12 } }, zero);
    assert.notEqual(zero.statusCode, 200, "a cap of 0 is refused");
    assert.equal(calls.length, 1);
  });
});
