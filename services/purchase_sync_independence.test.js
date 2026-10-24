/**
 * The purchase-side jobs do not depend on the Digisme employee sync.
 *
 *   node --test services/purchase_sync_independence.test.js
 *
 * When /purchase stopped updating on 6 September the Digisme pause was an
 * obvious suspect, since it landed the following day. It was not the cause -
 * the pusher was getting a 301 from the new HTTPS redirect - but the question
 * was worth answering properly, and worth keeping answered.
 *
 * Two separate things feed the purchase side, and neither is Digisme's:
 *
 *   the `purchase` table          written by an EXTERNAL push to
 *                                 POST /purchase and POST /purchase/bulk.
 *                                 There is no cron for it at all.
 *   `purchase_acknowledgement`    pulled from GoFrugal. Its cron, and then
 *                                 the whole Purchase Acknowledgement feature,
 *                                 were removed when GoFrugal was replaced by
 *                                 RetailPilot.
 *
 * These tests pinned that the pause could reach neither. The Digisme
 * employee sync has since been removed outright, so they now pin the same
 * thing about the removal - nobody should have to re-derive it the next time
 * purchase data goes quiet.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
/** Statements only; a comment naming Digisme proves nothing either way. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the GoFrugal purchase-acknowledgement cron", () => {
  const server = codeOf(read("server.js"));

  it("is no longer registered - GoFrugal was replaced by RetailPilot", () => {
    assert.doesNotMatch(server, /register\(\s*"purchase_acknowledgement_gofrugal_sync"/);
  });

  it("and the Purchase Acknowledgement routes are gone with it", () => {
    assert.ok(!fs.existsSync(path.join(ROOT, "routes/purchase_acknowledgement.js")));
    assert.doesNotMatch(server, /purchase_acknowledgement"\)/);
  });

  it("and server.js knows nothing about the Digisme employee flag at all", () => {
    for (const flag of ["digisme.employeeSync", "DIGISME_EMPLOYEE_SYNC", "localEmployeeMaster"]) {
      assert.ok(!server.includes(flag), `server.js must not reference ${flag}`);
    }
  });
});

describe("the Digisme employee sync is gone, and took nothing else with it", () => {
  const synker = read("services/synker.js");
  const code = codeOf(synker);

  it("registers no employee_sync job, and no conditional registration at all", () => {
    const init = code.slice(code.indexOf("initCronJobs("), code.indexOf("async syncStockHoldingReportWithLogging"));
    const registered = [...init.matchAll(/register\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(!registered.includes("employee_sync"), "the job is removed, not merely skipped");
    assert.ok(!/if\s*\(/.test(init), "no job is registered behind a flag any more");
  });

  it("the stock holding pull (old Delium / GoFrugal API) is retired too", () => {
    const init = code.slice(code.indexOf("initCronJobs("), code.indexOf("async syncStockHoldingReportWithLogging"));
    const registered = [...init.matchAll(/register\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(!registered.includes("stock_holding_report_sync"));
  });

  it("no Digisme code, credential or flag is left in the synker", () => {
    for (const gone of [
      "syncDigismeEmployees",
      "_fetchDigismeEmployees",
      "_authenticateDigisme",
      "getDigismeToken",
      "DIGISME_API_KEY",
      "DIGISME_CUSTOM_KEY",
      "indhrmsgateway",
      "lifecycleConfig",
      "encryptAES",
    ]) {
      assert.ok(!code.includes(gone), `services/synker.js still references ${gone}`);
    }
  });

  it("nothing in the synker mentions purchases", () => {
    const init = code.slice(code.indexOf("initCronJobs("), code.indexOf("async syncStockHoldingReportWithLogging"));
    assert.ok(!/purchase/i.test(init), "the purchase jobs do not live here");
  });
});

describe("the purchase table's only cron writer is the RetailPilot pull", () => {
  it("nothing else schedules a write to `purchase`", () => {
    // Established during the 6 September investigation and worth keeping
    // recorded: if someone later adds a purchase cron, this test should fail
    // and make them say so deliberately.
    const server = codeOf(read("server.js"));
    const names = [...server.matchAll(/register\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const purchaseJobs = names.filter((n) => /purchase/.test(n));
    assert.deepEqual(
      purchaseJobs.sort(),
      ["purchase_ref_cache_warm", "retailpilot_purchase_sync"],
      "the only purchase jobs are the Purchase Ref cache warm and the RetailPilot pull"
    );
  });

  it("the two write routes are the only writers", () => {
    const routes = codeOf(read("routes/purchase.js"));
    assert.match(routes, /router\.post\("\/bulk"/);
    assert.match(routes, /router\.post\("\/"/);
    // And nothing in services/ calls the bulk create.
    for (const f of fs.readdirSync(path.join(ROOT, "services")).filter((f) => f.endsWith(".js") && !f.includes("test"))) {
      const src = read(path.join("services", f));
      assert.ok(
        !/bulkCreatePurchase|purchaseUsecase\.bulkCreate/.test(src),
        `${f} must not write purchases on a schedule`
      );
    }
  });
});
