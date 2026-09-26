/**
 * The attendance recalculation worker across a DB outage, on the REAL
 * server.js with its real per-minute cron.
 *
 *   NODE_BIN=... SCENARIO=handshake_hang node test_support/api_db_stress/recalcOutage.js
 *
 * 1. queue a WORK_SHIFT_SAVE run for the 300-employee stress shift (9001)
 * 2. start the server (crons on) and wait for the worker to claim it
 * 3. OUTAGE_S of fault while the run is in flight, then RECOVER_S healthy
 * 4. every 5 s record: the run row (read DIRECTLY from MariaDB, not through
 *    the fault), the API pool's queue, heap, and the cron's own log lines
 *
 * Answers: does a failed tick leave a growing chain of pending work, is the
 * run left RUNNING, does the cron hammer the pool every minute during a known
 * outage, and does the run finish after recovery. Test harness only.
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const mysql = require("mysql");

const env = process.env;
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));
const C = {
  nodeBin: env.NODE_BIN || process.execPath,
  scenario: env.SCENARIO || "handshake_hang",
  outageS: num("OUTAGE_S", 180),
  recoverS: num("RECOVER_S", 240),
  port: num("API_PORT", 18081),
  out: env.OUT || "/tmp/claude-0/recalc-outage.json",
};
const ROOT = path.join(__dirname, "..", "..");
const PROBE = `/tmp/claude-0/probe-recalc-${process.pid}.jsonl`;
const ctl = (p) => new Promise((r) => http.get({ host: "127.0.0.1", port: 13399, path: p }, (x) => { x.resume(); x.on("end", r); }).on("error", r));
const db = mysql.createConnection({ host: "127.0.0.1", port: 3306, user: "bm", password: "bm", database: "dnds_api_test" });
const q = (sql, p) => new Promise((res, rej) => db.query(sql, p, (e, r) => (e ? rej(e) : res(r))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function netUnreachable(on) {
  const sh = (c) => { try { execSync(c, { stdio: "ignore" }); } catch (e) { /* ok */ } };
  if (on) { sh("ip addr del 198.51.100.7/32 dev lo"); sh("ip route add unreachable 198.51.100.7/32"); }
  else { sh("ip route del unreachable 198.51.100.7/32"); sh("ip addr add 198.51.100.7/32 dev lo"); }
}

(async () => {
  await ctl("/mode/pass");
  await q("DELETE FROM attendance_recalculation_run WHERE work_shift_id = 9001");
  await q("DELETE FROM attendance_day_calculation WHERE employee_id BETWEEN 50001 AND 50300").catch(() => {});
  const ins = await q(
    `INSERT INTO attendance_recalculation_run (trigger_source, from_date, to_date, work_shift_id, status, queued_at, requested_by_employee_id)
     VALUES ('WORK_SHIFT_SAVE', '2026-08-01', '2026-09-25', 9001, 'QUEUED', CURRENT_TIMESTAMP(3), 50001)`
  );
  const runId = ins.insertId;

  const srvEnv = { ...env, PORT: String(C.port), PROBE_OUT: PROBE, DIGISME_ATTENDANCE_CRON_ENABLED: "false" };
  delete srvEnv.CRON_DISABLED;
  delete srvEnv.TELEGRAM_BOT_TOKEN;
  const srv = spawn(C.nodeBin, ["-r", "./test_support/api_db_stress/probe.js", "server.js"], { cwd: ROOT, env: srvEnv, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  srv.stdout.on("data", (d) => (log += d));
  srv.stderr.on("data", (d) => (log += d));
  const T0 = Date.now();
  const series = [];
  const snap = async (phase) => {
    const [row] = await q(
      `SELECT status, attempts, employees_targeted, employees_completed, employees_failed, days_processed,
              TIMESTAMPDIFF(SECOND, heartbeat_at, CURRENT_TIMESTAMP(3)) AS heartbeat_age_s, LEFT(COALESCE(last_error,''),120) AS last_error
         FROM attendance_recalculation_run WHERE attendance_recalculation_run_id = ?`,
      [runId]
    );
    const lines = fs.existsSync(PROBE) ? fs.readFileSync(PROBE, "utf8").trim().split("\n") : [];
    const p = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
    const main = p ? p.pools.find((x) => x.name === "dnds_api_test") : null;
    const g = p && p.guard ? p.guard.find((x) => x.name === "main") : null;
    series.push({
      t: Math.round((Date.now() - T0) / 1000),
      phase,
      run: row,
      mysql_queued: main ? main.queued : null,
      guard: g || undefined,
      heap_mb: p ? p.heap_used_mb : null,
      cron_error_lines: (log.match(/\[CRON\] attendance_recalculation_queue/g) || []).length,
      cron_skip_lines: (log.match(/attendance_recalculation_queue tick skipped/g) || []).length,
    });
  };

  // Wait for the claim (the cron fires on the minute).
  for (let i = 0; i < 90; i += 1) {
    await sleep(2000);
    const [r] = await q("SELECT status, employees_completed FROM attendance_recalculation_run WHERE attendance_recalculation_run_id = ?", [runId]);
    if (r && r.status === "RUNNING" && Number(r.employees_completed) >= 0) break;
  }
  await snap("claimed");
  await sleep(15000); // let it get into the run
  await snap("pre_outage");

  if (C.scenario === "unreachable") netUnreachable(true);
  else await ctl(`/mode/${C.scenario}`);
  await ctl("/kill");
  const tOut = Date.now();
  while (Date.now() - tOut < C.outageS * 1000) {
    await sleep(5000);
    await snap("outage");
  }
  if (C.scenario === "unreachable") netUnreachable(false);
  await ctl("/mode/pass");
  const tRec = Date.now();
  while (Date.now() - tRec < C.recoverS * 1000) {
    await sleep(5000);
    await snap("recover");
    const last = series[series.length - 1].run;
    if (last && /COMPLETED|FAILED/.test(last.status) && Date.now() - tRec > 60000) break;
  }
  srv.kill("SIGKILL");
  const summary = {
    config: C,
    run_id: runId,
    final_run: series[series.length - 1].run,
    peak_mysql_queued: Math.max(0, ...series.map((s) => s.mysql_queued || 0)),
    peak_heap_mb: Math.max(0, ...series.map((s) => s.heap_mb || 0)),
    series,
    cron_log: (log.match(/\[CRON\] attendance_recalculation_queue[^\n]*/g) || []).slice(0, 20),
  };
  fs.writeFileSync(C.out, JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ out: C.out, final_run: summary.final_run, peak_mysql_queued: summary.peak_mysql_queued, peak_heap_mb: summary.peak_heap_mb }));
  db.end();
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
