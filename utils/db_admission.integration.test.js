/**
 * DB admission control against a REAL mysqljs pool and a REAL MariaDB/MySQL,
 * with a fault proxy in between. Skipped unless DB_IT=1.
 *
 *   DB_IT=1 DB_IT_USER=bm DB_IT_PASS=bm DB_IT_NAME=dnds_api_test \
 *     node --test utils/db_admission.integration.test.js
 *
 * Proves, on the real driver:
 *   - a caller whose wait times out is gone: it is not left in mysqljs's
 *     `_connectionQueue`, and it NEVER executes after the database returns
 *   - mysqljs's queue stays empty under a handshake-hang outage while the
 *     guard's own waiters stay within their bound
 *   - transactions: one permit per checked-out connection for the whole
 *     transaction, statements on it need no other permit, commit / rollback /
 *     error paths return the permit exactly once, and semantics are intact
 *   - a transaction that asks the POOL for a second connection while every
 *     permit is held by such transactions fails after the wait deadline
 *     instead of hanging forever (mysqljs alone: forever)
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const mysql = require("mysql");
const { guardPool } = require("./db_admission");

const ENABLED = process.env.DB_IT === "1";
const DB = {
  host: process.env.DB_IT_HOST || "127.0.0.1",
  port: Number(process.env.DB_IT_PORT || 3306),
  user: process.env.DB_IT_USER || "bm",
  password: process.env.DB_IT_PASS || "bm",
  database: process.env.DB_IT_NAME || "dnds_api_test",
};
const PROXY_PORT = 13406;
const CTL_PORT = 13499;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctl = (p) => new Promise((r) => http.get({ host: "127.0.0.1", port: CTL_PORT, path: p }, (x) => { x.resume(); x.on("end", r); }).on("error", r));
const q = (pool, sql, params) => new Promise((res, rej) => pool.query(sql, params, (e, r) => (e ? rej(e) : res(r))));

function makePools({ limit = 4, viaProxy = false, lanes } = {}) {
  const raw = mysql.createPool({
    ...DB,
    host: viaProxy ? "127.0.0.1" : DB.host,
    port: viaProxy ? PROXY_PORT : DB.port,
    connectionLimit: limit,
    acquireTimeout: 1500,
    connectTimeout: 1500,
    queueLimit: limit,
  });
  const guarded = guardPool(raw, { name: "it", lanes, failureThreshold: 3, openMs: 1000 });
  return { raw, guarded };
}

describe("admission on the real driver", { skip: !ENABLED && "set DB_IT=1 (needs a MySQL/MariaDB)" }, () => {
  let proxy;
  let direct;
  before(async () => {
    proxy = spawn(process.execPath, [path.join(__dirname, "..", "test_support", "api_db_stress", "faultProxy.js"), String(PROXY_PORT), DB.host, String(DB.port), String(CTL_PORT)], { stdio: "ignore" });
    await sleep(500);
    direct = mysql.createConnection(DB);
    await q(direct, "CREATE TABLE IF NOT EXISTS db_admission_it (id INT PRIMARY KEY, note VARCHAR(40)) ENGINE=InnoDB");
    await q(direct, "DELETE FROM db_admission_it");
  });
  after(async () => {
    await q(direct, "DROP TABLE IF EXISTS db_admission_it").catch(() => {});
    direct.end();
    proxy.kill();
  });

  describe("queue acceptance under a handshake-hang outage", () => {
    it("mysqljs's queue stays empty, guard waiters stay bounded, timed-out callers are removed and NEVER run after recovery", async () => {
      await ctl("/mode/pass");
      const { raw, guarded } = makePools({ limit: 4, viaProxy: true, lanes: { interactive: { maxWaiting: 50, waitTimeoutMs: 800 } } });
      await q(guarded, "SELECT 1"); // warm
      await ctl("/mode/handshake_hang");
      await ctl("/kill");
      let maxMysqlQueue = 0;
      let maxWaiting = 0;
      const outcomes = {};
      const marks = [];
      // 300 callers over ~3 s, each would INSERT its own id if it ever ran.
      for (let i = 1; i <= 300; i += 1) {
        marks.push(i);
        guarded.query("INSERT INTO db_admission_it (id, note) VALUES (?, 'outage')", [i], (err) => {
          const k = err ? err.code : "ok";
          outcomes[k] = (outcomes[k] || 0) + 1;
        });
        if (i % 10 === 0) {
          await sleep(100);
          maxMysqlQueue = Math.max(maxMysqlQueue, raw._connectionQueue.length);
          maxWaiting = Math.max(maxWaiting, guarded.stats().lanes.interactive.waiting);
        }
      }
      await sleep(3500); // every wait deadline has passed
      maxMysqlQueue = Math.max(maxMysqlQueue, raw._connectionQueue.length);
      const settled = Object.values(outcomes).reduce((a, b) => a + b, 0);
      assert.equal(settled, 300, `every caller got an answer: ${JSON.stringify(outcomes)}`);
      assert.equal(outcomes.ok || 0, 0);
      assert.ok(maxWaiting <= 50, `guard waiters peaked at ${maxWaiting}`);
      assert.ok(maxMysqlQueue <= 4, `mysqljs queue peaked at ${maxMysqlQueue} (<= connectionLimit, and only transiently)`);
      assert.equal(raw._connectionQueue.length, 0, "no hidden mysqljs waiter left behind");
      assert.equal(guarded.stats().lanes.interactive.waiting, 0);

      // The database comes back. Nothing from the outage runs.
      await ctl("/mode/pass");
      await sleep(1500);
      await q(guarded, "SELECT 1").catch(() => {}); // the half-open probe
      await sleep(300);
      const rows = await q(direct, "SELECT COUNT(*) AS n FROM db_admission_it WHERE note = 'outage'");
      assert.equal(Number(rows[0].n), 0, "no dead work executed after recovery - no thundering herd");
      assert.equal(guarded.stats().circuit.state, "closed");
      await q(guarded, "SELECT 1"); // and normal service resumes
      await new Promise((r) => guarded.end(r));
    });
  });

  describe("circuit generations on the real driver", () => {
    const ctlJson = (p) => new Promise((r) => http.get({ host: "127.0.0.1", port: CTL_PORT, path: p }, (x) => { let b = ""; x.on("data", (d) => (b += d)); x.on("end", () => r(JSON.parse(b))); }).on("error", () => r(null)));
    it("CLOSED -> OPEN -> HALF_OPEN -> OPEN -> HALF_OPEN -> CLOSED; stragglers from before the open never move it; exactly one probe connection; callers fail fast while OPEN", async () => {
      await ctl("/mode/pass");
      const raw = mysql.createPool({ ...DB, host: "127.0.0.1", port: PROXY_PORT, connectionLimit: 4, acquireTimeout: 8000, connectTimeout: 8000, queueLimit: 4 });
      const g = guardPool(raw, { name: "trace", failureThreshold: 3, openMs: 1000, maxOpenMs: 2000 });
      const T0 = Date.now();
      const trace = [];
      let last = null;
      const mark = (event) => {
        const st = g.stats();
        const row = { t_ms: Date.now() - T0, event, state: st.circuit.state, opens: st.circuit.opens, open_ms: st.circuit.open_ms, active: st.active, refused_unavailable: st.lanes.interactive.refused_unavailable, straggler_failures_ignored: st.straggler_failures_ignored, straggler_successes_ignored: st.straggler_successes_ignored };
        trace.push(row);
        return row;
      };
      const poll = setInterval(() => {
        const st = g.stats().circuit.state;
        if (st !== last) { last = st; mark(`state=${st}`); }
      }, 5);
      try {
        assert.equal((await q(g, "SELECT 1 AS ok"))[0].ok, 1, "CLOSED serves normally");
        await ctl("/kill");
        await new Promise((r) => raw.getConnection((e, c) => { if (!e) c.destroy(); r(); })); // no idle connection left
        await sleep(100);

        // B: a connection attempt that will FAIL LATE (handshake never answered, fails at 8 s).
        await ctl("/mode/handshake_hang");
        let bErr = null;
        g.query("SELECT 'B'", (e) => (bErr = e ? e.code : "ok"));
        await sleep(100);
        // A: a connection attempt that will SUCCEED LATE (greeting delayed 1.5 s).
        await ctl("/mode/slow?ms=1500");
        let aRes = null;
        g.query("SELECT 'A' AS a", (e, rows) => (aRes = e ? e.code : rows[0].a));
        await sleep(100);
        // Three immediate connection failures open the circuit.
        await ctl("/mode/refuse");
        const opening = await Promise.allSettled([1, 2, 3].map(() => q(g, "SELECT 1")));
        assert.ok(opening.every((r) => r.status === "rejected"));
        assert.equal(mark("3 refused").state, "open");
        const openCount = g.stats().circuit.opens;

        // OPEN: callers fail fast, no connection attempt.
        const t1 = Date.now();
        const fast = await Promise.allSettled(Array.from({ length: 20 }, () => q(g, "SELECT 1")));
        assert.ok(fast.every((r) => r.status === "rejected" && r.reason.code === "DB_UNAVAILABLE"));
        assert.ok(Date.now() - t1 < 100, "fail fast");

        // A's late SUCCESS arrives after the open period ended: HALF_OPEN is not closed by it.
        for (let i = 0; i < 60 && aRes === null; i += 1) await sleep(100);
        assert.equal(aRes, "A", "the straggler's own query still gets its result");
        const afterA = mark("late success (A)");
        assert.equal(afterA.state, "half_open", "a pre-open success cannot close it");
        assert.equal(afterA.straggler_successes_ignored, 1);

        // B's late FAILURE (its pre-open attempt is RST now, along with A's
        // idle connection) arrives in HALF_OPEN: it neither re-opens nor
        // extends anything.
        const beforeB = g.stats().circuit;
        await ctl("/kill");
        for (let i = 0; i < 100 && bErr === null; i += 1) await sleep(50);
        assert.ok(bErr && bErr !== "ok");
        const afterB = mark(`late failure (B: ${bErr})`);
        assert.equal(afterB.state, "half_open", "a pre-open failure cannot re-open it");
        assert.ok(afterB.straggler_failures_ignored >= 1);
        assert.equal(afterB.opens, beforeB.opens, "no extra open");
        assert.equal(afterB.open_ms, beforeB.open_ms, "open period not extended");

        // The PROBE against a still-refusing DB re-opens it, doubled (capped at maxOpenMs).
        await assert.rejects(q(g, "SELECT 'probe1'"));
        const reopened = mark("probe 1 refused");
        assert.equal(reopened.state, "open");
        assert.equal(reopened.open_ms, 2000);
        assert.equal(reopened.opens, beforeB.opens + 1);

        // DB back. At half-open, 10 simultaneous callers: exactly ONE connection attempt reaches the DB.
        await ctl("/mode/pass");
        while (g.stats().circuit.state !== "half_open") await sleep(20);
        const accepted0 = (await ctlJson("/stats")).accepted;
        const burst = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => q(g, `SELECT ${i} AS i`)));
        const accepted1 = (await ctlJson("/stats")).accepted;
        const okCount = burst.filter((r) => r.status === "fulfilled").length;
        mark(`half-open burst: ${okCount} probe ok, ${10 - okCount} DB_UNAVAILABLE, ${accepted1 - accepted0} connection(s) accepted`);
        assert.equal(okCount, 1, "one probe");
        assert.ok(burst.filter((r) => r.status === "rejected").every((r) => r.reason.code === "DB_UNAVAILABLE"), "the others do not become probes");
        assert.equal(accepted1 - accepted0, 1, "exactly one connection attempt at the database");
        assert.equal(g.stats().circuit.state, "closed", "the probe's success closes it");
        assert.ok(g.stats().circuit.opens > openCount - 1);

        // Closed again: normal service, admitted by permits (no backlog was kept to release).
        const after = await Promise.allSettled(Array.from({ length: 12 }, () => q(g, "SELECT 1")));
        assert.equal(after.filter((r) => r.status === "fulfilled").length, 12);
        mark("closed: 12/12 served");
        assert.equal(raw._connectionQueue.length, 0);
      } finally {
        clearInterval(poll);
        if (process.env.CIRCUIT_TRACE_OUT) require("fs").writeFileSync(process.env.CIRCUIT_TRACE_OUT, JSON.stringify(trace, null, 1));
        await ctl("/mode/pass");
        await new Promise((r) => g.end(r));
      }
    });
  });

  describe("transactions", () => {
    const getConn = (pool) => new Promise((res, rej) => pool.getConnection((e, c) => (e ? rej(e) : res(c))));
    const cq = (c, sql, p) => new Promise((res, rej) => c.query(sql, p, (e, r) => (e ? rej(e) : res(r))));
    const begin = (c) => new Promise((res, rej) => c.beginTransaction((e) => (e ? rej(e) : res())));
    const commit = (c) => new Promise((res, rej) => c.commit((e) => (e ? rej(e) : res())));
    const rollback = (c) => new Promise((res) => c.rollback(() => res()));

    it("one permit for the whole transaction; its statements need no other; COMMIT persists; permit returned once", async () => {
      await ctl("/mode/pass");
      const { guarded } = makePools({ limit: 2 });
      const c = await getConn(guarded);
      assert.equal(guarded.stats().active, 1);
      await begin(c);
      for (let i = 0; i < 20; i += 1) await cq(c, "INSERT INTO db_admission_it (id, note) VALUES (?, 'tx-commit')", [1000 + i]);
      assert.equal(guarded.stats().active, 1, "20 statements, still one permit");
      await commit(c);
      c.release();
      assert.equal(guarded.stats().active, 0);
      // A second release is still mysqljs's own error (unchanged) - and it
      // does not return a second permit.
      assert.throws(() => c.release(), /already released/);
      assert.equal(guarded.stats().active, 0);
      const rows = await q(direct, "SELECT COUNT(*) AS n FROM db_admission_it WHERE note = 'tx-commit'");
      assert.equal(Number(rows[0].n), 20);
      await new Promise((r) => guarded.end(r));
    });

    it("ROLLBACK after an error undoes the transaction and returns the permit", async () => {
      const { guarded } = makePools({ limit: 2 });
      const c = await getConn(guarded);
      await begin(c);
      await cq(c, "INSERT INTO db_admission_it (id, note) VALUES (2000, 'tx-rollback')");
      await assert.rejects(cq(c, "INSERT INTO db_admission_it (id, note) VALUES (2000, 'dup')"), (e) => e.code === "ER_DUP_ENTRY");
      await rollback(c);
      c.release();
      assert.equal(guarded.stats().active, 0);
      const rows = await q(direct, "SELECT COUNT(*) AS n FROM db_admission_it WHERE id = 2000");
      assert.equal(Number(rows[0].n), 0, "rolled back");
      await new Promise((r) => guarded.end(r));
    });

    it("concurrent transactions filling every permit complete without deadlocking (statements run on the held connection)", async () => {
      const { guarded } = makePools({ limit: 3 });
      const one = async (k) => {
        const c = await getConn(guarded);
        try {
          await begin(c);
          for (let i = 0; i < 10; i += 1) await cq(c, "INSERT INTO db_admission_it (id, note) VALUES (?, 'tx-concurrent')", [3000 + k * 100 + i]);
          await commit(c);
        } catch (e) {
          await rollback(c);
          throw e;
        } finally {
          c.release();
        }
      };
      await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8].map(one)); // 9 transactions on 3 permits
      assert.equal(guarded.stats().active, 0);
      const rows = await q(direct, "SELECT COUNT(*) AS n FROM db_admission_it WHERE note = 'tx-concurrent'");
      assert.equal(Number(rows[0].n), 90);
      await new Promise((r) => guarded.end(r));
    });

    it("a destroyed connection (fatal error mid-transaction) returns its permit once; the server rolls the transaction back", async () => {
      const { guarded } = makePools({ limit: 2 });
      const c = await getConn(guarded);
      await begin(c);
      await cq(c, "INSERT INTO db_admission_it (id, note) VALUES (4000, 'tx-destroyed')");
      c.destroy();
      c.release();
      assert.equal(guarded.stats().active, 0);
      await sleep(300);
      const rows = await q(direct, "SELECT COUNT(*) AS n FROM db_admission_it WHERE id = 4000");
      assert.equal(Number(rows[0].n), 0, "uncommitted work is gone");
      await new Promise((r) => guarded.end(r));
    });

    it("a transaction that asks the POOL for a second connection while all permits are held fails after the deadline - it does not hang forever", async () => {
      const { raw, guarded } = makePools({ limit: 2, lanes: { interactive: { waitTimeoutMs: 700 } } });
      const holders = await Promise.all([getConn(guarded), getConn(guarded)]);
      await Promise.all(holders.map(begin));
      const t0 = Date.now();
      // Each holder now issues a POOL query (not on its own connection) - the
      // self-deadlock shape. mysqljs alone would queue these forever.
      const nested = await Promise.allSettled(holders.map(() => q(guarded, "SELECT 1")));
      assert.ok(nested.every((r) => r.status === "rejected" && r.reason.code === "DB_ACQUIRE_TIMEOUT"));
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(raw._connectionQueue.length, 0, "nothing left in mysqljs's queue");
      await Promise.all(holders.map(rollback));
      holders.forEach((c) => c.release());
      assert.equal(guarded.stats().active, 0);
      await q(guarded, "SELECT 1");
      await new Promise((r) => guarded.end(r));
    });

    it("statements in a transaction get the lane's default timeout; one that sets its own keeps it", async () => {
      const { guarded } = makePools({ limit: 1, lanes: { interactive: { queryTimeoutMs: 400 } } });
      const c = await getConn(guarded);
      await assert.rejects(cq(c, "SELECT SLEEP(2)"), (e) => e.code === "PROTOCOL_SEQUENCE_TIMEOUT");
      c.release();
      assert.equal(guarded.stats().active, 0);
      const c2 = await getConn(guarded);
      const r = await new Promise((res, rej) => c2.query({ sql: "SELECT SLEEP(0.6) AS s", timeout: 5000 }, (e, rows) => (e ? rej(e) : res(rows))));
      assert.equal(Number(r[0].s), 0);
      c2.release();
      await new Promise((res) => guarded.end(res));
    });
  });
});
