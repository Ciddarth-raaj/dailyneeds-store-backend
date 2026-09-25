const { AsyncLocalStorage } = require("async_hooks");
const logger = require("./logger");

/**
 * TEMPORARY: where the time goes on an attendance month read.
 *
 * Added to diagnose "My Attendance loads slowly" on production, where the
 * read could not be reproduced as slow against a production-shaped copy of
 * the schema. It MEASURES and changes nothing: no query, no result and no
 * rule depends on it, and a request without a timing context (every caller
 * other than the two month reads) takes exactly the path it always did.
 *
 * ONE CONTEXT PER REQUEST, carried by AsyncLocalStorage so the repository can
 * attribute its queries to the request that caused them without a parameter
 * being threaded through every signature. Per query it records how long the
 * request WAITED for a pooled connection separately from how long MySQL took
 * to answer - a slow read and a starved pool look identical from outside.
 *
 * OUTPUT
 *   `Server-Timing` on the response - visible in the browser's DevTools, so
 *   the numbers can be read on production without log access. Phase names
 *   and durations only; no attendance data.
 *   A log line (`ATTENDANCE.READ_TIMING`) when the request took at least
 *   ATTENDANCE_SLOW_MS (default 1500), or always when
 *   ATTENDANCE_TIMING_LOG=1.
 *
 * Remove once the production cause is confirmed.
 */
const storage = new AsyncLocalStorage();

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

function create(label, { receivedAt = null } = {}) {
  const t0 = nowMs();
  const ctx = {
    label,
    t0,
    phases: new Map(),
    queries: [],
    pool: null,
  };
  // Time spent in front of the handler - auth, IP policy, permissions - when
  // the request stamped its arrival.
  if (typeof receivedAt === "number" && receivedAt > 0 && receivedAt <= t0) {
    ctx.phases.set("middleware", t0 - receivedAt);
  }
  return ctx;
}

const current = () => storage.getStore() || null;

const run = (ctx, fn) => storage.run(ctx, fn);

function add(ctx, name, ms) {
  if (!ctx) return;
  ctx.phases.set(name, (ctx.phases.get(name) || 0) + ms);
}

/** Time an async step. Without a context this is just `fn()`. */
async function phase(name, fn) {
  const ctx = current();
  if (!ctx) return fn();
  const t = nowMs();
  try {
    return await fn();
  } finally {
    add(ctx, name, nowMs() - t);
  }
}

/** Time a synchronous step. Without a context this is just `fn()`. */
function phaseSync(name, fn) {
  const ctx = current();
  if (!ctx) return fn();
  const t = nowMs();
  try {
    return fn();
  } finally {
    add(ctx, name, nowMs() - t);
  }
}

/**
 * The pool's state as the request found it. The fields are private to
 * `mysql`'s Pool, so anything unexpected simply yields null.
 */
function snapshotPool(pool) {
  try {
    if (!pool || !Array.isArray(pool._allConnections)) return null;
    return {
      limit: pool.config && pool.config.connectionLimit,
      open: pool._allConnections.length,
      free: Array.isArray(pool._freeConnections) ? pool._freeConnections.length : null,
      queued: Array.isArray(pool._connectionQueue) ? pool._connectionQueue.length : null,
    };
  } catch (err) {
    return null;
  }
}

function recordQuery(ctx, { code, wait_ms, exec_ms, rows }) {
  if (!ctx) return;
  ctx.queries.push({ code, wait_ms, exec_ms, rows });
}

/**
 * Run one read on `db`, attributing it to the current request.
 *
 * With a pool and a timing context the connection is taken explicitly so the
 * wait for it is measured apart from the query - which is what `pool.query`
 * does internally (get, query, release), just observed. Anything else goes
 * through `db.query` unchanged.
 */
