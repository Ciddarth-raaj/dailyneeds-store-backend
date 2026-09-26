/**
 * DB ADMISSION CONTROL for the API's mysqljs pools. Node 14 syntax only.
 *
 * WHY. mysqljs 2.x queues every caller that cannot get a connection in the
 * pool's `_connectionQueue`, with no limit (`queueLimit` 0) and no deadline:
 * its `acquireTimeout` bounds connecting and the pre-use ping, NOT the time a
 * caller waits in that queue. When the database is slow or unreachable the
 * queue grows for as long as the outage lasts, every waiter keeps its request
 * (req, res, parsed body, closures) alive, and when the database comes back
 * the whole backlog runs at once. Measured against the real server.js:
 * docs/api-db-backpressure.md.
 *
 * WHAT THIS DOES. `guardPool(rawPool)` returns an object with the same
 * surface the codebase uses - `query(sql[, values], cb)`,
 * `getConnection(cb)`, `escape`, `escapeId`, `format`, `on`, `end`,
 * `config`, and read-only views of mysqljs's private arrays for the
 * temporary read timing - but no caller ever reaches mysqljs's queue:
 *
 *   PERMITS    at most `connectionLimit` acquisitions are ever outstanding,
 *              so mysqljs always has a connection (or a connection slot) for
 *              whoever it is handed and its own queue stays empty.
 *   LANES      each caller runs in a lane taken from AsyncLocalStorage:
 *              `interactive` (HTTP, the default), `attendance_read` (the two
 *              My Attendance month reads) and `background` (crons -
 *              services/cron_service.js). A lane has its own cap on
 *              connections in use, its own bounded waiter queue and its own
 *              wait deadline. Background work is capped well below the pool
 *              size, so no amount of it can take every connection from HTTP
 *              traffic; interactive waiters are always served first.
 *   DEADLINE   a waiter that has not got a connection within its lane's
 *              `waitTimeoutMs` is REMOVED from the queue and failed with
 *              DB_ACQUIRE_TIMEOUT. It never reached mysqljs, so nothing of it
 *              is left behind to run later.
 *   BOUND      a lane whose waiter queue is full refuses at once (DB_BUSY).
 *   CIRCUIT    `failureThreshold` consecutive connection-level failures
 *              (refused, unreachable, handshake/ping/query inactivity
 *              timeout, lost connection) OPEN the circuit for `openMs`
 *              (doubling on each consecutive re-open, up to `maxOpenMs`):
 *              every waiter is failed at once and new callers fail
 *              immediately with DB_UNAVAILABLE instead of each burning a
 *              connect attempt. Then ONE probe is let through (half-open):
 *              success closes it, failure re-opens it. So a recovering
 *              database sees one connection attempt, not a stampede.
 *   TIMEOUTS   a statement that sets no `timeout` of its own gets its LANE's
 *              default (interactive 120 s, attendance_read 60 s, background
 *              10 min), on `pool.query` AND on every statement run on a
 *              connection handed out by `getConnection` - a transaction
 *              included, BEGIN/COMMIT/ROLLBACK too - so a silent peer cannot
 *              pin a connection forever. A statement that sets its own
 *              `timeout` keeps it. On expiry mysqljs errors the statement
 *              (PROTOCOL_SEQUENCE_TIMEOUT, fatal) and destroys the
 *              connection. THE SERVER MAY STILL FINISH THE STATEMENT: MySQL
 *              only notices the client is gone when it next writes to the
 *              socket, so an autocommit write can still commit after the
 *              client gave up; an open transaction is rolled back when the
 *              server sees the disconnect. docs/api-db-backpressure.md
 *              bounds how many such abandoned statements can exist.
 *
 * WHAT IT DOES NOT CHANGE. Transactions still run on one connection from
 * getConnection to release. Results, errors and callback order of a query
 * that gets a connection are exactly mysqljs's. A caller that is refused
 * receives an ordinary Error in its callback - code DB_BUSY,
 * DB_ACQUIRE_TIMEOUT, DB_UNAVAILABLE or POOL_CLOSED - through the same path
 * a connection error always took, so every existing error handler applies.
 */
const { AsyncLocalStorage, AsyncResource } = require("async_hooks");

