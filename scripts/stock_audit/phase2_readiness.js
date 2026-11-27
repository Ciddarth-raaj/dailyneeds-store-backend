/**
 * Stock Audit - Phase 2 READINESS + RECONCILIATION. Strictly READ-ONLY.
 *
 * Runs on the production host from ~/dailyneeds-store-backend (the deployed
 * checkout), bundled into one file because that checkout does not have the
 * stock audit code. It:
 *   1. ENV      - MySQL version, database size, where MySQL runs (local or
 *                 managed: a yes/no, never the host), disk space, backup tools
 *   2. STAFF    - active employees per programme store and designation id
 *                 (counts only, no names), the RetailPilot staff map size
 *   3. RECON    - RetailPilot audit sessions since 25 Nov 2026 00:00 IST:
 *                 independent SPECTRA aggregates vs the DNDS calculation
 *                 (utils/stock_audit_progress.js) on the same rows
 *   4. RECOUNT  - whether RetailPilot recount transactions exist yet
 * SELECT statements only (SPECTRA and MySQL); writes nothing anywhere; never
 * prints keys, hosts, request headers or personal names. RetailPilot user
 * ids are printed only as counts or, for the one auditor whose CSV was
 * supplied, as the article ids they finalized.
 */
const fs = require("fs");
const { execSync } = require("child_process");
const cwd = process.cwd();
const dyn = (p) => require(p); // resolved on the host, not bundled
const mysql = dyn(`${cwd}/node_modules/mysql`);
const rpConfig = dyn(`${cwd}/config/retailpilot`);

const spectraFactory = require("../../services/retailpilot_spectra");
const { STREAMS, startCursor, toUtc } = require("../../utils/stock_audit_queries");
const { sessionRow } = require("../../utils/stock_audit_mirror");
const { computePeriod } = require("../../utils/stock_audit_progress");
const { istDate } = require("../../utils/stock_audit_activity");

