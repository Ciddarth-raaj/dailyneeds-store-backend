/**
 * BULK ATTENDANCE RECALCULATION - a benchmark against a SCRATCH database.
 *
 *   ATTENDANCE_BENCH_MYSQL=mysql://user:pass@localhost/att_bench \
 *     node scripts/diagnostics/attendance_bulk_recalc_bench.js [--seed] [--sizes=1,10,50,100]
 *       [--concurrency=1] [--undated=20000] [--interactive]
 *
 * REFUSES to run unless the database name contains "bench" or "scratch": with
 * --seed it DELETES every row of the attendance tables it fills.
 *
 * It builds the calculation usecase exactly as `server.js` does (the real
 * repository, the real punch re-derive service) over a 10-connection pool,
 * and instruments that pool from the outside: every statement is counted and
 * classified, the wait for a pooled connection is timed apart from the
 * statement, and the peak number of connections checked out is recorded.
 *
 * `--interactive` runs a stand-in for the API's own traffic beside the bulk
 * run - one single-employee month read every 100 ms on the same pool - and
 * reports its latency, which is the number that says whether a bulk run
 * starves the requests people are waiting on.
 */
const mysql = require("mysql");

const URL = process.env.ATTENDANCE_BENCH_MYSQL;
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v === undefined ? true : v];
  })
);

if (!URL || !/bench|scratch/i.test(URL.split("/").pop())) {
  console.error("ATTENDANCE_BENCH_MYSQL must name a scratch database (its name must contain 'bench' or 'scratch')");
  process.exit(2);
}

const SIZES = String(args.sizes || "1,10,50,100").split(",").map(Number);
const FROM = "2026-08-01";
const TO = "2026-08-31";
const NOW = Date.parse("2026-09-25T12:00:00+05:30");
const SHIFT_ID = 1;
// Stores are sized to the runs: store 101 holds 1 employee, 110 holds 10...
const storeFor = (n) => 100 + n;

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

/* ------------------------------------------------------------ the pool */

