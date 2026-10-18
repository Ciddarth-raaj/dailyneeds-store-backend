/**
 * POST /purchase/retailpilot-sync and the Tally response deletes, over real
 * HTTP, with the real permission middleware (middlewares/permissions.js).
 *
 *   node --test routes/purchase_retailpilot_sync.test.js
 *
 * req.decoded is what middlewares/auth.js leaves on an authenticated
 * request; a request without it is one auth let through with no session.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");

const buildPermissions = require("../middlewares/permissions");
const buildRoutes = require("./purchase");

const GRANTS = {
  10: ["view_purchases", "sync_retailpilot_purchases"], // purchase manager
  11: ["view_purchases"], // accounts clerk
};
const permissions = buildPermissions({
  getPermissionById: async (designationId) => (GRANTS[designationId] || []).map((k) => ({ permission_key: k })),
});

const runs = [];
const sync = { run: async (opts) => { runs.push(opts); return { code: 200, dry_run: !!opts.dryRun, row_count: 0 }; } };
const deletes = [];
const purchaseUsecase = {
  deleteTallyResponseForPurchase: async (id) => { deletes.push(["purchase", id]); return { code: 200, purchase_id: id }; },
  deleteTallyResponse: async (v) => { deletes.push(["voucher", v]); return { code: 409 }; },
};

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for middlewares/auth.js: the session travels in a test header.
  app.use((req, res, next) => {
    const s = req.headers["x-test-session"];
    if (s) req.decoded = JSON.parse(s);
    next();
  });
  app.use("/purchase", buildRoutes(purchaseUsecase, sync, permissions).getRouter());
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function call(method, path, session, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(session ? { "x-test-session": JSON.stringify(session) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("manual RetailPilot purchase sync - who may run it", () => {
  it("no session: 401, nothing runs", async () => {
    runs.length = 0;
    const r = await call("POST", "/purchase/retailpilot-sync", null, { dry_run: true });
    assert.equal(r.status, 401);
    assert.equal(runs.length, 0);
  });

  it("a logged-in user without sync_retailpilot_purchases: 403, nothing runs", async () => {
    runs.length = 0;
    const r = await call("POST", "/purchase/retailpilot-sync", { employee_id: 5, designation_id: 11, user_type: 1 }, { dry_run: true });
    assert.equal(r.status, 403);
    assert.equal(r.body.msg, "You do not have permission to perform this action");
    assert.equal(runs.length, 0);
  });

  it("a designation granted sync_retailpilot_purchases may run it", async () => {
    runs.length = 0;
    const r = await call("POST", "/purchase/retailpilot-sync", { employee_id: 6, designation_id: 10, user_type: 1 }, { days: 15, dry_run: true });
    assert.equal(r.status, 200);
    assert.deepEqual(runs, [{ days: 15, dryRun: true }]);
  });

  it("an admin (user_type 2) may run it without the grant", async () => {
    runs.length = 0;
    const r = await call("POST", "/purchase/retailpilot-sync", { employee_id: 1, designation_id: null, user_type: 2 }, {});
    assert.equal(r.status, 200);
    assert.deepEqual(runs, [{ days: undefined, dryRun: false }]);
  });

  it("the look-back is still limited to 90 days", async () => {
    runs.length = 0;
    const r = await call("POST", "/purchase/retailpilot-sync", { employee_id: 1, user_type: 2 }, { days: 91 });
    assert.equal(r.body.code, 422);
    assert.equal(runs.length, 0);
  });

  it("the key the route checks is the one the migration declares", () => {
    const fs = require("fs");
    const path = require("path");
    const up = fs.readFileSync(
      path.join(__dirname, "..", "migrations", "mysql", "migrations", "sqls", "20261205130000-retailpilot-purchase-sync-permission-up.sql"),
      "utf8"
    );
    assert.equal(buildRoutes.RETAILPILOT_SYNC_PERMISSION, "sync_retailpilot_purchases");
    assert.match(up, /INSERT INTO `all_permissions`[\s\S]*'sync_retailpilot_purchases'[\s\S]*WHERE NOT EXISTS/);
    assert.doesNotMatch(up.replace(/--[^\n]*/g, ""), /INSERT INTO `permissions`/, "granted to nobody");
  });
});

describe("deleting a Tally response", () => {
  const admin = { employee_id: 1, user_type: 2 };

  it("by purchase id goes to exactly that purchase", async () => {
    deletes.length = 0;
    const r = await call("DELETE", "/purchase/57/tally-response", admin);
    assert.equal(r.body.code, 200);
    assert.deepEqual(deletes, [["purchase", 57]]);
  });

  it("refuses a purchase id that is not a positive number", async () => {
    deletes.length = 0;
    const r = await call("DELETE", "/purchase/abc/tally-response", admin);
    assert.equal(r.body.code, 422);
    assert.deepEqual(deletes, []);
  });

  it("the old delete by voucher number still reaches its own handler", async () => {
    deletes.length = 0;
    await call("DELETE", "/purchase/delete-tally/951", admin);
    assert.deepEqual(deletes, [["voucher", "951"]]);
  });
});