/**
 * mysqljs calls back from the DB socket's own async context, not the
 * caller's, so a callback-style chain (query inside a query callback) would
 * otherwise lose its lane half way. Bind every callback to the context it
 * was issued in.
 *
 * NOT AsyncResource.bind: on Node 14 (production) it binds
 * runInAsyncScope(fn, thisArg, ...args) WITHOUT a thisArg, so the callback's
 * first argument is swallowed as `this` - `cb(err, conn)` arrives as
 * `cb(conn)`. Fixed in later Node versions; found by running this on
 * 14.21.3. runInAsyncScope is called explicitly instead.
 */
function bindToCaller(fn) {
  if (typeof fn !== "function") return fn;
  const resource = new AsyncResource("DB_ADMISSION_CALLBACK");
  return function boundToCaller(...args) {
    return resource.runInAsyncScope(fn, this, ...args);
  };
}

const laneStore = new AsyncLocalStorage();

/** Run fn with DB work attributed to `lane` (and optional route label). */
function runInLane(lane, fn, extra) {
  return laneStore.run({ lane, ...(extra || {}) }, fn);
}
function currentContext() {
  return laneStore.getStore() || null;
}

const LANE_DEFAULTS = {
  // The waiter bounds are deliberately generous: they must never refuse a
  // HEALTHY burst (30 people opening the Mini App at 07:00 is ~210 queries).
  // During an outage it is the deadline and the circuit that empty the queue;
  // the bound only guarantees it can never grow without limit. A waiter is a
  // closure and a timer - the request it belongs to exists regardless.
  interactive: { maxActive: null /* = connectionLimit */, maxWaiting: 500, waitTimeoutMs: 5000, priority: 0, queryTimeoutMs: 120000 },
  // My Attendance month reads (Telegram Mini App + /attendance/me) fan out
  // ~10 queries, 7 of them at once. Capped so a burst of them - the morning
  // after the 07:00 Missing Attendance message - cannot hold every
  // connection while the database is slow.
  attendance_read: { maxActive: 5, maxWaiting: 500, waitTimeoutMs: 5000, priority: 1, queryTimeoutMs: 60000 },
  // Cron work: never more than 4 of the 10 connections, so HTTP always has 6.
  // One recalculation run alone issues 7 reads at once, and ticks of
  // different jobs can overlap, so the waiter bound is generous and the
  // deadline long - a healthy database must never refuse cron work.
  //
  // `reserved: 1`: while cron work is waiting and holds no connection, HTTP
  // lanes may not take the last free one - so continuous HTTP load cannot
  // starve a recalculation run either. With no cron work waiting, HTTP may
  // use all 10.
  //
  // Its default statement timeout is long (10 min): batch statements (the
  // GoFrugal full-table reads, 5000-row inserts, the daily recalculation)
  // are legitimate here, and this lane is capped, so a stuck one can never
  // take more than 4 connections from HTTP.
  background: { maxActive: 4, maxWaiting: 100, waitTimeoutMs: 60000, priority: 2, reserved: 1, queryTimeoutMs: 600000 },
};

/**
 * Express handler wrapper: run `handler` with its DB work in `lane`.
 * Keeps the request as context for per-route wait metrics.
 */
function inLane(lane, handler) {
  return (req, res, next) => runInLane(lane, () => handler(req, res, next), { req });
}

/** Errors that say the DATABASE (not the query) is unwell. */
const CONNECTION_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "PROTOCOL_SEQUENCE_TIMEOUT", // handshake / ping / query inactivity timeout
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR",
  "HANDSHAKE_NO_SSL_SUPPORT",
]);

function admissionError(code, message) {
  const err = new Error(message);
  err.code = code;
  err.fatal = false;
  err.dbAdmission = true;
  return err;
}