function instrumentedPool(url, limit) {
  const pool = mysql.createPool(`${url}${url.includes("?") ? "&" : "?"}connectionLimit=${limit}&multipleStatements=true`);
  const stats = {
    queries: 0,
    writes: 0,
    byVerb: {},
    byStatement: {},
    poolWaitMs: 0,
    poolWaitMax: 0,
    reset() {
      Object.assign(this, { queries: 0, writes: 0, byVerb: {}, byStatement: {}, poolWaitMs: 0, poolWaitMax: 0 });
    },
  };
  // "SELECT biomax_punch_derived", "INSERT attendance_day_calculation" ...
  const statementKey = (sql) => {
    const s = String(typeof sql === "object" && sql ? sql.sql : sql).replace(/\s+/g, " ").trim();
    const verb = s.split(" ")[0].toUpperCase();
    const table = (s.match(/\b(?:FROM|INTO|UPDATE)\s+`?(\w+)/i) || [])[1] || "";
    return `${verb} ${table}`.trim();
  };
  const verbOf = (sql) => {
    const s = String(typeof sql === "object" && sql ? sql.sql : sql).trim().toUpperCase();
    return s.split(/\s+/)[0] || "?";
  };
  const count = (sql) => {
    const verb = verbOf(sql);
    stats.queries += 1;
    stats.byVerb[verb] = (stats.byVerb[verb] || 0) + 1;
    if (["INSERT", "UPDATE", "DELETE", "REPLACE"].includes(verb)) stats.writes += 1;
  };
  const wrapConnection = (connection) => {
    if (connection.__benchWrapped) return connection;
    connection.__benchWrapped = true;
    const q = connection.query.bind(connection);
    connection.query = (sql, ...rest) => {
      count(sql);
      const key = statementKey(sql);
      const t = nowMs();
      const cbIndex = rest.findIndex((r) => typeof r === "function");
      if (cbIndex >= 0) {
        const cb = rest[cbIndex];
        rest[cbIndex] = (...res) => {
          const e = stats.byStatement[key] || (stats.byStatement[key] = { n: 0, ms: 0 });
          e.n += 1;
          e.ms += nowMs() - t;
          cb(...res);
        };
      }
      return q(sql, ...rest);
    };
    return connection;
  };
  const getConnection = pool.getConnection.bind(pool);
  pool.getConnection = (cb) => {
    const asked = nowMs();
    getConnection((err, connection) => {
      const waited = nowMs() - asked;
      stats.poolWaitMs += waited;
      stats.poolWaitMax = Math.max(stats.poolWaitMax, waited);
      if (err) return cb(err);
      cb(null, wrapConnection(connection));
    });
  };
  // `pool.query` = getConnection + query + release; route it through the
  // wrapped getConnection so it is counted and timed the same way.
  pool.query = (sql, params, cb) => {
    if (typeof params === "function") {
      cb = params;
      params = undefined;
    }
    pool.getConnection((err, connection) => {
      if (err) return cb(err);
      connection.query(sql, params, (qErr, rows) => {
        connection.release();
        cb(qErr, rows);
      });
    });
  };
  return { pool, stats };
}

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

/* ------------------------------------------------------------ the seed */

async function seed(pool, { undated }) {
  const maxN = Math.max(...SIZES);
  const t = nowMs();
  for (const table of [
    "attendance_day_calculation", "attendance_recalculation_run", "attendance_approval_step",
    "attendance_regularized_punch", "attendance_approval_request", "attendance_date_shift_override",
    "attendance_punch_void", "biomax_punch_derived", "biomax_punch", "employee_work_shift_assignment",
    "work_shift_weekly_schedule", "work_shift_config_version", "payrun_employee_calculation",
  ]) {
    await q(pool, `DELETE FROM ${table}`);
  }
  await q(pool, "DELETE FROM new_employee WHERE employee_id BETWEEN 1 AND 9999");
  await q(pool, "DELETE FROM work_shift WHERE work_shift_id = ?", [SHIFT_ID]);
  for (const n of [...SIZES.map(storeFor), 999]) {
    await q(pool, "INSERT IGNORE INTO outlets (outlet_id, outlet_name, outlet_code, opening_cash) VALUES (?, ?, ?, 0)", [n, `Bench ${n}`, `B${n}`]);
  }

  await q(
    pool,
    `INSERT INTO work_shift (work_shift_id, shift_code, shift_name, active, late_grace_minutes,
       late_deduction_interval_minutes, late_deduct_minutes, late_exclude_grace_from_deduction,
       late_offset_against_overtime, early_exit_grace_minutes, early_exit_deduction_interval_minutes,
       early_exit_deduct_minutes, early_exit_offset_against_overtime, overtime_allowed,
       overtime_minimum_minutes, overtime_rounding_method, overtime_rounding_interval_minutes,
       overtime_minimum_threshold_only, overtime_minimum_excluded, pre_shift_overtime_allowed,
       pre_shift_overtime_minimum_minutes, pre_shift_overtime_minimum_excluded,
       pre_shift_overtime_rounding_method, pre_shift_overtime_rounding_interval_minutes,
       missed_clock_in_rule_enabled, missed_clock_in_treatment, minimum_hours_rule_enabled,
       minimum_half_day_minutes, minimum_full_day_minutes, regularization_allowed,
       regularization_control_enabled, regularization_require_existing_punch,
       regularization_requires_approval)
     VALUES (?, '9TO6', '9 to 6', 1, 10, 0, 0, 0, 0, 10, 0, 0, 0, 1, 30, 'DOWN', 30, 0, 0, 0, 0, 0,
             'NONE', 0, 0, 'FULL_DAY', 0, 240, 480, 1, 0, 0, 1)`,
    [SHIFT_ID]
  );
  for (let dow = 0; dow < 7; dow += 1) {
    await q(
      pool,
      `INSERT INTO work_shift_weekly_schedule (work_shift_id, day_of_week, is_working_day, in_time,
         out_time, attendance_day_cutoff, break_minutes, normal_work_minutes, ot_rate)
       VALUES (?, ?, ?, '09:00:00', '18:00:00', '04:00:00', 60, 480, 1.0)`,
      [SHIFT_ID, dow, dow === 0 ? 0 : 1]
    );
  }

  // Employees: one store per run size, so each run is a store filter.
  const employees = [];
  let id = 1;
  for (const n of SIZES) {
    for (let i = 0; i < n; i += 1) employees.push({ id: id++, store: storeFor(n) });
  }
  // Bystanders: other stores, so the tables are not only the run's rows.
  for (let i = 0; i < 200; i += 1) employees.push({ id: id++, store: 999 });
  await q(
    pool,
    `INSERT INTO new_employee (employee_id, employee_name, store_id, designation_id, status,
       date_of_joining, attendance_required, default_work_shift_id)
     VALUES ?`,
    [employees.map((e) => [e.id, `Bench ${e.id}`, e.store, 1, 1, "2025-01-01", 1, SHIFT_ID])]
  );
  await q(
    pool,
    `INSERT INTO employee_work_shift_assignment (employee_id, work_shift_id, effective_from, source)
     VALUES ?`,
    [employees.map((e) => [e.id, SHIFT_ID, "2025-01-01", "MIGRATION_BACKFILL"])]
  );

  // Punches: May-September 2026, a normal day is IN/OUT; every 7th is odd
  // (a missing OUT), every 5th has a lunch pair; some overtime.
  const pad = (n) => String(n).padStart(2, "0");
  const punches = [];
  const start = Date.parse("2026-05-01T00:00:00Z");
  const end = Date.parse("2026-09-24T00:00:00Z");
  for (const e of employees) {
    for (let d = start, k = 0; d <= end; d += 86400000, k += 1) {
      const day = new Date(d);
      if (day.getUTCDay() === 0) continue;
      const ymd = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
      const times = ["08:5" + (k % 10), "18:" + pad((e.id * 7 + k * 13) % 60)];
      if (k % 5 === 0) times.splice(1, 0, "13:00", "13:4" + (k % 10));
      if ((e.id + k) % 7 === 0) times.pop();
      if ((e.id + k) % 11 === 0) times[times.length - 1] = "20:15";
      for (const hm of times) {
        const io = `${ymd} ${hm}:00`;
        punches.push([String(e.id), io.replace(/[-: ]/g, ""), io, "LIVE", e.id, ymd]);
      }
    }
  }
  // Undatable punches that match nobody - device users with no employee row.
  for (let i = 0; i < undated; i += 1) {
    const d = new Date(start + (i % 140) * 86400000);
    const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const io = `${ymd} ${pad(8 + (i % 10))}:${pad(i % 60)}:${pad(Math.floor(i / 60) % 60)}`;
    punches.push([String(50000 + (i % 400)), io.replace(/[-: ]/g, ""), io, "LIVE", null, null]);
  }
  for (let i = 0; i < punches.length; i += 5000) {
    const chunk = punches.slice(i, i + 5000);
    const r = await q(
      pool,
      "INSERT INTO biomax_punch (dev_id, user_id, io_time_raw, io_time, ingest_source) VALUES ?",
      [chunk.map((p) => ["DEV1", p[0], p[1], p[2], p[3]])]
    );
    const first = Number(r.insertId);
    await q(
      pool,
      `INSERT INTO biomax_punch_derived (biomax_punch_id, attendance_date, derivation_status,
         employee_id, work_shift_id, derived_at) VALUES ?`,
      [chunk.map((p, j) => [first + j, p[5], p[4] ? "OK" : "UNMATCHED", p[4], p[4] ? SHIFT_ID : null, "2026-09-01 00:00:00"])]
    );
  }

  // Some approval traffic: an approved OT request on one date in ten.
  const approvals = [];
  for (const e of employees) {
    for (let day = 3; day <= 31; day += 10) {
      approvals.push([`2026-08-${pad(day)}`, e.id, e.id, "OT", "APPROVED", 1, 1, 60, 60, "SETTLED", "STORE_EMPLOYEE", "bench"]);
    }
  }
  await q(
    pool,
    `INSERT INTO attendance_approval_request (attendance_date, requested_for_employee_id,
       requested_by_employee_id, request_type, status, current_stage_no, total_stages,
       candidate_ot_minutes, approved_ot_minutes, finalization_state, requester_class, reason) VALUES ?`,
    [approvals]
  ).catch((err) => console.warn(`approval seed skipped: ${err.message}`));

  await q(pool, "ANALYZE TABLE biomax_punch, biomax_punch_derived, new_employee, attendance_approval_request");
  console.log(
    `seeded ${employees.length} employees, ${punches.length} punches (${undated} undatable), ` +
      `${approvals.length} OT requests in ${Math.round(nowMs() - t)} ms`
  );
}

/* ------------------------------------------------------------ the runs */

function buildUsecase(pool) {
  const calcRepo = require("../../repository/attendance_calculation")(pool);
  const importRepo = require("../../repository/attendance_import")(pool);
  const store = require("../../biomax/store").createStore(pool);
  const importUsecase = require("../../usecase/attendance_import")(importRepo, store);
  const usecase = require("../../usecase/attendance_calculation")(calcRepo, { now: NOW });
  usecase.setPunchRedriveService(importUsecase);
  return usecase;
}

async function interactiveLoad(usecase, stop) {
  const latencies = [];
  while (!stop.done) {
    const t = nowMs();
    try {
      await usecase.readRange({ employee_id: 1, from_date: FROM, to_date: TO, now: NOW });
    } catch (err) {
      /* measured regardless */
    }
    latencies.push(nowMs() - t);
    await new Promise((r) => setTimeout(r, 100));
  }
  latencies.sort((a, b) => a - b);
  const pct = (p) => (latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]) : null);
  return { samples: latencies.length, p50: pct(0.5), p95: pct(0.95), max: pct(1) };
}

async function runOnce(pool, stats, usecase, n, { interactive }) {
  // Warm nothing: every run starts from the same rows.
  const stop = { done: false };
  const load = interactive ? interactiveLoad(usecase, stop) : null;
  await new Promise((r) => setTimeout(r, interactive ? 300 : 0));

  stats.reset();
  const cpu0 = process.cpuUsage();
  let peakRss = process.memoryUsage().rss;
  // The pool's own bookkeeping: connections handed out, and callers queued
  // waiting for one. Sampled, so a sub-5ms spike can be missed.
  let peakInUse = 0;
  let peakQueued = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const all = pool._allConnections ? pool._allConnections.length : 0;
    const free = pool._freeConnections ? pool._freeConnections.length : 0;
    peakInUse = Math.max(peakInUse, all - free);
    peakQueued = Math.max(peakQueued, pool._connectionQueue ? pool._connectionQueue.length : 0);
  }, 2);
  const t = nowMs();
  const result = await usecase.recalculateBulk({
    from_date: FROM,
    to_date: TO,
    store_id: storeFor(n),
    now: NOW,
    actor_employee_id: 1,
  });
  const elapsed = nowMs() - t;
  clearInterval(sampler);
  const cpu = process.cpuUsage(cpu0);
  stop.done = true;
  const interactiveStats = load ? await load : null;

  return {
    employees: n,
    status: result.status,
    completed: result.employees_completed,
    failed: result.employees_failed,
    days_written: result.attendance_days_processed,
    total_ms: Math.round(elapsed),
    ms_per_employee: Math.round(elapsed / n),
    queries: stats.queries,
    queries_per_employee: +(stats.queries / n).toFixed(1),
    writes: stats.writes,
    writes_per_employee: +(stats.writes / n).toFixed(1),
    by_verb: stats.byVerb,
    db_ms_by_statement: Object.fromEntries(
      Object.entries(stats.byStatement)
        .sort((x, y) => y[1].ms - x[1].ms)
        .slice(0, 6)
        .map(([k, v]) => [k, { n: v.n, ms: Math.round(v.ms) }])
    ),
    pool_wait_ms_total: Math.round(stats.poolWaitMs),
    pool_wait_ms_max: Math.round(stats.poolWaitMax),
    peak_connections: peakInUse,
    peak_pool_queue: peakQueued,
    cpu_ms: Math.round((cpu.user + cpu.system) / 1000),
    cpu_pct_of_one_core: Math.round(((cpu.user + cpu.system) / 1000 / elapsed) * 100),
    peak_rss_mb: Math.round(peakRss / 1048576),
    interactive: interactiveStats,
  };
}

async function main() {
  const { pool, stats } = instrumentedPool(URL, Number(args.pool || 10));
  if (args.seed) await seed(pool, { undated: Number(args.undated || 0) });
  if (args.concurrency) process.env.ATTENDANCE_BULK_CONCURRENCY = String(args.concurrency);
  const usecase = buildUsecase(pool);
  const results = [];
  for (const n of SIZES) {
    const r = await runOnce(pool, stats, usecase, n, { interactive: !!args.interactive });
    results.push(r);
    console.log(JSON.stringify(r));
  }
  // A correctness fingerprint of what was stored: identical across
  // configurations means identical rows.
  const [fp] = await q(
    pool,
    `SELECT COUNT(*) AS n_rows,
            SUM(CRC32(CONCAT_WS('|', employee_id, attendance_date, worked_minutes, regular_minutes,
              shortage_minutes, late_minutes, early_exit_minutes, candidate_ot_minutes,
              approved_ot_minutes, shift_authorised_ot_minutes, status, review_reasons,
              raw_punch_ids, effective_punches, shift_snapshot_hash))) AS fingerprint
       FROM attendance_day_calculation`
  );
  console.log(JSON.stringify({ stored: fp }));
  if (args.dump) {
    // Every stored column except the row's own timestamps, in key order:
    // two dumps that are byte-identical are two identical sets of rows.
    const { CALCULATION_COLUMNS } = require("../../repository/attendance_calculation");
    const rows = await q(
      pool,
      `SELECT ${CALCULATION_COLUMNS.map((c) =>
        c === "attendance_date" ? "DATE_FORMAT(attendance_date, '%Y-%m-%d') AS attendance_date" : `\`${c}\``
      ).join(", ")}
         FROM attendance_day_calculation ORDER BY employee_id, attendance_date`
    );
    require("fs").writeFileSync(args.dump, rows.map((r) => JSON.stringify(r)).join("\n"));
  }
  pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
