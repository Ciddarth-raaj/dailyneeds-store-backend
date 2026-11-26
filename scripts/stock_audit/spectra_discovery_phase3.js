/**
 * Stock Audit discovery, PHASE 3 (read-only): direct SPECTRA SELECTs on the
 * stock audit tables report 6 reads, plus API behaviour tests. Runs on the
 * production host via the discovery workflow (mode phase3), reusing
 * config/retailpilot.js. Also counts (only counts) how many RetailPilot
 * auditor ids already have a row in the DNDS wh_rp_staff_map table.
 * Writes nothing anywhere. No keys, hosts or headers are printed.
 */
const fs = require("fs");
const axios = require("axios");
const zlib = require("zlib");
const rp = require("./config/retailpilot");

const svc = { baseUrl: rp.baseUrl, key: rp.apiKey, product: rp.product };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (label, obj) => console.log(`@@${label} ${JSON.stringify(obj)}`);
const H = { "X-Authentication": svc.key, "X-Product": svc.product, "Content-Type": "application/json" };

async function req(method, path, { data, params, raw } = {}) {
  const t0 = Date.now();
  try {
    const r = await axios({ method, url: `${svc.baseUrl}${path}`, data, params, headers: H, timeout: 120000,
      validateStatus: () => true, responseType: raw ? "arraybuffer" : "json", maxContentLength: 200 * 1024 * 1024 });
    return { status: r.status, ms: Date.now() - t0, data: r.data, headers: r.headers };
  } catch (e) { return { status: 0, ms: Date.now() - t0, error: e.code || e.message }; }
}
const errInfo = (r) => { const d = r.data && typeof r.data === "object" && !Buffer.isBuffer(r.data) ? r.data : {};
  return { status: r.status, error: d.error || r.error || null, message: String(d.message || d.detail || "").slice(0, 800), hint: String(d.hint || "").slice(0, 6000) }; };
const trunc = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
  v != null && typeof v === "object" ? JSON.stringify(v).slice(0, 2500) : typeof v === "string" && v.length > 300 ? v.slice(0, 300) + "..." : v]));

async function q(label, query, { page = 1, size = 50 } = {}) {
  await sleep(700);
  const r = await req("POST", "/spectra/query", { data: { query, page, size } });
  out("Q", { label, query: query.replace(/\s+/g, " ").trim(), status: r.status, ms: r.ms,
    ...(r.status === 200 ? { pagination: r.data.pagination, columns: (r.data.meta || {}).columns, rows: (r.data.data || []).map(trunc) } : { err: errInfo(r) }) });
  return r.status === 200 ? r.data.data : null;
}

const S = "public.stock_audit_count_session", L = "public.stock_audit_count_line", G = "public.stock_ledgers";

