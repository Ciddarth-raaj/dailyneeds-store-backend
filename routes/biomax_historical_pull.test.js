/**
 * Historical pull routes: the surface, the key on every endpoint, and that
 * nothing raw leaks through them.
 *
 *   node --test routes/biomax_historical_pull.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./biomax_historical_pull");
const P = require("../constants/hr_permissions");

function guardsOf(router) {
  const guards = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const method = Object.keys(layer.route.methods)[0].toUpperCase();
    const guard = layer.route.stack.map((s) => s.handle.__guard).find(Boolean);
    guards.push({ method, path: layer.route.path, guard, handler: layer.route.stack.slice(-1)[0].handle });
  }
  return guards;
}

const permissions = {
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
  actorFor: async () => ({ userId: 1, employeeId: 1, isAdmin: true }),
};

function fakeRes() {
  const res = { statusCode: 200, body: null, status(s) { res.statusCode = s; return res; }, json(b) { res.body = b; return res; }, end() {} };
  return res;
}

describe("/attendance/historical-pulls", () => {
  const guards = guardsOf(buildRoutes({}, permissions).getRouter());
  const find = (m, p) => guards.find((g) => g.method === m && g.path === p);

  it("defines list, details and create, and nothing else", () => {
    assert.deepEqual(guards.map((g) => `${g.method} ${g.path}`).sort(), ["GET /", "GET /details", "POST /create"]);
  });

  it("every endpoint requires manage_biomax_historical_pull - a key granted to nobody, so admin only", () => {
    for (const g of guards) assert.deepEqual(g.guard.keys, [P.MANAGE_BIOMAX_HISTORICAL_PULL], `${g.method} ${g.path}`);
    assert.notEqual(P.MANAGE_BIOMAX_HISTORICAL_PULL, P.MANAGE_BIOMAX_DEVICES);
  });

  it("there is no cancel/delete/send/raw endpoint: nothing here talks to a device or returns bytes", () => {
    assert.ok(!guards.some((g) => /send|raw|body|cancel|delete|retry/i.test(g.path)));
    assert.ok(!guards.some((g) => g.method === "DELETE"));
  });

  it("create validates its body and passes device/from/to plus the actor to the usecase", async () => {
    let got = null;
    const routes = buildRoutes({ async create(input, actor) { got = { input, actor }; return { code: 200, biomax_historical_pull_id: 1 }; } }, permissions);
    const h = guardsOf(routes.getRouter()).find((g) => g.path === "/create").handler;
    let res = fakeRes();
    await h({ body: { biomax_device_id: 6, from: "2026-09-01", to: "2026-09-02" } }, res);
    assert.equal(res.body.code, 200);
    assert.deepEqual(got.input, { biomax_device_id: 6, from: "2026-09-01", to: "2026-09-02" });
    assert.equal(got.actor.employeeId, 1);
    res = fakeRes();
    await h({ body: { biomax_device_id: 6, from: "2026-09-01" } }, res);
    assert.equal(res.statusCode, 400);
    res = fakeRes();
    await h({ body: { biomax_device_id: 6, from: "2026-09-01", to: "2026-09-02", cmd_code: "CLEAR_LOG_DATA" } }, res);
    assert.equal(res.statusCode, 400, "no caller-supplied command code is accepted at all");
  });

  it("a 409 from the usecase reaches the client with the existing pull id", async () => {
    const err = Object.assign(new Error("already covers"), { name: "ConflictError", httpCode: 409, existing_pull_id: 5 });
    const routes = buildRoutes({ async create() { throw err; } }, permissions);
    const h = guardsOf(routes.getRouter()).find((g) => g.path === "/create").handler;
    const res = fakeRes();
    await h({ body: { biomax_device_id: 6, from: "2026-09-01", to: "2026-09-02" } }, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { code: 409, msg: "already covers", existing_pull_id: 5 });
  });

  it("list rejects an unknown status and details requires an id", async () => {
    const routes = buildRoutes({ async list() { return []; }, async details() { return {}; } }, permissions);
    const g = guardsOf(routes.getRouter());
    let res = fakeRes();
    await g.find((x) => x.path === "/").handler({ query: { status: "DONE" } }, res);
    assert.equal(res.statusCode, 400);
    res = fakeRes();
    await g.find((x) => x.path === "/details").handler({ query: {} }, res);
    assert.equal(res.statusCode, 400);
  });
});
