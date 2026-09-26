/**
 * Biomax receiver stress harness - realtime_enroll_data flood against a
 * slow database. Local/CI only: it DROPS and recreates its tables, so it
 * refuses to run unless DB_NAME ends in "_test".
 *
 *   IMPL_DIR=/path/to/repo DURATION_S=90 RATE=100 SLOW_MS=30000 \
 *     node test_support/biomax/stress/stress.js
 *
 * What it does, all at once for DURATION_S:
 *
 *   enroll flood   RATE requests/s of request_code realtime_enroll_data, bodies
 *                  of 25-35 KB (length-prefixed JSON with a random base64 blob -
 *                  a SYNTHETIC stand-in, the real structure is uncaptured), spread over the 7 real Cloud IDs
 *   polls          each device sends receive_cmd every POLL_MS
 *   punches        one NEW realtime_glog every PUNCH_MS, and every third one is
 *                  re-sent (a retransmission) to check dedup
 *   /healthz       probed every second with an 800 ms budget - the API's own
 *                  BIOMAX_HEALTH_TIMEOUT_MS
 *
 * SLOW_MS is injected in the DATABASE, not in JS: BEFORE triggers on
 * biomax_raw_request INSERT and biomax_device UPDATE call SLEEP(), so the
 * real mysql driver, its real pool and its real queue are what is measured.
 * SLOW_PUNCH_MS optionally does the same to biomax_punch INSERT.
 *
 * Output: a JSON summary on stdout (and OUT=file if given).
 */
const { fork, execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const mysql = require("mysql");

const env = process.env;
const num = (k, d) => (env[k] === undefined ? d : Number(env[k]));
const CFG = {
  impl: path.resolve(env.IMPL_DIR || path.join(__dirname, "..", "..", "..")),
  durationS: num("DURATION_S", 60),
  rate: num("RATE", 100),
  slowMs: num("SLOW_MS", 30000),
  slowPunchMs: num("SLOW_PUNCH_MS", 0),
  pollMs: num("POLL_MS", 2000),
  punchMs: num("PUNCH_MS", 2000),
  heapMb: num("HEAP_MB", 450),
  db: {
    host: env.DB_HOST || "127.0.0.1",
    port: num("DB_PORT", 3306),
    user: env.DB_USER || "bm",
    password: env.DB_PASS || "bm",
    database: env.DB_NAME || "biomax_test",
  },
};
if (!/_test$/.test(CFG.db.database)) {
  console.error("refusing: DB_NAME must end in _test");
  process.exit(2);
}

const DEVICES = ["C26924B2E7351O35", "C2695C935328OB31", "C2695C9353290F31", "C26044C84F1A1D31", "AMDB24121401205", "C2695C56D30E1430", "AMDB24121401307"];

/* ------------------------------------------------------------ db setup -- */

function sql(conn, text, params) {
  return new Promise((resolve, reject) => conn.query(text, params, (e, r) => (e ? reject(e) : resolve(r))));
}

async function setupDb() {
  const conn = mysql.createConnection({ ...CFG.db, multipleStatements: true });
  await sql(conn, fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  const secs = (ms) => (ms / 1000).toFixed(3);
  if (CFG.slowMs > 0) {
    await sql(conn, `CREATE TRIGGER stress_slow_raw BEFORE INSERT ON biomax_raw_request FOR EACH ROW SET @stress = SLEEP(${secs(CFG.slowMs)})`);
    await sql(conn, `CREATE TRIGGER stress_slow_touch BEFORE UPDATE ON biomax_device FOR EACH ROW SET @stress = SLEEP(${secs(CFG.slowMs)})`);
  }
  if (CFG.slowPunchMs > 0) {
    await sql(conn, `CREATE TRIGGER stress_slow_punch BEFORE INSERT ON biomax_punch FOR EACH ROW SET @stress = SLEEP(${secs(CFG.slowPunchMs)})`);
  }
  conn.end();
}

async function dbFacts() {
  const conn = mysql.createConnection(CFG.db);
  // Triggers off first so the facts query is not itself slowed.
  const raw = await sql(conn, "SELECT outcome, request_code, COUNT(*) n, SUM(byte_length) bytes, SUM(LENGTH(raw_frame)) stored FROM biomax_raw_request GROUP BY outcome, request_code");
  const punches = await sql(conn, "SELECT COUNT(*) n, SUM(retransmit_count) retransmits FROM biomax_punch");
  const derived = await sql(conn, "SELECT COUNT(*) n FROM biomax_punch_derived");
  conn.end();
  return { raw, punches: punches[0], derived: derived[0].n };
}

/* ------------------------------------------------------------- frames -- */

function frame(devId, requestCode, body, extra = "") {
  const head =
    "POST /hdata.aspx HTTP/1.0\r\n" +
    "User-Agent: Mozilla/4.0\r\n" +
    "Content-Type: application/octet-stream\r\n" +
    "Connection: close\r\n" +
    `request_code: ${requestCode}\r\n` +
    `Content-Length: ${body.length}\r\n` +
    `dev_id: ${devId}\r\n` +
    extra +
    "blk_no: 0\r\n" +
    `blk_len: ${body.length}\r\n` +
    "HOST: 127.0.0.1:7005\r\n\r\n";
  return Buffer.concat([Buffer.from(head, "latin1"), body]);
}

function framed(json) {
  const j = Buffer.from(json, "utf8");
  const p = Buffer.alloc(4);
  p.writeUInt32LE(j.length + 2);
  return Buffer.concat([p, j, Buffer.from([0x0a, 0x00])]);
}

// A handful of fixed bodies per device: a terminal re-sending the same
// enrolment over and over sends the SAME bytes, which is what production saw.
const enrollBodies = new Map();
function enrollBody(devId, i) {
  const key = `${devId}:${i % 3}`;
  if (!enrollBodies.has(key)) {
    const size = 25 * 1024 + crypto.randomInt(10 * 1024);
    const template = crypto.randomBytes(Math.floor((size * 3) / 4) - 200).toString("base64");
    const json = JSON.stringify({ user_id: String(1000 + (i % 3)), user_name: "", user_privilege: "USER", enroll_data_array: [{ backup_number: 12, enroll_data: template }] });
    enrollBodies.set(key, framed(json));
  }
  return enrollBodies.get(key);
}

function punchBody(userId, ioTime) {
  return framed(`{"fk_bin_data_lib":"FKDataHS102","io_mode":16777216,"io_time":"${ioTime}","log_image":null,"user_id":"${userId}","verify_mode":1073741824}`);
}

/** Send bytes, read to close. Resolves {ms, headers, raw, timedOut, reset}. */
function send(port, bytes, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const raw = Buffer.concat(chunks);
      const text = raw.toString("latin1");
      const m = /\r\nresponse_code: ?([^\r\n]*)/i.exec(text);
      resolve({ ms: Date.now() - t0, raw, responseCode: m ? m[1].trim() : null, ...extra });
    };
    const sock = net.connect(port, "127.0.0.1", () => sock.write(bytes));
    const timer = setTimeout(() => {
      sock.destroy();
      finish({ timedOut: true });
    }, timeoutMs);
    sock.on("data", (d) => chunks.push(d));
    sock.on("close", () => finish({}));
    sock.on("error", (e) => finish({ error: e.code }));
  });
}