const SINCE = "2026-11-25T00:00:00+05:30";
const PROGRAMME = [3, 4, 5, 6, 7];
const CSV_AUDITOR = { rp_store_id: "kKFom", rp_user_id: "kvvUlR2Ptiod" };
const out = (label, obj) => console.log(`@@${label} ${JSON.stringify(obj)}`);
const sh = (cmd) => {
  try { return execSync(cmd, { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (e) { return null; }
};

(async () => {
  const env = process.argv[2] || "production";
  const cfg = JSON.parse(fs.readFileSync(`${cwd}/config.json`, "utf8")).db.mysql[env];
  const conn = mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.username, password: cfg.password, database: cfg.database });
  const q = (sql, p = []) => new Promise((res) => conn.query(sql, p, (e, r) => res(e ? { error: e.code } : r)));
  const host = String(cfg.host || "");

  // ---------------------------------------------------------------- 1. ENV
  const v = await q("SELECT VERSION() AS version, @@version_comment AS comment, @@datadir AS datadir, @@log_bin AS log_bin, @@gtid_mode AS gtid_mode, @@innodb_file_per_table AS fpt, @@read_only AS read_only, @@super_read_only AS super_read_only");
  const size = await q("SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024 / 1024, 2) AS gb, COUNT(*) AS tables_n FROM information_schema.TABLES WHERE table_schema = DATABASE()");
  const top = await q("SELECT table_name AS t, ROUND((data_length + index_length) / 1024 / 1024 / 1024, 2) AS gb FROM information_schema.TABLES WHERE table_schema = DATABASE() ORDER BY (data_length + index_length) DESC LIMIT 8");
  const engines = await q("SELECT engine, COUNT(*) AS n FROM information_schema.TABLES WHERE table_schema = DATABASE() GROUP BY engine");
  const migrated = await q("SELECT COUNT(*) AS n, MAX(name) AS last FROM migrations");
  const files = fs.readdirSync(`${cwd}/migrations/mysql/migrations`).filter((f) => /^\d+-.+\.js$/.test(f)).length;
  const local = ["localhost", "127.0.0.1", "::1"].includes(host);
  const datadir = v[0] && v[0].datadir;
  out("ENV", {
    mysql: v[0] || v,
    managed_rds: /\.rds\.amazonaws\.com$/i.test(host),
    mysql_on_app_server: local,
    db_size: size[0] || size,
    largest_tables: top,
    engines,
    migrations: { applied: migrated[0] && migrated[0].n, last_applied: migrated[0] && migrated[0].last, files_in_checkout: files },
    disk: sh("df -h -x tmpfs -x devtmpfs --output=target,size,used,avail,pcent 2>/dev/null"),
    datadir_size: local && datadir ? sh(`du -sh ${JSON.stringify(datadir)} 2>/dev/null`) : null,
    block_devices: sh("lsblk -d -o NAME,SIZE,TYPE,MOUNTPOINT 2>/dev/null"),
    tools: {
      mysqldump: sh("command -v mysqldump && mysqldump --version"),
      mysql84_client: sh("ls ~/mysql84/bin/mysqldump 2>/dev/null && ~/mysql84/bin/mysqldump --version"),
      xtrabackup: sh("command -v xtrabackup && xtrabackup --version 2>&1 | head -1"),
      mysqlsh: sh("command -v mysqlsh"),
      aws_cli: sh("command -v aws && aws --version 2>&1"),
      aws_identity_available: sh("aws sts get-caller-identity --query Arn --output text 2>/dev/null") ? true : false,
    },
    ec2: (() => {
      const tok = sh("curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'");
      if (!tok) return null;
      const md = (p) => sh(`curl -s -m 2 -H 'X-aws-ec2-metadata-token: ${tok}' http://169.254.169.254/latest/meta-data/${p}`);
      return { instance_type: md("instance-type"), az: md("placement/availability-zone"), iam_role_attached: Boolean(md("iam/security-credentials/")) };
    })(),
    existing_backups: sh("du -sh ~/db-backups 2>/dev/null; ls -1t ~/db-backups/pre-deploy 2>/dev/null | head -3"),
    pm2: sh("pm2 jlist 2>/dev/null | node -e \"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).map(p=>p.name+':'+p.pm2_env.status).join(', '))}catch(e){}})\""),
  });

  // ---------------------------------------------------------------- 2. STAFF
  const outlets = await q("SELECT outlet_id, outlet_name, retailpilot_id FROM outlets WHERE retailpilot_id IS NOT NULL AND retailpilot_id <> ''");
  const desig = await q("SELECT designation_id, designation_name FROM designation ORDER BY designation_id");
  const staff = await q(`SELECT e.store_id, e.designation_id, COUNT(*) AS n FROM new_employee e WHERE e.status = 1 AND e.store_id IN (${PROGRAMME.join(",")}) GROUP BY e.store_id, e.designation_id ORDER BY e.store_id, e.designation_id`);
  const map = await q("SELECT COUNT(*) AS rows_n, SUM(employee_id IS NOT NULL) AS mapped FROM wh_rp_staff_map");
  const mapRows = await q("SELECT m.rp_user_id, m.employee_id, e.store_id, e.status FROM wh_rp_staff_map m LEFT JOIN new_employee e ON e.employee_id = m.employee_id WHERE m.employee_id IS NOT NULL");
  out("STAFF", { outlets: outlets.map((o) => ({ outlet_id: o.outlet_id, name: o.outlet_name, rp: o.retailpilot_id })), designations: desig, active_by_store_designation: staff, staff_map: map[0] || map });

  // ---------------------------------------------------------------- 3. RECON
  const spectra = spectraFactory({ ...rpConfig, retry: spectraFactory.DEFAULT_RETRY });
  // ONE cut-off for every read below, so live counting during the run cannot open a gap
  const AS_OF = new Date(Date.now() - 60000).toISOString();
  out("AS_OF", { utc: AS_OF });
  const all = [];
  await spectra.queryKeyset((c, s) => STREAMS.session.build(c, s), startCursor(null, { since: SINCE }), STREAMS.session.cursorOf, async (page) => { all.push(...page); }, { size: 2000 });
  // a session counts as at AS_OF: finalized before it (an update after it may only have re-touched it)
  const rows = all.filter((r) => r.status !== "FINALIZED" || (r.finalized_at && toUtc(r.finalized_at).iso < toUtc(AS_OF).iso));
  // independent aggregates computed by RetailPilot's own database (named GROUP BY only)
  const agg = async (label, sql) => {
    try {
      const r = await spectra.queryAll(sql, 20);
      out("AGG", { label, rows: r });
      return r;
    } catch (e) {
      out("AGG", { label, error: String(e.message).slice(0, 200) });
      return null;
    }
  };
  const S = "public.stock_audit_count_session";
  const since = toUtc(SINCE).iso;
  await agg("store_finalized", `SELECT store_id, COUNT(*) AS finalized_sessions, COUNT(DISTINCT article_id) AS distinct_articles, COUNT(DISTINCT finalized_by) AS counters FROM ${S} WHERE status = 'FINALIZED' AND finalized_at >= '${since}' AND finalized_at < '${AS_OF}' GROUP BY store_id ORDER BY store_id`);
  await agg("store_status", `SELECT store_id, status, COUNT(*) AS n FROM ${S} WHERE updated_at >= '${since}' GROUP BY store_id, status ORDER BY store_id, status`);
  await agg("store_user_articles", `SELECT store_id, finalized_by, COUNT(DISTINCT article_id) AS distinct_articles, COUNT(*) AS sessions FROM ${S} WHERE status = 'FINALIZED' AND finalized_at >= '${since}' AND finalized_at < '${AS_OF}' GROUP BY store_id, finalized_by ORDER BY store_id, finalized_by`);
  await agg("repeat_finalized", `WITH d AS (SELECT store_id, article_id, COUNT(*) AS c, COUNT(DISTINCT finalized_by) AS users FROM ${S} WHERE status = 'FINALIZED' AND finalized_at >= '${since}' AND finalized_at < '${AS_OF}' GROUP BY store_id, article_id) SELECT c AS finalized_per_article, users, COUNT(*) AS articles FROM d WHERE c > 1 GROUP BY c, users ORDER BY c, users`);

  // the DNDS calculation on the very same rows (no allotment: none imported in production)
  const byRp = new Map(outlets.map((o) => [o.retailpilot_id, Number(o.outlet_id)]));
  const sessions = rows.map((r) => sessionRow(r, (rp) => (byRp.has(rp) ? byRp.get(rp) : null))).map((s) => ({
    ...s, finalized_at: s.finalized_at ? `${s.finalized_at.replace(" ", "T")}Z` : null, started_at: s.started_at ? `${s.started_at.replace(" ", "T")}Z` : null,
  }));
  const people = new Map(mapRows.map((m) => [m.rp_user_id, { employee_id: Number(m.employee_id), name: null }]));
  const cycles = PROGRAMME.map((o, i) => ({ cycle_id: 900 + i, outlet_id: o, name: "recon", period_code: "RECON", start_date: "2026-11-25", end_date: "2026-12-31", deadline: "2026-12-05", status: "OPEN" }));
  const stores = outlets.filter((o) => PROGRAMME.includes(Number(o.outlet_id))).map((o) => ({ outlet_id: Number(o.outlet_id), name: o.outlet_name, rp_id: o.retailpilot_id }));
  const now = new Date();
  const today = istDate(now.toISOString());
  const t0 = Date.now();
  const p = computePeriod({ cycles, stores, sessions, people, today, asOf: now.toISOString() });
  out("DNDS", {
    ms: Date.now() - t0,
    today,
    sessions_read: rows.length,
    stores: p.stores.map((s) => ({ outlet_id: s.outlet_id, rp: s.rp_id, audited_unique: s.audited, audited_today: s.audited_today, counters: s.employees.filter((e) => e.audited > 0).length, unmapped_counters: s.employees.filter((e) => e.audited > 0 && e.employee_id == null).length, shortage_qty: s.shortage_qty, excess_qty: s.excess_qty })),
    users_n: p.employees.filter((e) => e.audited > 0).length,
    eligibility: Object.entries(p.eligibility.reduce((t, r) => ((t[`${r.status}:${r.reasons.join("+")}`] = (t[`${r.status}:${r.reasons.join("+")}`] || 0) + 1), t), {})),
    warehouse_and_other_excluded: p.issues.outside_programme,
    before_effective_date: p.issues.before_effective_date,
  });
  // participation inputs: mapped employees of each store who counted
  const counted = new Set(p.employees.filter((e) => e.audited > 0 && e.employee_id != null).map((e) => `${e.outlet_id}|${e.employee_id}`));
  out("PARTICIPATION_INPUT", PROGRAMME.map((o) => ({ outlet_id: o, mapped_employees_who_counted: [...counted].filter((k) => k.startsWith(`${o}|`)).length })));
  // the supplied CSV's auditor: the articles RetailPilot shows them finalizing (article ids only)
  const mine = rows.filter((r) => r.store_id === CSV_AUDITOR.rp_store_id && (r.finalized_by || r.initiated_by) === CSV_AUDITOR.rp_user_id && r.status === "FINALIZED");
  out("CSV_AUDITOR", { sessions: mine.length, distinct_articles: new Set(mine.map((r) => Number(r.article_id))).size, days: Object.entries(mine.reduce((t, r) => ((t[istDate(r.finalized_at)] = (t[istDate(r.finalized_at)] || 0) + 1), t), {})) });

  // ---------------------------------------------------------------- 3b. per IST day, and booked differences
  const dayBounds = [];
  for (let t = Date.parse("2026-11-25T00:00:00+05:30"); t <= now.getTime(); t += 86400000) dayBounds.push([new Date(t).toISOString(), new Date(t + 86400000).toISOString(), istDate(new Date(t + 3600000).toISOString())]);
  const perDay = [];
  for (const [from, to, day] of dayBounds) {
    const r = await agg(`day_${day}`, `SELECT store_id, COUNT(DISTINCT article_id) AS distinct_articles FROM ${S} WHERE status = 'FINALIZED' AND finalized_at >= '${from}' AND finalized_at < '${to < AS_OF ? to : AS_OF}' GROUP BY store_id ORDER BY store_id`);
    perDay.push({ day, spectra: r });
  }
  // DNDS: the same day counts from the same rows (unique articles finalized that IST day)
  const dndsDays = {};
  for (const s of sessions.filter((x) => x.status === "FINALIZED" && x.finalized_at)) {
    const k = `${istDate(s.finalized_at)}|${s.rp_store_id}`;
    if (!dndsDays[k]) dndsDays[k] = new Set();
    dndsDays[k].add(s.article_id);
  }
  out("DNDS_DAYS", Object.entries(dndsDays).map(([k, v]) => ({ key: k, distinct_articles: v.size })).sort((x, y) => x.key.localeCompare(y.key)));
  const { adjustmentRow } = require("../../utils/stock_audit_mirror");
  const ledger = [];
  await spectra.queryKeyset((c, s2) => STREAMS.adjustment.build(c, s2), startCursor(null, { since: SINCE }), STREAMS.adjustment.cursorOf, async (page) => { ledger.push(...page); }, { size: 2000 });
  const markers = ledger.map(adjustmentRow).filter((a) => a.is_marker);
  const finalizedSlugs = new Map(sessions.filter((x) => x.status === "FINALIZED").map((x) => [x.rp_slug, x.rp_store_id]));
  const varBy = {};
  for (const m of markers) {
    const st = finalizedSlugs.get(m.session_slug);
    if (!st || m.var_qty == null) continue;
    varBy[st] = varBy[st] || { short_qty: 0, excess_qty: 0, short_value: 0, excess_value: 0, markers: 0 };
    varBy[st].markers += 1;
    if (m.var_qty < 0) { varBy[st].short_qty += -m.var_qty; varBy[st].short_value += -(m.var_value || 0); } else { varBy[st].excess_qty += m.var_qty; varBy[st].excess_value += m.var_value || 0; }
  }
  out("DNDS_VARIANCE", { ledger_rows: ledger.length, markers: markers.length, by_store: varBy });
  await agg("stkadj_nonmarker_by_store", `SELECT store_id, SUM(CASE WHEN quantity < 0 THEN -quantity ELSE 0 END) AS short_qty, SUM(CASE WHEN quantity > 0 THEN quantity ELSE 0 END) AS excess_qty, COUNT(*) AS rows_n FROM public.stock_ledgers WHERE action = 'STK_ADJ' AND quantity <> 0 AND ts >= '${since}' GROUP BY store_id ORDER BY store_id`);

  // ---------------------------------------------------------------- 1b. RDS backup settings (describe calls only; no identifiers printed)
  if (/\.rds\.amazonaws\.com$/i.test(host)) {
    const raw = sh("aws rds describe-db-instances --output json 2>&1 || true");
    let rds = { available: false, note: raw ? String(raw).slice(0, 160).replace(/arn:[^\s"]+/g, "<arn>") : "no output" };
    try {
      const inst = JSON.parse(raw).DBInstances.find((d) => d.Endpoint && d.Endpoint.Address === host);
      if (inst) {
        const snaps = sh(`aws rds describe-db-snapshots --db-instance-identifier ${JSON.stringify(inst.DBInstanceIdentifier)} --output json 2>&1 || true`);
        let snap = null;
        try {
          const list = JSON.parse(snaps).DBSnapshots || [];
          const by = (t) => list.filter((x) => x.SnapshotType === t);
          const latest = (l) => l.map((x) => x.SnapshotCreateTime).sort().pop() || null;
          snap = { automated: by("automated").length, manual: by("manual").length, latest_automated: latest(by("automated")), latest_manual: latest(by("manual")) };
        } catch (e) { snap = { note: String(snaps).slice(0, 160).replace(/arn:[^\s"]+/g, "<arn>") }; }
        rds = {
          available: true, engine: inst.Engine, engine_version: inst.EngineVersion, instance_class: inst.DBInstanceClass, multi_az: inst.MultiAZ,
          storage_type: inst.StorageType, allocated_gb: inst.AllocatedStorage, backup_retention_days: inst.BackupRetentionPeriod,
          backup_window_utc: inst.PreferredBackupWindow, latest_restorable_time: inst.LatestRestorableTime, deletion_protection: inst.DeletionProtection,
          storage_encrypted: inst.StorageEncrypted, snapshots: snap,
        };
      } else rds = { available: false, note: "no instance matched the configured endpoint" };
    } catch (e) { /* keep the note */ }
    out("RDS", rds);
  }

  // ---------------------------------------------------------------- 4. RECOUNT
  await agg("recount_links", `SELECT COUNT(*) AS sessions, COUNT(recount_slug) AS with_recount_slug, MAX(updated_at) AS latest FROM ${S}`);
  out("DONE", {});
  conn.end();
})().catch((e) => {
  out("FAILED", { message: String(e && e.message).slice(0, 300) });
  process.exit(1);
});
