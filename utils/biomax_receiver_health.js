/**
 * The Attendance API's view of the Biomax receiver's own /healthz.
 *
 * WHY THE API AND NOT THE BROWSER. The receiver listens on BIOMAX_PORT
 * (7005) directly, not behind nginx, and that port is for the terminals. A
 * browser must never be pointed at it: it is unauthenticated, it is on the
 * private host, and asking a user's machine to reach it would either fail
 * or open a port that should stay shut. So the API - which is already on
 * the same host as the receiver - probes 127.0.0.1 and hands the screen a
 * small, authenticated answer.
 *
 * WHAT IS PASSED ON, AND WHAT IS NOT. Only {status, ok, db,
 * last_punch_received}. The host, the port, the receiver's Node version and
 * any error text from the socket stay here: a health widget does not need
 * the internal topology, and an error string is exactly where a hostname
 * leaks. The reason is reduced to a short, fixed word.
 *
 * A FAILED PROBE IS NOT A VERDICT ON THE TERMINALS. If the probe times out,
 * the answer is UNAVAILABLE and nothing else changes: each device keeps the
 * connection status its own last_seen_at earns. The receiver being
 * unreachable from this process for 800ms says nothing about whether DN1 in
 * Vallalar Salai was polling a minute ago.
 */

const http = require("http");

const RECEIVER = {
  ONLINE: "ONLINE",
  DEGRADED: "DEGRADED",
  UNAVAILABLE: "UNAVAILABLE",
};

const DEFAULT_TIMEOUT_MS = 800;

function positiveInt(value, fallback) {
  const n = Number(String(value === undefined || value === null ? "" : value).trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** GET http://127.0.0.1:<port>/healthz, resolving to the parsed body or throwing. */
function defaultProbe({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: "/healthz", timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        // A health body is tiny; refuse to buffer anything that is not.
        if (body.length < 8192) body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (err) {
          reject(new Error("unreadable"));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => reject(err));
  });
}

/**
 * @returns {Promise<{status, ok, db, last_punch_received, reason?}>}
 *          Never rejects: an unreachable receiver is an answer, not an error.
 */
async function checkReceiverHealth(options = {}) {
  const env = options.env || process.env;
  const probe = options.probe || defaultProbe;
  const target = {
    host: env.BIOMAX_HEALTH_HOST || "127.0.0.1",
    port: positiveInt(env.BIOMAX_PORT, 7005),
    timeoutMs: positiveInt(env.BIOMAX_HEALTH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
  try {
    const result = await probe(target);
    const body = (result && result.body) || {};
    const db = body.db === true;
    const ok = body.ok === true && result.statusCode === 200;
    return {
      status: ok && db ? RECEIVER.ONLINE : RECEIVER.DEGRADED,
      ok,
      db,
      last_punch_received: body.last_punch_received || null,
    };
  } catch (err) {
    return {
      status: RECEIVER.UNAVAILABLE,
      ok: false,
      db: false,
      last_punch_received: null,
      // Fixed vocabulary only - never err.message, which carries the address.
      reason: err && err.message === "timeout" ? "timeout" : "unreachable",
    };
  }
}

module.exports = { RECEIVER, DEFAULT_TIMEOUT_MS, checkReceiverHealth, defaultProbe };
