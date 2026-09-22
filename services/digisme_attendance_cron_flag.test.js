/**
 * DIGISME_ATTENDANCE_CRON_ENABLED=false stops the two DigiSME attendance
 * jobs from being registered - and stops nothing else.
 *
 *   node --test services/digisme_attendance_cron_flag.test.js
 *
 * The interesting half of this file does not test a copy of the gate: it
 * lifts the REAL block out of server.js between its
 * `digisme-cron-gate:start/end` markers and runs it against a recording
 * CronService, once per value of the flag. server.js cannot be required here
 * (it opens sockets and a database on load), so the markers are the seam.
 * Delete or rename them and these tests fail loudly rather than quietly
 * passing against nothing.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

const {
  isDigismeAttendanceCronEnabled,
  DIGISME_ATTENDANCE_CRON_DISABLED_LOG,
} = require("./digisme_attendance_cron_flag");

/* --------------------------------------------------------- 1. the flag */

describe("isDigismeAttendanceCronEnabled", () => {
  it("defaults to enabled when the variable is absent or empty", () => {
    assert.equal(isDigismeAttendanceCronEnabled({}), true);
    assert.equal(isDigismeAttendanceCronEnabled({ DIGISME_ATTENDANCE_CRON_ENABLED: "" }), true);
    assert.equal(isDigismeAttendanceCronEnabled({ DIGISME_ATTENDANCE_CRON_ENABLED: undefined }), true);
  });

  it("is enabled for 'true' and for anything that is not the word false", () => {
    for (const value of ["true", "TRUE", "1", "yes", "off", "falsey", "disabled"]) {
      assert.equal(isDigismeAttendanceCronEnabled({ DIGISME_ATTENDANCE_CRON_ENABLED: value }), true, value);
    }
  });

  it("is disabled only for an explicit, case-insensitive false", () => {
    for (const value of ["false", "FALSE", "False", " false ", "\tfalse\n"]) {
      assert.equal(isDigismeAttendanceCronEnabled({ DIGISME_ATTENDANCE_CRON_ENABLED: value }), false, JSON.stringify(value));
    }
  });
});

/* ------------------------------------------- 2. the real block, executed */

const GATE = (() => {
  const start = SERVER.indexOf("/* digisme-cron-gate:start */");
  const end = SERVER.indexOf("/* digisme-cron-gate:end */");
  assert.ok(start !== -1 && end > start, "the digisme-cron-gate markers must still be in server.js");
  return SERVER.slice(start + "/* digisme-cron-gate:start */".length, end);
})();

/** Runs the extracted block with a recording cron service and a chosen env. */
function runGate(env) {
  const registered = [];
  const logs = [];
  const runs = [];
  const self = {
    cronService: { register: (name, schedule, task) => registered.push({ name, schedule, task }) },
    digismeAttendanceSyncUsecase: {
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
  it("registers both jobs when the flag is missing", () => {
    const { names, logs } = runGate({});
    assert.deepEqual(names, ["digisme_attendance_live", "digisme_attendance_recovery"]);
    assert.deepEqual(logs, []);
  });

  it("registers both jobs when the flag is true", () => {
    assert.deepEqual(runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: "true" }).names, [
      "digisme_attendance_live",
      "digisme_attendance_recovery",
    ]);
  });

  it("registers NEITHER job when the flag is false", () => {
    for (const value of ["false", "FALSE", " False "]) {
      const { registered } = runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: value });
      assert.deepEqual(registered, [], `expected no registration for ${JSON.stringify(value)}`);
    }
  });

  it("logs the disabled line exactly once, and only when disabled", () => {
    const { logs } = runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: "false" });
    assert.deepEqual(logs, ["[CRON] DigiSME attendance cron disabled by DIGISME_ATTENDANCE_CRON_ENABLED=false"]);
  });

  it("keeps the live and recovery schedules unchanged when enabled", () => {
    const { registered } = runGate({ DIGISME_ATTENDANCE_CRON_ENABLED: "true" });
    assert.equal(registered[0].schedule, "* * * * *");
    assert.equal(registered[1].schedule, "45 6,12,18,23 * * *");
  });

  it("the registered callbacks still call the one sync usecase", async () => {
    const { registered, runs } = runGate({});
    await registered[0].task();
    await registered[1].task();
    assert.deepEqual(runs, ["live", "historical"]);
  });
});

/* -------------------------------------------------- 3. nothing else moved */

describe("no other cron is affected", () => {
  const code = SERVER.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const ALL = [...code.matchAll(/this\.cronService\.register\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);

  it("the gate covers the two DigiSME jobs and nothing more", () => {
    const gated = [...GATE.matchAll(/this\.cronService\.register\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(gated, ["digisme_attendance_live", "digisme_attendance_recovery"]);
  });

  it("every other job is still registered unconditionally", () => {
    const others = ALL.filter((n) => !n.startsWith("digisme_attendance_"));
    // A representative spread across the file, not an exhaustive list.
    for (const name of [
      "purchase_acknowledgement_gofrugal_sync",
      "attendance_recalculation_queue",
      "telegram_link_poll",
      "attendance_missing_telegram",
      "break_glass_rotation_check",
    ]) {
      assert.ok(others.includes(name), `${name} must still be registered`);
    }
    assert.ok(others.length >= 10, `expected the other crons to survive, saw ${others.length}`);
  });

  it("CRON_DISABLED is untouched - it is still the only thing cron_service.start() checks", () => {
    const service = fs.readFileSync(path.join(ROOT, "services", "cron_service.js"), "utf8");
    assert.match(service, /process\.env\.CRON_DISABLED === "true"/);
    assert.ok(
      !/DIGISME_ATTENDANCE_CRON_ENABLED/.test(service),
      "the switch belongs at the registration site, not inside the shared scheduler"
    );
  });
});
