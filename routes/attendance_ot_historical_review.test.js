/**
 * The Historical OT Review API's guards and request handling.
 *
 *   node --test routes/attendance_ot_historical_review.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./attendance_ot_historical_review");
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

describe("APPROVAL PERMISSIONS: every Historical OT Review route needs attendance_ot_historical_review", () => {
  const layers = layersOf(buildRoutes({}, tagging));
  it("exactly three routes, each behind the one key", () => {
    assert.deepEqual(layers.map((l) => `${l.method} ${l.path}`).sort(), [
      "GET /attendance/ot/historical-review/batches",
      "GET /attendance/ot/historical-review/preview",
      "POST /attendance/ot/historical-review/authorise",
    ]);
    layers.forEach((l) => assert.deepEqual(l.guard, { mode: "any", keys: [P.ATTENDANCE_OT_HISTORICAL_REVIEW] }, l.path));
    assert.equal(P.ATTENDANCE_OT_HISTORICAL_REVIEW, "attendance_ot_historical_review");
  });
  it("the REAL permission middleware: a designation without the key is refused, with it allowed", async () => {
    const buildPermissions = require("../middlewares/permissions");
    const permissions = buildPermissions({
      getPermissionById: async (designationId) =>
        (designationId === 2 ? [P.ATTENDANCE_OT_HISTORICAL_REVIEW] : [P.VIEW_CALCULATED_ATTENDANCE]).map((permission_key) => ({ permission_key })),
    });
    let previewed = 0;
    const routes = buildRoutes({ preview: async () => { previewed += 1; return { lines: [] }; } }, permissions);
    const layer = routes.getRouter().stack.find((l) => l.route && l.route.path === "/attendance/ot/historical-review/preview");
    const run = async (decoded) => {
      const r = res();
      for (const s of layer.route.stack) {
        // eslint-disable-next-line no-await-in-loop
        const go = await new Promise((resolve) => {
          const maybe = s.handle({ query: {}, decoded }, r, () => resolve(true));
          Promise.resolve(maybe).then(() => resolve(false));
        });
        if (!go) break;
      }
      return r;
    };
    const refused = await run({ employee_id: 50, designation_id: 9, user_type: 1 });
    assert.equal(refused.statusCode === 403 || (refused.body && refused.body.code === 403), true, JSON.stringify(refused));
    assert.equal(previewed, 0);
    const allowed = await run({ employee_id: 51, designation_id: 2, user_type: 1 });
    assert.equal(allowed.body.code, 200, JSON.stringify(allowed.body));
    assert.equal(previewed, 1);
  });
});

describe("authorise: the administrator is the token's, and an explicit confirmation is required", () => {
  const calls = [];
  const usecase = {
    authorise: async (args) => { calls.push(args); return { review_batch_id: 1, summary: { created: 1 } }; },
  };
  const post = layersOf(buildRoutes(usecase, tagging)).find((l) => l.method === "POST");
  const hash = "a".repeat(64);

  it("refuses without confirm: true", async () => {
    const r = res();
    await post.handler({ body: { preview_hash: hash }, decoded: { employee_id: 8, id: 1 } }, r);
    assert.notEqual(r.statusCode, 200);
    assert.equal(calls.length, 0);
  });
  it("refuses an actor named in the body", async () => {
    const r = res();
    await post.handler({ body: { preview_hash: hash, confirm: true, actor: { employee_id: 1 } }, decoded: { employee_id: 8, id: 1 } }, r);
    assert.notEqual(r.statusCode, 200);
    assert.equal(calls.length, 0);
  });
  it("passes the token's employee as the authorising administrator", async () => {
    const r = res();
    await post.handler({ body: { preview_hash: hash, confirm: true, items: [{ employee_id: 945, attendance_date: "2026-09-04" }] }, decoded: { employee_id: 8, id: 1 } }, r);
    assert.equal(r.body.code, 200);
    assert.deepEqual(calls[0].actor, { employee_id: 8, user_id: 1 });
    assert.deepEqual(calls[0].items, [{ employee_id: 945, attendance_date: "2026-09-04" }]);
  });
  it("a stale preview answers 409", async () => {
    const stale = buildRoutes({ authorise: async () => { const e = new Error("changed"); e.code = "PREVIEW_STALE"; throw e; } }, tagging);
    const handler = layersOf(stale).find((l) => l.method === "POST").handler;
    const r = res();
    await handler({ body: { preview_hash: hash, confirm: true }, decoded: { employee_id: 8 } }, r);
    assert.equal(r.statusCode, 409);
  });
});
