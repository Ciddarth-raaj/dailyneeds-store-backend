/**
 * Every Attendance Approver Setup endpoint is behind manage_attendance_approvers.
 *
 *   node --test routes/attendance_approver_setup.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildRoutes = require("./attendance_approver_setup");
const P = require("../constants/hr_permissions");

const tagging = {
  require: (...keys) => { const mw = (req, res, next) => next(); mw.__guard = { mode: "any", keys }; return mw; },
  requireAll: (...keys) => { const mw = (req, res, next) => next(); mw.__guard = { mode: "all", keys }; return mw; },
};
const guards = [];
for (const layer of buildRoutes({}, tagging).getRouter().stack) {
  if (!layer.route) continue;
  const method = Object.keys(layer.route.methods)[0].toUpperCase();
  guards.push({ method, path: layer.route.path, guard: layer.route.stack.map((s) => s.handle.__guard).find(Boolean) || null });
}

describe("the approver setup API", () => {
  it("exposes list, options, current approvers, audit, bulk set, replace, get one and save one", () => {
    assert.deepEqual(guards.map((g) => `${g.method} ${g.path}`).sort(), [
      "GET /attendance/approver-setup",
      "GET /attendance/approver-setup/:employee_id",
      "GET /attendance/approver-setup/audit",
      "GET /attendance/approver-setup/current-approvers",
      "GET /attendance/approver-setup/options",
      "POST /attendance/approver-setup/bulk",
      "POST /attendance/approver-setup/replace",
      "PUT /attendance/approver-setup/:employee_id",
    ]);
  });
  it("every endpoint, reads included, requires manage_attendance_approvers and nothing weaker", () => {
    assert.equal(P.MANAGE_ATTENDANCE_APPROVERS, "manage_attendance_approvers");
    guards.forEach((g) => assert.deepEqual(g.guard, { mode: "any", keys: ["manage_attendance_approvers"] }, `${g.method} ${g.path}`));
  });
  it("the static sub-paths are declared before the :employee_id parameter so they are not swallowed by it", () => {
    const order = guards.map((g) => g.path);
    const param = order.indexOf("/attendance/approver-setup/:employee_id");
    for (const p of ["/attendance/approver-setup/options", "/attendance/approver-setup/current-approvers", "/attendance/approver-setup/audit", "/attendance/approver-setup/bulk", "/attendance/approver-setup/replace"]) {
      assert.ok(order.indexOf(p) < param, p);
    }
  });
});