(async () => {
  out("START", {});
  // Whitelist: a table that does not exist -> whitelist_violation, whose hint lists what this key can read.
  await q("whitelist_hint", "SELECT 1 AS x FROM public.dnds_discovery_probe_nonexistent");

  // --- sessions
  await q("session_status", `SELECT status, COUNT(*) AS n, COUNT(recount_slug) AS with_recount_slug, COUNT(cancel_reason) AS with_cancel_reason,
      COUNT(finalized_by) AS with_finalized_by, MIN(started_at) AS first_started, MAX(updated_at) AS last_updated FROM ${S} GROUP BY status ORDER BY status`);
  await q("session_by_store_loc_action", `SELECT store_id, stock_location, net_adj_action, COUNT(*) AS n FROM ${S} GROUP BY store_id, stock_location, net_adj_action ORDER BY store_id, stock_location, net_adj_action`);
  await q("session_sample_recent", `SELECT * FROM ${S} ORDER BY updated_at DESC, slug ASC LIMIT 10`);
  await q("session_sample_oldest", `SELECT * FROM ${S} ORDER BY started_at ASC, slug ASC LIMIT 3`);
  await q("session_cancelled_sample", `SELECT slug, store_id, article_id, status, cancel_reason, initiated_by, started_at, updated_at FROM ${S} WHERE cancel_reason IS NOT NULL ORDER BY updated_at DESC, slug LIMIT 10`);
  await q("session_initiator_vs_finalizer", `SELECT CASE WHEN finalized_by IS NULL THEN 'no_finalizer' WHEN finalized_by = initiated_by THEN 'same_user' ELSE 'different_user' END AS who, status, COUNT(*) AS n FROM ${S} GROUP BY 1, 2 ORDER BY 1, 2`);
  // recount linkage, both directions
  await q("recount_forward", `WITH r AS (SELECT slug, recount_slug, store_id, article_id, stock_location, status, initiated_by, finalized_by, started_at, finalized_at FROM ${S} WHERE recount_slug IS NOT NULL)
      SELECT r.slug, r.recount_slug, r.store_id, r.article_id, r.status, r.initiated_by, r.finalized_by, r.finalized_at,
             o.status AS linked_status, o.initiated_by AS linked_initiated_by, o.finalized_by AS linked_finalized_by, o.started_at AS linked_started_at, o.finalized_at AS linked_finalized_at, o.recount_slug AS linked_recount_slug
      FROM r LEFT JOIN ${S} o ON o.slug = r.recount_slug ORDER BY r.finalized_at DESC NULLS LAST, r.slug LIMIT 15`);
  await q("recount_link_stats", `WITH r AS (SELECT s.slug, s.recount_slug, s.article_id, s.store_id FROM ${S} s WHERE s.recount_slug IS NOT NULL)
      SELECT COUNT(*) AS with_recount_slug, COUNT(o.slug) AS recount_slug_resolves_to_session,
             SUM(CASE WHEN o.article_id = r.article_id AND o.store_id = r.store_id THEN 1 ELSE 0 END) AS same_article_store
      FROM r LEFT JOIN ${S} o ON o.slug = r.recount_slug`);
  await q("finalized_repeat_counts", `WITH d AS (SELECT store_id, article_id, stock_location, COUNT(*) AS c FROM ${S} WHERE status = 'FINALIZED' GROUP BY store_id, article_id, stock_location)
      SELECT c AS finalized_sessions_per_store_article_loc, COUNT(*) AS n FROM d GROUP BY c ORDER BY c`);
  await q("monthly_volume", `SELECT DATE_TRUNC('month', started_at) AS month, status, COUNT(*) AS n, COUNT(DISTINCT article_id) AS articles, COUNT(DISTINCT initiated_by) AS users FROM ${S} GROUP BY 1, 2 ORDER BY 1, 2`);

  // --- lines
  await q("line_groups", `SELECT source, holding_type, status, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(updated_at) AS last_at FROM ${L} GROUP BY source, holding_type, status ORDER BY source, holding_type, status`);
  await q("line_sample", `SELECT * FROM ${L} ORDER BY updated_at DESC, slug ASC LIMIT 10`);
  await q("lines_per_session", `WITH c AS (SELECT session_slug, COUNT(*) AS n FROM ${L} GROUP BY session_slug) SELECT n AS lines_per_session, COUNT(*) AS sessions FROM c GROUP BY n ORDER BY n LIMIT 30`);
  await q("lines_of_one_recounted_session", `WITH r AS (SELECT slug, recount_slug FROM ${S} WHERE recount_slug IS NOT NULL AND status = 'FINALIZED' ORDER BY finalized_at DESC LIMIT 2)
      SELECT r.slug AS session, l.slug AS line, l.session_slug, l.counted_qty, l.snapshot_qty, l.source, l.status, l.holding_type, l.batch_id, l.created_at, l.updated_at
      FROM r JOIN ${L} l ON l.session_slug = r.slug OR l.session_slug = r.recount_slug ORDER BY r.slug, l.created_at, l.slug`);

  // --- ledger markers / adjustments
  await q("marker_sample", `WITH m AS (SELECT slug AS session_slug, marker_ledger_slug FROM ${S} WHERE status = 'FINALIZED' AND marker_ledger_slug IS NOT NULL ORDER BY finalized_at DESC LIMIT 3)
      SELECT m.session_slug, g.slug, g.action, g.ts, g.quantity, g.store_id, g.article_id, g.batch_id, g.stock_location, g.net_landing_cost, g.traceability
      FROM m JOIN ${G} g ON g.slug = m.marker_ledger_slug ORDER BY g.ts DESC, g.slug`);
  await q("stk_adj_recent_sample", `SELECT slug, action, ts, quantity, store_id, article_id, batch_id, stock_location, net_landing_cost, traceability FROM ${G}
      WHERE action = 'STK_ADJ' AND quantity <> 0 AND ts >= '2026-11-20' ORDER BY ts DESC, slug LIMIT 5`);
  await q("ledger_actions_7d", `SELECT action, COUNT(*) AS n FROM ${G} WHERE ts >= '2026-11-19' GROUP BY action ORDER BY n DESC`);

  // --- incremental read shape
  await q("incremental_probe", `SELECT slug, status, updated_at FROM ${S} WHERE updated_at >= '2026-11-26' ORDER BY updated_at ASC, slug ASC`, { size: 5 });

  // --- API behaviour
  await q("t_union_all", `SELECT 'a' AS k FROM ${S} WHERE slug = 'x' UNION ALL SELECT 'b' AS k FROM ${S} WHERE slug = 'y'`);
  await q("t_offset", `SELECT slug FROM ${S} ORDER BY slug LIMIT 5 OFFSET 5`);
  await q("t_subquery", `SELECT slug FROM ${S} WHERE article_id IN (SELECT article_id FROM ${L} LIMIT 1)`);
  await q("t_size_cap", `SELECT slug FROM ${S} ORDER BY slug`, { size: 5000 });
  await q("t_limit_vs_size", `SELECT slug FROM ${S} ORDER BY slug LIMIT 3`, { size: 100 });
  await q("t_page2", `SELECT slug FROM ${S} ORDER BY slug`, { page: 2, size: 3 });

  // --- report 6 raw export (fixed) and visual export
  for (const [label, path, body] of [
    ["export_raw", "/spectra/reports/6/export-raw", { params: { from_ts: "2026-11-25", to_ts: "2026-11-26" }, page: 1, size: 5 }],
    ["export_visual_audit_log", "/spectra/reports/6/export", { params: { from_ts: "2026-11-25", to_ts: "2026-11-26" }, visual_index: 12, page: 1, size: 5 }],
  ]) {
    await sleep(1200);
    const r = await req("POST", path, { data: body, raw: true });
    let text = null, gz = null;
    if (r.data) { let b = Buffer.from(r.data); gz = b[0] === 0x1f && b[1] === 0x8b; try { if (gz) b = zlib.gunzipSync(b); } catch (e) {} text = b.toString("utf8"); }
    const hdr = Object.fromEntries(Object.entries(r.headers || {}).filter(([k]) => /^(x-spectra-|content-type|content-disposition|retry-after)/i.test(k)));
    const lines = (text || "").split(/\r?\n/);
    const head = (lines[0] || "").split(",");
    const fb = head.indexOf("finalized_by");
    out("EXPORT", { label, status: r.status, ms: r.ms, still_gzip_after_client: gz, headers: hdr, header_row: head,
      rows: r.status === 200 ? lines.slice(1, 6).map((l) => { const c = l.split(","); if (fb >= 0 && c[fb]) c[fb] = "<redacted>"; return c.join(","); }) : undefined,
      err: r.status === 200 ? undefined : String(text || r.error || "").slice(0, 800) });
  }

  // --- DNDS side (counts only): auditor ids already in wh_rp_staff_map
  try {
    const auditors = await q("auditors_all", `SELECT DISTINCT COALESCE(finalized_by, initiated_by) AS auditor FROM ${S} WHERE status = 'FINALIZED' ORDER BY 1`, { size: 2000 });
    const env = process.env.API_ENV || "development";
    const cfg = JSON.parse(fs.readFileSync("config.json", "utf8")).db.mysql[env];
    const mysql = require("mysql");
    const conn = mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.username, password: cfg.password, database: cfg.database });
    const ids = (auditors || []).map((a) => a.auditor).filter(Boolean);
    conn.query("SELECT COUNT(*) AS in_map, SUM(employee_id IS NOT NULL) AS mapped_to_employee FROM wh_rp_staff_map WHERE rp_user_id IN (?)", [ids.length ? ids : ["-"]], (err, rows) => {
      out("DNDS_STAFF_MAP_OVERLAP", err ? { error: err.code } : { auditors_in_retailpilot: ids.length, ...rows[0] });
      conn.query("SELECT COUNT(*) AS total_rows, SUM(employee_id IS NOT NULL) AS mapped FROM wh_rp_staff_map", (e2, r2) => {
        out("DNDS_STAFF_MAP_SIZE", e2 ? { error: e2.code } : r2[0]);
        conn.query("SELECT outlet_name, retailpilot_id FROM outlets WHERE retailpilot_id IS NOT NULL ORDER BY outlet_id", (e3, r3) => {
          out("DNDS_BRANCH_MAP", e3 ? { error: e3.code } : r3);
          conn.end(); out("END", {});
        });
      });
    });
  } catch (e) { out("DNDS_ERR", { error: e.message }); out("END", {}); }
})();
