/**
 * Does the REAL server.js exit after an uncaught exception, and after SIGTERM?
 *
 *   NODE_BIN=... node test_support/api_db_stress/zombie.js
 *
 * Boots the server (crons off), waits until it answers, then either
 *   fatal:   a preload throws an uncaught exception 2 s after boot, or
 *   sigterm: the harness sends SIGTERM (what pm2 stop/reload sends first)
 * and reports, over the next 15 s: is the process still alive, does the
 * port still accept connections, what did it exit with and how fast.
 * "alive but not listening" is the zombie pm2 shows as `online`.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const nodeBin = process.env.NODE_BIN || process.execPath;
const PRELOAD = `${require("os").tmpdir()}/throw-after-boot.js`;
fs.writeFileSync(PRELOAD, "setTimeout(() => { throw new Error('ZOMBIE-TEST: uncaught exception after boot'); }, Number(process.env.THROW_AFTER_MS || 8000));\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const http = require("http");
const CTL_PORT = Number(process.env.CTL_PORT || 13399);
const ctl = (p) => new Promise((r) => http.get({ host: "127.0.0.1", port: CTL_PORT, path: p }, (x) => { x.resume(); x.on("end", r); }).on("error", r));
const portOpen = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
};

async function scenario(kind, port) {
  const args = kind === "sigterm" ? ["server.js"] : ["-r", PRELOAD, "server.js"];
  // ZOMBIE_CRON=1: crons scheduled as in production (their timers are what
  // can keep a half-closed process alive).
  const env = { ...process.env, PORT: String(port), THROW_AFTER_MS: "8000", DIGISME_ATTENDANCE_CRON_ENABLED: "false" };
  if (process.env.ZOMBIE_CRON === "1") delete env.CRON_DISABLED;
  else env.CRON_DISABLED = "true";
  const child = spawn(nodeBin, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  let exit = null;
  child.on("exit", (code, signal) => (exit = { code, signal, at: Date.now() }));
  for (let i = 0; i < 60 && !(await portOpen(port)); i += 1) await sleep(250);
  const listeningAtBoot = await portOpen(port);
  let t0;
  if (kind === "sigterm") {
    t0 = Date.now();
    child.kill("SIGTERM");
  } else if (kind === "fatal_db_stuck") {
    // The production shape: the database goes silent with a request's query
    // in flight, then something throws. mysqljs's pool.end() waits for that
    // query - which, with no query timeout, never finishes.
    const token = await require("./mintToken")(50001);
    await ctl("/mode/freeze");
    http.get({ host: "127.0.0.1", port, path: "/telegram/attendance/month?month=2026-09", headers: { "x-telegram-session": token } }, (r) => r.resume()).on("error", () => {});
    for (let i = 0; i < 100 && !/ZOMBIE-TEST/.test(out); i += 1) await sleep(100);
    t0 = Date.now();
  } else {
    // wait for the throw
    for (let i = 0; i < 100 && !/ZOMBIE-TEST/.test(out); i += 1) await sleep(100);
    t0 = Date.now();
  }
  const samples = [];
  for (let s = 0; s < 20; s += 1) {
    await sleep(1000);
    samples.push({ t: s + 1, process_alive: alive(child.pid) && !exit, port_accepting: await portOpen(port) });
    if (exit) break;
  }
  if (!exit) child.kill("SIGKILL");
  await ctl("/mode/pass");
  await sleep(200);
  const exitLogs = (out.match(/"code":"SERVER\.EXIT[A-Z_]*"/g) || []).length;
  return {
    kind,
    listening_at_boot: listeningAtBoot,
    exited: !!exit && exit.code !== null,
    exit_code: exit ? exit.code : null,
    exit_signal: exit ? exit.signal : null,
    exit_after_ms: exit ? exit.at - t0 : null,
    zombie: samples.some((s) => s.process_alive && !s.port_accepting),
    samples: samples.slice(0, 6),
    server_exit_log_lines: exitLogs,
    // level + code of each exit log line: a deploy's SIGTERM must not log as a crash.
    server_exit_logs: (out.match(/[^\n]*"code":"SERVER\.EXIT[A-Z_]*"[^\n]*/g) || []).map((l) => {
      try {
        const j = JSON.parse(l);
        return { level: j.level, code: j.code, ref: j.ref };
      } catch (e) {
        return l.slice(0, 200);
      }
    }),
  };
}

(async () => {
  const results = [];
  results.push(await scenario("fatal", 18091));
  results.push(await scenario("sigterm", 18092));
  results.push(await scenario("fatal_db_stuck", 18093));
  const outFile = process.env.OUT || `${require("os").tmpdir()}/zombie.json`;
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
  console.log(JSON.stringify(results.map((r) => ({ kind: r.kind, zombie: r.zombie, exited: r.exited, exit_code: r.exit_code, exit_signal: r.exit_signal, exit_after_ms: r.exit_after_ms, log_lines: r.server_exit_log_lines, logs: r.server_exit_logs }))));
  process.exit(0);
})();
