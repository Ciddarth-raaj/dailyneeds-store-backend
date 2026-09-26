/**
 * Bounded post-response work for the receiver. Node 14 syntax only.
 *
 * Everything the receiver does AFTER a reply has gone out - device
 * last-seen upkeep, diagnostic raw-request rows, a historical pull's status
 * bookkeeping - runs through here instead of being awaited inside the
 * request handler. That matters because an awaited write keeps the whole
 * request alive (req, res, the socket, the body, the rebuilt frame) for as
 * long as the database takes, and the mysql pool queues waiters without any
 * limit: a noisy device plus a slow database used to turn into an unbounded
 * backlog of retained requests (the 2026-09 biomax-receiver OOM).
 *
 * Two lanes, each with its own hard bounds, all counted, none silent:
 *
 *   concurrency              jobs running at once, both lanes together - at
 *                            most this many pool connections are ever spent
 *                            on housekeeping, so punches always have the rest
 *   ordinary lane            last-seen upkeep, diagnostic raw rows
 *     maxPending               jobs waiting
 *     maxPendingBytes          payload bytes (raw frames) waiting
 *   critical lane            rare state transitions (a pull becoming
 *                            RECEIVING) - small, and must not be starved
 *     maxCriticalPending       jobs waiting
 *     maxCriticalPendingBytes  bytes waiting; a critical job is charged at
 *                              least CRITICAL_MIN_BYTES whatever it declares
 *
 * Beyond its lane's bounds a new job is DROPPED - counted, and logged at
 * most once a minute per lane (HOUSEKEEPING_DROPPED / CRITICAL_DROPPED). No
 * class of job can grow a queue without limit: the most that can ever be
 * waiting is maxPending + maxCriticalPending jobs.
 *
 * Priority: whenever a slot frees, a waiting critical job is started before
 * any ordinary one. So ordinary traffic can delay a critical job by at most
 * the jobs already RUNNING (each bounded by the store's acquire + query
 * deadlines), never by the ones waiting.
 *
 * A job may carry a `key`: a second job with the same key while the first
 * is still waiting is COALESCED into it (counted) - repeated state
 * transitions for the same pull collapse to one.
 *
 * Nothing here ever writes to the database itself and nothing is awaited by
 * a request. A job that fails is logged (HOUSEKEEPING_FAILED, with its name
 * and the error, at most `failureLogPerMinute` lines a minute; the rest are
 * counted and the next line says how many). After close() nothing new is
 * accepted and nothing waiting is started, so a shutdown cannot turn into a
 * stream of "Pool is closed" failures.
 */

/** What a critical job is charged at minimum: its closure, key and entry. */
const CRITICAL_MIN_BYTES = 256;

