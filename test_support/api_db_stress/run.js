/**
 * API DB-outage stress run: the REAL server.js, a fault proxy in front of a
 * real MariaDB, open-loop client load, and a per-second probe inside the
 * server. Test harness only - it points config.json at 127.0.0.1:13306.
 *
 *   SCENARIO=handshake_hang OUTAGE_S=300 node test_support/api_db_stress/run.js
 *
 * Env:
 *   NODE_BIN        interpreter for the SERVER (e.g. Node 14.21.3), default this one
 *   SCENARIO        pass | slow | handshake_hang | refuse | unreachable | freeze
 *   WARM_S          healthy period before the fault          (default 30)
 *   OUTAGE_S        fault duration                           (default 180)
 *   RECOVER_S       healthy period after, load continues     (default 90)
 *   DRAIN_S         load stopped, watch the server settle    (default 60)
 *   MONTH_RPS       /telegram/attendance/month per second    (default 8)
 *   ORDINARY_RPS    /designation/permissions per second      (default 4)
 *   CLIENT_TIMEOUT_MS client gives up and closes the socket  (default 30000)
 *   SLOW_MS         for SCENARIO=slow                        (default 2000)
 *   HEAP_MB         --max-old-space-size for the server      (default unset)
 *   CRON            1 = crons run as in production           (default 1)
 *   OUT             summary JSON path
 *
 * Needs: MariaDB with the migrated schema + test_support/api_db_stress/seed.sql,
 * faultProxy.js on 0.0.0.0:13306 -> 3306 with control port 13399, config.json
 * naming the DB as 198.51.100.7:13306 and `ip addr add 198.51.100.7/32 dev lo`
 * (root; see README.md in this directory).
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { mintMonth, mintLogin } = (() => {
  const m = require("./mintToken");
  return { mintMonth: m, mintLogin: m.login };
})();

const env = process.env;
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));
const C = {
  nodeBin: env.NODE_BIN || process.execPath,
  scenario: env.SCENARIO || "handshake_hang",
  warmS: num("WARM_S", 30),
  outageS: num("OUTAGE_S", 180),
  recoverS: num("RECOVER_S", 90),
  drainS: num("DRAIN_S", 60),
  monthRps: num("MONTH_RPS", 8),
  ordinaryRps: num("ORDINARY_RPS", 4),
  clientTimeoutMs: num("CLIENT_TIMEOUT_MS", 30000),
  slowMs: num("SLOW_MS", 2000),
  heapMb: env.HEAP_MB ? Number(env.HEAP_MB) : null,
  cron: env.CRON === undefined ? true : env.CRON === "1",
  port: num("API_PORT", 18080),
  out: env.OUT || `/tmp/claude-0/api-stress-${env.SCENARIO || "handshake_hang"}.json`,
};
const ROOT = path.join(__dirname, "..", "..");
const PROBE = `/tmp/claude-0/probe-${process.pid}.jsonl`;

const ctl = (p) =>
  new Promise((resolve) => http.get({ host: "127.0.0.1", port: 13399, path: p }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => resolve(b)); }).on("error", () => resolve(null)));

function get(pathname, headers) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve({ ms: Date.now() - t0, ...r });
    };
    const req = http.get({ host: "127.0.0.1", port: C.port, path: pathname, headers, agent: false }, (res) => {
      res.resume();
      res.on("end", () => done({ status: res.statusCode }));
      res.on("error", () => done({ status: "reset" }));
    });
    req.setTimeout(C.clientTimeoutMs, () => {
      req.destroy();
      done({ status: "client_timeout" });
    });
    req.on("error", (e) => done({ status: e.code || "error" }));
  });
}

/**
 * A REAL EHOSTUNREACH. config.json names the DB as 198.51.100.7, a loopback
 * alias the proxy listens on. For the outage the alias is removed and an
 * `unreachable` route installed: new connects fail with EHOSTUNREACH exactly
 * as they do when the DB host drops off the network; established sockets
 * are also RST (the proxy is told to kill them).
 */
const { execSync } = require("child_process");
function netUnreachable(on) {
  const sh = (c) => { try { execSync(c, { stdio: "ignore" }); } catch (e) { /* already in that state */ } };
  if (on) {
    sh("ip addr del 198.51.100.7/32 dev lo");
    sh("ip route add unreachable 198.51.100.7/32");
  } else {
    sh("ip route del unreachable 198.51.100.7/32");
    sh("ip addr add 198.51.100.7/32 dev lo");
  }
}