/* --------------------------------------------------------------- run -- */

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function run() {
  await setupDb();
  const child = fork(path.join(__dirname, "host.js"), [], {
    env: { ...env, IMPL_DIR: CFG.impl, DB_HOST: CFG.db.host, DB_PORT: String(CFG.db.port), DB_USER: CFG.db.user, DB_PASS: CFG.db.password, DB_NAME: CFG.db.database, BIOMAX_SPOOL_DIR: fs.mkdtempSync("/tmp/biomax-stress-spool-") },
    execArgv: [`--max-old-space-size=${CFG.heapMb}`, "--expose-gc"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let childOut = "";
  child.stdout.on("data", (d) => (childOut += d));
  child.stderr.on("data", (d) => (childOut += d));
  const stats = [];
  let stopped = null;
  let exited = null;
  child.on("message", (m) => {
    if (m.type === "stats") stats.push(m);
    if (m.type === "stopped") stopped = m;
  });
  child.on("exit", (code, signal) => (exited = { code, signal, at: Date.now() }));
  const port = await new Promise((resolve, reject) => {
    child.once("message", (m) => (m.type === "listening" ? resolve(m.port) : reject(new Error("bad start"))));
    child.once("exit", () => reject(new Error(`child exited before listening:\n${childOut}`)));
  });

  const t0 = Date.now();
  const until = t0 + CFG.durationS * 1000;
  const results = { enroll: [], poll: [], punch: [], dup: [], health: [] };
  const inflight = new Set();
  const track = (p) => {
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  };

  // enroll flood - open loop at RATE/s
  let n = 0;
  const enrollTimer = setInterval(() => {
    const perTick = Math.max(1, Math.round(CFG.rate / 20));
    for (let k = 0; k < perTick; k += 1) {
      const dev = DEVICES[n % DEVICES.length];
      const f = frame(dev, "realtime_enroll_data", enrollBody(dev, n), "cmd_id: RTEnrollDataAction\r\n");
      n += 1;
      track(send(port, f, 20000).then((r) => results.enroll.push(r)));
    }
  }, 50);

  // polls
  const pollTimer = setInterval(() => {
    for (const dev of DEVICES) track(send(port, frame(dev, "receive_cmd", Buffer.alloc(0)), 20000).then((r) => results.poll.push(r)));
  }, CFG.pollMs);

  // punches (+ a retransmission of every third)
  let p = 0;
  const punchTimer = setInterval(() => {
    p += 1;
    const sec = String(p % 60).padStart(2, "0");
    const min = String(Math.floor(p / 60) % 60).padStart(2, "0");
    const ioTime = `20260926${String(10 + Math.floor(p / 3600)).padStart(2, "0")}${min}${sec}`;
    const f = frame("C2695C56D30E1430", "realtime_glog", punchBody("1952", ioTime), "cmd_id: RTLogSendAction\r\n");
    track(
      send(port, f, 20000).then((r) => {
        results.punch.push({ ...r, ioTime });
        if (p % 3 === 0) return send(port, f, 20000).then((d) => results.dup.push({ ...d, ioTime }));
        return null;
      })
    );
  }, CFG.punchMs);

  // healthz with the API's 800 ms budget
  const healthTimer = setInterval(() => {
    track(
      send(port, Buffer.from("GET /healthz HTTP/1.0\r\n\r\n", "latin1"), 800).then((r) => {
        const body = r.raw.subarray(r.raw.indexOf("\r\n\r\n") + 4).toString();
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          /* none */
        }
        results.health.push({ t: Date.now() - t0, ms: r.ms, timedOut: !!r.timedOut, bytes: r.raw.length, ok: parsed ? parsed.ok : null, db: parsed ? parsed.db : null });
      })
    );
  }, 1000);

  while (Date.now() < until && !exited) await new Promise((r) => setTimeout(r, 250));
  clearInterval(enrollTimer);
  clearInterval(pollTimer);
  clearInterval(punchTimer);
  clearInterval(healthTimer);
  const crashed = exited;

  // Let in-flight client requests finish (each has its own timeout).
  await Promise.race([Promise.all([...inflight]), new Promise((r) => setTimeout(r, 21000))]);

  let shutdown = null;
  if (!exited) {
    const s0 = Date.now();
    child.send({ type: "stop" });
    while (!exited && Date.now() - s0 < 15000) await new Promise((r) => setTimeout(r, 100));
    shutdown = { ms: Date.now() - s0, reported: stopped };
  }
  if (!exited) child.kill("SIGKILL");

  // Drop the triggers so the facts query and any leftovers finish.
  const conn = mysql.createConnection(CFG.db);
  await sql(conn, "DROP TRIGGER IF EXISTS stress_slow_raw").catch(() => {});
  await sql(conn, "DROP TRIGGER IF EXISTS stress_slow_touch").catch(() => {});
  await sql(conn, "DROP TRIGGER IF EXISTS stress_slow_punch").catch(() => {});
  conn.end();
  const facts = await dbFacts();

  const mb = (b) => Math.round((b / 1048576) * 10) / 10;
  const heap = stats.map((s) => s.heapUsed);
  const last = stats[stats.length - 1] || {};
  const summarize = (list) => ({
    sent: list.length,
    replied: list.filter((r) => r.responseCode).length,
    no_reply: list.filter((r) => !r.responseCode).length,
    codes: list.reduce((a, r) => ((a[r.responseCode || "none"] = (a[r.responseCode || "none"] || 0) + 1), a), {}),
    p50_ms: pct(list.map((r) => r.ms), 50),
    p99_ms: pct(list.map((r) => r.ms), 99),
    max_ms: list.length ? Math.max(...list.map((r) => r.ms)) : null,
  });
  const summary = {
    impl: CFG.impl,
    config: { durationS: CFG.durationS, rate: CFG.rate, slowMs: CFG.slowMs, slowPunchMs: CFG.slowPunchMs, heapMb: CFG.heapMb },
    crashed: crashed ? { ...crashed, after_s: Math.round((crashed.at - t0) / 100) / 10, tail: childOut.slice(-600) } : null,
    memory: {
      heap_start_mb: mb(heap[0] || 0),
      heap_peak_mb: mb(Math.max(0, ...heap)),
      heap_end_mb: mb(heap[heap.length - 1] || 0),
      rss_peak_mb: mb(Math.max(0, ...stats.map((s) => s.rss))),
      series_mb_every_10s: stats.filter((_, i) => i % 10 === 0).map((s) => mb(s.heapUsed)),
      pool_queue_peak: Math.max(0, ...stats.map((s) => s.poolQueue || 0)),
      pool_queue_series_every_10s: stats.filter((_, i) => i % 10 === 0).map((s) => s.poolQueue),
    },
    health: {
      probes: results.health.length,
      answered_within_800ms: results.health.filter((h) => !h.timedOut && h.bytes > 0).length,
      timed_out_zero_bytes: results.health.filter((h) => h.timedOut && h.bytes === 0).length,
      p50_ms: pct(results.health.filter((h) => !h.timedOut).map((h) => h.ms), 50),
      max_ms: results.health.length ? Math.max(...results.health.map((h) => h.ms)) : null,
      db_true: results.health.filter((h) => h.db === true).length,
      db_false: results.health.filter((h) => h.db === false).length,
    },
    enroll: summarize(results.enroll),
    poll: summarize(results.poll),
    punch: summarize(results.punch),
    punch_retransmit: summarize(results.dup),
    receiver_log: last.counts || null,
    receiver_runtime: last.runtime || null,
    shutdown: shutdown ? { ms: shutdown.ms, pool_closed_log_lines: shutdown.reported ? shutdown.reported.counts.poolClosedLines : null, housekeeping_failed_total: shutdown.reported ? shutdown.reported.counts.housekeepingFailed : null } : null,
    db: facts,
  };
  const out = JSON.stringify(summary, null, 2);
  if (env.OUT) fs.writeFileSync(env.OUT, out);
  console.log(out);
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
