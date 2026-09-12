/**
 * Stage 0C / C1c — the employment-period reconciler, after the Digisme sync
 * was removed.
 *
 *   node --test services/synker_lifecycle.test.js
 *
 * This file used to pin how `syncDigismeEmployees()` invoked the reconciler:
 * that the 07:00 cron and a manual POST /employee/sync behaved identically
 * because both reached the one call site. That sync is gone
 * (docs/digisme-employee-sync-removal.md), so the contract it pinned no
 * longer exists.
 *
 * What is still true, and worth keeping true, is the reconciler itself:
 * `reconcileEmployeeLifecycle()` is correct when called, reports a partial
 * failure as 207 rather than a silent success, survives a deployment where it
 * is not wired, and is still constructed and handed to the synker by
 * server.js.
 *
 * IT HAS NO CALLER. That is asserted here deliberately rather than left to be
 * discovered: nothing reconciles employment periods on a schedule today. The
 * sync that used to call it had been disabled at two independent switches for
 * the whole of Stage 0C, so this ran in production under neither the pause
 * nor the removal - but a reader of this file should not have to work that
 * out. Giving it a caller is a separate decision.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const synkerSource = read("services/synker.js");
const serverSource = read("server.js");
/** Statements only; a comment naming something proves nothing either way. */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A Synker with nothing but the reconciler wired. */
function makeSynker({ lifecycle = null, throws = false } = {}) {
  delete require.cache[require.resolve("./synker")];
  const build = require("./synker");
  const calls = { reconcile: 0 };
  const synker = build({}, {}, {}, {}, {}, {}, {}, {});

  if (lifecycle !== null) {
    synker.setEmployeeLifecycleUsecase({
      reconcileAll: async () => {
        calls.reconcile += 1;
        if (throws) throw new Error("deadlock");
        return lifecycle;
      },
    });
  }
  return { synker, calls };
}

const EMPTY = {
  candidates: 0, none: 0, open_initial: 0, open_rejoin: 0,
  close: 0, fill: 0, skipped: 0, failed: 0, failures: [],
};

describe("the reconciler still works when called", () => {
  it("reconciles once and reports 200 on a clean run", async () => {
    const { synker, calls } = makeSynker({ lifecycle: EMPTY });
    const res = await synker.reconcileEmployeeLifecycle();
    assert.equal(calls.reconcile, 1);
    assert.equal(res.code, 200);
    assert.equal(res.lifecycle.failed, 0);
  });

  it("individual employee failures surface as 207 rather than a silent success", async () => {
    const { synker } = makeSynker({
      lifecycle: { ...EMPTY, candidates: 2, failed: 1, close: 1, failures: [{ employee_id: 9, error: "x" }] },
    });
    const res = await synker.reconcileEmployeeLifecycle();
    assert.equal(res.code, 207);
    assert.equal(res.lifecycle.failed, 1);
  });

  it("a thrown reconciliation is visible and retryable", async () => {
    const { synker, calls } = makeSynker({ lifecycle: EMPTY, throws: true });
    const res = await synker.reconcileEmployeeLifecycle();
    assert.equal(calls.reconcile, 1);
    assert.equal(res.code, 207);
    assert.match(res.error, /deadlock/);
    // Reconciliation is derived from current state, so running again repairs it.
    synker.setEmployeeLifecycleUsecase({ reconcileAll: async () => ({ ...EMPTY }) });
    assert.equal((await synker.reconcileEmployeeLifecycle()).code, 200);
  });

  it("a deployment with no reconciler wired says so instead of throwing", async () => {
    const { synker } = makeSynker({ lifecycle: null });
    const res = await synker.reconcileEmployeeLifecycle();
    assert.equal(res.code, 200);
    assert.equal(res.lifecycle.skipped, "not_wired");
  });
});

describe("the Digisme sync it used to hang off is gone", () => {
  const code = codeOf(synkerSource);

  it("no sync function, credential or endpoint remains", () => {
    for (const gone of [
      "syncDigismeEmployees",
      "_fetchDigismeEmployees",
      "_authenticateDigisme",
      "getDigismeToken",
      "DIGISME_API_KEY",
      "DIGISME_CUSTOM_KEY",
      "indhrmsgateway",
    ]) {
      assert.ok(!code.includes(gone), `services/synker.js still references ${gone}`);
    }
  });

  it("the reconciler has no caller in the tree", () => {
    const callers = [];
    for (const dir of ["services", "routes", "usecase", "utils"]) {
      for (const f of fs.readdirSync(path.join(__dirname, "..", dir))) {
        if (!f.endsWith(".js") || f.includes(".test.")) continue;
        const src = codeOf(read(path.join(dir, f)));
        if (/\breconcileEmployeeLifecycle\(\)/.test(src.replace(/async reconcileEmployeeLifecycle\(\)/, ""))) {
          callers.push(`${dir}/${f}`);
        }
      }
    }
    assert.deepEqual(callers, [], "nothing calls it - giving it a caller is a deliberate, separate change");
  });

  it("and POST /employee/sync no longer exists", () => {
    const routes = codeOf(read("routes/employee.js"));
    assert.ok(!/router\.post\("\/sync"/.test(routes));
    const employeeUsecase = codeOf(read("usecase/employee.js"));
    assert.ok(!/setSynker/.test(employeeUsecase), "the synker is not wired into the employee usecase any more");
  });
});

describe("the wiring in server.js", () => {
  it("builds the repository, the usecase, and hands it to the synker", () => {
    assert.match(serverSource, /require\("\.\/repository\/employee_lifecycle"\)/);
    assert.match(serverSource, /require\("\.\/usecase\/employee_lifecycle"\)/);
    assert.match(serverSource, /setEmployeeLifecycleUsecase\(this\.employeeLifecycleUsecase\)/);
  });

  it("gives the usecase the user repository, so a rejoin can revoke sessions", () => {
    const call = serverSource.match(
      /this\.employeeLifecycleUsecase = require\("\.\/usecase\/employee_lifecycle"\)\([\s\S]*?\);/
    );
    assert.ok(call, "the usecase must be constructed");
    assert.match(call[0], /this\.userRepo/);
  });
});
