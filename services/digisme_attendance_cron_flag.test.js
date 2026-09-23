/**
 * DIGISME_ATTENDANCE_CRON_ENABLED=false stops the two DigiSME attendance
 * jobs from being registered - and stops nothing else.
 *
 *   node --test services/digisme_attendance_cron_flag.test.js
 *
 * The gate is not tested as a copy: the REAL block is lifted out of server.js
 * between its `digisme-cron-gate:start/end` markers and run against a
 * recording CronService, once per value of the flag. server.js cannot be
 * required here (it opens sockets and a database on load), so the markers are
 * the seam. Delete or rename them and these tests fail loudly rather than
 * quietly passing against nothing.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const CODE = SERVER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const {
  isDigismeAttendanceCronEnabled,
  DIGISME_ATTENDANCE_CRON_DISABLED_LOG,
} = require("./digisme_attendance_cron_flag");
const createDigismeSync = require("../usecase/digisme_attendance_sync");

const DIGISME_JOBS = ["digisme_attendance_live", "digisme_attendance_recovery"];

/* --------------------------------------------------------- the flag */

describe("isDigismeAttendanceCronEnabled", () => {
  it("C. defaults to enabled when the variable is absent or empty", () => {
    assert.equal(isDigismeAttendanceCronEnabled({}), true);
    assert.equal(isDigismeAttendanceCronEnabled({ DIGISME_ATTENDANCE_CRON_ENABLED: "" }), true);
    assert.equal(isDigismeAttendanceCronEnabled({ DIGISME_ATTENDANCE_CRON_ENABLED: undefined }), true);
  });

  it("C. is enabled for 'true' and for anything that is not the word false", () => {
    for (const value of ["true", "TRUE", "1", "yes", "off", "0", "no", "falsey", "disabled"]) {
      assert.equal(isDigismeAttendanceCronEnabled({ DIGISME_ATTENDANCE_CRON_ENABLED: value }), true, value);
    }
  });

  it("A/B. is disabled only for an explicit, case-insensitive, trimmed false", () => {
    for (const value of ["false", "FALSE", "False", " FALSE ", "\tfalse\n"]) {
      assert.equal(
        isDigismeAttendanceCronEnabled({ DIGISME_ATTENDANCE_CRON_ENABLED: value }),
        false,
        JSON.stringify(value)
      );
    }
  });
});

/* ------------------------------------------- the real block, executed */

const GATE = (() => {
  const start = SERVER.indexOf("/* digisme-cron-gate:start */");
  const end = SERVER.indexOf("/* digisme-cron-gate:end */");
  assert.ok(start !== -1 && end > start, "the digisme-cron-gate markers must still be in server.js");
  return SERVER.slice(start + "/* digisme-cron-gate:start */".length, end);
})();

/** Runs the extracted block with a recording cron service and a chosen env. */
function runGate(env, usecase) {
  const registered = [];
  const logs = [];
  const runs = [];
  const self = {
    cronService: { register: (name, schedule, task) => registered.push({ name, schedule, task }) },
    digismeAttendanceSyncUsecase: usecase || {
      runLive: async () => runs.push("live"),
      runHistorical: async () => runs.push("historical"),
    },
  };
  // eslint-disable-next-line no-new-func
  const block = new Function(
    "isDigismeAttendanceCronEnabled",
    "DIGISME_ATTENDANCE_CRON_DISABLED_LOG",
    "console",
    "process",
    GATE
  );
  block.call(
    self,
    isDigismeAttendanceCronEnabled,
    DIGISME_ATTENDANCE_CRON_DISABLED_LOG,
    { log: (msg) => logs.push(msg) },
    { env }
  );
  return { registered, logs, runs, names: registered.map((j) => j.name) };
}

