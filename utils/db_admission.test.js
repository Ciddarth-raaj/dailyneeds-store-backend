/**
 * DB admission control - against a fake mysqljs pool the test drives.
 *
 *   node --test utils/db_admission.test.js
 *
 * The properties that matter (docs/api-db-backpressure.md): waiters are
 * bounded; a waiter that times out is REMOVED and never runs later; mysqljs's
 * own queue is never used; a sick database fails callers fast and lets one
 * probe through; cron work cannot take every connection; permits return
 * exactly once.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { guardPool, runInLane, currentContext, poolOptionsFromEnv } = require("./db_admission");

/** A fake mysqljs Pool: getConnection is answered only when the test says so. */
function fakePool({ limit = 10 } = {}) {
  const pending = []; // getConnection callbacks not yet answered
  const executed = []; // sql actually run on a connection
  let nextId = 1;
  function makeConnection() {
    const c = {
      id: nextId++,
      released: 0,
      destroyed: 0,
      queries: [],
      query(sql, values, cb) {
        if (typeof values === "function") {
          cb = values;
          values = undefined;
        }
        c.queries.push(sql);
        executed.push(typeof sql === "string" ? sql : sql.sql);
        setImmediate(() => cb && cb(null, [{ ok: 1 }], []));
      },
      release() {
        c.released += 1;
      },
      destroy() {
        c.destroyed += 1;
      },
    };
    return c;
  }
  const pool = {
    config: { connectionLimit: limit, queueLimit: 10 },
    _allConnections: [],
    _freeConnections: [],
    _acquiringConnections: [],
    _connectionQueue: [],
    getConnection(cb) {
      pending.push(cb);
    },
    end(cb) {
      if (cb) cb();
    },
    escape: (v) => `'${v}'`,
    escapeId: (v) => `\`${v}\``,
    on() {},
    once() {},
  };
  return {
    pool,
    pending,
    executed,
    /** Answer the oldest n getConnection calls with a connection. */
    grant(n = pending.length) {
      for (const cb of pending.splice(0, n)) cb(null, makeConnection());
    },
    /** Fail the oldest n with an error code. */
    fail(code, n = pending.length) {
      for (const cb of pending.splice(0, n)) cb(Object.assign(new Error(code), { code }));
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("bounded waiting", () => {
  it("never asks mysqljs for more than connectionLimit connections, bounds waiters, refuses the rest at once", async () => {
    const f = fakePool({ limit: 10 });
    const g = guardPool(f.pool, { lanes: { interactive: { maxWaiting: 50, waitTimeoutMs: 10000 } } });
    const outcomes = {};
    for (let i = 0; i < 1000; i += 1) {
      g.query("SELECT 1", (err) => {
        const k = err ? err.code : "ok";
        outcomes[k] = (outcomes[k] || 0) + 1;
      });
    }
    await tick();
    assert.equal(f.pending.length, 10, "only connectionLimit acquisitions reach mysqljs");
    assert.equal(f.pool._connectionQueue.length, 0, "mysqljs's own queue is never used");
    const s = g.stats();
    assert.equal(s.lanes.interactive.waiting, 50);
    assert.equal(outcomes.DB_BUSY, 1000 - 10 - 50, "everything beyond the bound is refused immediately");
  });

  it("a waiter that times out is REMOVED - it never runs later, even when the database comes back", async () => {
    const f = fakePool({ limit: 2 });
    const g = guardPool(f.pool, { lanes: { interactive: { maxWaiting: 100, waitTimeoutMs: 50 } } });
    const outcomes = [];
    for (let i = 0; i < 20; i += 1) g.query(`SELECT ${i}`, (err) => outcomes.push(err ? err.code : "ok"));
    await sleep(120);
    assert.equal(outcomes.filter((o) => o === "DB_ACQUIRE_TIMEOUT").length, 18);
    assert.equal(g.stats().lanes.interactive.waiting, 0, "nothing left waiting");
    // The database answers now: only the two that held permits run.
    f.grant();
    await sleep(20);
    assert.deepEqual(f.executed.sort(), ["SELECT 0", "SELECT 1"]);
    assert.equal(outcomes.filter((o) => o === "ok").length, 2);
    // ...and no stampede: a new caller is served normally, nothing else was waiting.
    g.query("SELECT new", () => {});
    await tick();
    f.grant();
    await sleep(10);
    assert.equal(f.executed.length, 3);
  });

  it("waiters are served FIFO as permits return", async () => {
    const f = fakePool({ limit: 1 });
    const g = guardPool(f.pool);
    const order = [];
    for (let i = 0; i < 5; i += 1) g.query(`Q${i}`, () => order.push(i));
    for (let i = 0; i < 5; i += 1) {
      await tick();
      f.grant(1);
      await sleep(5);
    }
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });
});

describe("circuit breaker", () => {
  it("consecutive connection failures open it; waiters are failed at once; callers fail fast; one probe; recovery closes it", async () => {
    let t = 1000;
    const f = fakePool({ limit: 10 });
    const g = guardPool(f.pool, { now: () => t, failureThreshold: 3, openMs: 5000 });
    const outcomes = [];
    for (let i = 0; i < 30; i += 1) g.query("SELECT 1", (err) => outcomes.push(err ? err.code : "ok"));
    await tick();
    assert.equal(g.stats().lanes.interactive.waiting, 20);
    f.fail("EHOSTUNREACH", 3);
    await tick();
    const s = g.stats();
    assert.equal(s.circuit.state, "open");
    assert.equal(s.lanes.interactive.waiting, 0, "waiters flushed the moment it opens");
    // Failures 1 and 2 arrived while it was still closed, so each freed
    // permit went to the next waiter (2 more attempts); the 18 still waiting
    // when the third failure opened it were failed at once.
    assert.equal(outcomes.filter((o) => o === "DB_UNAVAILABLE").length, 18);
    // New callers do not even try.
    const before = f.pending.length;
    let fast = null;
    g.query("SELECT 1", (err) => (fast = err.code));
    await tick();
    assert.equal(fast, "DB_UNAVAILABLE");
    assert.equal(f.pending.length, before, "no connection attempt while open");
    assert.equal(g.isUnavailable(), true);

    // Open period over: exactly one probe goes through.
    t += 5000;
    const probe = [];
    for (let i = 0; i < 5; i += 1) g.query("SELECT 1", (err) => probe.push(err ? err.code : "ok"));
    await tick();
    assert.equal(f.pending.length, before + 1, "one probe");
    assert.equal(probe.filter((o) => o === "DB_UNAVAILABLE").length, 4);
    // Probe fails: re-open, doubled. (The probe is the NEWEST attempt; the
    // older ones are stragglers from before the circuit opened.)
    f.pending.pop()(Object.assign(new Error("EHOSTUNREACH"), { code: "EHOSTUNREACH" }));
    await tick();
    assert.equal(g.stats().circuit.state, "open");
    assert.equal(g.stats().circuit.open_ms, 10000);
    // Next probe succeeds: closed, normal service.
    t += 10000;
    f.fail("EHOSTUNREACH"); // the 7 stragglers from before the circuit opened
    await tick();
    assert.equal(g.stats().circuit.state, "half_open", "stragglers failing late do not re-open it");
    let ok = null;
    g.query("SELECT probe", (err) => (ok = err ? err.code : "ok"));
    await tick();
    assert.equal(f.pending.length, 1, "exactly one probe attempt");
    f.grant(1);
    await sleep(10);
    assert.equal(ok, "ok");
    assert.equal(g.stats().circuit.state, "closed");
    assert.equal(g.isUnavailable(), false);
  });

  it("with NO HTTP traffic, a cron tick in the background lane becomes the half-open probe and closes the circuit (isUnavailable is false in HALF_OPEN until a probe is out)", async () => {
    let t = 0;
    const f = fakePool({ limit: 4 });
    const g = guardPool(f.pool, { now: () => t, failureThreshold: 1, openMs: 5000 });
    g.query("SELECT 1", () => {});
    await tick();
    f.fail("ECONNREFUSED");
    await tick();
    assert.equal(g.isUnavailable(), true, "OPEN: the cron gate skips");
    t += 5000;
    assert.equal(g.stats().circuit.state, "half_open");
    assert.equal(g.isUnavailable(), false, "HALF_OPEN, no probe out: the next caller may probe");
    let result = null;
    runInLane("background", () => g.query("SELECT cron", (err) => (result = err ? err.code : "ok")));
    await tick();
    assert.equal(g.isUnavailable(), true, "probe out: everyone else still fails fast");
    f.grant(1);
    await sleep(10);
    assert.equal(result, "ok");
    assert.equal(g.stats().circuit.state, "closed", "closed by the cron's probe, no HTTP request needed");
    assert.equal(g.isUnavailable(), false);
  });

  it("HALF_OPEN is moved ONLY by the probe: a straggler's late success does not close it, a straggler's late failure does not re-open it", async () => {
    let t = 0;
    const f = fakePool({ limit: 10 });
    const g = guardPool(f.pool, { now: () => t, failureThreshold: 2, openMs: 1000 });
    for (let i = 0; i < 4; i += 1) g.query("X", () => {});
    await tick();
    f.fail("ECONNREFUSED", 2); // opens; 2 stragglers still pending
    await tick();
    assert.equal(g.stats().circuit.state, "open");
    // While OPEN a straggler failure is counted, nothing more.
    f.fail("ECONNREFUSED", 1);
    await tick();
    assert.equal(g.stats().circuit.state, "open");
    assert.equal(g.stats().straggler_failures_ignored, 1);
    t = 1000; // half-open
    let probeResult = null;
    g.query("PROBE", (err) => (probeResult = err ? err.code : "ok"));
    await tick();
    assert.equal(g.stats().circuit.state, "half_open");
    // The last straggler SUCCEEDS late: not trusted.
    f.pending.shift()(null, { query: (sql, v, cb) => setImmediate(() => cb(null, [])), release() {}, destroy() {} });
    await tick();
    assert.equal(g.stats().circuit.state, "half_open", "a straggler's success did not close it");
    assert.equal(g.stats().straggler_successes_ignored, 1);
    // Only one probe at a time.
    const refused = [];
    for (let i = 0; i < 5; i += 1) g.query("Y", (err) => refused.push(err && err.code));
    await tick();
    assert.deepEqual(refused, Array(5).fill("DB_UNAVAILABLE"));
    assert.equal(f.pending.length, 1, "exactly the probe is in flight");
    // The probe succeeds: closed.
    f.grant(1);
    await sleep(10);
    assert.equal(probeResult, "ok");
    assert.equal(g.stats().circuit.state, "closed");
  });

  it("CLOSED -> OPEN -> HALF_OPEN -> CLOSED, recorded", async () => {
    let t = 0;
    const f = fakePool({ limit: 10 });
    const states = [];
    const g = guardPool(f.pool, { now: () => t, failureThreshold: 3, openMs: 2000 });
    const record = () => states.push(g.stats().circuit.state);
    record();
    for (let i = 0; i < 3; i += 1) g.query("X", () => {});
    await tick();
    f.fail("PROTOCOL_SEQUENCE_TIMEOUT");
    await tick();
    record();
    t = 1999;
    record();
    t = 2000;
    record();
    g.query("P", () => {});
    await tick();
    f.grant(1);
    await sleep(10);
    record();
    assert.deepEqual(states, ["closed", "open", "open", "half_open", "closed"]);
  });

  it("query inactivity timeouts count as database failures", async () => {
    const f = fakePool({ limit: 5 });
    const g = guardPool(f.pool, { failureThreshold: 2 });
    // connections whose queries time out
    const timeoutConn = () => ({
      query(sql, values, cb) {
        setImmediate(() => cb(Object.assign(new Error("Query inactivity timeout"), { code: "PROTOCOL_SEQUENCE_TIMEOUT", fatal: true })));
      },
      release() {},
      destroy() {},
    });
    g.query("A", () => {});
    g.query("B", () => {});
    await tick();
    f.pending.splice(0).forEach((cb) => cb(null, timeoutConn()));
    await sleep(10);
    assert.equal(g.stats().query_timeouts, 2);
    assert.equal(g.stats().circuit.state, "open");
  });

  it("an ordinary SQL error is NOT a database failure", async () => {
    const f = fakePool({ limit: 5 });
    const g = guardPool(f.pool, { failureThreshold: 1 });
    const errConn = () => ({
      query(sql, values, cb) {
        setImmediate(() => cb(Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" })));
      },
      release() {},
      destroy() {},
    });
    let got = null;
    g.query("INSERT", (err) => (got = err.code));
    await tick();
    f.pending.splice(0).forEach((cb) => cb(null, errConn()));
    await sleep(10);
    assert.equal(got, "ER_DUP_ENTRY", "the caller sees exactly the mysqljs error");
    assert.equal(g.stats().circuit.state, "closed");
  });
});

describe("lanes", () => {
  it("background work is capped and cannot take the pool from interactive traffic", async () => {
    const f = fakePool({ limit: 10 });
    const g = guardPool(f.pool, { lanes: { background: { maxActive: 3, maxWaiting: 5, waitTimeoutMs: 10000 } } });
    const bg = [];
    await runInLane("background", async () => {
      for (let i = 0; i < 20; i += 1) g.query("BG", (err) => bg.push(err ? err.code : "ok"));
    });
    await tick();
    let s = g.stats();
    assert.equal(s.lanes.background.active, 3);
    assert.equal(s.lanes.background.waiting, 5);
    assert.equal(bg.filter((o) => o === "DB_BUSY").length, 12);
    // Interactive still gets the other 7 immediately.
    for (let i = 0; i < 7; i += 1) g.query("HTTP", () => {});
    await tick();
    s = g.stats();
    assert.equal(s.lanes.interactive.active, 7);
    assert.equal(s.lanes.interactive.waiting, 0);
  });

  it("a burst of month reads (attendance_read) cannot take the connections ordinary requests need", async () => {
    const f = fakePool({ limit: 10 });
    const g = guardPool(f.pool, { lanes: { attendance_read: { maxActive: 5, maxWaiting: 60, waitTimeoutMs: 10000 } } });
    await runInLane("attendance_read", async () => {
      for (let i = 0; i < 70; i += 1) g.query("MONTH", () => {}); // 10 month reads x 7 parallel queries
    });
    await tick();
    let s = g.stats();
    assert.equal(s.lanes.attendance_read.active, 5);
    assert.equal(s.lanes.attendance_read.waiting, 60);
    assert.equal(s.lanes.attendance_read.refused_busy, 5);
    for (let i = 0; i < 5; i += 1) g.query("ORDINARY", () => {});
    await tick();
    s = g.stats();
    assert.equal(s.lanes.interactive.active, 5, "ordinary traffic still gets connections at once");
  });

  it("HTTP cannot starve cron work: a waiting background job holding no connection gets the next free one (reserved: 1)", async () => {
    const f = fakePool({ limit: 2 });
    const g = guardPool(f.pool, { lanes: { background: { maxActive: 2, maxWaiting: 5, waitTimeoutMs: 10000, reserved: 1 } } });
    const order = [];
    g.query("I0", () => order.push("I0"));
    g.query("I1", () => order.push("I1"));
    await runInLane("background", async () => g.query("B", () => order.push("B")));
    g.query("I2", () => order.push("I2"));
    await tick();
    for (let i = 0; i < 4; i += 1) {
      f.grant(1);
      await sleep(5);
    }
    assert.deepEqual(order, ["I0", "I1", "B", "I2"], "the freed permit went to the starving background job first");
  });

  it("...and once background holds its reserved connection, waiting HTTP goes first again", async () => {
    const f = fakePool({ limit: 3 });
    const g = guardPool(f.pool, { lanes: { background: { maxActive: 2, maxWaiting: 5, waitTimeoutMs: 10000, reserved: 1 } } });
    const order = [];
    await runInLane("background", async () => {
      g.query("B0", () => order.push("B0"));
    });
    g.query("I0", () => order.push("I0"));
    g.query("I1", () => order.push("I1"));
    await runInLane("background", async () => g.query("B1", () => order.push("B1")));
    g.query("I2", () => order.push("I2"));
    await tick();
    // pending acquisitions: [B0, I0, I1]. Finish I0 while B0 is still held.
    const answer = (idx) => f.pending.splice(idx, 1)[0](null, { query: (sql, v, cb) => setImmediate(() => (typeof v === "function" ? v : cb)(null, [])), release() {}, destroy() {} });
    answer(1); // I0 completes and frees a permit
    await sleep(10);
    assert.deepEqual(order, ["I0"]);
    assert.equal(g.stats().lanes.interactive.waiting, 0, "I2 got the freed permit, not B1");
    assert.equal(g.stats().lanes.background.waiting, 1);
  });

  it("with no cron work waiting, HTTP may use every connection (the reservation costs nothing when idle)", async () => {
    const f = fakePool({ limit: 10 });
    const g = guardPool(f.pool);
    for (let i = 0; i < 10; i += 1) g.query("HTTP", () => {});
    await tick();
    assert.equal(g.stats().lanes.interactive.active, 10);
  });

  it("the lane survives a callback-style chain (mysqljs calls back from its own socket context)", async () => {
    const f = fakePool({ limit: 10 });
    const g = guardPool(f.pool);
    let innerLane = null;
    await runInLane("background", async () => {
      await new Promise((resolve) => {
        g.query("OUTER", () => {
          innerLane = currentContext() && currentContext().lane;
          g.query("INNER", () => resolve());
        });
        setImmediate(() => f.grant());
        setTimeout(() => f.grant(), 20);
      });
    });
    assert.equal(innerLane, "background");
    assert.equal(g.stats().lanes.background.acquired, 2);
    assert.equal(g.stats().lanes.interactive.acquired, 0);
  });
});

describe("connections from getConnection (transactions)", () => {
  it("return their permit exactly once, on release OR destroy, however many times either is called", async () => {
    const f = fakePool({ limit: 1 });
    const g = guardPool(f.pool);
    let conn = null;
    g.getConnection((err, c) => (conn = c));
    await tick();
    f.grant();
    await tick();
    assert.equal(g.stats().active, 1);
    conn.release();
    conn.release();
    conn.destroy();
    assert.equal(g.stats().active, 0);
    // The same physical connection handed out again carries a fresh permit.
    let again = null;
    g.getConnection((err, c) => (again = c));
    await tick();
    f.pending.shift()(null, conn);
    await tick();
    assert.equal(again, conn);
    assert.equal(g.stats().active, 1);
    again.destroy();
    assert.equal(g.stats().active, 0);
  });

  it("get the default query timeout unless the caller set one, and keep the caller's values/callback", async () => {
    const f = fakePool({ limit: 1 });
    const g = guardPool(f.pool, { defaultQueryTimeoutMs: 1234 });
    let conn = null;
    g.getConnection((err, c) => (conn = c));
    await tick();
    f.grant();
    await tick();
    await new Promise((r) => conn.query("SELECT ?", [1], r));
    await new Promise((r) => conn.query("SELECT 2", r));
    await new Promise((r) => conn.query({ sql: "SELECT 3", timeout: 99 }, r));
    assert.deepEqual(conn.queries[0], { sql: "SELECT ?", timeout: 1234 });
    assert.deepEqual(conn.queries[1], { sql: "SELECT 2", timeout: 1234 });
    assert.deepEqual(conn.queries[2], { sql: "SELECT 3", timeout: 99 });
    conn.release();
  });
});

describe("shutdown and compatibility", () => {
  it("end() fails every waiter with POOL_CLOSED and refuses new callers", async () => {
    const f = fakePool({ limit: 1 });
    const g = guardPool(f.pool);
    const got = [];
    for (let i = 0; i < 4; i += 1) g.query("X", (err) => got.push(err ? err.code : "ok"));
    await tick();
    g.end();
    g.query("Y", (err) => got.push(err.code));
    await tick();
    assert.equal(got.filter((c) => c === "POOL_CLOSED").length, 4);
  });

  it("exposes what the codebase reads from a mysqljs pool", () => {
    const f = fakePool({ limit: 7 });
    const g = guardPool(f.pool);
    assert.equal(g.config.connectionLimit, 7);
    assert.ok(Array.isArray(g._allConnections));
    assert.ok(Array.isArray(g._connectionQueue));
    assert.equal(g.escape("a"), "'a'");
    assert.equal(g.escapeId("t"), "`t`");
    assert.equal(g.format("SELECT ?", [1]), "SELECT 1");
  });

  it("DB_ADMISSION=off is the rollback switch: no guard, no extra pool options", () => {
    const off = poolOptionsFromEnv({ DB_ADMISSION: "off" });
    assert.equal(off.enabled, false);
    assert.deepEqual(off.mysql, {});
    const on = poolOptionsFromEnv({});
    assert.equal(on.enabled, true);
    assert.equal(on.mysql.acquireTimeout, 3000);
    assert.equal(on.mysql.queueLimit, 10);
    assert.equal(on.guard.maxOpenMs, 10000);
    assert.equal(poolOptionsFromEnv({ DB_CIRCUIT_MAX_OPEN_MS: "30000" }).guard.maxOpenMs, 30000);
  });

  it("the open period doubles on each failed probe but never beyond maxOpenMs (default 10 s): a recovered database waits at most that long for its probe", async () => {
    let t = 0;
    const f = fakePool({ limit: 2 });
    const g = guardPool(f.pool, { now: () => t, failureThreshold: 1, openMs: 5000 });
    g.query("SELECT 1", () => {});
    await tick();
    f.fail("ECONNREFUSED");
    await tick();
    const seen = [g.stats().circuit.open_ms];
    for (let i = 0; i < 4; i += 1) {
      t += seen[seen.length - 1];
      g.query("SELECT probe", () => {});
      await tick();
      f.pending.pop()(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }));
      await tick();
      seen.push(g.stats().circuit.open_ms);
    }
    assert.deepEqual(seen, [5000, 10000, 10000, 10000, 10000]);
  });
});