const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function main() {
  await ctl("/mode/pass");
  const monthTokens = await Promise.all(Array.from({ length: 300 }, (_, i) => mintMonth(50001 + i)));
  const loginTokens = await Promise.all(Array.from({ length: 50 }, (_, i) => mintLogin(60001 + i, 50001 + i)));

  const args = [];
  if (C.heapMb) args.push(`--max-old-space-size=${C.heapMb}`);
  args.push("-r", "./test_support/api_db_stress/probe.js", "server.js");
  const srvEnv = { ...env, PORT: String(C.port), PROBE_OUT: PROBE, DIGISME_ATTENDANCE_CRON_ENABLED: "false" };
  delete srvEnv.TELEGRAM_BOT_TOKEN;
  if (!C.cron) srvEnv.CRON_DISABLED = "true";
  else delete srvEnv.CRON_DISABLED;
  let T0 = Date.now();
  const srv = spawn(C.nodeBin, args, { cwd: ROOT, env: srvEnv, stdio: ["ignore", "pipe", "pipe"] });
  let srvLog = "";
  let srvExit = null;
  const keep = (d) => {
    srvLog += d;
    if (srvLog.length > 400000) srvLog = srvLog.slice(-200000);
  };
  srv.stdout.on("data", keep);
  srv.stderr.on("data", keep);
  srv.on("exit", (code, sig) => (srvExit = { code, sig, at_s: Math.round((Date.now() - T0) / 1000) }));
  for (let i = 0; i < 60; i += 1) {
    const r = await get("/", {});
    if (r.status && typeof r.status === "number") break;
    await new Promise((r2) => setTimeout(r2, 500));
  }

  T0 = Date.now();
  const phaseAt = (s) => T0 + s * 1000;
  const tOutage = phaseAt(C.warmS);
  const tRecover = phaseAt(C.warmS + C.outageS);
  const tStopLoad = phaseAt(C.warmS + C.outageS + C.recoverS);
  const tEnd = phaseAt(C.warmS + C.outageS + C.recoverS + C.drainS);

  const results = []; // {kind, sent_s, phase, ms, status}
  const phaseOf = (t) => (t < tOutage ? "warm" : t < tRecover ? "outage" : "recover");
  let inflight = 0;
  let seq = 0;
  const fire = (kind) => {
    const sent = Date.now();
    const i = seq++;
    let p;
    if (kind === "month") {
      const month = i % 2 ? "2026-08" : "2026-09";
      p = get(`/telegram/attendance/month?month=${month}`, { "x-telegram-session": monthTokens[i % 300] });
    } else {
      p = get("/designation/permissions", { "x-access-token": loginTokens[i % 50] });
    }
    inflight += 1;
    p.then((r) => {
      inflight -= 1;
      results.push({ kind, sent_s: (sent - T0) / 1000, phase: phaseOf(sent), ...r });
    });
  };
  // Open loop, 20 ticks a second, fractional rates carried over.
  let accM = 0;
  let accO = 0;
  const loadTimer = setInterval(() => {
    if (Date.now() >= tStopLoad) return;
    accM += C.monthRps / 20;
    accO += C.ordinaryRps / 20;
    while (accM >= 1) { fire("month"); accM -= 1; }
    while (accO >= 1) { fire("ordinary"); accO -= 1; }
  }, 50);

  // Fault schedule.
  let faultApplied = false;
  let recovered = false;
  const faultTimer = setInterval(async () => {
    const now = Date.now();
    if (!faultApplied && now >= tOutage) {
      faultApplied = true;
      const s = C.scenario;
      if (s === "slow") await ctl(`/mode/slow?ms=${C.slowMs}`);
      else if (s === "unreachable") netUnreachable(true);
      else if (s !== "pass") await ctl(`/mode/${s}`);
      // A real outage also breaks the connections the pool already holds.
      if (s === "handshake_hang" || s === "refuse" || s === "unreachable") await ctl("/kill");
    }
    if (!recovered && now >= tRecover) {
      recovered = true;
      if (C.scenario === "unreachable") netUnreachable(false);
      await ctl("/mode/pass");
    }
  }, 200);

  // Proxy connection count once a second.
  const proxySeries = [];
  const proxyTimer = setInterval(async () => {
    const s = await ctl("/stats");
    if (s) {
      const j = JSON.parse(s);
      proxySeries.push({ t: Math.round((Date.now() - T0) / 1000), open: j.open, accepted: j.accepted });
    }
  }, 1000);

  while (Date.now() < tEnd && !srvExit) await new Promise((r) => setTimeout(r, 500));
  clearInterval(loadTimer);
  clearInterval(faultTimer);
  clearInterval(proxyTimer);
  await ctl("/mode/pass");
  // Anything still outstanding at the client has already passed CLIENT_TIMEOUT_MS or is about to.
  const tWait = Date.now();
  while (inflight > 0 && Date.now() - tWait < C.clientTimeoutMs + 2000) await new Promise((r) => setTimeout(r, 200));

  // Server-side view.
  const probe = fs.existsSync(PROBE)
    ? fs.readFileSync(PROBE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const lastProbe = probe[probe.length - 1] || null;
  if (!srvExit) srv.kill("SIGKILL");

  // Per-phase stats.
  const phases = {};
  for (const ph of ["warm", "outage", "recover"]) {
    for (const kind of ["month", "ordinary"]) {
      const rs = results.filter((r) => r.phase === ph && r.kind === kind);
      const ok = rs.filter((r) => r.status === 200);
      const codes = {};
      rs.forEach((r) => (codes[r.status] = (codes[r.status] || 0) + 1));
      phases[`${ph}.${kind}`] = {
        sent: rs.length,
        ok: ok.length,
        codes,
        p50_ms: pct(rs.map((r) => r.ms), 50),
        p95_ms: pct(rs.map((r) => r.ms), 95),
        p99_ms: pct(rs.map((r) => r.ms), 99),
        max_ms: rs.length ? Math.max(...rs.map((r) => r.ms)) : null,
      };
    }
  }
  const mainPool = (p) => (p.pools || []).find((x) => x.name === "dnds_api_test") || {};
  const every = (n) => probe.filter((_, i) => i % n === 0);
  const summary = {
    config: C,
    server_exit: srvExit,
    server_fatal: /heap out of memory|Ineffective mark-compacts|FATAL ERROR/.test(srvLog)
      ? srvLog.slice(Math.max(0, srvLog.search(/FATAL|heap out of memory|<--- Last few GCs/) - 200)).slice(0, 1500)
      : null,
    phases,
    timeline_every_10s: every(10).map((p) => ({
      t: p.t,
      queued: mainPool(p).queued,
      all: mainPool(p).all,
      acquiring: mainPool(p).acquiring,
      heap_mb: p.heap_used_mb,
      rss_mb: p.rss_mb,
      eld_p99_ms: p.eld_p99_ms,
      eld_max_ms: p.eld_max_ms,
      http_in_flight: p.http.in_flight,
      http_aborted: p.http.aborted,
      handles: p.handles,
      guard: (p.guard || []).find((g) => g.name === "main") || undefined,
    })),
    peaks: {
      queued: Math.max(0, ...probe.map((p) => mainPool(p).queued || 0)),
      guard_waiting: Math.max(0, ...probe.map((p) => { const g = (p.guard || []).find((x) => x.name === "main"); return g ? g.interactive_waiting + g.background_waiting : 0; })),
      heap_mb: Math.max(0, ...probe.map((p) => p.heap_used_mb)),
      rss_mb: Math.max(0, ...probe.map((p) => p.rss_mb)),
      eld_max_ms: Math.max(0, ...probe.map((p) => p.eld_max_ms)),
      http_in_flight: Math.max(0, ...probe.map((p) => p.http.in_flight)),
      db_tcp_open: Math.max(0, ...proxySeries.map((p) => p.open)),
    },
    end_state: lastProbe && {
      t: lastProbe.t,
      queued: mainPool(lastProbe).queued,
      heap_mb: lastProbe.heap_used_mb,
      rss_mb: lastProbe.rss_mb,
      http_in_flight_server: lastProbe.http.in_flight,
      http_aborted_total: lastProbe.http.aborted,
      pools: lastProbe.pools,
    },
    client_outstanding_at_end: inflight,
    db_tcp_series_every_10s: proxySeries.filter((_, i) => i % 10 === 0),
  };
  fs.writeFileSync(C.out, JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ out: C.out, server_exit: srvExit, peaks: summary.peaks, end_state: summary.end_state && { queued: summary.end_state.queued, heap_mb: summary.end_state.heap_mb, http_in_flight_server: summary.end_state.http_in_flight_server } }));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