function positive(v, fallback) {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * @param {object} rawPool a mysqljs Pool
 * @param {object} [options]
 * @param {string} [options.name]                label for stats/logs
 * @param {object} [options.lanes]               overrides per lane, see LANE_DEFAULTS
 * @param {number} [options.defaultQueryTimeoutMs] default 120000
 * @param {number} [options.failureThreshold]    default 3
 * @param {number} [options.openMs]              default 5000
 * @param {number} [options.maxOpenMs]           default 10000
 * @param {function} [options.now]
 * @param {object} [options.log]                 {error(code, desc, ref), info(...)}
 */
function guardPool(rawPool, options = {}) {
  const name = options.name || "mysql";
  const now = options.now || (() => Date.now());
  const log = options.log || { error() {}, info() {} };
  const limit = positive(rawPool && rawPool.config && rawPool.config.connectionLimit, 10);
  const failureThreshold = positive(options.failureThreshold, 3);
  const baseOpenMs = positive(options.openMs, 5000);
  const maxOpenMs = positive(options.maxOpenMs, 10000);

  const lanes = {};
  const laneOverrides = options.lanes || {};
  for (const laneName of Object.keys(LANE_DEFAULTS).concat(Object.keys(laneOverrides))) {
    if (lanes[laneName]) continue;
    const cfg = { ...LANE_DEFAULTS.interactive, ...(LANE_DEFAULTS[laneName] || {}), ...(laneOverrides[laneName] || {}) };
    lanes[laneName] = {
      name: laneName,
      maxActive: Math.min(limit, positive(cfg.maxActive, limit)),
      maxWaiting: Math.max(0, Number.isFinite(cfg.maxWaiting) ? cfg.maxWaiting : 100),
      waitTimeoutMs: positive(cfg.waitTimeoutMs, 5000),
      priority: Number.isFinite(cfg.priority) ? cfg.priority : 0,
      reserved: Math.max(0, Number.isFinite(cfg.reserved) ? cfg.reserved : 0),
      // A statement with no `timeout` of its own gets this (0 = none). A
      // global override (options.defaultQueryTimeoutMs) applies to every lane.
      queryTimeoutMs:
        options.defaultQueryTimeoutMs !== undefined
          ? options.defaultQueryTimeoutMs
          : Number.isFinite(cfg.queryTimeoutMs) && cfg.queryTimeoutMs >= 0
          ? cfg.queryTimeoutMs
          : 120000,
      active: 0,
      waiting: [], // {cb, at, timer}
      totals: { acquired: 0, refused_busy: 0, timed_out: 0, refused_unavailable: 0, flushed_on_open: 0, wait_ms_sum: 0, wait_ms_max: 0 },
    };
  }
  const laneOrder = Object.keys(lanes).sort((a, b) => lanes[a].priority - lanes[b].priority);
  const laneFor = (laneName) => lanes[laneName] || lanes.interactive;

  let active = 0;
  let closed = false;
  const circuit = { state: "closed", consecutiveFailures: 0, openedAt: null, openUntil: 0, opens: 0, currentOpenMs: baseOpenMs, probeInFlight: false, lastError: null };
  const totals = { connect_failures: 0, query_timeouts: 0, circuit_opened: 0, straggler_failures_ignored: 0, straggler_successes_ignored: 0 };
  const routeWait = new Map(); // route label -> {count, sum, max}  (capped)

  // ------------------------------------------------------------- circuit --

  /**
   * `isProbe`: this outcome is the half-open probe's own. Only the probe
   * moves a half-open circuit on failure; an attempt that started before
   * the circuit opened and fails late is counted and nothing more.
   */
  function noteFailure(err, isProbe) {
    circuit.lastError = err && err.code ? String(err.code) : "error";
    if (!isProbe && circuit.state !== "closed") {
      totals.straggler_failures_ignored += 1;
      return;
    }
    circuit.consecutiveFailures += 1;
    if (isProbe) {
      circuit.probeInFlight = false;
      open(true);
      return;
    }
    if (circuit.state === "closed" && circuit.consecutiveFailures >= failureThreshold) open(false);
  }
  /**
   * A connection was obtained. In CLOSED it resets the failure count. Out of
   * OPEN/HALF_OPEN it is the PROBE's success that closes the circuit and
   * nothing else: an attempt that started before the circuit opened and
   * happens to succeed late is counted, not trusted.
   */
  function noteSuccess(isProbe) {
    if (circuit.state === "closed") {
      circuit.consecutiveFailures = 0;
      return;
    }
    if (!isProbe) {
      totals.straggler_successes_ignored += 1;
      return;
    }
    if (circuit.state !== "closed") {
      log.info("DB_CIRCUIT_CLOSED", `${name}: database reachable again - circuit closed`, { pool: name, was_open_ms: circuit.openedAt ? now() - circuit.openedAt : null });
    }
    circuit.state = "closed";
    circuit.consecutiveFailures = 0;
    circuit.probeInFlight = false;
    circuit.currentOpenMs = baseOpenMs;
    circuit.openedAt = null;
  }
  function open(reopen) {
    circuit.currentOpenMs = reopen ? Math.min(maxOpenMs, circuit.currentOpenMs * 2) : baseOpenMs;
    circuit.state = "open";
    if (!reopen || !circuit.openedAt) circuit.openedAt = now();
    circuit.openUntil = now() + circuit.currentOpenMs;
    circuit.opens += 1;
    totals.circuit_opened += 1;
    if (!reopen) {
      log.error("DB_CIRCUIT_OPEN", `${name}: ${circuit.consecutiveFailures} consecutive connection failures (${circuit.lastError}) - failing fast for ${circuit.currentOpenMs} ms`, { pool: name, last_error: circuit.lastError });
    }
    // Nobody waits on a database we believe is down: fail every waiter now.
    for (const laneName of laneOrder) {
      const lane = lanes[laneName];
      const waiting = lane.waiting.splice(0);
      for (const w of waiting) {
        clearTimeout(w.timer);
        lane.totals.flushed_on_open += 1;
        w.cb(admissionError("DB_UNAVAILABLE", `${name}: database unavailable (${circuit.lastError}); try again shortly`));
      }
    }
  }
  /** "closed" | "open" | "half_open", advancing open -> half_open on time. */
  function circuitState() {
    if (circuit.state === "open" && now() >= circuit.openUntil) circuit.state = "half_open";
    return circuit.state;
  }

  // ------------------------------------------------------------ permits --

  function acquire(laneName, cb, label) {
    const lane = laneFor(laneName);
    if (closed) return process.nextTick(cb, admissionError("POOL_CLOSED", "Pool is closed."));
    const state = circuitState();
    if (state === "open" || (state === "half_open" && circuit.probeInFlight)) {
      lane.totals.refused_unavailable += 1;
      return process.nextTick(cb, admissionError("DB_UNAVAILABLE", `${name}: database unavailable (${circuit.lastError}); try again shortly`));
    }
    const asked = now();
    if (state === "half_open") {
      // The single probe. It bypasses the queue (nothing is queued while
      // open) but never the permit count: while attempts from before the
      // circuit opened still hold every permit, callers keep failing fast.
      if (active >= limit) {
        lane.totals.refused_unavailable += 1;
        return process.nextTick(cb, admissionError("DB_UNAVAILABLE", `${name}: database unavailable (${circuit.lastError}); try again shortly`));
      }
      circuit.probeInFlight = true;
      return grant(lane, cb, asked, label, true);
    }
    if (canGrant(lane) && !higherPriorityWaiting(lane)) return grant(lane, cb, asked, label);
    if (lane.waiting.length >= lane.maxWaiting) {
      lane.totals.refused_busy += 1;
      return process.nextTick(cb, admissionError("DB_BUSY", `${name}: too many requests waiting for a database connection (${lane.name}); try again shortly`));
    }
    const w = { cb, at: asked, label, timer: null };
    w.timer = setTimeout(() => {
      const i = lane.waiting.indexOf(w);
      if (i === -1) return;
      lane.waiting.splice(i, 1); // REMOVED: it never reached mysqljs
      lane.totals.timed_out += 1;
      cb(admissionError("DB_ACQUIRE_TIMEOUT", `${name}: no database connection within ${lane.waitTimeoutMs} ms (${lane.name})`));
    }, lane.waitTimeoutMs);
    if (typeof w.timer.unref === "function") w.timer.unref();
    lane.waiting.push(w);
  }

  /**
   * Permits `lane` may not take because another lane with waiters is below
   * its reservation (it holds fewer connections than it is guaranteed).
   */
  function reservedForOthers(lane) {
    let held = 0;
    for (const laneName of laneOrder) {
      const other = lanes[laneName];
      if (other === lane || !other.reserved || !other.waiting.length) continue;
      held += Math.max(0, other.reserved - other.active);
    }
    return held;
  }
  const canGrant = (lane) => active < limit - reservedForOthers(lane) && lane.active < lane.maxActive;
  function higherPriorityWaiting(lane) {
    for (const laneName of laneOrder) {
      const other = lanes[laneName];
      if (other === lane) return false;
      if (other.waiting.length && canGrant(other)) return true;
    }
    return false;
  }

  function grant(lane, cb, asked, label, isProbe) {
    active += 1;
    lane.active += 1;
    const waited = now() - asked;
    lane.totals.acquired += 1;
    lane.totals.wait_ms_sum += waited;
    if (waited > lane.totals.wait_ms_max) lane.totals.wait_ms_max = waited;
    noteRouteWait(label, waited);
    let permitReturned = false;
    const returnPermit = () => {
      if (permitReturned) return;
      permitReturned = true;
      active -= 1;
      lane.active -= 1;
      dispatch();
    };
    rawPool.getConnection((err, connection) => {
      if (err) {
        if (CONNECTION_FAILURE_CODES.has(err.code) || err.code === "POOL_CLOSED") {
          totals.connect_failures += 1;
          if (err.code !== "POOL_CLOSED") noteFailure(err, isProbe);
        } else if (isProbe) {
          circuit.probeInFlight = false; // not a health failure; let the next caller probe
        }
        returnPermit();
        cb(err);
        return;
      }
      noteSuccess(isProbe);
      cb(null, bindPermit(connection, returnPermit, lane));
    });
  }

  function dispatch() {
    for (;;) {
      if (circuitState() !== "closed") return;
      let next = null;
      for (const laneName of laneOrder) {
        const lane = lanes[laneName];
        if (lane.waiting.length && canGrant(lane)) {
          next = lane;
          break;
        }
      }
      if (!next) return;
      const w = next.waiting.shift();
      clearTimeout(w.timer);
      grant(next, w.cb, w.at, w.label);
    }
  }

  // -------------------------------------------------------- connections --

  /**
   * The connection handed to a caller returns its permit exactly once, on
   * release() or destroy() - whichever comes first - and its queries get the
   * default timeout. Patched per hand-out; the originals are kept on the
   * object the first time.
   */
  function bindPermit(connection, returnPermit, lane) {
    if (!connection.__admissionOriginal) {
      connection.__admissionOriginal = { release: connection.release, destroy: connection.destroy, query: connection.query };
      const original = connection.__admissionOriginal;
      connection.query = function patchedQuery(sql, values, cb) {
        const ms = connection.__queryTimeoutMs;
        if (typeof values === "function") return original.query.call(this, withDefaultTimeout(sql, ms), bindToCaller(values));
        return original.query.call(this, withDefaultTimeout(sql, ms), values, bindToCaller(cb));
      };
      connection.release = function patchedRelease() {
        const permit = connection.__permit;
        connection.__permit = null;
        const r = original.release.apply(this, arguments);
        if (permit) permit();
        return r;
      };
      connection.destroy = function patchedDestroy() {
        const permit = connection.__permit;
        connection.__permit = null;
        const r = original.destroy.apply(this, arguments);
        if (permit) permit();
        return r;
      };
    }
    connection.__permit = returnPermit;
    // The lane that checked it out decides the default statement timeout for
    // everything run on it until release - a transaction included.
    connection.__queryTimeoutMs = lane ? lane.queryTimeoutMs : 0;
    return connection;
  }

  function withDefaultTimeout(sql, ms) {
    if (!ms) return sql;
    if (typeof sql === "string") return { sql, timeout: ms };
    if (sql && typeof sql === "object" && sql.timeout === undefined && typeof sql.sql === "string" && !(sql.constructor && sql.constructor.name === "Query")) {
      return { ...sql, timeout: ms };
    }
    return sql;
  }

  // ------------------------------------------------------ route labels --

  function noteRouteWait(label, waited) {
    if (!label) return;
    let r = routeWait.get(label);
    if (!r) {
      if (routeWait.size >= 40) return; // low cardinality, by construction
      r = { count: 0, wait_ms_sum: 0, wait_ms_max: 0 };
      routeWait.set(label, r);
    }
    r.count += 1;
    r.wait_ms_sum += waited;
    if (waited > r.wait_ms_max) r.wait_ms_max = waited;
  }
  function labelFromContext(ctx) {
    if (!ctx) return null;
    if (ctx.label) return ctx.label;
    const req = ctx.req;
    if (req) return `${req.method} ${req.baseUrl || ""}${req.route && req.route.path ? req.route.path : ""}`.slice(0, 80);
    return null;
  }

  // ------------------------------------------------------- public API --

  function query(sql, values, cb) {
    if (typeof values === "function") {
      cb = values;
      values = undefined;
    }
    cb = bindToCaller(cb);
    const ctx = currentContext();
    acquire(ctx && ctx.lane ? ctx.lane : "interactive", (err, connection) => {
      if (err) {
        if (typeof cb === "function") cb(err);
        return;
      }
      connection.query(sql, values, function onQueryDone(qErr) {
        if (qErr && qErr.code === "PROTOCOL_SEQUENCE_TIMEOUT") {
          totals.query_timeouts += 1;
          noteFailure(qErr);
        }
        connection.release();
        if (typeof cb === "function") cb.apply(this, arguments);
      });
    }, labelFromContext(ctx));
    // mysqljs returns a Query; nothing in this codebase uses it (checked:
    // no .on()/.stream() on a pool.query result). Return nothing rather than
    // an object that would silently never emit.
    return undefined;
  }

  function getConnection(cb) {
    cb = bindToCaller(cb);
    const ctx = currentContext();
    acquire(ctx && ctx.lane ? ctx.lane : "interactive", cb, labelFromContext(ctx));
  }

  function end(cb) {
    closed = true;
    for (const laneName of laneOrder) {
      const lane = lanes[laneName];
      for (const w of lane.waiting.splice(0)) {
        clearTimeout(w.timer);
        w.cb(admissionError("POOL_CLOSED", "Pool is closed."));
      }
    }
    return rawPool.end(cb);
  }

  function stats() {
    const len = (a) => (Array.isArray(a) ? a.length : null);
    const laneStats = {};
    for (const laneName of laneOrder) {
      const l = lanes[laneName];
      laneStats[laneName] = {
        active: l.active,
        max_active: l.maxActive,
        waiting: l.waiting.length,
        max_waiting: l.maxWaiting,
        wait_timeout_ms: l.waitTimeoutMs,
        reserved: l.reserved,
        query_timeout_ms: l.queryTimeoutMs,
        ...l.totals,
        wait_ms_avg: l.totals.acquired ? Math.round(l.totals.wait_ms_sum / l.totals.acquired) : 0,
      };
    }
    const routes = {};
    routeWait.forEach((v, k) => {
      routes[k] = { count: v.count, wait_ms_avg: Math.round(v.wait_ms_sum / v.count), wait_ms_max: v.wait_ms_max };
    });
    return {
      name,
      connection_limit: limit,
      active,
      circuit: { state: circuitState(), consecutive_failures: circuit.consecutiveFailures, last_error: circuit.lastError, opens: circuit.opens, open_ms: circuit.state === "closed" ? 0 : circuit.currentOpenMs },
      lanes: laneStats,
      ...totals,
      mysql: {
        all: len(rawPool._allConnections),
        free: len(rawPool._freeConnections),
        acquiring: len(rawPool._acquiringConnections),
        queued: len(rawPool._connectionQueue),
        queue_limit: rawPool.config ? rawPool.config.queueLimit : null,
      },
      routes,
    };
  }

  const guarded = {
    query,
    getConnection,
    end,
    stats,
    /** True while callers are being failed fast (open or probing). */
    // True exactly when acquire() would refuse: OPEN, or HALF_OPEN with the
    // probe already out. HALF_OPEN with no probe out is NOT unavailable - the
    // next caller (a cron tick, when there is no HTTP traffic) must be let
    // through to BECOME the probe, or a quiet process would never close the
    // circuit and every gated cron would skip for ever.
    isUnavailable: () => {
      const state = circuitState();
      return state === "open" || (state === "half_open" && circuit.probeInFlight);
    },
    escape: (v) => rawPool.escape(v),
    escapeId: (v) => rawPool.escapeId(v),
    format: (sql, values) => (typeof rawPool.format === "function" ? rawPool.format(sql, values) : require("mysql").format(sql, values)),
    on: (...a) => (rawPool.on(...a), guarded),
    once: (...a) => (rawPool.once(...a), guarded),
    raw: rawPool,
  };
  // Read-only views for code that inspects mysqljs's pool (utils/attendance_read_timing.js).
  for (const k of ["config", "_allConnections", "_freeConnections", "_connectionQueue", "_acquiringConnections", "_closed"]) {
    Object.defineProperty(guarded, k, { get: () => rawPool[k], enumerable: false });
  }
  return guarded;
}

/**
 * Pool + guard settings from the environment, with the defaults this was
 * measured with. `DB_ADMISSION=off` is the rollback switch: the pool is then
 * created exactly as before this change (no extra mysqljs options, no guard).
 *
 *   DB_CONNECT_TIMEOUT_MS         3000   TCP connect, and handshake/ping (mysqljs acquireTimeout)
 *   DB_INTERACTIVE_QUERY_TIMEOUT_MS      120000 default statement timeout, HTTP (0 = none)
 *   DB_ATTENDANCE_READ_QUERY_TIMEOUT_MS  60000  ... My Attendance month reads
 *   DB_BACKGROUND_QUERY_TIMEOUT_MS       600000 ... cron work (batch statements are legitimate)
 *   DB_INTERACTIVE_MAX_WAITING    500    HTTP callers allowed to wait
 *   DB_INTERACTIVE_WAIT_MS        5000   ... and for how long
 *   DB_ATTENDANCE_READ_MAX_ACTIVE 5      connections My Attendance month reads may hold at once
 *   DB_ATTENDANCE_READ_MAX_WAITING 500
 *   DB_ATTENDANCE_READ_WAIT_MS    5000
 *   DB_BACKGROUND_MAX_ACTIVE      4      connections cron work may hold at once
 *   DB_BACKGROUND_MAX_WAITING     100
 *   DB_BACKGROUND_WAIT_MS         60000
 *   DB_CIRCUIT_FAILURES           3      consecutive connection failures that open the circuit
 *   DB_CIRCUIT_OPEN_MS            5000   first open period (doubles on each failed probe ...)
 *   DB_CIRCUIT_MAX_OPEN_MS        10000  ... up to this: the longest a recovered database can
 *                                        wait for its probe (one handshake per period)
 */
function poolOptionsFromEnv(env = process.env) {
  const int = (k, d) => {
    const v = env[k];
    if (v === undefined || String(v).trim() === "") return d;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const enabled = !/^(off|false|0|no)$/i.test(String(env.DB_ADMISSION === undefined ? "" : env.DB_ADMISSION).trim());
  if (!enabled) return { enabled: false, mysql: {}, guard: null };
  const connectMs = int("DB_CONNECT_TIMEOUT_MS", 3000);
  return {
    enabled: true,
    mysql: { acquireTimeout: connectMs, connectTimeout: connectMs, queueLimit: 10 },
    guard: {
      failureThreshold: int("DB_CIRCUIT_FAILURES", 3),
      openMs: int("DB_CIRCUIT_OPEN_MS", 5000),
      maxOpenMs: int("DB_CIRCUIT_MAX_OPEN_MS", 10000),
      lanes: {
        interactive: {
          maxWaiting: int("DB_INTERACTIVE_MAX_WAITING", 500),
          waitTimeoutMs: int("DB_INTERACTIVE_WAIT_MS", 5000),
          queryTimeoutMs: int("DB_INTERACTIVE_QUERY_TIMEOUT_MS", 120000),
        },
        attendance_read: {
          maxActive: int("DB_ATTENDANCE_READ_MAX_ACTIVE", 5),
          maxWaiting: int("DB_ATTENDANCE_READ_MAX_WAITING", 500),
          waitTimeoutMs: int("DB_ATTENDANCE_READ_WAIT_MS", 5000),
          queryTimeoutMs: int("DB_ATTENDANCE_READ_QUERY_TIMEOUT_MS", 60000),
        },
        background: {
          maxActive: int("DB_BACKGROUND_MAX_ACTIVE", 4),
          maxWaiting: int("DB_BACKGROUND_MAX_WAITING", 100),
          waitTimeoutMs: int("DB_BACKGROUND_WAIT_MS", 60000),
          queryTimeoutMs: int("DB_BACKGROUND_QUERY_TIMEOUT_MS", 600000),
        },
      },
    },
  };
}

module.exports = { guardPool, runInLane, inLane, currentContext, poolOptionsFromEnv, LANE_DEFAULTS, CONNECTION_FAILURE_CODES };
