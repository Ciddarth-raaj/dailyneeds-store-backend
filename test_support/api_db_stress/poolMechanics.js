/**
 * The mysqljs pool, isolated: what happens to waiters under each fault.
 *
 *   node test_support/api_db_stress/poolMechanics.js <mode> [seconds] [rate]
 *
 * Uses the REAL drivers/mysql.js (same createPool options production uses),
 * pointed by config.json at the fault proxy (control port 13399). Issues
 * `rate` pool.query("SELECT 1") per second - each holding a 4 KB payload in
 * its closure, a stand-in for the request state a real handler keeps alive -
 * for `seconds`, with the fault applied AFTER the pool is warm. Prints one
 * line a second: waiters in _connectionQueue, connections, heap, callbacks
 * still pending, and how the finished ones ended.
 *
 * modes: pass | slow | handshake_hang | refuse | freeze | unreachable
 * ("unreachable" repoints the pool at 198.51.100.7, which needs
 *  `ip route add unreachable 198.51.100.7/32` - a real EHOSTUNREACH)
 */
global.env = "development";
global.isDev = () => true;
const http = require("http");

const [mode = "handshake_hang", seconds = "60", rate = "20"] = process.argv.slice(2);
const ctl = (path) =>
  new Promise((resolve) => http.get({ host: "127.0.0.1", port: 13399, path }, (r) => { r.resume(); r.on("end", resolve); }).on("error", resolve));

(async () => {
  await ctl("/mode/pass");
  const db = await require("../../drivers/mysql")().connect();
  const pool = db.connection;
  // mode "unreachable": the run scripts drop the 198.51.100.7 alias and add an
  // `unreachable` route for it (config.json names the DB by that address).
  await new Promise((r) => pool.query("SELECT 1", r)); // warm one connection

  if (mode === "slow") await ctl("/mode/slow?ms=3000");
  else if (mode === "handshake_hang" || mode === "refuse" || mode === "freeze") await ctl(`/mode/${mode}`);
  if (mode === "handshake_hang" || mode === "refuse" || mode === "unreachable") await ctl("/kill");

  let pending = 0;
  const ended = {};
  const retained = new Set();
  const t0 = Date.now();
  const issue = setInterval(() => {
    for (let i = 0; i < Number(rate) / 10; i += 1) {
      const state = { payload: Buffer.alloc(4096, 1), at: Date.now() }; // what a handler holds
      retained.add(state);
      pending += 1;
      pool.query("SELECT 1", (err) => {
        pending -= 1;
        retained.delete(state);
        const k = err ? err.code || err.message.slice(0, 40) : "ok";
        ended[k] = (ended[k] || 0) + 1;
      });
    }
  }, 100);
  const report = setInterval(() => {
    const m = process.memoryUsage();
    console.log(JSON.stringify({
      t: Math.round((Date.now() - t0) / 1000),
      queued: pool._connectionQueue.length,
      all: pool._allConnections.length,
      free: pool._freeConnections.length,
      acquiring: pool._acquiringConnections.length,
      guard_waiting: typeof pool.stats === "function" ? pool.stats().lanes.interactive.waiting : undefined,
      circuit: typeof pool.stats === "function" ? pool.stats().circuit.state : undefined,
      pending_callbacks: pending,
      heap_mb: Math.round(m.heapUsed / 104857.6) / 10,
      ended,
    }));
  }, 1000);
  setTimeout(async () => {
    clearInterval(issue);
    console.log("--- stop issuing; DB restored (mode pass) - watch the backlog drain");
    await ctl("/mode/pass");
    setTimeout(() => {
      clearInterval(report);
      console.log(JSON.stringify({ final_pending: pending, ended }));
      process.exit(0);
    }, 40000);
  }, Number(seconds) * 1000);
})();
