/**
 * The DigiSME crons assume ONE API PROCESS. This file fails if that stops
 * being true.
 *
 *   node --test services/digisme_cron_topology.test.js
 *
 * The live sync runs every minute and the recovery job four times a day.
 * Their re-entrancy guards and - far more importantly - the call throttle
 * they share are BOTH in-process module state. That is sound only while pm2
 * runs the API as a single fork-mode instance, which it does today:
 * ecosystem.config.js declares the app with no `instances` and no
 * `exec_mode`, and `pm2 reload 0` in fork mode is a restart rather than an
 * overlap (verified in docs/auth-stage0a-preproduction-readiness.md:
 * pm_id=0, exec_mode=fork_mode, instances=1).
 *
 * Add `instances: 2` or `exec_mode: "cluster"` and every instance runs its
 * own copy of both crons AND its own throttle queue. Vendor traffic
 * multiplies by the instance count, quietly breaching the 5-calls-per-minute
 * limit, and NOTHING IN OUR LOGS SAYS SO - each process believes it is
 * behaving. That is why this is a test and not a comment.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("the API is a single process", () => {
  it("ecosystem.config.js declares no instances and no cluster mode", () => {
    const ecosystem = require(path.join(ROOT, "ecosystem.config.js"));
    const api = ecosystem.apps.find((a) => a.script === "server.js");
    assert.ok(api, "the API app must still be declared");
    assert.equal(
      api.instances,
      undefined,
      "the DigiSME crons and their shared throttle are in-process: see the header before scaling this"
    );
    assert.notEqual(api.exec_mode, "cluster", "cluster mode multiplies DigiSME vendor traffic by the instance count");
  });

  it("the biomax receiver, which is a second process, makes no DigiSME calls", () => {
    // It is the one other pm2 app. If it ever called the gateway it would
    // have its own throttle queue and the two would not coordinate.
    const receiver = read(path.join("biomax", "receiver.js"));
    assert.ok(!/digisme_attendance/i.test(receiver));
  });
});

describe("both jobs share one client and one instance", () => {
  const server = read("server.js");
  const code = server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the sync usecase is constructed exactly once", () => {
    const matches = code.match(/require\("\.\/usecase\/digisme_attendance_sync"\)/g) || [];
    assert.equal(matches.length, 1, "two instances would each think they were the only run in flight");
  });

  it("both crons call that one instance", () => {
    assert.match(code, /register\(\s*"digisme_attendance_live",\s*"\* \* \* \* \*"/);
    assert.match(code, /register\(\s*"digisme_attendance_recovery",\s*"45 6,12,18,23 \* \* \*"/);
    assert.match(code, /this\.digismeAttendanceSyncUsecase\.runLive\(\)/);
    assert.match(code, /this\.digismeAttendanceSyncUsecase\.runHistorical\(\)/);
  });

  it("the schedules match the rows the operator screen displays", () => {
    // api_sync_cron_config does NOT schedule anything - the strings above
    // do. The two are kept equal by hand, and drifted apart once already
    // (20260701120000-product-sync-cron-4am). This keeps them honest.
    const sql = read(path.join("migrations", "mysql", "migrations", "sqls", "20261013120000-digisme-attendance-api-sync-up.sql"));
    assert.match(sql, /'digisme_attendance_live',[^,]+, 'sync', '\* \* \* \* \*'/);
    assert.match(sql, /'digisme_attendance_recovery',[^,]+, 'sync', '45 6,12,18,23 \* \* \*'/);
  });

  it("nothing else in the codebase calls the DigiSME client", () => {
    // A second caller would be fine (the queue is shared) but a second
    // SCHEDULE would not be obvious, so any new one should be a deliberate
    // edit here.
    const callers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (["node_modules", ".git", "docs", "migrations", "scripts", "test_support"].includes(entry.name)) continue;
          walk(rel);
        } else if (entry.name.endsWith(".js") && !entry.name.includes(".test.")) {
          if (/require\(["'][^"']*services\/digisme_attendance["']\)/.test(read(rel))) callers.push(rel);
        }
      }
    };
    for (const dir of ["services", "routes", "usecase", "repository", "utils", "biomax", "middlewares"]) walk(dir);
    if (/require\("\.\/services\/digisme_attendance"\)/.test(server)) callers.push("server.js");
    assert.deepEqual(callers, ["server.js"], "only server.js wires the DigiSME client");
  });
});

describe("phase 1 exposes no new route", () => {
  it("there is no manual DigiSME sync endpoint", () => {
    // Deliberate: the live sync self-heals today and recovery runs four
    // times a day, so a manual endpoint would be new permission surface for
    // no requirement. The usecase is callable as-is when one is wanted.
    const files = fs.readdirSync(path.join(ROOT, "routes")).filter((f) => f.endsWith(".js") && !f.includes(".test."));
    for (const f of files) {
      const code = read(path.join("routes", f)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.ok(
        !/digisme[_-]?attendance[_-]?sync|\/digisme\/(live|recovery|sync)/i.test(code),
        `routes/${f} exposes a DigiSME sync endpoint; phase 1 is cron-only`
      );
    }
  });
});
