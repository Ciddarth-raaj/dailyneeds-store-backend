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
 * Three limits, all counted, none silent:
 *
 *   concurrency      jobs running at once - i.e. at most this many pool
 *                    connections are ever spent on housekeeping, so punches
 *                    always have the rest
 *   maxPending       jobs waiting; beyond it a new job is DROPPED (counted,
 *                    logged at most once a minute with totals)
 *   maxPendingBytes  bytes of payload (raw frames) waiting, same rule
 *
 * A job may carry a `key`: a second job with the same key while the first
 * is still waiting is COALESCED into it (counted). A `critical` job - small,
 * rare state transitions such as a pull becoming RECEIVING - is never
 * dropped for capacity; it still waits its turn behind `concurrency`.
 *
 * Nothing here ever writes to the database itself and nothing is awaited by
 * a request. A job that fails is logged (HOUSEKEEPING_FAILED, with its name
 * and the error, at most `failureLogPerMinute` lines a minute; the rest are
 * counted and the next line says how many). After close() nothing new is
 * accepted and nothing waiting is started, so a shutdown cannot turn into a
 * stream of "Pool is closed" failures.
 */

function createHousekeeper(options = {}) {
  const concurrency = positive(options.concurrency, 1);
  const maxPending = positive(options.maxPending, 100);
  const maxPendingBytes = positive(options.maxPendingBytes, 4 * 1024 * 1024);
  const failureLogPerMinute = positive(options.failureLogPerMinute, 10);
  const log = options.log || { error() {}, info() {} };
  const now = options.now || (() => Date.now());

  const queue = [];
  const pendingKeys = new Map(); // key -> job (waiting only)
  let pendingBytes = 0;
  let running = 0;
  let closed = false;
  let idleWaiters = [];

  const totals = {
    submitted: 0,
    completed: 0,
    failed: 0,
    dropped: 0,
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

  // Rate-limited logging: one DROPPED line a minute, N FAILED lines a minute.
  let dropMinute = null;
  let dropsSinceLog = 0;
  let failMinute = null;
  let failsThisMinute = 0;
  let failsSuppressed = 0;

  function noteDrop(name, reason) {
    dropsSinceLog += 1;
    const m = Math.floor(now() / 60000);
    if (m === dropMinute) return;
    dropMinute = m;
    log.error("HOUSEKEEPING_DROPPED", `housekeeping queue full (${reason}); ${dropsSinceLog} job(s) dropped since the last report`, {
      job: name,
      dropped_since_last_report: dropsSinceLog,
      pending: queue.length,
      pending_bytes: pendingBytes,
      dropped_total: totals.dropped,
    });
    dropsSinceLog = 0;
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
    const bytes = Number.isFinite(job.bytes) && job.bytes > 0 ? job.bytes : 0;
    if (!job.critical) {
      const reason = queue.length >= maxPending ? `${maxPending} jobs waiting` : pendingBytes + bytes > maxPendingBytes ? `${maxPendingBytes} bytes waiting` : null;
      if (reason) {
        totals.dropped += 1;
        s.dropped += 1;
        noteDrop(name, reason);
        return "dropped";
      }
    }
    totals.submitted += 1;
    s.submitted += 1;
    const entry = { name, run: job.run, key: job.key || null, bytes };
    queue.push(entry);
    pendingBytes += bytes;
    if (entry.key) pendingKeys.set(entry.key, entry);
    pump();
    return "accepted";
  }

  function pump() {
    while (!closed && running < concurrency && queue.length) {
      const job = queue.shift();
      pendingBytes -= job.bytes;
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
        if (running === 0 && queue.length === 0) {
          const waiters = idleWaiters;
          idleWaiters = [];
          waiters.forEach((w) => w());
        }
      });
    }
  }

  /** Resolves once nothing is running or waiting (tests, shutdown). */
  function idle() {
    if (running === 0 && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  /**
   * Stop: accept nothing more, drop what has not started (counted), and
   * wait up to timeoutMs for what is running.
   */
  function close({ timeoutMs = 2000 } = {}) {
    if (!closed) {
      closed = true;
      totals.dropped_on_shutdown += queue.length;
      queue.length = 0;
      pendingKeys.clear();
      pendingBytes = 0;
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
      pending: queue.length,
      pending_bytes: pendingBytes,
      running,
      concurrency,
      max_pending: maxPending,
      max_pending_bytes: maxPendingBytes,
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

module.exports = { createHousekeeper, createDiagLimiter };
