/**
 * One SERVER.RUNTIME.STATS log line every DB_STATS_INTERVAL_MS (default
 * 60 s): process memory, event-loop delay, HTTP requests in flight, every
 * guarded DB pool's admission state (utils/db_admission.js), cron skips and
 * the attendance recalculation worker's state. Low cardinality by design:
 * lanes and at most 40 route labels, no ids.
 *
 * Node 14: perf_hooks.monitorEventLoopDelay exists (>= 11.10).
 */
const { monitorEventLoopDelay } = require("perf_hooks");

function createRuntimeStats({ pools = {}, cronService = null, workerState = null, lifecycle = null, logger = null, intervalMs } = {}) {
  const eld = monitorEventLoopDelay({ resolution: 20 });
  eld.enable();
  const http = { in_flight: 0, started: 0, finished: 0, client_aborted: 0 };

  /** Express middleware: counts requests in flight and client aborts. */
  function httpCounter(req, res, next) {
    http.in_flight += 1;
    http.started += 1;
    let done = false;
    const end = (aborted) => {
      if (done) return;
      done = true;
      http.in_flight -= 1;
      if (aborted) http.client_aborted += 1;
      else http.finished += 1;
    };
    res.once("finish", () => end(false));
    res.once("close", () => end(!res.writableFinished));
    next();
  }

  function snapshot() {
    const m = process.memoryUsage();
    const mb = (b) => Math.round((b / 1048576) * 10) / 10;
    const out = {
      memory: { heap_used_mb: mb(m.heapUsed), heap_total_mb: mb(m.heapTotal), rss_mb: mb(m.rss), external_mb: mb(m.external) },
      event_loop_delay_ms: {
        p50: Math.round(eld.percentile(50) / 1e6),
        p95: Math.round(eld.percentile(95) / 1e6),
        p99: Math.round(eld.percentile(99) / 1e6),
        max: Math.round(eld.max / 1e6),
      },
      http: { ...http },
      db: {},
    };
    for (const name of Object.keys(pools)) {
      const p = pools[name];
      const st = p && typeof p.stats === "function" ? p.stats() : null;
      if (!st) {
        out.db[name] = null;
        continue;
      }
      // Totals across lanes, then the per-lane detail.
      let running = 0;
      let waiting = 0;
      let rejected = 0;
      let timedOut = 0;
      for (const l of Object.values(st.lanes)) {
        running += l.active;
        waiting += l.waiting;
        rejected += l.refused_busy + l.refused_unavailable + l.flushed_on_open;
        timedOut += l.timed_out;
      }
      out.db[name] = {
        circuit: st.circuit.state,
        circuit_opens: st.circuit.opens,
        db_failures: st.connect_failures + st.query_timeouts,
        admission: { running, waiting, rejected, timed_out: timedOut },
        mysql: st.mysql,
        lanes: st.lanes,
        routes: st.routes,
      };
    }
    if (api.cronService && typeof api.cronService.stats === "function") out.cron = api.cronService.stats();
    if (api.lifecycle && typeof api.lifecycle.stats === "function") out.process = api.lifecycle.stats();
    if (typeof workerState === "function") {
      try {
        out.attendance_recalculation_worker = workerState();
      } catch (e) {
        out.attendance_recalculation_worker = null;
      }
    }
    return out;
  }

  let timer = null;
  function start() {
    const every = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 60000;
    timer = setInterval(() => {
      try {
        const s = snapshot();
        eld.reset();
        if (logger) {
          logger.Log({ level: logger.LEVEL.INFO, component: "SERVER", code: "SERVER.RUNTIME.STATS", description: "runtime snapshot", category: "", ref: s });
        }
      } catch (e) {
        /* a stats line is never worth a crash */
      }
    }, every);
    if (typeof timer.unref === "function") timer.unref();
  }
  function stop() {
    if (timer) clearInterval(timer);
    eld.disable();
  }

  const api = { httpCounter, snapshot, start, stop, cronService, lifecycle };
  return api;
}

module.exports = { createRuntimeStats };