describe("the gate in server.js", () => {
  it("A. flag=false registers NEITHER DigiSME attendance job", () => {
    const { registered } = runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: "false" });
    assert.deepEqual(registered, []);
  });

  it("B. flag=' FALSE ' also registers neither", () => {
    for (const value of [" FALSE ", "False", "\tfalse\n"]) {
      assert.deepEqual(runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: value }).registered, [], JSON.stringify(value));
    }
  });

  it("logs the disabled line exactly once, and only when disabled", () => {
    assert.deepEqual(runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: "false" }).logs, [
      "[CRON] DigiSME attendance sync disabled by DIGISME_ATTENDANCE_CRON_ENABLED=false",
    ]);
    assert.deepEqual(runGate({}).logs, []);
    assert.deepEqual(runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: "true" }).logs, []);
  });

  it("C. unset registers both jobs on their unchanged schedules", () => {
    const { registered } = runGate({});
    assert.deepEqual(
      registered.map((j) => [j.name, j.schedule]),
      [
        ["digisme_attendance_live", "* * * * *"],
        ["digisme_attendance_recovery", "45 6,12,18,23 * * *"],
      ]
    );
  });

  it("C. flag=true registers both jobs, and their callbacks still call the one sync usecase", async () => {
    const { registered, runs } = runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: "true" });
    assert.deepEqual(registered.map((j) => j.name), DIGISME_JOBS);
    await registered[0].task();
    await registered[1].task();
    assert.deepEqual(runs, ["live", "historical"]);
  });
});

/* ------------------------ D/E. no DigiSME call, no DigiSME failure alert */

describe("D/E. disabled mode makes no DigiSME call and cannot raise a DigiSME failure alert", () => {
  /**
   * The REAL sync usecase, wired to a DigiSME client that fails every call
   * (production has no DigiSME attendance credentials) and to a recording
   * Telegram alerter. Its constructor makes no call on its own.
   */
  const realUsecase = () => {
    const clientCalls = [];
    const alerts = [];
    const failing = (name) => async (...args) => {
      clientCalls.push(name);
      throw new Error("DigiSME credentials missing");
    };
    const client = new Proxy({}, { get: (_t, prop) => (typeof prop === "string" ? failing(prop) : undefined) });
    const usecase = createDigismeSync({
      client,
      repo: {},
      store: {},
      importUsecase: {},
      apiSyncLogger: { write: async () => {} },
      alerter: { sendMessage: async (text) => alerts.push(text) },
      // Inside the alert window, on a working day.
      now: () => new Date("2026-09-24T06:30:00Z"),
    });
    const calls = { runLive: 0, runHistorical: 0 };
    const spy = {
      runLive: (...a) => { calls.runLive += 1; return usecase.runLive(...a); },
      runHistorical: (...a) => { calls.runHistorical += 1; return usecase.runHistorical(...a); },
    };
    return { spy, calls, clientCalls, alerts };
  };

  /** Fire every registered job as a cron would, a day's worth of minutes. */
  const fireAll = async (registered, times) => {
    for (let i = 0; i < times; i += 1) {
      for (const job of registered) {
        /* eslint-disable no-await-in-loop */
        await Promise.resolve(job.task()).catch(() => {});
        /* eslint-enable no-await-in-loop */
      }
    }
  };

  it("D/E. flag=false: zero runLive/runHistorical, zero DigiSME client calls, zero alerts", async () => {
    const u = realUsecase();
    const { registered } = runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: "false" }, u.spy);
    await fireAll(registered, 120);
    assert.deepEqual(u.calls, { runLive: 0, runHistorical: 0 });
    assert.deepEqual(u.clientCalls, []);
    assert.deepEqual(u.alerts, []);
  });

  it("contrast - flag unset: the same failing setup IS called by the crons (the behaviour being switched off)", async () => {
    const u = realUsecase();
    const { registered } = runGate({}, u.spy);
    await fireAll(registered, 1);
    assert.equal(u.calls.runLive, 1);
    assert.equal(u.calls.runHistorical, 1);
    assert.ok(u.clientCalls.length > 0, "enabled crons do reach the DigiSME client");
  });

  it("E. nothing else in the codebase calls runLive/runHistorical - the two crons were the only route", () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".git"].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js") && !entry.name.includes("harness")) {
          const src = fs.readFileSync(full, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
          if (/digismeAttendanceSyncUsecase\.run(Live|Historical)\(/.test(src)) hits.push(path.relative(ROOT, full));
        }
      }
    };
    walk(ROOT);
    assert.deepEqual(hits, ["server.js"]);
    const inServer = (CODE.match(/digismeAttendanceSyncUsecase\.run(Live|Historical)\(/g) || []).length;
    const inGate = (GATE.match(/digismeAttendanceSyncUsecase\.run(Live|Historical)\(/g) || []).length;
    assert.equal(inServer, 2);
    assert.equal(inGate, 2, "both calls are inside the gate");
  });
});

