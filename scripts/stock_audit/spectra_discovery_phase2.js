/**
 * Stock Audit discovery, PHASE 2 (read-only). Runs on the production host via
 * .github/workflows/stock-audit-spectra-discovery.yml, from
 * ~/dailyneeds-store-backend, reusing config/retailpilot.js (.env).
 *   - POST /spectra/query on the three tables report 6's base SQL names, to
 *     record whether this key's whitelist allows them (expect whitelist_violation)
 *   - GET  /spectra/reports/{6,13}: flags (store_scoped, excel_enabled, disabled)
 *   - POST /spectra/reports/6/run: small pages of every visual
 *   - POST /spectra/reports/6/export-raw: page 1, 25 rows, CSV + paging headers
 *   - GET  /spectra/reports/6/distinct for store_id / auditor_slug / variance_kind
 *   - GET  /spectra/reports/{61..100} on runway (definitions only)
 * Writes nothing. Never prints keys, hosts or headers. Resolved user names
 * (column_config.resolve) are redacted; Keypoint slugs (ids) are kept.
 */
const axios = require("axios");
const zlib = require("zlib");
const rp = require("./config/retailpilot");

const svc = { baseUrl: rp.baseUrl, key: rp.apiKey, product: rp.product };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (label, obj) => console.log(`@@${label} ${JSON.stringify(obj)}`);
const H = () => ({ "X-Authentication": svc.key, "X-Product": svc.product, "Content-Type": "application/json" });

async function call(method, path, data, params, raw = false) {
  const t0 = Date.now();
  try {
    const r = await axios({ method, url: `${svc.baseUrl}${path}`, data, params, headers: H(), timeout: 120000,
      validateStatus: () => true, responseType: raw ? "arraybuffer" : "json", decompress: true,
      maxContentLength: 200 * 1024 * 1024 });
    return { status: r.status, ms: Date.now() - t0, data: r.data, headers: r.headers };
  } catch (e) { return { status: 0, ms: Date.now() - t0, error: e.code || e.message }; }
}
const errInfo = (r) => { const d = r.data && typeof r.data === "object" && !Buffer.isBuffer(r.data) ? r.data : {};
  return { status: r.status, error: d.error || r.error || null, message: String(d.message || d.detail || "").slice(0, 800), hint: String(d.hint || "").slice(0, 3000) }; };
const pick = (h, re) => Object.fromEntries(Object.entries(h || {}).filter(([k]) => re.test(k)));

const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const from = new Date(Date.now() + 5.5 * 3600e3 - 119 * 86400e3).toISOString().slice(0, 10);
const PARAMS = { from_ts: from, to_ts: today };

function redactRows(rows, resolveCols) {
  return (rows || []).map((r) => { const o = { ...r }; for (const c of resolveCols) if (c in o && o[c] != null) o[c] = "<name redacted>"; return o; });
}

