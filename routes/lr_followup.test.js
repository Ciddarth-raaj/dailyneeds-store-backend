/**
 * LR Follow-up, Credit Purchase and Transporter Master - the route surface,
 * what guards each endpoint, and that the branch scope is applied on the
 * server.
 *
 *   node --test routes/lr_followup.test.js
 *
 * Two kinds of test. The guard table is read off the real routers. The
 * enforcement tests run the real routers in a real Express app over HTTP,
 * with a permissions object that answers from a held-key set and a branch
 * scope the test chooses - so "refused" means the request really was.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const buildLr = require("./lr_followup");
const buildCredit = require("./credit_purchase");
const buildTransporter = require("./transporter_master");

const NONE = "NONE";
const fakeScope = (decide) => ({
  DASHBOARD_SCOPE: { NONE, ALL_STORES: "ALL_STORES", OWN_STORE: "OWN_STORE" },
  resolveDashboardScope: async (req) => decide(req),
});

function guardTable(router) {
  const rows = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const method = Object.keys(layer.route.methods)[0].toUpperCase();
    const guard = layer.route.stack.map((s) => s.handle.__guard).find(Boolean);
    rows.push({ route: `${method} ${layer.route.path}`, keys: guard ? guard.keys : null });
  }
  return rows;
}

const recordingPermissions = {
  require: (...keys) => {
    const mw = (req, res, next) => next();
    mw.__guard = { keys };
    return mw;
  },
};

describe("every endpoint carries the right key", () => {
  it("LR Follow-up", () => {
    const table = guardTable(buildLr({}, recordingPermissions, fakeScope(() => ({}))).getRouter());
    assert.deepEqual(
      Object.fromEntries(table.map((r) => [r.route, r.keys])),
      {
        "GET /summary": ["view_lr_followup"],
        "GET /": ["view_lr_followup"],
        "GET /legacy": ["manage_lr_legacy_verification"],
        "POST /legacy/backfill": ["manage_lr_legacy_verification"],
        "GET /by-source/:type(ADVANCE_REQUEST|CREDIT_PURCHASE)/:sourceId(\\d+)": ["view_lr_followup"],
        "GET /:id(\\d+)": ["view_lr_followup"],
        "PATCH /:id(\\d+)/lr": ["update_lr_followup"],
        "POST /:id(\\d+)/follow-ups": ["update_lr_followup"],
        "POST /:id(\\d+)/goods-received": ["mark_lr_goods_received"],
        "POST /:id(\\d+)/resolve": ["manage_lr_legacy_verification"],
      }
    );
  });

  it("Credit Purchase - and there is no edit or delete", () => {
    const table = guardTable(buildCredit({}, recordingPermissions, fakeScope(() => ({}))).getRouter());
    assert.deepEqual(Object.fromEntries(table.map((r) => [r.route, r.keys])), {
      "GET /": ["view_credit_purchase"],
      "GET /:id(\\d+)": ["view_credit_purchase"],
      "POST /": ["create_credit_purchase"],
    });
  });

  it("Transporter Master - and there is no delete", () => {
    const table = guardTable(buildTransporter({}, recordingPermissions).getRouter());
    assert.deepEqual(Object.fromEntries(table.map((r) => [r.route, r.keys])), {
      "GET /options": ["view_transporter_master", "create_credit_purchase", "update_lr_followup"],
      "GET /": ["view_transporter_master"],
      "GET /:id(\\d+)": ["view_transporter_master"],
      "POST /": ["create_transporter_master"],
      "PATCH /:id(\\d+)": ["edit_transporter_master"],
    });
  });
});

describe("17 and 18. enforced on the server", () => {
  let server;
  let base;
  const calls = [];
  let held = new Set();
  let scope = { kind: "ALL_STORES", store_ids: null };

  const permissions = {
    require: (...keys) => (req, res, next) =>
      keys.some((k) => held.has(k)) ? next() : res.status(403).json({ code: 403, msg: "no" }),
  };

  const usecase = new Proxy(
    {},
    {
      get: (_, name) => async (...args) => {
        calls.push({ name, args });
        if (name === "getDetail" && args[1] && !args[1].includes(1)) {
          const err = new Error("Follow-up not found");
          err.name = "NotFoundError";
          throw err;
        }
        return { ok: true };
      },
    }
  );

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.decoded = { employee_id: 501, user_type: 1 };
      req.auth = { userId: 9, employeeId: 501, isSystemAccount: false };
      next();
    });
    const dashboardScope = fakeScope(() => scope);
    app.use("/lr-followup", buildLr(usecase, permissions, dashboardScope).getRouter());
    app.use("/credit-purchase", buildCredit(usecase, permissions, dashboardScope).getRouter());
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const call = (method, path, body) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it("refuses an action without its key, even with the view key", async () => {
    held = new Set(["view_lr_followup"]);
    assert.equal((await call("POST", "/lr-followup/5/goods-received", {})).status, 403);
    assert.equal((await call("PATCH", "/lr-followup/5/lr", { lr_no: "X" })).status, 403);
    assert.equal((await call("POST", "/lr-followup/5/resolve", { decision: "REFUNDED", remark: "x" })).status, 403);
    assert.equal((await call("POST", "/credit-purchase", {})).status, 403);
    assert.equal(calls.length, 0);
  });

  it("refuses everybody without a branch scope - the key alone grants no location", async () => {
    held = new Set(["view_lr_followup", "mark_lr_goods_received"]);
    scope = { kind: NONE, store_ids: [], reason: "NO_SCOPE_GRANTED" };
    const r = await call("GET", "/lr-followup");
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "NO_SCOPE_GRANTED");
    // The web app keeps the session only for this exact wording; any other
    // 403 sends the user to /login (util/handle403.js in the frontend).
    assert.equal(r.body.msg, "You do not have permission to perform this action");
    assert.match(r.body.detail, /branch scope/);
    assert.equal((await call("POST", "/lr-followup/5/goods-received", {})).status, 403);
    assert.equal(calls.length, 0);
  });

  it("hands the caller's own branch to the usecase, and a direct id outside it is not found", async () => {
    held = new Set(["view_lr_followup", "mark_lr_goods_received"]);
    scope = { kind: "OWN_STORE", store_ids: [2] };
    const r = await call("GET", "/lr-followup/77");
    assert.equal(r.status, 404);
    await call("POST", "/lr-followup/77/goods-received", { remark: "ok" });
    const last = calls[calls.length - 1];
    assert.equal(last.name, "markGoodsReceived");
    assert.deepEqual(last.args[3], [2]);
    assert.equal(last.args[2], 501); // the employee, from the session, not the body
  });

  it("only an All Stores holder may run the company-wide backfill", async () => {
    held = new Set(["manage_lr_legacy_verification"]);
    scope = { kind: "OWN_STORE", store_ids: [2] };
    assert.equal((await call("POST", "/lr-followup/legacy/backfill")).status, 403);
    scope = { kind: "ALL_STORES", store_ids: null };
    assert.equal((await call("POST", "/lr-followup/legacy/backfill")).status, 200);
  });

  it("validates bodies before anything runs", async () => {
    held = new Set(["update_lr_followup", "create_credit_purchase"]);
    scope = { kind: "ALL_STORES", store_ids: null };
    const before = calls.length;
    assert.equal((await call("POST", "/lr-followup/5/follow-ups", {})).status, 400); // remark required
    assert.equal((await call("POST", "/credit-purchase", { distributor_code: 1 })).status, 400);
    assert.equal(
      (await call("POST", "/credit-purchase", {
        distributor_code: 1, bill_reference: "B1", amount: 10, bill_date: "2026-09-30", outlet_id: 1,
      })).status,
      400 // transporter is required
    );
    assert.equal(calls.length, before);
  });
});
