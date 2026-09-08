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
 *   `purchase_acknowledgement`    pulled from GoFrugal every five minutes by
 *                                 `purchase_acknowledgement_gofrugal_sync`,
 *                                 registered in server.js.
 *
 * These tests pin that the pause cannot reach either, so nobody has to
 * re-derive it the next time purchase data goes quiet.
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

  it("is registered", () => {
    assert.match(server, /register\(\s*"purchase_acknowledgement_gofrugal_sync"/);
  });

  it("is registered UNCONDITIONALLY - no flag can skip it", () => {
    // Everything from the start of the registration back to the previous
    // statement: if a conditional wrapped it, it would be in here.
    const at = server.indexOf('"purchase_acknowledgement_gofrugal_sync"');
    const before = server.slice(Math.max(0, at - 600), at);
    for (const flag of ["employeeSync", "digisme", "DIGISME", "localEmployeeMaster"]) {
      assert.ok(
        !new RegExp(flag).test(before),
        `the purchase acknowledgement cron must not sit behind ${flag}`
      );
    }
  });

  it("and server.js knows nothing about the Digisme employee flag at all", () => {
    for (const flag of ["digisme.employeeSync", "DIGISME_EMPLOYEE_SYNC", "localEmployeeMaster"]) {
      assert.ok(!server.includes(flag), `server.js must not reference ${flag}`);
    }
  });
});

describe("the Digisme pause is scoped to the employee sync alone", () => {
  const synker = read("services/synker.js");
  const code = codeOf(synker);

  it("the cron conditional names only employee_sync", () => {
    const init = code.slice(code.indexOf("initCronJobs("), code.indexOf("async syncStockHoldingReportWithLogging"));
    const guarded = init.slice(init.indexOf("if (lifecycleConfig.digisme.employeeSync)"));
    // The guarded block ends at its else; everything registered inside it must
    // be the employee sync and nothing else.
    const block = guarded.slice(0, guarded.indexOf("} else {"));
    const registered = [...block.matchAll(/register\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(registered, ["employee_sync"]);
  });

  it("the other synker jobs are registered outside it", () => {
    const init = code.slice(code.indexOf("initCronJobs("), code.indexOf("async syncStockHoldingReportWithLogging"));
    const guardStart = init.indexOf("if (lifecycleConfig.digisme.employeeSync)");
    const guardEnd = init.indexOf("}", init.indexOf("} else {") + 8);
    const outside = init.slice(0, guardStart) + init.slice(guardEnd);
    const registered = [...outside.matchAll(/register\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(registered.includes("product_sync"));
    assert.ok(registered.includes("stock_holding_report_sync"));
    assert.ok(!registered.includes("employee_sync"));
  });

  it("and the C2 local-master guard touches only the employee sync function", () => {
    const employeeFn = code.slice(
      code.indexOf("async syncDigismeEmployees()"),
      code.indexOf("async reconcileEmployeeLifecycle()")
    );
    assert.ok(employeeFn.includes("lifecycleConfig.localEmployeeMaster"));
    const everythingElse = code.replace(employeeFn, "");
    assert.ok(!/localEmployeeMaster/.test(everythingElse), "no other job is gated by it");
  });

  it("nothing in the synker mentions purchases, so the pause cannot reach them", () => {
    const init = code.slice(code.indexOf("initCronJobs("), code.indexOf("async syncStockHoldingReportWithLogging"));
    assert.ok(!/purchase/i.test(init), "the purchase jobs do not live here");
  });
});

describe("the purchase table has no cron writing it", () => {
  it("nothing schedules a write to `purchase` - it is an external push", () => {
    // Established during the 6 September investigation and worth keeping
    // recorded: if someone later adds a purchase cron, this test should fail
    // and make them say so deliberately.
    const server = codeOf(read("server.js"));
    const names = [...server.matchAll(/register\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    const purchaseJobs = names.filter((n) => /purchase/.test(n));
    assert.deepEqual(
      purchaseJobs.sort(),
      ["purchase_acknowledgement_gofrugal_sync", "purchase_ref_cache_warm"],
      "the only purchase jobs are the GoFrugal acknowledgement pull and a cache warm"
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
