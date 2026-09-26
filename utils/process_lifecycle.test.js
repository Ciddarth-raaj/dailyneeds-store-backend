/**
 * How the API process ends (utils/process_lifecycle.js).
 *
 *   node --test utils/process_lifecycle.test.js
 *
 * The real server is exercised end to end by
 * test_support/api_db_stress/zombie.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { installProcessLifecycle } = require("./process_lifecycle");

function fakeProc(uptimeS = 3600) {
  const p = new EventEmitter();
  p.uptime = () => uptimeS;
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("process lifecycle", () => {
  it("an uncaught exception logs ONCE, runs cleanup, and exits 1 (so pm2 restarts it)", async () => {
    const proc = fakeProc();
    const logs = [];
    const exits = [];
    let closed = 0;
    installProcessLifecycle({ proc, onClose: async () => closed++, log: (code) => logs.push(code), exit: (c) => exits.push(c), minUptimeMs: 0 });
    proc.emit("uncaughtException", new Error("boom"));
    proc.emit("uncaughtException", new Error("second boom during shutdown"));
    await sleep(20);
    assert.deepEqual(exits, [1]);
    assert.equal(closed, 1, "cleanup ran once");
    assert.deepEqual(logs, ["SERVER.EXIT", "SERVER.EXIT_DURING_SHUTDOWN"]);
  });

  it("SIGTERM / SIGINT are graceful: cleanup, exit 0", async () => {
    for (const sig of ["SIGTERM", "SIGINT"]) {
      const proc = fakeProc();
      const exits = [];
      let closed = 0;
      installProcessLifecycle({ proc, onClose: async () => closed++, log: () => {}, exit: (c) => exits.push(c) });
      proc.emit(sig);
      await sleep(20);
      assert.deepEqual(exits, [0], sig);
      assert.equal(closed, 1);
    }
  });

  it("exits by the deadline even when cleanup hangs", async () => {
    const proc = fakeProc();
    const exits = [];
    const t0 = Date.now();
    installProcessLifecycle({ proc, onClose: () => new Promise(() => {}), log: () => {}, exit: (c) => exits.push(c), fatalDeadlineMs: 100, minUptimeMs: 0 });
    proc.emit("uncaughtException", new Error("boom"));
    await sleep(150);
    assert.deepEqual(exits, [1]);
    assert.ok(Date.now() - t0 < 1000);
  });

  it("a fatal error right after boot waits out the minimum uptime: no tight restart loop", async () => {
    const proc = fakeProc(0.05); // 50 ms old
    const exits = [];
    const t0 = Date.now();
    installProcessLifecycle({ proc, onClose: async () => {}, log: () => {}, exit: (c) => exits.push({ c, at: Date.now() - t0 }), minUptimeMs: 300, fatalDeadlineMs: 50 });
    proc.emit("uncaughtException", new Error("boot crash"));
    await sleep(100);
    assert.equal(exits.length, 0, "not yet");
    await sleep(300);
    assert.equal(exits.length, 1);
    assert.ok(exits[0].at >= 240, `exited after ${exits[0].at} ms`);
  });

  it("a cleanup that throws is logged and the process still exits", async () => {
    const proc = fakeProc();
    const logs = [];
    const exits = [];
    installProcessLifecycle({ proc, onClose: async () => { throw new Error("pool end failed"); }, log: (code) => logs.push(code), exit: (c) => exits.push(c), minUptimeMs: 0 });
    proc.emit("uncaughtException", new Error("boom"));
    await sleep(20);
    assert.deepEqual(exits, [1]);
    assert.ok(logs.includes("SERVER.EXIT_CLEANUP_FAILED"));
  });

  it("an unhandled rejection is counted, not fatal (unchanged Node 14 behaviour)", async () => {
    const proc = fakeProc();
    const exits = [];
    const lc = installProcessLifecycle({ proc, onClose: async () => {}, log: () => {}, exit: (c) => exits.push(c) });
    proc.emit("unhandledRejection", new Error("x"));
    await sleep(10);
    assert.deepEqual(exits, []);
    assert.equal(lc.stats().unhandled_rejections, 1);
  });
});
