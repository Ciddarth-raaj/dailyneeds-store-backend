/**
 * Stage 0C / P1 — the Digisme employee sync is paused, reversibly.
 *
 * Stage 0C makes dnds.co.in the owner of the employee lifecycle. The nightly
 * Digisme sync writes several of the same columns, so it is switched off for
 * the duration - switched off, not removed: every line of the integration is
 * still in the tree and one environment variable brings it back.
 *
 * What these tests are really protecting is the word "zero". A pause that
 * skipped only the cron would still let POST /employee/sync run the whole
 * routine; a pause that returned late would still have authenticated against
 * Digisme and upserted designations, departments and outlets before giving
 * up. So the assertions below are not "it returned 423" but "nothing was
 * called": the network functions and every usecase the routine writes
 * through are replaced with stubs that fail the test if they are reached.
 *
 * The flag is read once at require time (config/lifecycle.js, same shape as
 * config/auth.js), so each case reloads the modules under a fresh value
 * rather than mutating a live one.
 */
process.env.IS_TEST = "true";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");

const MODULES = ["../config/lifecycle", "../services/synker", "../routes/employee"];

/** Reload the flag and everything that reads it, under `value`. */
/**
 * `localMaster` defaults to "off" because these tests are about P1's own
 * switch. Stage 0C / C2 added a SECOND, independent guard - dnds.co.in is
 * now the employee master - so turning DIGISME_EMPLOYEE_SYNC on no longer
 * restores the legacy behaviour by itself. The last test in this file pins
 * that, and the rest disable the C2 guard so they still test what they were
 * written to test.
 */
const loadWith = (value, localMaster = "off") => {
  if (value === undefined) delete process.env.DIGISME_EMPLOYEE_SYNC;
  else process.env.DIGISME_EMPLOYEE_SYNC = value;
  process.env.LOCAL_EMPLOYEE_MASTER = localMaster;
  for (const m of MODULES) delete require.cache[require.resolve(m)];
  return {
    lifecycle: require("../config/lifecycle"),
    buildSynker: require("../services/synker"),
    buildEmployeeRoutes: require("../routes/employee"),
  };
};

/**
 * A usecase whose every method fails the test when called. This is what
 * "zero DB writes" means here: designation, department, outlet and employee
 * writes all go through these.
 */
const forbidden = (label, calls) =>
  new Proxy(
    {},
    {
      get: (_t, name) => async () => {
        calls.push(`${label}.${String(name)}`);
        throw new Error(`${label}.${String(name)} must not be called while paused`);
      },
    }
  );

/** A synker with every collaborator booby-trapped, plus network stubs. */
const makeSynker = (buildSynker, calls) => {
  const s = buildSynker(
    forbidden("productUsecase", calls),
    forbidden("categoryUsecase", calls),
    forbidden("subcategoryUsecase", calls),
    forbidden("departmentUsecase", calls),
    forbidden("brandUsecase", calls),
    forbidden("cleaningPackingUsecase", calls),
    forbidden("designationUsecase", calls),
    forbidden("outletUsecase", calls),
    forbidden("employeeUsecase", calls),
    forbidden("productRepo", calls),
    forbidden("stockHoldingReportUsecase", calls)
  );
  // Network: both the token request and the employee fetch. Reaching either
  // one is a failure, and throwing here also proves the ON case got past the
  // guard without any real traffic leaving the process.
  s.getDigismeToken = async () => {
    calls.push("network.getDigismeToken");
    throw new Error("NETWORK_REACHED");
  };
  s._authenticateDigisme = async () => {
    calls.push("network._authenticateDigisme");
    throw new Error("NETWORK_REACHED");
  };
  s._fetchDigismeEmployees = async () => {
    calls.push("network._fetchDigismeEmployees");
    throw new Error("NETWORK_REACHED");
  };
  return s;
};

/** Records what a cron service was asked to register. */
const recordingCronService = () => {
  const registered = [];
  return { registered, register: (name, schedule) => registered.push({ name, schedule }) };
};

const OFF_VALUES = [undefined, "", "off", "false", "0", "no", "ON_BUT_TYPO"];