function createHousekeeper(options = {}) {
  const concurrency = positive(options.concurrency, 1);
  const maxPending = positive(options.maxPending, 100);
  const maxPendingBytes = positive(options.maxPendingBytes, 4 * 1024 * 1024);
  const maxCriticalPending = positive(options.maxCriticalPending, 32);
  const maxCriticalPendingBytes = positive(options.maxCriticalPendingBytes, 64 * 1024);
  const failureLogPerMinute = positive(options.failureLogPerMinute, 10);
  const log = options.log || { error() {}, info() {} };
  const now = options.now || (() => Date.now());

  const lanes = {
    ordinary: { queue: [], bytes: 0, max: maxPending, maxBytes: maxPendingBytes, dropCode: "HOUSEKEEPING_DROPPED", dropMinute: null, dropsSinceLog: 0 },
    critical: { queue: [], bytes: 0, max: maxCriticalPending, maxBytes: maxCriticalPendingBytes, dropCode: "CRITICAL_DROPPED", dropMinute: null, dropsSinceLog: 0 },
  };
  const pendingKeys = new Map(); // key -> job (waiting only)
  const waiting = () => lanes.ordinary.queue.length + lanes.critical.queue.length;
  let running = 0;
  let closed = false;
  let idleWaiters = [];

  const totals = {
    submitted: 0,
    completed: 0,
    failed: 0,
    dropped: 0,
    critical_dropped: 0,
    coalesced: 0,
    dropped_on_shutdown: 0,
    rejected_after_close: 0,
    aborted_on_shutdown: 0,
  };
  const byName = new Map(); // name -> {submitted, completed, failed, dropped, coalesced}
  const nameStats = (name) => {
    let s = byName.get(name);
    if (!s) {
      s = { submitted: 0, completed: 0, failed: 0, dropped: 0, coalesced: 0 };
      byName.set(name, s);
    }
    return s;
  };

  // Rate-limited logging: one DROPPED line a minute per lane, N FAILED
  // lines a minute.
  let failMinute = null;
  let failsThisMinute = 0;
  let failsSuppressed = 0;

  function noteDrop(lane, laneName, name, reason) {
    lane.dropsSinceLog += 1;
    const m = Math.floor(now() / 60000);
    if (m === lane.dropMinute) return;
    lane.dropMinute = m;
    log.error(lane.dropCode, `housekeeping ${laneName} lane full (${reason}); ${lane.dropsSinceLog} job(s) dropped since the last report`, {
      job: name,
      lane: laneName,
      dropped_since_last_report: lane.dropsSinceLog,
      pending: lane.queue.length,
      pending_bytes: lane.bytes,
      dropped_total: laneName === "critical" ? totals.critical_dropped : totals.dropped,
    });
    lane.dropsSinceLog = 0;
  }

  function noteFailure(name, err) {
    const m = Math.floor(now() / 60000);
    if (m !== failMinute) {
      failMinute = m;
      failsThisMinute = 0;
    }
    failsThisMinute += 1;
    if (failsThisMinute > failureLogPerMinute) {
      failsSuppressed += 1;
      return;
    }
    const ref = { job: name, error_code: err && err.code ? err.code : undefined, failed_total: totals.failed };
    if (failsSuppressed) {
      ref.suppressed_since_last_line = failsSuppressed;
      failsSuppressed = 0;
    }
    log.error("HOUSEKEEPING_FAILED", `${name}: ${err && err.message ? err.message : String(err)}`, ref);
  }

  /**
   * @param {{name: string, run: function(): Promise, key?: string, bytes?: number, critical?: boolean}} job
   * @returns {'accepted'|'coalesced'|'dropped'|'closed'}
   */
  function submit(job) {
    const name = job.name || "job";
    if (closed) {
      totals.rejected_after_close += 1;
      return "closed";
    }
    const s = nameStats(name);
    if (job.key && pendingKeys.has(job.key)) {
      totals.coalesced += 1;
      s.coalesced += 1;
      return "coalesced";
    }
    const laneName = job.critical ? "critical" : "ordinary";
    const lane = lanes[laneName];
    const declared = Number.isFinite(job.bytes) && job.bytes > 0 ? job.bytes : 0;
    const bytes = job.critical ? Math.max(declared, CRITICAL_MIN_BYTES) : declared;
    const reason = lane.queue.length >= lane.max ? `${lane.max} jobs waiting` : lane.bytes + bytes > lane.maxBytes ? `${lane.maxBytes} bytes waiting` : null;
    if (reason) {
      if (job.critical) totals.critical_dropped += 1;
      else totals.dropped += 1;
      s.dropped += 1;
      noteDrop(lane, laneName, name, reason);
      return "dropped";
    }
    totals.submitted += 1;
    s.submitted += 1;
    const entry = { name, run: job.run, key: job.key || null, bytes, lane };
    lane.queue.push(entry);
    lane.bytes += bytes;
    if (entry.key) pendingKeys.set(entry.key, entry);
    pump();
    return "accepted";
  }

  function pump() {
    while (!closed && running < concurrency && waiting()) {
      // Critical first, always.
      const lane = lanes.critical.queue.length ? lanes.critical : lanes.ordinary;
      const job = lane.queue.shift();
      lane.bytes -= job.bytes;
      if (job.key && pendingKeys.get(job.key) === job) pendingKeys.delete(job.key);
      running += 1;
      let p;
      try {
        // Started synchronously: a free slot means the work begins now.
        p = Promise.resolve(job.run());
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(
        () => {
          totals.completed += 1;
          nameStats(job.name).completed += 1;
        },
        (err) => {
          // Shutdown cut it off (pool ended, connection destroyed): counted,
          // not logged - one line per casualty is the loop this prevents.
          if (closed || (err && err.code === "POOL_CLOSED")) {
            totals.aborted_on_shutdown += 1;
            return;
          }
          totals.failed += 1;
          nameStats(job.name).failed += 1;
          noteFailure(job.name, err);
        }
      ).then(() => {
        running -= 1;
        pump();
        if (running === 0 && waiting() === 0) {
          const waiters = idleWaiters;
          idleWaiters = [];
          waiters.forEach((w) => w());
        }
      });
    }
  }

  /** Resolves once nothing is running or waiting (tests, shutdown). */
  function idle() {
    if (running === 0 && waiting() === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  /**
   * Stop: accept nothing more, drop what has not started (counted), and
   * wait up to timeoutMs for what is running.
   */
  function close({ timeoutMs = 2000 } = {}) {
    if (!closed) {
      closed = true;
      totals.dropped_on_shutdown += waiting();
      lanes.ordinary.queue.length = 0;
      lanes.critical.queue.length = 0;
      lanes.ordinary.bytes = 0;
      lanes.critical.bytes = 0;
      pendingKeys.clear();
    }
    if (running === 0) return Promise.resolve(stats());
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(stats()), timeoutMs);
      idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(stats());
      });
    });
  }

  function stats() {
    const names = {};
    byName.forEach((v, k) => {
      names[k] = { ...v };
    });
    return {
      pending: waiting(),
      pending_bytes: lanes.ordinary.bytes + lanes.critical.bytes,
      running,
      concurrency,
      ordinary_pending: lanes.ordinary.queue.length,
      ordinary_pending_bytes: lanes.ordinary.bytes,
      critical_pending: lanes.critical.queue.length,
      critical_pending_bytes: lanes.critical.bytes,
      max_pending: maxPending,
      max_pending_bytes: maxPendingBytes,
      max_critical_pending: maxCriticalPending,
      max_critical_pending_bytes: maxCriticalPendingBytes,
      closed,
      ...totals,
      by_job: names,
    };
  }

  return { submit, idle, close, stats };
}