function timedQuery(db, code, sql, params, callback) {
  const ctx = current();
  if (!ctx || !db || typeof db.getConnection !== "function") {
    const t = nowMs();
    return db.query(sql, params, (err, rows) => {
      if (ctx) recordQuery(ctx, { code, wait_ms: null, exec_ms: nowMs() - t, rows: rows ? rows.length : 0 });
      callback(err, rows);
    });
  }
  if (!ctx.pool) ctx.pool = snapshotPool(db);
  const asked = nowMs();
  return db.getConnection((connErr, connection) => {
    const got = nowMs();
    if (connErr) {
      recordQuery(ctx, { code, wait_ms: got - asked, exec_ms: 0, rows: 0 });
      callback(connErr);
      return;
    }
    connection.query(sql, params, (err, rows) => {
      connection.release();
      recordQuery(ctx, {
        code,
        wait_ms: got - asked,
        exec_ms: nowMs() - got,
        rows: rows ? rows.length : 0,
      });
      callback(err, rows);
    });
  });
}

const round = (ms) => Math.round(ms * 10) / 10;

function summary(ctx) {
  const total = nowMs() - ctx.t0 + (ctx.phases.get("middleware") || 0);
  const waits = ctx.queries.map((q) => q.wait_ms).filter((ms) => typeof ms === "number");
  return {
    label: ctx.label,
    total_ms: round(total),
    phases: Object.fromEntries([...ctx.phases].map(([k, v]) => [k, round(v)])),
    query_count: ctx.queries.length,
    pool_wait_ms_max: waits.length ? round(Math.max(...waits)) : null,
    pool_wait_ms_sum: waits.length ? round(waits.reduce((a, b) => a + b, 0)) : null,
    pool: ctx.pool,
    queries: ctx.queries.map((q) => ({
      code: q.code,
      wait_ms: q.wait_ms === null ? null : round(q.wait_ms),
      exec_ms: round(q.exec_ms),
      rows: q.rows,
    })),
  };
}

/** `Server-Timing` value: every phase, the query count and the pool wait. */
function serverTiming(ctx) {
  const s = summary(ctx);
  const entries = Object.entries(s.phases).map(([k, v]) => `${k};dur=${v}`);
  // The read never consults the payroll lock - a locked month is read from
  // its stored rows and refused at WRITE time - so it is reported, at zero,
  // rather than left for somebody to wonder about.
  entries.push(`payroll_lock_lookup;dur=0;desc="not queried on read"`);
  entries.push(`db_queries;desc="${s.query_count}"`);
  if (s.pool_wait_ms_max !== null) entries.push(`db_pool_wait_max;dur=${s.pool_wait_ms_max}`);
  entries.push(`total;dur=${s.total_ms}`);
  return entries.join(", ");
}

function slowThresholdMs() {
  const n = Number(process.env.ATTENDANCE_SLOW_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

function report(ctx, ref = {}) {
  if (!ctx) return null;
  const s = summary(ctx);
  if (process.env.ATTENDANCE_TIMING_LOG === "1" || s.total_ms >= slowThresholdMs()) {
    logger.Log({
      // INFO either way: this logger's WARN level is not one winston knows.
      level: logger.LEVEL.INFO,
      component: "ATTENDANCE.READ_TIMING",
      code: "ATTENDANCE.READ_TIMING",
      description: `${s.label} ${s.total_ms} ms, ${s.query_count} queries`,
      category: "",
      ref: { ...ref, ...s },
    });
  }
  return s;
}

/**
 * Wrap a month-read handler: run it inside a fresh context, set
 * `Server-Timing` just before the body is sent, then time the send itself
 * (the sensitive-field filter and JSON serialization) and report.
 */
function instrument(label, handler) {
  return (req, res) => {
    const ctx = create(label, { receivedAt: req.receivedAtMs });
    const json = res.json.bind(res);
    res.json = (body) => {
      try {
        if (!res.headersSent) res.set("Server-Timing", serverTiming(ctx));
      } catch (err) {
        // Measurement must never cost the response.
      }
      const t = nowMs();
      const out = json(body);
      add(ctx, "response", nowMs() - t);
      report(ctx, { path: req.path, status: res.statusCode });
      return out;
    };
    return run(ctx, () => handler(req, res));
  };
}

module.exports = {
  create,
  current,
  run,
  phase,
  phaseSync,
  timedQuery,
  summary,
  serverTiming,
  report,
  instrument,
  snapshotPool,
  nowMs,
};
