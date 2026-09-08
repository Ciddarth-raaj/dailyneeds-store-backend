/**
 * Stage 0C / C1c — how the Digisme sync invokes the reconciler.
 *
 *   node --test services/synker_lifecycle.test.js
 *
 * The requirement is that the 07:00 cron and a manual POST /employee/sync
 * behave identically. They do, and not by two call sites kept in step: both
 * reach `syncDigismeEmployees()`, and the reconciler is called there, once,
 * after the employee master has been written. This file pins that - a future
 * change that reconciled from the cron only would fail here.
 *
 * Digisme's role is unchanged. Nothing in these tests writes to
 * `new_employee`; the reconciler runs after the sync has, and reads what it
 * left.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const synkerSource = read("services/synker.js");
const serverSource = read("server.js");

/** A Synker with the network and the master sync stubbed out. */
function makeSynker({ syncFails = false, lifecycle = null } = {}) {
  delete require.cache[require.resolve("./synker")];
  // Both guards off, for these tests only: P1's pause and C2's local-master
  // guard each block this path on their own, and what is under test here is
  // what happens AFTER them - that the reconciler runs once, at the right
  // moment. That C2 blocks the path is pinned in routes/employee_master.test.js
  // and services/digisme_pause.p1.test.js.
  process.env.DIGISME_EMPLOYEE_SYNC = "on";
  process.env.LOCAL_EMPLOYEE_MASTER = "off";
  delete require.cache[require.resolve("../config/lifecycle")];
  const build = require("./synker");

  const calls = { bulkCreate: 0, reconcile: 0 };
  const employeeUsecase = {
    bulkCreate: async () => {
      calls.bulkCreate += 1;
      if (syncFails) throw new Error("Digisme returned garbage");
      return { affectedRows: 1 };
    },
  };
  const noopBulk = async () => ({});
  const synker = build(
    {}, {}, {},
    { bulkCreate: noopBulk },              // department
    {}, {},
    { bulkCreate: noopBulk },              // designation
    { bulkCreate: noopBulk },              // outlet
    employeeUsecase,
    {}, {}
  );

  // The Digisme fetch is the only network call; everything past it is real.
  synker._fetchDigismeEmployees = async () => [
    {
      EmployeeCode: 101, EmployeeName: "test person", Gender: "MALE", MartialStatus: "SINGLE",
      DepartmentCode: "NONE", DesignationCode: "D1", DesignationName: "Cashier",
      CategoryCode: "C1", CategoryName: "Branch", ShiftCode: "S1", MobileNo: "91-9000000000",
      IsTerminated: "No", TerminateDate: null,
    },
  ];

  if (lifecycle !== null) {
    synker.setEmployeeLifecycleUsecase({
      reconcileAll: async () => {
        calls.reconcile += 1;
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

describe("20. both sync entry points run the same reconciler", () => {
  it("the cron job and POST /employee/sync both call syncDigismeEmployees", () => {
    // The cron registration.
    assert.match(synkerSource, /cronService\.register\(\s*"employee_sync"/);
    const cron = synkerSource.slice(
      synkerSource.indexOf('"employee_sync"'),
      synkerSource.indexOf('"employee_sync"') + 400
    );
    assert.match(cron, /this\.syncDigismeEmployees\(\)/);

    // The manual route, via the usecase.
    const usecase = read("usecase/employee.js");
    const sync = usecase.slice(usecase.indexOf("  sync()"), usecase.indexOf("  sync()") + 600);
    assert.match(sync, /this\.synker\.syncDigismeEmployees\(\)/);
  });

  it("reconciliation is called from syncDigismeEmployees itself, not from either caller", () => {
    const fn = synkerSource.slice(
      synkerSource.indexOf("async syncDigismeEmployees()"),
      synkerSource.indexOf("async reconcileEmployeeLifecycle()")
    );
    assert.match(fn, /this\.reconcileEmployeeLifecycle\(\)/);
    // Exactly one call site in the whole file besides the definition.
    const hits = synkerSource.match(/this\.reconcileEmployeeLifecycle\(\)/g) || [];
    assert.equal(hits.length, 1, "one entry point, so the two callers cannot drift apart");
  });

  it("a real sync run reconciles exactly once, after the master is written", async () => {
    const { synker, calls } = makeSynker({ lifecycle: { ...EMPTY, candidates: 0 } });
    const res = await synker.syncDigismeEmployees();
    assert.equal(calls.bulkCreate, 1);
    assert.equal(calls.reconcile, 1);
    assert.equal(res.code, 200);
  });
});

describe("failure handling", () => {
  it("a failed master sync does NOT reconcile against half-written data", async () => {
    const { synker, calls } = makeSynker({ syncFails: true, lifecycle: EMPTY });
    const res = await synker.syncDigismeEmployees();
    assert.equal(calls.reconcile, 0, "no conclusions from a master Digisme never confirmed");
    assert.equal(res.code, 500);
  });

  it("a failed reconciliation is visible and retryable, and does not fail the sync", async () => {
    const { synker, calls } = makeSynker({ lifecycle: EMPTY });
    synker.setEmployeeLifecycleUsecase({
      reconcileAll: async () => {
        calls.reconcile += 1;
        throw new Error("deadlock");
      },
    });
    const res = await synker.syncDigismeEmployees();
    assert.equal(res.code, 207, "partial: the master synced, the lifecycle did not");
    assert.match(res.error, /deadlock/);
    // Reconciliation is derived from current state, so simply running again repairs it.
    synker.setEmployeeLifecycleUsecase({ reconcileAll: async () => ({ ...EMPTY }) });
    assert.equal((await synker.syncDigismeEmployees()).code, 200);
  });

  it("individual employee failures surface as 207 rather than a silent success", async () => {
    const { synker } = makeSynker({
      lifecycle: { ...EMPTY, candidates: 2, failed: 1, close: 1, failures: [{ employee_id: 9, error: "x" }] },
    });
    const res = await synker.syncDigismeEmployees();
    assert.equal(res.code, 207);
    assert.equal(res.lifecycle.failed, 1);
  });

  it("a deployment with no reconciler wired still syncs", async () => {
    const { synker, calls } = makeSynker({ lifecycle: null });
    const res = await synker.syncDigismeEmployees();
    assert.equal(calls.bulkCreate, 1);
    assert.equal(res.code, 200);
    assert.equal(res.lifecycle.skipped, "not_wired");
  });
});

describe("Digisme's role is unchanged", () => {
  it("the sync still writes the employee master before anything lifecycle-related", () => {
    const fn = synkerSource.slice(
      synkerSource.indexOf("async syncDigismeEmployees()"),
      synkerSource.indexOf("async reconcileEmployeeLifecycle()")
    );
    assert.ok(
      fn.indexOf("employeeUsecase.bulkCreate") < fn.indexOf("reconcileEmployeeLifecycle"),
      "reconciliation reads what the sync left, so it must come second"
    );
    // Designation, department and outlet upserts are untouched by C1c.
    for (const marker of [
      "designationUsecase.bulkCreate",
      "departmentUsecase.bulkCreate",
      "outletUsecase.bulkCreate",
    ]) {
      assert.ok(fn.includes(marker), `${marker} must still run`);
    }
  });

  it("C1c writes nothing to new_employee", () => {
    for (const file of [
      "repository/employee_lifecycle.js",
      "usecase/employee_lifecycle.js",
    ]) {
      const src = read(file);
      assert.ok(!/UPDATE\s+new_employee/i.test(src), `${file} must not update the employee master`);
      assert.ok(!/INSERT\s+INTO\s+new_employee/i.test(src), `${file} must not insert employees`);
      assert.ok(!/DELETE\s+FROM\s+new_employee/i.test(src), `${file} must not delete employees`);
    }
  });

  it("C1c leaves the resignation table alone", () => {
    // Digisme is still authoritative, and `resignation` is keyed by
    // employee_name with a free-text date - not a deterministic link. C1c
    // reads and writes neither, so it cannot become a second lifecycle
    // master or corrupt an old ambiguous row.
    // Matched as SQL against the table, not as the word: `end_reason_type`
    // legitimately takes the ENUM value 'resignation', and the prose
    // explains why the table is left alone.
    for (const file of ["repository/employee_lifecycle.js", "usecase/employee_lifecycle.js"]) {
      const src = read(file);
      for (const sql of [
        /\bFROM\s+resignation\b/i,
        /\bJOIN\s+resignation\b/i,
        /\bINTO\s+resignation\b/i,
        /\bUPDATE\s+resignation\b/i,
        /\bDELETE\s+FROM\s+resignation\b/i,
      ]) {
        assert.ok(!sql.test(src), `${file} must not touch the resignation table (${sql})`);
      }
    }
  });

  it("the P1 Digisme pause still short-circuits before any lifecycle work", () => {
    const fn = synkerSource.slice(
      synkerSource.indexOf("async syncDigismeEmployees()"),
      synkerSource.indexOf("async reconcileEmployeeLifecycle()")
    );
    assert.ok(
      fn.indexOf("lifecycleConfig.digisme.employeeSync") < fn.indexOf("_fetchDigismeEmployees"),
      "the pause guard must still come first"
    );
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