/**
 * Which diagnostic raw-request rows are worth writing.
 *
 * A device that re-sends the same frame all day (it does: an enrolment
 * upload it never sees accepted) must not become one BLOB row per retry.
 * Three windows, all per `windowMs`:
 *
 *   exact key   (dev_id, request_code, body hash): the first one only
 *   source key  (dev_id, request_code): at most perSource rows
 *   everything: at most maxPerWindow rows
 *
 * What is not written is counted per source and reported on the NEXT row
 * written for that source ("+N suppressed"), and in stats(). Maps are capped
 * at maxKeys entries - dev_id is whatever a client puts in a header - and are
 * simply reset when a window turns or the cap is hit.
 */
function createDiagLimiter(options = {}) {
  const windowMs = positive(options.windowMs, 60 * 60 * 1000);
  const perSource = positive(options.perSource, 6);
  const maxPerWindow = positive(options.maxPerWindow, 120);
  const maxKeys = positive(options.maxKeys, 2000);
  const now = options.now || (() => Date.now());

  let window = null;
  let exact = new Set();
  let sources = new Map(); // source -> {written, suppressed}
  let writtenThisWindow = 0;
  const totals = { written: 0, suppressed_identical: 0, suppressed_rate: 0 };

  function roll() {
    const w = Math.floor(now() / windowMs);
    if (w !== window || exact.size > maxKeys || sources.size > maxKeys) {
      // Carry suppressed counts into the new window so they still get reported.
      const carried = new Map();
      if (sources.size <= maxKeys) {
        sources.forEach((v, k) => {
          if (v.suppressed) carried.set(k, { written: 0, suppressed: v.suppressed });
        });
      }
      window = w;
      exact = new Set();
      sources = carried;
      writtenThisWindow = 0;
    }
  }

  /** @returns {{write: boolean, suppressed: number, why?: string}} */
  function check(sourceKey, exactKey) {
    roll();
    let s = sources.get(sourceKey);
    if (!s) {
      s = { written: 0, suppressed: 0 };
      sources.set(sourceKey, s);
    }
    if (exactKey && exact.has(exactKey)) {
      s.suppressed += 1;
      totals.suppressed_identical += 1;
      return { write: false, suppressed: s.suppressed, why: "identical" };
    }
    if (s.written >= perSource || writtenThisWindow >= maxPerWindow) {
      s.suppressed += 1;
      totals.suppressed_rate += 1;
      return { write: false, suppressed: s.suppressed, why: "rate" };
    }
    if (exactKey) exact.add(exactKey);
    s.written += 1;
    writtenThisWindow += 1;
    totals.written += 1;
    const suppressed = s.suppressed;
    s.suppressed = 0;
    return { write: true, suppressed };
  }

  function stats() {
    return { window_ms: windowMs, per_source: perSource, max_per_window: maxPerWindow, written_this_window: writtenThisWindow, ...totals };
  }

  return { check, stats };
}

function positive(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

module.exports = { createHousekeeper, createDiagLimiter, CRITICAL_MIN_BYTES };