describe("P1: flag OFF (the default)", () => {
  it("defaults to paused when the variable is not set at all", () => {
    const { lifecycle } = loadWith(undefined);
    assert.equal(lifecycle.digisme.employeeSync, false);
  });

  it("treats every non-affirmative value as paused", () => {
    for (const v of OFF_VALUES) {
      const { lifecycle } = loadWith(v);
      assert.equal(lifecycle.digisme.employeeSync, false, `value ${JSON.stringify(v)}`);
    }
  });

  it("does not register the employee_sync cron", () => {
    const { buildSynker } = loadWith("off");
    const cronService = recordingCronService();
    makeSynker(buildSynker, []).initCronJobs(cronService, null);
    const names = cronService.registered.map((j) => j.name);
    assert.ok(!names.includes("employee_sync"), `registered: ${names.join(", ")}`);
  });

  it("leaves the unrelated cron jobs registered and scheduled as before", () => {
    const { buildSynker } = loadWith("off");
    const cronService = recordingCronService();
    makeSynker(buildSynker, []).initCronJobs(cronService, null);
    const names = cronService.registered.map((j) => j.name);
    assert.deepEqual(names, ["product_sync", "stock_holding_report_sync"]);
    const product = cronService.registered.find((j) => j.name === "product_sync");
    assert.equal(product.schedule, "0 4 * * *");
    const stock = cronService.registered.find((j) => j.name === "stock_holding_report_sync");
    assert.equal(stock.schedule, "30 7 * * *");
  });

  it("a direct call makes ZERO network requests and ZERO writes", async () => {
    const { buildSynker, lifecycle } = loadWith("off");
    const calls = [];
    const result = await makeSynker(buildSynker, calls).syncDigismeEmployees();

    assert.deepEqual(calls, [], `nothing may be called, but was: ${calls.join(", ")}`);
    assert.equal(result.code, 423);
    assert.equal(result.paused, true);
    assert.equal(result.msg, lifecycle.PAUSED_MESSAGE);
  });

  it("the direct call does not throw, so a stray caller cannot crash a job", async () => {
    const { buildSynker } = loadWith("off");
    await makeSynker(buildSynker, []).syncDigismeEmployees();
  });
});

describe("P1: flag ON restores the existing behaviour", () => {
  it("registers the employee_sync cron on its original schedule", () => {
    const { buildSynker } = loadWith("on");
    const cronService = recordingCronService();
    makeSynker(buildSynker, []).initCronJobs(cronService, null);
    const job = cronService.registered.find((j) => j.name === "employee_sync");
    assert.ok(job, "employee_sync must be registered when the flag is on");
    assert.equal(job.schedule, "0 7 * * *");
    assert.deepEqual(
      cronService.registered.map((j) => j.name),
      ["product_sync", "employee_sync", "stock_holding_report_sync"]
    );
  });

  it("accepts on / true / 1", () => {
    for (const v of ["on", "ON", "true", "1", " on "]) {
      const { lifecycle } = loadWith(v);
      assert.equal(lifecycle.digisme.employeeSync, true, `value ${JSON.stringify(v)}`);
    }
  });

  it("but C2's local-master guard still blocks the employee write", async () => {
    // After Stage 0C / C2 the employee master is local. Turning the Digisme
    // sync back on is no longer enough to let it write employees, which is
    // the whole point of that second guard.
    const { buildSynker } = loadWith("on", "on");
    const calls = [];
    const res = await makeSynker(buildSynker, calls).syncDigismeEmployees();
    assert.equal(res.code, 423);
    assert.equal(res.localEmployeeMaster, true);
    assert.ok(
      !calls.includes("network._fetchDigismeEmployees"),
      `Digisme must not even be contacted, calls: ${calls.join(", ") || "none"}`
    );
  });

  it("a direct call proceeds past the guard and reaches the fetch", async () => {
    const { buildSynker } = loadWith("on");
    const calls = [];
    // The routine catches its own errors, so the proof is the recorded call,
    // not a rejection: it got as far as asking Digisme for employees.
    await makeSynker(buildSynker, calls).syncDigismeEmployees();
    assert.ok(
      calls.includes("network._fetchDigismeEmployees"),
      `expected the fetch to be reached, calls: ${calls.join(", ") || "none"}`
    );
  });
});

describe("P1: POST /employee/sync", () => {
  let server, port;

  const mount = (flagValue) => {
    const { buildEmployeeRoutes } = loadWith(flagValue);
    const usecaseCalls = [];
    const employeeUsecase = new Proxy(
      {},
      {
        get: (_t, name) => async () => {
          usecaseCalls.push(String(name));
          return { code: 200 };
        },
      }
    );
    const passthrough = (req, res, next) => next();
    const permissions = { require: () => passthrough };
    const sensitive = { filterResponse: passthrough, guardWrite: passthrough };

    const app = express();
    app.use(bodyParser.json());
    app.use("/employee", buildEmployeeRoutes(employeeUsecase, permissions, sensitive).getRouter());
    return { app, usecaseCalls };
  };

  const listen = async (app) => {
    server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    port = server.address().port;
  };

  afterEach(() => {
    if (server) server.close();
    server = undefined;
  });

  it("answers 423 with a clear message while paused, and never calls the usecase", async () => {
    const { app, usecaseCalls } = mount("off");
    await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/employee/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await res.json();
    assert.equal(res.status, 423);
    assert.equal(body.code, 423);
    assert.equal(body.paused, true);
    assert.match(body.msg, /paused/i);
    assert.deepEqual(usecaseCalls, [], "the usecase must not be reached while paused");
  });

  it("calls the usecase as before when the flag is on", async () => {
    const { app, usecaseCalls } = mount("on");
    await listen(app);
    const res = await fetch(`http://127.0.0.1:${port}/employee/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.code, 200);
    assert.deepEqual(usecaseCalls, ["sync"]);
  });
});
