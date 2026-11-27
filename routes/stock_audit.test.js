/**
 * /stock-audit routes: permission key first, then store scope; disabled
 * actions answer 501. Uses a fake usecase (no database).
 *   node --test routes/stock_audit.test.js
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const P = require("../constants/stock_audit_permissions");
const routesFactory = require("./stock_audit");

// caller described by headers: x-keys (comma list, "*" = admin), x-branches, x-employee
const permissions = {
  has: async (req, ...keys) => req.keys === "*" || keys.some((k) => req.keys.split(",").includes(k)),
  require: (...keys) => async (req, res, next) => ((await permissions.has(req, ...keys)) ? next() : res.status(403).json({ code: 403, msg: "no permission" })),
};
const branchScope = { resolve: async (req) => ({ kind: req.branches ? "OWN_BRANCHES" : "NONE", store_ids: req.branches ? req.branches.split(",").map(Number) : [] }) };
const calls = [];
const usecase = new Proxy({}, {
  get: (_, name) => async (args) => {
    calls.push({ name, args });
    if (name === "ownRpIds") return ["me1"];
    if (name === "employee") return args && args.selfRpIds && !args.selfRpIds.includes(args.rpUserId) ? null : { rp_user_id: args.rpUserId };
    return { ok: true, name };
  },
});

let server;
let offServer;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.keys = req.headers["x-keys"] || "";
    req.branches = req.headers["x-branches"] || "";
    req.decoded = { employee_id: Number(req.headers["x-employee"] || 1) };
    req.auth = { employeeId: Number(req.headers["x-employee"] || 1), storeId: Number(req.headers["x-store"] || 0) || null };
    next();
  });
  app.use("/stock-audit", routesFactory({ usecase, permissions, branchScope, enabled: true, syncEnabled: true }).getRouter());
  const off = express();
  off.use((req, res, next) => { req.keys = "*"; req.decoded = { employee_id: 1 }; next(); });
  off.use("/stock-audit", routesFactory({ usecase, permissions, branchScope, enabled: false }).getRouter());
  offServer = off.listen(0);
  await new Promise((r) => offServer.once("listening", r));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); offServer.close(); });

function call(method, path, { keys = "", branches = "", employee = 1, store = null, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${base}${path}`, { method, headers: { "x-keys": keys, "x-branches": branches, "x-employee": String(employee), "x-store": String(store || ""), "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const last = (name) => [...calls].reverse().find((c) => c.name === name);

describe("permission key first", () => {
  it("no key -> 403 before anything is read", async () => {
    calls.length = 0;
    assert.equal((await call("GET", "/stock-audit/stores")).status, 403);
    assert.equal(calls.length, 0);
  });
  it("an employee's own key cannot list other employees", async () => {
    assert.equal((await call("GET", "/stock-audit/employees", { keys: P.VIEW_OWN_PERFORMANCE, branches: "7" })).status, 403);
  });
});

describe("store scope", () => {
  it("all-stores key -> every programme store (null scope)", async () => {
    const r = await call("GET", "/stock-audit/stores", { keys: P.VIEW_ALL_STORES });
    assert.equal(r.status, 200);
    assert.equal(last("stores").args.outlets, null);
  });
  it("store key -> only the caller's own programme branches", async () => {
    await call("GET", "/stock-audit/employees", { keys: P.VIEW_STORE, branches: "7,2" });
    assert.deepEqual(last("employees").args.outlets, [7]); // warehouse dropped
  });
  it("asking for another store is refused, not narrowed", async () => {
    const r = await call("GET", "/stock-audit/employees?outlet_id=5", { keys: P.VIEW_STORE, branches: "7" });
    assert.equal(r.status, 403);
  });
  it("the warehouse is never a programme store", async () => {
    assert.equal((await call("GET", "/stock-audit/stores?outlet_id=2", { keys: P.VIEW_ALL_STORES })).status, 400);
  });
  it("no branch assignment -> refused", async () => {
    assert.equal((await call("GET", "/stock-audit/stores", { keys: P.VIEW_STORE })).status, 403);
  });
});

describe("self-service", () => {
  it("/my uses the caller's own RetailPilot ids only", async () => {
    const r = await call("GET", "/stock-audit/my", { keys: P.VIEW_OWN_PERFORMANCE, employee: 42 });
    assert.equal(r.status, 200);
    assert.equal(last("ownRpIds").args, 42);
    assert.deepEqual(r.body.data.employees.map((e) => e.rp_user_id), ["me1"]);
  });
  it("another person's articles through /my are passed with the caller's own ids (usecase refuses)", async () => {
    await call("GET", "/stock-audit/my/someoneElse/articles", { keys: P.VIEW_OWN_PERFORMANCE });
    assert.deepEqual(last("articles").args.selfRpIds, ["me1"]);
  });
});

describe("not enabled", () => {
  for (const [path, key] of [["/stock-audit/approvals/E-7-x/approve", P.APPROVE_INCENTIVES], ["/stock-audit/approvals/E-7-x/reject", P.APPROVE_INCENTIVES], ["/stock-audit/incentives/1/revoke", P.REVOKE_INCENTIVES], ["/stock-audit/payroll/post", P.PROCESS_PAYROLL]]) {
    it(`${path} answers 501 even for an administrator`, async () => {
      const r = await call("POST", path, { keys: "*" });
      assert.equal(r.status, 501);
      assert.match(r.body.msg, /not enabled/);
      void key;
    });
  }
});

describe("actions record who acted", () => {
  it("allotment validate / confirm pass the caller as `by`", async () => {
    await call("POST", "/stock-audit/allotment/validate", { keys: P.IMPORT_ALLOTMENT, employee: 77, body: { period_code: "2026-Q4", files: [] } });
    assert.equal(last("validateUpload").args.by, 77);
    await call("POST", "/stock-audit/allotment/uploads/5/confirm", { keys: P.IMPORT_ALLOTMENT, employee: 77 });
    assert.equal(last("confirmUpload").args, 5);
  });
  it("independent store verification needs the company-wide key too, and passes the caller's store", async () => {
    assert.equal((await call("POST", "/stock-audit/stores/7/independent-verification", { keys: P.REVIEW_VERIFICATION, branches: "7", body: { done: true } })).status, 403);
    await call("POST", "/stock-audit/stores/7/independent-verification", { keys: `${P.REVIEW_VERIFICATION},${P.VIEW_ALL_STORES}`, store: 3, body: { done: true } });
    assert.equal(last("recordStoreVerification").args.byOutletId, 3);
  });
  it("a sync can only be started with the sync key", async () => {
    assert.equal((await call("POST", "/stock-audit/sync", { keys: P.VIEW_ALL_STORES, body: { kind: "HISTORICAL" } })).status, 403);
    assert.equal((await call("POST", "/stock-audit/sync", { keys: P.RUN_SYNC, body: { kind: "HISTORICAL" } })).status, 200);
  });
});

describe("activation switch", () => {
  it("with STOCK_AUDIT_ENABLED off every endpoint answers 503, even for an administrator, and nothing is read", async () => {
    calls.length = 0;
    const port = offServer.address().port;
    const r = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/stock-audit/stores`, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b) })); }));
    assert.equal(r.status, 503);
    assert.equal(calls.length, 0);
  });
});

describe("headcount, exclusions and responsible persons", () => {
  it("snapshot / exclusion requests need the cycle key and the caller's own store", async () => {
    assert.equal((await call("POST", "/stock-audit/eligibility/7/snapshot", { keys: P.VIEW_STORE, branches: "7" })).status, 403);
    assert.equal((await call("POST", "/stock-audit/eligibility/5/snapshot", { keys: P.MANAGE_CYCLES, branches: "7" })).status, 403);
    assert.equal((await call("POST", "/stock-audit/eligibility/7/snapshot", { keys: P.MANAGE_CYCLES, branches: "7", employee: 33 })).status, 200);
    assert.equal(last("takeSnapshot").args.by, 33);
    await call("POST", "/stock-audit/eligibility/7/exclusions", { keys: P.MANAGE_CYCLES, branches: "7", body: { employee_id: 9, reason: "Long leave" } });
    assert.deepEqual([last("requestExclusion").args.employeeId, last("requestExclusion").args.reason], [9, "Long leave"]);
  });
  it("deciding an exclusion needs its own key", async () => {
    assert.equal((await call("POST", "/stock-audit/exclusions/4/approve", { keys: P.MANAGE_CYCLES })).status, 403);
    assert.equal((await call("POST", "/stock-audit/exclusions/4/approve", { keys: P.APPROVE_EXCLUSIONS, employee: 8 })).status, 200);
    assert.deepEqual([last("decideExclusion").args.id, last("decideExclusion").args.approve, last("decideExclusion").args.by], [4, true, 8]);
  });
  it("assigning a store role needs the roles key and the store in scope; the Operations Manager needs company-wide access", async () => {
    assert.equal((await call("PUT", "/stock-audit/roles", { keys: P.VIEW_ALL_STORES, body: { role: "STORE_MANAGER", outlet_id: 7, employee_id: 5 } })).status, 403);
    assert.equal((await call("PUT", "/stock-audit/roles", { keys: P.MANAGE_ROLES, branches: "5", body: { role: "STORE_MANAGER", outlet_id: 7, employee_id: 5 } })).status, 403);
    assert.equal((await call("PUT", "/stock-audit/roles", { keys: P.MANAGE_ROLES, branches: "7", body: { role: "STORE_MANAGER", outlet_id: 7, employee_id: 5 } })).status, 200);
    assert.equal((await call("PUT", "/stock-audit/roles", { keys: P.MANAGE_ROLES, branches: "7", body: { role: "OPERATIONS_MANAGER", employee_id: 6 } })).status, 403);
    assert.equal((await call("PUT", "/stock-audit/roles", { keys: `${P.MANAGE_ROLES},${P.VIEW_ALL_STORES}`, body: { role: "OPERATIONS_MANAGER", employee_id: 6 } })).status, 200);
  });
  it("designation settings: policy key only", async () => {
    assert.equal((await call("PUT", "/stock-audit/settings", { keys: P.MANAGE_ROLES, body: { eligible_designation_ids: [2] } })).status, 403);
    assert.equal((await call("PUT", "/stock-audit/settings", { keys: P.MANAGE_POLICY, body: { eligible_designation_ids: [2] } })).status, 200);
  });
});

describe("staged access (STOCK_AUDIT_ACCESS=restricted)", () => {
  let srv;
  let port;
  before(async () => {
    const app = express();
    app.use((req, res, next) => { req.keys = "*"; req.decoded = { employee_id: 1, user_type: Number(req.headers["x-type"] || 1), designation_id: Number(req.headers["x-desig"] || 0) }; next(); });
    const perms = { ...permissions, ADMIN_USER_TYPE: 2 };
    app.use("/stock-audit", routesFactory({ usecase, permissions: perms, branchScope, enabled: true, access: { mode: "restricted", designationIds: [11] } }).getRouter());
    srv = app.listen(0);
    await new Promise((r) => srv.once("listening", r));
    port = srv.address().port;
  });
  after(() => srv.close());
  const get = (headers) => new Promise((resolve) => http.get({ host: "127.0.0.1", port, path: "/stock-audit/stores", headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }));
  it("administrators and HR (designation 11) get in; a store employee or manager does not, whatever keys they hold", async () => {
    assert.equal(await get({ "x-type": "2" }), 200);
    assert.equal(await get({ "x-desig": "11" }), 200);
    assert.equal(await get({ "x-desig": "3" }), 503);
    assert.equal(await get({ "x-desig": "2" }), 503);
  });
});
