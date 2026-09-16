/**
 * THE TELEGRAM POLLER RUNS EVERY THREE SECONDS, AND THAT IS ONLY SAFE
 * BECAUSE OF FACTS THAT LIVE IN OTHER FILES.
 *
 *   node --test services/telegram_poll_topology.test.js
 *
 * A cadence is not a local decision. Twenty ticks a minute is harmless only
 * while (a) exactly one process runs the schedule, (b) exactly one caller
 * owns Telegram's update offset, (c) a slow tick cannot overlap the next one,
 * and (d) each call returns immediately instead of holding a connection open.
 * Break any one of those and the symptom is not a crash - it is linking that
 * works for some employees and not others, with nothing in the log to say so.
 *
 * So the cadence and its four preconditions are asserted together, here,
 * against the source. A future change that scales the API to two instances or
 * switches getUpdates to long polling fails this file rather than production.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const server = strip(read("server.js"));

/** The literal the server registers the poller with. */
function pollSchedule() {
  const m = server.match(/TELEGRAM_LINK_POLL_CRON\s*=\s*"([^"]+)"/);
  assert.ok(m, "TELEGRAM_LINK_POLL_CRON must still be a literal in server.js");
  return m[1];
}

describe("the Telegram poll cadence", () => {
  it("is every three seconds, as a six-field expression", () => {
    assert.equal(pollSchedule(), "*/3 * * * * *");
  });

  it("is registered against the poller and nothing else", () => {
    const registration = server.match(
      /register\(\s*"telegram_link_poll",\s*TELEGRAM_LINK_POLL_CRON,[\s\S]{0,200}?pollTelegramUpdates/
    );
    assert.ok(registration, "the three-second schedule must be the one wired to pollTelegramUpdates");
  });

  it("is a schedule the pinned node-cron actually accepts", () => {
    assert.equal(cron.validate(pollSchedule()), true);
  });

  it("fires seconds apart, measured not assumed", async () => {
    // node-cron's seconds field is the whole reason this cadence is
    // expressible. Asserting the string alone would still pass if a future
    // node-cron dropped six-field support and silently reinterpreted it.
    //
    // DELIBERATELY LOOSE BOUNDS. What is being distinguished here is seconds
    // from MINUTES - a five-field schedule cannot produce three ticks inside
    // this window at all, whatever the machine is doing. Pinning the gap to
    // 3000ms +/- 500 instead would make a busy CI box, which delays timers by
    // whole seconds, fail a test about node-cron's field parsing. That is a
    // flake, and a flake in a file like this teaches people to re-run it.
    const fired = [];
    await new Promise((resolve) => {
      const task = cron.schedule(pollSchedule(), () => {
        fired.push(Date.now());
        if (fired.length >= 3) {
          task.stop();
          resolve();
        }
      });
      setTimeout(() => {
        task.stop();
        resolve();
      }, 30000);
    });
    assert.ok(fired.length >= 3, `expected 3 ticks in 30s, saw ${fired.length} - is this still a seconds-precision schedule?`);
    for (let i = 1; i < fired.length; i += 1) {
      const gap = fired[i] - fired[i - 1];
      assert.ok(gap < 10000, `tick gap was ${gap}ms - that is not a seconds-precision cadence`);
    }
  });
});

describe("the preconditions the cadence depends on", () => {
  it("(a) the API is ONE process - no instances, no cluster mode", () => {
    // Two instances would each run this schedule, and each would call
    // getUpdates with its own in-memory offset. They would not both see a
    // message; they would race and each swallow updates the other needed.
    const ecosystem = require(path.join(ROOT, "ecosystem.config.js"));
    const api = ecosystem.apps.find((a) => a.script === "server.js");
    assert.ok(api, "the API app must still be declared");
    assert.equal(api.instances, undefined, "a second instance is a second poller racing the same offset");
    assert.notEqual(api.exec_mode, "cluster", "cluster mode multiplies the poller by the instance count");
  });

  it("(b) exactly one cron job polls, and it is this one", () => {
    const polls = server.match(/pollTelegramUpdates\s*\(/g) || [];
    assert.equal(polls.length, 1, "one scheduled poller, not two");
  });

  it("(c) a slow tick cannot overlap the next - the re-entrancy guard is intact", () => {
    const poll = strip(read("usecase/passwordReset.js"));
    assert.ok(/if \(this\.polling\) return/.test(poll), "the in-progress guard must survive");
    assert.ok(/in_progress/.test(poll), "an overlapping tick must report it rather than run");
    assert.ok(/finally\s*\{\s*this\.polling = false;/.test(poll), "the guard must clear even when the tick throws");
  });

  it("(d) getUpdates is SHORT polling - a tick must not hold the connection", () => {
    // With long polling the call would still be open when the next tick
    // arrives, every tick, so the re-entrancy guard would skip almost all of
    // them and the cadence would silently revert to the long-poll timeout.
    const service = strip(read("services/telegram.js"));
    const call = service.match(/async getUpdates\([\s\S]{0,300}?\n  \}/);
    assert.ok(call, "getUpdates must still be defined in the service");
    assert.ok(/timeout:\s*0/.test(call[0]), "timeout must stay 0; long polling breaks the three-second cadence");
  });
});

describe("what the faster poll must NOT have become", () => {
  it("it is still polling, not a webhook", () => {
    assert.ok(!/setWebhook/i.test(server), "a webhook would need the API reachable over public HTTPS");
  });

  it("no second timer polls Telegram alongside the cron", () => {
    const poll = strip(read("usecase/passwordReset.js"));
    assert.ok(!/setInterval/.test(poll), "the cron is the only clock");
  });
});
