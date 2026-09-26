/**
 * Background database probe for /healthz. Node 14 syntax only.
 *
 * /healthz must answer at once however sick the database is, and however
 * often it is asked. So it never touches the database: it reads the last
 * result this monitor recorded. The monitor is the ONLY thing that probes:
 *
 *   serialized  one probe at a time; the next is scheduled intervalMs after
 *               the previous one has fully SETTLED - not merely timed out -
 *               so there is never more than one probe (and never more than
 *               one connection attempt) in flight
 *   hard limit  a probe that has not answered within timeoutMs is recorded
 *               as failed ("timeout") at that moment; the store's own
 *               acquire/query deadlines then make the call itself settle
 *   stale       a result older than staleAfterMs is reported as db:false,
 *               "stale" - e.g. if a probe somehow never settles
 *
 * Connection attempts are therefore at most one per (intervalMs + time to
 * fail), independent of how many health requests arrive.
 */

function createHealthMonitor(options = {}) {
  const probe = options.probe; // {ping(), lastPunchAt()}
  const intervalMs = positive(options.intervalMs, 5000);
  const timeoutMs = positive(options.timeoutMs, 2000);
  const staleAfterMs = positive(options.staleAfterMs, 3 * intervalMs + timeoutMs);
  const now = options.now || (() => Date.now());
  const log = options.log || { error() {}, info() {} };

  let timer = null;
  let stopped = true;
  let inFlight = false;
  let last = null; // {ok, error, last_punch_received, latency_ms, at}
  let lastPunch = null;
  let consecutiveFailures = 0;
  const totals = { probes: 0, probes_ok: 0, probes_failed: 0, probes_timed_out: 0 };

  function schedule(ms) {
    if (stopped) return;
    timer = setTimeout(runProbe, ms);
    if (typeof timer.unref === "function") timer.unref();
  }

  function record(result) {
    last = result;
    if (result.ok) {
      totals.probes_ok += 1;
      if (consecutiveFailures) log.info("HEALTH_DB_RECOVERED", `database probe OK after ${consecutiveFailures} failure(s)`, { latency_ms: result.latency_ms });
      consecutiveFailures = 0;
    } else {
      totals.probes_failed += 1;
      consecutiveFailures += 1;
      // First failure and then every 12th: a dead DB is visible, not a flood.
      if (consecutiveFailures === 1 || consecutiveFailures % 12 === 0) {
        log.error("HEALTH_DB_FAILED", `database probe failed: ${result.error}`, { consecutive_failures: consecutiveFailures });
      }
    }
  }

  function runProbe() {
    timer = null;
    if (stopped || inFlight) return;
    inFlight = true;
    totals.probes += 1;
    const t0 = now();
    let decided = false;

    const hard = setTimeout(() => {
      if (decided) return;
      decided = true;
      totals.probes_timed_out += 1;
      record({ ok: false, error: "timeout", last_punch_received: lastPunch, latency_ms: null, at: now() });
    }, timeoutMs);
    if (typeof hard.unref === "function") hard.unref();

    let work;
    try {
      work = Promise.resolve(probe.ping()).then((ok) =>
        Promise.resolve(probe.lastPunchAt()).then((lp) => ({ ok: ok === true, lp }))
      );
    } catch (err) {
      work = Promise.reject(err);
    }
    work
      .then(
        (r) => {
          if (r.ok) lastPunch = r.lp === undefined ? null : r.lp;
          if (!decided) {
            decided = true;
            record({ ok: r.ok, error: r.ok ? null : "ping returned false", last_punch_received: lastPunch, latency_ms: now() - t0, at: now() });
          }
        },
        (err) => {
          if (!decided) {
            decided = true;
            record({ ok: false, error: err && err.code ? String(err.code) : "error", last_punch_received: lastPunch, latency_ms: now() - t0, at: now() });
          }
        }
      )
      .then(() => {
        clearTimeout(hard);
        inFlight = false;
        schedule(intervalMs);
      });
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    runProbe();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** The last recorded result, as /healthz reports it. Never does I/O. */
  function status() {
    const t = now();
    if (!last) {
      return { ok: false, error: "not_checked_yet", stale: false, checked_at: null, age_ms: null, latency_ms: null, last_punch_received: null, probe_in_flight: inFlight, consecutive_failures: 0, interval_ms: intervalMs, timeout_ms: timeoutMs, ...totals };
    }
    const age = t - last.at;
    const stale = age > staleAfterMs;
    return {
      ok: last.ok && !stale,
      error: stale ? "stale" : last.error || undefined,
      stale,
      checked_at: new Date(last.at).toISOString(),
      age_ms: age,
      latency_ms: last.latency_ms,
      last_punch_received: last.last_punch_received,
      probe_in_flight: inFlight,
      consecutive_failures: consecutiveFailures,
      interval_ms: intervalMs,
      timeout_ms: timeoutMs,
      ...totals,
    };
  }

  return { start, stop, status };
}

function positive(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

module.exports = { createHealthMonitor };
