/**
 * GoFrugal's feeds are refused; everything else, RetailPilot's syncs
 * included, goes through.
 *
 *   node --test middlewares/gofrugal_retired.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isRetired, create, RETIRED } = require("./gofrugal_retired");

function call(mw, method, url) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  mw({ method, originalUrl: url, url }, res, () => { passed = true; });
  return { passed, res };
}

test("every GoFrugal feed is refused with 410 and never reaches its route", () => {
  const mw = create({});
  for (const [method, p] of RETIRED) {
    const { passed, res } = call(mw, method, p);
    assert.equal(passed, false, p);
    assert.equal(res.statusCode, 410, p);
    assert.equal(res.body.code, 410);
  }
  assert.equal(call(mw, "POST", "/purchase/bulk/?x=1").res.statusCode, 410, "trailing slash and query");
  assert.equal(call(mw, "POST", "/Purchase/Bulk").res.statusCode, 410, "case");
});

test("RetailPilot syncs, reads and the rest still go through", () => {
  const mw = create({});
  for (const [m, p] of [
    ["POST", "/purchase/retailpilot-sync"],
    ["POST", "/product-distributors/retailpilot-sync"],
    ["POST", "/product/sync"],
    ["GET", "/purchase/bulk"],
    ["GET", "/stock-holding-report"],
    ["POST", "/product-distributors/bulk/holding-days"],
  ]) {
    assert.equal(call(mw, m, p).passed, true, `${m} ${p}`);
  }
  assert.equal(isRetired("POST", "/purchase"), false);
});

test("GOFRUGAL_FEEDS_BLOCKED=false lets them through (rollback)", () => {
  assert.equal(call(create({ GOFRUGAL_FEEDS_BLOCKED: "false" }), "POST", "/purchase/bulk").passed, true);
});

test("wired after the API Sync Log middleware and before the routes; the Delium stock holding cron is gone", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const logAt = server.indexOf("app.use(this.apiSyncLogger.middleware())");
  const blockAt = server.indexOf('app.use(require("./middlewares/gofrugal_retired").create())');
  const routeAt = server.indexOf('app.use("/purchase", purchaseRouter.getRouter())');
  assert.ok(logAt > 0 && blockAt > logAt && routeAt > blockAt);
  const synker = fs.readFileSync(path.join(__dirname, "..", "services", "synker.js"), "utf8");
  assert.doesNotMatch(synker, /register\(\s*"stock_holding_report_sync"/);
});