/* --------------------------------------------- F/G. attendance crons stay */

describe("F/G. the attendance crons are untouched by the switch", () => {
  it("the gate covers the two DigiSME jobs and nothing more", () => {
    const gated = [...GATE.matchAll(/this\.cronService\.register\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(gated, DIGISME_JOBS);
  });

  it("F. attendance_daily_recalculation stays registered at 06:55, outside the gate", () => {
    assert.match(CODE, /register\(\s*"attendance_daily_recalculation",\s*"55 6 \* \* \*"/);
    assert.ok(!/attendance_daily_recalculation/.test(GATE));
  });

  it("G. attendance_missing_telegram stays registered at 07:00, outside the gate, its own flag unchanged", () => {
    assert.match(CODE, /register\(\s*"attendance_missing_telegram",\s*"0 7 \* \* \*"/);
    assert.ok(!/attendance_missing_telegram/.test(GATE));
    assert.match(CODE, /process\.env\.ATTENDANCE_MISSING_TELEGRAM_ENABLED/);
  });

  it("F/G. both are scheduled in Asia/Kolkata", () => {
    const CronService = require("./cron_service");
    assert.equal(CronService.CRON_TIMEZONE, "Asia/Kolkata");
    const service = fs.readFileSync(path.join(ROOT, "services", "cron_service.js"), "utf8");
    assert.match(service, /\{\s*timezone:\s*CRON_TIMEZONE\s*\}/);
  });

  it("every other job is still registered unconditionally", () => {
    const all = [...CODE.matchAll(/this\.cronService\.register\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    const others = all.filter((n) => !DIGISME_JOBS.includes(n));
    for (const name of ["attendance_daily_recalculation", "attendance_missing_telegram", "attendance_recalculation_queue"]) {
      assert.ok(others.includes(name), `${name} must still be registered`);
    }
    assert.ok(others.length >= 10, `expected the other crons to survive, saw ${others.length}`);
  });

  it("CRON_DISABLED is untouched - the switch lives at the registration site, not in the shared scheduler", () => {
    const service = fs.readFileSync(path.join(ROOT, "services", "cron_service.js"), "utf8");
    assert.match(service, /process\.env\.CRON_DISABLED === "true"/);
    assert.ok(!/DIGISME_ATTENDANCE_CRON_ENABLED/.test(service));
  });
});

/* ------------------------------------------------ H. direct Biomax apart */

describe("H. the direct Biomax receiver is not part of this switch", () => {
  it("no Biomax file reads the flag, and the gate touches nothing Biomax", () => {
    const biomaxDir = path.join(ROOT, "biomax");
    for (const file of fs.readdirSync(biomaxDir).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(biomaxDir, file), "utf8");
      assert.ok(!/DIGISME_ATTENDANCE_CRON_ENABLED|digisme_attendance_cron_flag/.test(src), file);
    }
    assert.ok(!/biomax/i.test(GATE));
  });

  it("the receiver is still its own process, outside the API's crons", () => {
    const receiver = fs.readFileSync(path.join(ROOT, "biomax", "receiver.js"), "utf8");
    assert.ok(!/cronService|digisme_attendance/i.test(receiver));
  });
});