(async () => {
  out("START", { params: PARAMS });

  for (const t of ["public.stock_audit_count_session", "public.stock_audit_count_line", "public.stock_ledgers"]) {
    await sleep(700);
    const r = await call("POST", "/spectra/query", { query: `SELECT * FROM ${t} LIMIT 1`, page: 1, size: 1 });
    out("WHITELIST_CHECK", { table: t, status: r.status, ok: r.status === 200, columns: r.status === 200 ? r.data.meta : undefined, err: r.status === 200 ? undefined : errInfo(r) });
  }

  for (const n of [6, 13]) {
    await sleep(1100);
    const r = await call("GET", `/spectra/reports/${n}`);
    if (r.status === 200) {
      const d = r.data;
      out("REPORT_FLAGS", { report_no: n, store_scoped: d.store_scoped, excel_enabled: d.excel_enabled, disabled: d.disabled,
        disabled_reason: d.disabled_reason, is_builtin: d.is_builtin, hidden: d.hidden, retired: d.retired, feed: d.feed,
        sibling_of: d.sibling_of, updated_at: d.updated_at, column_docs: d.column_docs });
    } else out("REPORT_FLAGS_ERR", { report_no: n, ...errInfo(r) });
  }

  // Run every visual, page 1, 10 rows each.
  await sleep(1100);
  const run = await call("POST", "/spectra/reports/6/run", { params: PARAMS, size: 10 });
  if (run.status === 200) {
    out("RUN_META", { ms: run.ms, report: run.data.report, warnings: run.data.warnings });
    for (const v of run.data.visuals || []) {
      const res = v.result || {};
      const resolve = Object.keys((v.column_config || {}).resolve || {});
      out("RUN_VISUAL", { slug: v.viz_config.slug || null, kind: v.viz_config.kind, title: v.viz_config.title,
        resolve, pagination: res.pagination, output_columns: (res.meta || {}).output_columns,
        totals: (res.meta || {}).totals, truncated: (res.meta || {}).truncated, data: redactRows(res.data, resolve) });
    }
    const anyV = (run.data.visuals || [])[0];
    if (anyV) out("RUN_BASE_COLUMNS", { columns: ((anyV.result || {}).meta || {}).columns });
  } else out("RUN_ERR", errInfo(run));

  // Total row count of the audit log (one row per finalized session), via pagination.total
  for (const [label, p] of [["120d", PARAMS]]) {
    await sleep(1100);
    const r = await call("POST", "/spectra/reports/6/run", { params: p, visuals: ["audit_log"], size: 1 });
    out("AUDIT_LOG_TOTAL", { window: label, status: r.status, pagination: r.status === 200 ? r.data.visuals[0].result.pagination : errInfo(r) });
  }

  // Raw export, 25 rows
  await sleep(1100);
  const raw = await call("POST", "/spectra/reports/6/export-raw", { params: PARAMS, page: 1, size: 25 }, true);
  let text = "";
  if (raw.status === 200 && raw.data) {
    let buf = Buffer.from(raw.data);
    const gz = buf[0] === 0x1f && buf[1] === 0x8b;
    if (gz) buf = zlib.gunzipSync(buf);
    text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    const head = lines[0].split(",");
    const fb = head.indexOf("finalized_by");
    const red = lines.slice(1, 26).map((l) => { const c = l.split(","); if (fb >= 0 && c[fb]) c[fb] = "<id>"; return c.join(","); });
    out("EXPORT_RAW", { status: raw.status, ms: raw.ms, stillGzipAfterAxios: gz,
      headers: pick(raw.headers, /^(x-spectra-|content-type|content-disposition)/i), header_row: head, rows: red });
  } else out("EXPORT_RAW_ERR", { ...errInfo(raw), headers: pick(raw.headers, /^(x-spectra-|content-type|retry-after)/i),
    body: raw.data ? Buffer.from(raw.data).toString("utf8").slice(0, 800) : null });

  // Distinct values (counts only for user columns)
  for (const col of ["store_id", "variance_kind", "stock_location", "auditor_slug"]) {
    await sleep(1100);
    const r = await call("GET", "/spectra/reports/6/distinct", null, { col, params: JSON.stringify(PARAMS) });
    if (r.status === 200) {
      const v = r.data.values || [];
      out("DISTINCT", { col, count: v.length, truncated: r.data.truncated,
        values: col === "auditor_slug" ? v.slice(0, 5) : v.slice(0, 60), has_labels: Boolean(r.data.labels) });
    } else out("DISTINCT_ERR", { col, ...errInfo(r) });
  }

  // More runway reports
  let misses = 0;
  for (let n = 61; n <= 100; n++) {
    await sleep(1100);
    const r = await call("GET", `/spectra/reports/${n}`);
    if (r.status === 200) { misses = 0; out("REPORT", { report_no: n, name: r.data.name, section: r.data.section,
      visuals: (r.data.visuals || []).map((v) => (v.viz_config || {}).slug || null) }); }
    else if (++misses >= 12) break;
  }
  out("END", {});
})();
