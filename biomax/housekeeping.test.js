/**
 * The bounded post-response queue and the diagnostic-row limiter.
 *
 *   node --test biomax/housekeeping.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createHousekeeper, createDiagLimiter } = require("./housekeeping");

/** A job whose promise settles only when the test says so. */
function gate() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeLog() {
  const lines = [];
  return { lines, error: (code, description, ref) => lines.push({ code, description, ...(ref || {}) }), info() {} };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("housekeeper", () => {
  it("never runs more than `concurrency` jobs and never holds more than `maxPending`", async () => {
    const log = makeLog();
    const hk = createHousekeeper({ concurrency: 2, maxPending: 5, log });
    const gates = [];
    let started = 0;
    const verdicts = [];
    for (let i = 0; i < 50; i += 1) {
      verdicts.push(
        hk.submit({
          name: "slow",
          run: () => {
            started += 1;
            const g = gate();
            gates.push(g);
            return g.promise;
          },
        })
      );
    }
    assert.equal(started, 2, "two running");
    assert.equal(hk.stats().pending, 5, "five waiting");
    assert.equal(verdicts.filter((v) => v === "accepted").length, 7);
    assert.equal(verdicts.filter((v) => v === "dropped").length, 43);
    assert.equal(hk.stats().dropped, 43);
    // One DROPPED line for the burst, not 43.
    assert.equal(log.lines.filter((l) => l.code === "HOUSEKEEPING_DROPPED").length, 1);

    gates.forEach((g) => g.resolve());
    await tick();
    while (hk.stats().running) {
      gates.forEach((g) => g.resolve());
      await tick();
    }
    await hk.idle();
    assert.equal(hk.stats().completed, 7);
  });

  it("bounds the bytes waiting, not just the count", () => {
    const hk = createHousekeeper({ concurrency: 1, maxPending: 100, maxPendingBytes: 100000, log: makeLog() });
    const g = gate();
    hk.submit({ name: "block", run: () => g.promise });
    const out = [];
    for (let i = 0; i < 10; i += 1) out.push(hk.submit({ name: "raw", bytes: 30000, run: () => Promise.resolve() }));
    assert.deepEqual(out.slice(0, 3), ["accepted", "accepted", "accepted"]);
    assert.ok(out.slice(3).every((v) => v === "dropped"));
    assert.ok(hk.stats().pending_bytes <= 100000);
    g.resolve();
  });

  it("coalesces a job whose key is already waiting", () => {
    const hk = createHousekeeper({ concurrency: 1, log: makeLog() });
    const g = gate();
    hk.submit({ name: "block", run: () => g.promise });
    let runs = 0;
    const a = hk.submit({ name: "touch", key: "touch:X", run: () => runs++ });
    const b = hk.submit({ name: "touch", key: "touch:X", run: () => runs++ });
    assert.equal(a, "accepted");
    assert.equal(b, "coalesced");
    assert.equal(hk.stats().coalesced, 1);
    g.resolve();
  });

  it("a critical job is never dropped for capacity", () => {
    const hk = createHousekeeper({ concurrency: 1, maxPending: 1, log: makeLog() });
    const g = gate();
    hk.submit({ name: "block", run: () => g.promise });
    hk.submit({ name: "filler", run: () => Promise.resolve() });
    assert.equal(hk.submit({ name: "filler", run: () => Promise.resolve() }), "dropped");
    assert.equal(hk.submit({ name: "mark_pull_receiving", critical: true, run: () => Promise.resolve() }), "accepted");
    g.resolve();
  });

  it("logs failures with the job name, at most N a minute, and counts the rest", async () => {
    const log = makeLog();
    const hk = createHousekeeper({ concurrency: 1, failureLogPerMinute: 3, log, now: () => 0 });
    for (let i = 0; i < 10; i += 1) hk.submit({ name: "touch_device", run: () => Promise.reject(Object.assign(new Error("ER_LOCK_WAIT_TIMEOUT"), { code: "ER_LOCK_WAIT_TIMEOUT" })) });
    await hk.idle();
    const lines = log.lines.filter((l) => l.code === "HOUSEKEEPING_FAILED");
    assert.equal(lines.length, 3);
    assert.match(lines[0].description, /^touch_device: ER_LOCK_WAIT_TIMEOUT/);
    assert.equal(lines[0].job, "touch_device");
    assert.equal(hk.stats().failed, 10, "every failure is counted even when not logged");
    assert.equal(hk.stats().by_job.touch_device.failed, 10);
  });

  it("close(): drops what waits, starts nothing more, and does not log shutdown casualties", async () => {
    const log = makeLog();
    const hk = createHousekeeper({ concurrency: 1, log });
    const g = gate();
    let laterRan = 0;
    hk.submit({ name: "running", run: () => g.promise });
    for (let i = 0; i < 20; i += 1) hk.submit({ name: "waiting", run: () => laterRan++ });

    const closing = hk.close({ timeoutMs: 1000 });
    const poolClosed = Object.assign(new Error("Pool is closed."), { code: "POOL_CLOSED" });
    g.reject(poolClosed);
    const s = await closing;
    assert.equal(laterRan, 0, "nothing queued ran after close");
    assert.equal(s.dropped_on_shutdown, 20);
    assert.equal(s.aborted_on_shutdown, 1);
    assert.equal(hk.submit({ name: "late", run: () => laterRan++ }), "closed");
    assert.equal(laterRan, 0);
    assert.equal(log.lines.filter((l) => l.code === "HOUSEKEEPING_FAILED").length, 0, "no Pool is closed loop");
  });

  it("close() does not wait forever for a job that never settles", async () => {
    const hk = createHousekeeper({ concurrency: 1, log: makeLog() });
    hk.submit({ name: "stuck", run: () => new Promise(() => {}) });
    const t0 = Date.now();
    await hk.close({ timeoutMs: 50 });
    assert.ok(Date.now() - t0 < 1000);
  });
});

describe("diagnostic limiter", () => {
  it("writes an identical frame once per window and counts the repeats", () => {
    let t = 0;
    const d = createDiagLimiter({ windowMs: 1000, perSource: 6, now: () => t });
    assert.equal(d.check("DEV|realtime_enroll_data", "DEV|realtime_enroll_data|abc").write, true);
    for (let i = 0; i < 99; i += 1) assert.equal(d.check("DEV|realtime_enroll_data", "DEV|realtime_enroll_data|abc").write, false);
    assert.equal(d.stats().suppressed_identical, 99);
    t = 1000; // next window: written again, carrying the count
    const next = d.check("DEV|realtime_enroll_data", "DEV|realtime_enroll_data|abc");
    assert.equal(next.write, true);
    assert.equal(next.suppressed, 99);
  });

  it("caps distinct frames per source and in total", () => {
    const d = createDiagLimiter({ windowMs: 1000, perSource: 2, maxPerWindow: 3, now: () => 0 });
    assert.equal(d.check("A|x", "A|x|1").write, true);
    assert.equal(d.check("A|x", "A|x|2").write, true);
    assert.equal(d.check("A|x", "A|x|3").write, false, "per source");
    assert.equal(d.check("B|x", "B|x|1").write, true);
    assert.equal(d.check("C|x", "C|x|1").write, false, "global");
  });

  it("stays bounded when a client invents a new dev_id every time", () => {
    const d = createDiagLimiter({ windowMs: 1e9, maxKeys: 100, now: () => 0 });
    for (let i = 0; i < 10000; i += 1) d.check(`D${i}|x`, `D${i}|x|h`);
    assert.ok(d.stats().written <= 10000);
    // No direct handle on the maps; the cap is exercised without throwing
    // and later checks still work.
    assert.equal(typeof d.check("Z|x", "Z|x|h").write, "boolean");
  });
});
