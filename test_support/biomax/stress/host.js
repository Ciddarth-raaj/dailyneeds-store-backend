/**
 * Child process for the stress harness: runs ONE receiver implementation
 * against a real MySQL/MariaDB and reports its own memory and pool state to
 * the parent once a second over IPC. Never run against production.
 *
 *   IMPL_DIR   repository root whose biomax/ is loaded (lets the same
 *              harness drive the old and the new code)
 *   DB_HOST DB_PORT DB_USER DB_PASS DB_NAME
 *   PORT       0 = any
 *
 * Log lines are counted, not printed: stdout of a flood would otherwise be
 * the thing under test. HOUSEKEEPING_FAILED and "Pool is closed" lines are
 * counted separately so shutdown behaviour can be asserted on.
 */
const path = require("path");

const impl = path.resolve(process.env.IMPL_DIR || path.join(__dirname, "..", "..", ".."));
const receiverMod = require(path.join(impl, "biomax", "receiver.js"));
const storeMod = require(path.join(impl, "biomax", "store.js"));

const dbConfig = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  username: process.env.DB_USER || "bm",
  password: process.env.DB_PASS || "bm",
  database: process.env.DB_NAME || "biomax_test",
};

const counts = { byOutcome: {}, errors: {}, poolClosedLines: 0, housekeepingFailed: 0, maxDurationByOutcome: {} };
function note(fields) {
  const o = String(fields.outcome || "?");
  counts.byOutcome[o] = (counts.byOutcome[o] || 0) + 1;
  if (typeof fields.duration_ms === "number") {
    counts.maxDurationByOutcome[o] = Math.max(counts.maxDurationByOutcome[o] || 0, fields.duration_ms);
  }
}
function noteError(code, description) {
  counts.errors[code] = (counts.errors[code] || 0) + 1;
  if (/HOUSEKEEPING_FAILED/.test(code)) counts.housekeepingFailed += 1;
  if (/Pool is closed/i.test(String(description))) counts.poolClosedLines += 1;
}
const log = {
  request: note,
  error: (code, description) => noteError(code, description),
  info: () => {},
};

async function main() {
  let runtime;
  if (typeof receiverMod.createRuntime === "function") {
    // New wiring: the same function main() uses in production.
    runtime = receiverMod.createRuntime({ dbConfig, log, env: { ...process.env, BIOMAX_SPOOL_DIR: process.env.BIOMAX_SPOOL_DIR } });
  } else {
    // Original wiring (a2a50d7): one pool, one store, one receiver.
    const pool = storeMod.createPool(dbConfig);
    const store = storeMod.createStore(pool);
    const receiver = receiverMod.createReceiver({ store, log, config: { spoolDir: process.env.BIOMAX_SPOOL_DIR } });
    runtime = {
      pool,
      receiver,
      stats: () => ({}),
      async stop() {
        await receiver.close();
        await store.close();
      },
    };
  }
  const address = await runtime.receiver.listen(Number(process.env.PORT || 0), "127.0.0.1");

  const pool = runtime.pool;
  const report = () => {
    const m = process.memoryUsage();
    process.send({
      type: "stats",
      t: Date.now(),
      heapUsed: m.heapUsed,
      rss: m.rss,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
      poolQueue: pool && pool._connectionQueue ? pool._connectionQueue.length : null,
      poolAll: pool && pool._allConnections ? pool._allConnections.length : null,
      runtime: runtime.stats ? runtime.stats() : null,
      counts,
    });
  };
  const timer = setInterval(report, 1000);
  process.send({ type: "listening", port: address.port });

  process.on("message", async (msg) => {
    if (msg && msg.type === "stop") {
      const t0 = Date.now();
      clearInterval(timer);
      report();
      const hard = setTimeout(() => {
        process.send({ type: "stopped", ms: Date.now() - t0, hard: true, counts });
        process.exit(0);
      }, 6000);
      await runtime.stop();
      // Give any stray post-close work a chance to show itself in the counts.
      await new Promise((r) => setTimeout(r, 1500));
      clearTimeout(hard);
      process.send({ type: "stopped", ms: Date.now() - t0, hard: false, counts });
      process.exit(0);
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
