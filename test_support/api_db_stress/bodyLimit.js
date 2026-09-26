/**
 * What the global bodyParser.json({ limit: "120mb" }) costs, on the REAL
 * server.js: it is registered BEFORE authentication, so an anonymous client
 * can make the process buffer and JSON.parse up to 120 MB per request.
 *
 *   NODE_BIN=... node test_support/api_db_stress/bodyLimit.js
 *
 * Sends, with NO credentials, to /user/login (an unprotected route whose
 * real body is a username and a password):
 *   1. one 100 MB JSON body
 *   2. four 30 MB bodies at once
 * and samples the server's heap/RSS (probe.js) before, during and after.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const nodeBin = process.env.NODE_BIN || process.execPath;
const PORT = Number(process.env.API_PORT || 18095);
const PROBE = `${require("os").tmpdir()}/probe-body-${process.pid}.jsonl`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jsonOf(mb) {
  // A realistic "Excel rows as JSON" shape, mb megabytes.
  const row = JSON.stringify({ item_code: "ITEM000001", name: "x".repeat(60), qty: 12, price: 99.5, outlet: "DN1" });
  const n = Math.floor((mb * 1048576) / (row.length + 1));
  return Buffer.from(`{"username":"a","password":"b","rows":[${Array(n).fill(row).join(",")}]}`);
}

function post(body) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ host: "127.0.0.1", port: PORT, path: "/user/login", method: "POST", headers: { "content-type": "application/json", "content-length": body.length } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - t0 }));
    });
    req.on("error", (e) => resolve({ status: e.code, ms: Date.now() - t0 }));
    req.end(body);
  });
}

const lastProbe = () => {
  const lines = fs.existsSync(PROBE) ? fs.readFileSync(PROBE, "utf8").trim().split("\n") : [];
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
};

(async () => {
  const srv = spawn(nodeBin, ["-r", "./test_support/api_db_stress/probe.js", "server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CRON_DISABLED: "true", PROBE_OUT: PROBE, PROBE_INTERVAL_MS: "100" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    if (lastProbe()) break;
  }
  await sleep(2000);
  const base = lastProbe();
  const peakDuring = async (fn) => {
    let peakHeap = 0;
    let peakRss = 0;
    let done = false;
    const watcher = (async () => {
      while (!done) {
        const p = lastProbe();
        if (p) {
          peakHeap = Math.max(peakHeap, p.heap_used_mb);
          peakRss = Math.max(peakRss, p.rss_mb);
        }
        await sleep(50);
      }
    })();
    const result = await fn();
    await sleep(500);
    done = true;
    await watcher;
    return { result, peak_heap_mb: peakHeap, peak_rss_mb: peakRss };
  };
  const b100 = jsonOf(100);
  const one = await peakDuring(() => post(b100));
  await sleep(3000);
  const b30 = jsonOf(30);
  const four = await peakDuring(() => Promise.all([post(b30), post(b30), post(b30), post(b30)]));
  await sleep(3000);
  const after = lastProbe();
  srv.kill("SIGKILL");
  const out = {
    body_limit: "120mb, before auth",
    baseline: { heap_mb: base.heap_used_mb, rss_mb: base.rss_mb },
    one_100mb_anonymous: { status: one.result.status, ms: one.result.ms, peak_heap_mb: one.peak_heap_mb, peak_rss_mb: one.peak_rss_mb },
    four_30mb_anonymous_concurrent: { statuses: four.result.map((r) => r.status), peak_heap_mb: four.peak_heap_mb, peak_rss_mb: four.peak_rss_mb },
    after: { heap_mb: after.heap_used_mb, rss_mb: after.rss_mb },
  };
  fs.writeFileSync(process.env.OUT || `${require("os").tmpdir()}/body-limit.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
  process.exit(0);
})();
