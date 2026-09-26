/**
 * TCP fault injector between the API's mysql pool and a real MySQL/MariaDB.
 * Test harness only - never pointed at a production database.
 *
 *   node faultProxy.js <listenPort> <dbHost> <dbPort> <controlPort>
 *
 * Switch the fault at runtime (so an outage can start and END mid-run):
 *
 *   curl -s localhost:<controlPort>/mode/pass
 *   curl -s localhost:<controlPort>/mode/slow?ms=3000     every DB->client chunk delayed
 *   curl -s localhost:<controlPort>/mode/handshake_hang    TCP accepted, nothing ever sent back
 *                                                          (mysqljs: "Handshake inactivity timeout")
 *   curl -s localhost:<controlPort>/mode/refuse            listener closed -> ECONNREFUSED
 *   curl -s localhost:<controlPort>/mode/freeze            existing connections stop passing
 *                                                          bytes (a silent peer - no RST, no FIN)
 *   curl -s localhost:<controlPort>/kill                   RST every existing connection
 *   curl -s localhost:<controlPort>/stats                  JSON counters
 *
 * EHOSTUNREACH is produced for real by pointing the pool at an address with
 * an `ip route add unreachable ...` route (see run scripts), not here.
 */
const net = require("net");
const http = require("http");

const [listenPort, dbHost, dbPort, controlPort] = process.argv.slice(2);
let mode = "pass";
let slowMs = 0;
const conns = new Set(); // {client, upstream}
const stats = { accepted: 0, accepted_by_mode: {}, open: 0, killed: 0, bytes_up: 0, bytes_down: 0 };

let server = null;
function listen() {
  if (server) return;
  server = net.createServer(onClient);
  server.on("error", (e) => console.error("proxy listen error", e.code));
  server.listen(Number(listenPort), "0.0.0.0");
}
function unlisten() {
  if (!server) return;
  server.close();
  server = null;
}

function onClient(client) {
  stats.accepted += 1;
  stats.accepted_by_mode[mode] = (stats.accepted_by_mode[mode] || 0) + 1;
  const c = { client, upstream: null, frozen: false };
  conns.add(c);
  stats.open = conns.size;
  const drop = () => {
    if (!conns.has(c)) return;
    conns.delete(c);
    stats.open = conns.size;
    client.destroy();
    if (c.upstream) c.upstream.destroy();
  };
  client.on("error", drop);
  client.on("close", drop);
  if (mode === "handshake_hang") return; // accept and say nothing, ever

  const up = net.connect(Number(dbPort), dbHost);
  c.upstream = up;
  up.on("error", drop);
  up.on("close", drop);
  client.on("data", (d) => {
    if (c.frozen || mode === "freeze") return (c.frozen = true);
    stats.bytes_up += d.length;
    up.write(d);
  });
  up.on("data", (d) => {
    if (c.frozen || mode === "freeze") return (c.frozen = true);
    stats.bytes_down += d.length;
    if (mode === "slow" && slowMs > 0) setTimeout(() => client.writable && client.write(d), slowMs);
    else client.write(d);
  });
}

listen();

http
  .createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const m = /^\/mode\/(\w+)$/.exec(u.pathname);
    if (m) {
      mode = m[1];
      slowMs = Number(u.searchParams.get("ms") || 0);
      if (mode === "refuse") unlisten();
      else listen();
      if (mode === "pass") conns.forEach((c) => (c.frozen = false));
    } else if (u.pathname === "/kill") {
      conns.forEach((c) => {
        stats.killed += 1;
        try {
          c.client.resetAndDestroy ? c.client.resetAndDestroy() : c.client.destroy();
        } catch (e) {
          c.client.destroy();
        }
        if (c.upstream) c.upstream.destroy();
      });
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ mode, slowMs, ...stats }));
  })
  .listen(Number(controlPort), "127.0.0.1");
