/**
 * Preload for the API stress harness:  node -r ./test_support/api_db_stress/probe.js server.js
 *
 * Observes the REAL server process without changing a line of it, so the
 * same measurements are taken before and after a fix:
 *
 *   - every pool made by mysql.createPool (the API pool and GoFrugal pool),
 *     sampled from mysqljs 2.x internals: _connectionQueue (waiters),
 *     _allConnections, _freeConnections, _acquiringConnections
 *   - heap used/total, RSS, external/arrayBuffers
 *   - event-loop delay (perf_hooks histogram, reset each sample)
 *   - active handles / requests
 *   - HTTP requests in flight, started, finished, and client-aborted
 *     (response closed before it was finished)
 *
 * One JSON line per second to PROBE_OUT (default <os tmpdir>/api-probe.jsonl).
 * Test harness only.
 */
const fs = require("fs");
const http = require("http");
const { monitorEventLoopDelay } = require("perf_hooks");

const OUT = process.env.PROBE_OUT || `${require("os").tmpdir()}/api-probe.jsonl`;
const INTERVAL = Number(process.env.PROBE_INTERVAL_MS || 1000);
const t0 = Date.now();

const mysql = require("mysql");
const pools = [];
const origCreatePool = mysql.createPool;
mysql.createPool = function (config) {
  const pool = origCreatePool.apply(this, arguments);
  pools.push({ name: `${config && config.database}`, pool });
  return pool;
};

// With the admission layer present (after the fix), capture the guarded
// pools too, so their own waiters and circuit are sampled. Absent before the
// fix, in which case this does nothing.
const guarded = [];
try {
  const adm = require(require("path").join(__dirname, "..", "..", "utils", "db_admission"));
  const origGuard = adm.guardPool;
  adm.guardPool = function (rawPool, options) {
    const g = origGuard.apply(this, arguments);
    guarded.push(g);
    return g;
  };
} catch (e) {
  /* before the fix: no admission layer */
}

const httpStats = { in_flight: 0, started: 0, finished: 0, aborted: 0 };
const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res) {
  if (event === "request" && res && !res.__probed) {
    res.__probed = true;
    httpStats.in_flight += 1;
    httpStats.started += 1;
    let done = false;
    const end = (how) => {
      if (done) return;
      done = true;
      httpStats.in_flight -= 1;
      httpStats[how] += 1;
    };
    res.once("finish", () => end("finished"));
    res.once("close", () => end(res.writableFinished ? "finished" : "aborted"));
  }
  return origEmit.apply(this, arguments);
};

const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();

const len = (a) => (Array.isArray(a) ? a.length : null);
const mb = (b) => Math.round((b / 1048576) * 10) / 10;

function sample() {
  const m = process.memoryUsage();
  const line = {
    t: Math.round((Date.now() - t0) / 100) / 10,
    heap_used_mb: mb(m.heapUsed),
    heap_total_mb: mb(m.heapTotal),
    rss_mb: mb(m.rss),
    external_mb: mb(m.external),
    array_buffers_mb: mb(m.arrayBuffers || 0),
    eld_p50_ms: Math.round(eld.percentile(50) / 1e6),
    eld_p95_ms: Math.round(eld.percentile(95) / 1e6),
    eld_p99_ms: Math.round(eld.percentile(99) / 1e6),
    eld_max_ms: Math.round(eld.max / 1e6),
    handles: process._getActiveHandles().length,
    requests: process._getActiveRequests().length,
    http: { ...httpStats },
    pools: pools.map(({ name, pool }) => ({
      name,
      queued: len(pool._connectionQueue),
      all: len(pool._allConnections),
      free: len(pool._freeConnections),
      acquiring: len(pool._acquiringConnections),
      closed: !!pool._closed,
    })),
    guard: guarded.map((g) => {
      const st = g.stats();
      return {
        name: st.name,
        active: st.active,
        circuit: st.circuit.state,
        interactive_waiting: st.lanes.interactive.waiting,
        attendance_waiting: st.lanes.attendance_read ? st.lanes.attendance_read.waiting : 0,
        background_waiting: st.lanes.background.waiting,
        interactive_active: st.lanes.interactive.active,
        attendance_active: st.lanes.attendance_read ? st.lanes.attendance_read.active : 0,
        background_active: st.lanes.background.active,
        refused_busy: Object.values(st.lanes).reduce((a, l) => a + l.refused_busy, 0),
        timed_out: Object.values(st.lanes).reduce((a, l) => a + l.timed_out, 0),
        refused_unavailable: Object.values(st.lanes).reduce((a, l) => a + l.refused_unavailable, 0),
        flushed_on_open: Object.values(st.lanes).reduce((a, l) => a + l.flushed_on_open, 0),
        circuit_opens: st.circuit.opens,
        connect_failures: st.connect_failures,
        query_timeouts: st.query_timeouts,
        straggler_failures_ignored: st.straggler_failures_ignored,
        straggler_successes_ignored: st.straggler_successes_ignored,
      };
    }),
  };
  eld.reset();
  fs.appendFileSync(OUT, JSON.stringify(line) + "\n");
}
setInterval(sample, INTERVAL).unref();

// CIRCUIT_TRACE_MS=<n>: poll every guarded pool's circuit every n ms and
// append each state change to PROBE_OUT.circuit (one JSON line each), with
// the pool's permits in use and refusal counters at that instant. Reading
// the state is what acquire() itself does (open -> half_open on time).
if (Number(process.env.CIRCUIT_TRACE_MS) > 0) {
  const last = new Map();
  setInterval(() => {
    for (const g of guarded) {
      const st = g.stats();
      const prev = last.get(st.name);
      if (prev !== st.circuit.state) {
        last.set(st.name, st.circuit.state);
        fs.appendFileSync(`${OUT}.circuit`, JSON.stringify({
          at_ms: Date.now() - t0,
          pool: st.name,
          from: prev || null,
          to: st.circuit.state,
          opens: st.circuit.opens,
          open_ms: st.circuit.open_ms,
          last_error: st.circuit.last_error,
          active: st.active,
          refused_unavailable: Object.values(st.lanes).reduce((a, l) => a + l.refused_unavailable, 0),
          flushed_on_open: Object.values(st.lanes).reduce((a, l) => a + l.flushed_on_open, 0),
          straggler_failures_ignored: st.straggler_failures_ignored,
          straggler_successes_ignored: st.straggler_successes_ignored,
        }) + "\n");
      }
    }
  }, Number(process.env.CIRCUIT_TRACE_MS)).unref();
}
