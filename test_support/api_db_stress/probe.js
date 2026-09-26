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
 * One JSON line per second to PROBE_OUT (default /tmp/api-probe.jsonl).
 * Test harness only.
 */
const fs = require("fs");
const http = require("http");
const { monitorEventLoopDelay } = require("perf_hooks");

const OUT = process.env.PROBE_OUT || "/tmp/api-probe.jsonl";
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
        background_waiting: st.lanes.background.waiting,
        refused_busy: st.lanes.interactive.refused_busy + st.lanes.background.refused_busy,
        timed_out: st.lanes.interactive.timed_out + st.lanes.background.timed_out,
        refused_unavailable: st.lanes.interactive.refused_unavailable + st.lanes.background.refused_unavailable,
        flushed_on_open: st.lanes.interactive.flushed_on_open + st.lanes.background.flushed_on_open,
        connect_failures: st.connect_failures,
        query_timeouts: st.query_timeouts,
      };
    }),
  };
  eld.reset();
  fs.appendFileSync(OUT, JSON.stringify(line) + "\n");
}
setInterval(sample, INTERVAL).unref();
