/**
 * Stock Audit - read-only discovery, phase 4: AUDIT CYCLES.
 * Does RetailPilot hold the audit cycle (id, name, dates, deadline, stores,
 * status) and does each count link to it? Same transport and safeguards as
 * spectra_discovery.js: GET /spectra/schema, POST /spectra/query (SELECT),
 * GET /spectra/reports[/n]. Writes nothing. Personal values redacted.
 */
const axios = require("axios");
const rp = require("./config/retailpilot");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (label, obj) => console.log(`@@${label} ${JSON.stringify(obj)}`);
const SERVICES = [
  { name: "runway", baseUrl: rp.baseUrl, key: rp.apiKey, product: rp.product },
  { name: "masterhub", baseUrl: rp.masterhubBaseUrl, key: rp.apiKey, product: rp.masterhubProduct },
  { name: "Mandapam", baseUrl: rp.salesBaseUrl, key: rp.salesApiKey, product: rp.salesProduct },
];
const CYCLE_RE = /cycle|campaign|round|plan|period|schedul|deadline|due_|window|assort|allot|assign|audit|count_sess|stock_take|stocktake|physical|wave|batch_audit|season/i;
const PII_RE = /name|phone|mobile|email|address|pan|aadha|password|token|secret|api_?key|otp|dob|birth|salary|account|ifsc|photo|image|signature/i;
const KEEP_RE = /(_id|_code|_no|_number|_status|_type|uuid|_at|_date|_on)$|^id$|^slug$|store_name|cycle_name|plan_name|^title$|^status$/i;
const call = async (svc, method, path, data, params) => {
  try {
    const r = await axios({ method, url: `${svc.baseUrl}${path}`, data, params, timeout: 60000, validateStatus: () => true,
      headers: { "X-Authentication": svc.key, "X-Product": svc.product, "Content-Type": "application/json" } });
    return { status: r.status, data: r.data };
  } catch (e) { return { status: 0, error: e.code || e.message }; }
};
const errInfo = (r) => { const d = r.data && typeof r.data === "object" ? r.data : {}; return { status: r.status, error: d.error || r.error || null, message: String(d.message || d.detail || "").slice(0, 300) }; };
const clean = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v == null ? v : PII_RE.test(k) && !KEEP_RE.test(k) ? "<redacted>" : typeof v === "object" ? JSON.stringify(v).slice(0, 160) : typeof v === "string" && v.length > 100 ? v.slice(0, 100) + "..." : v]));
const tablesOf = (s) => { const t = s && (s.tables || s.data || s); if (Array.isArray(t)) return t; return Object.entries(t || {}).map(([k, v]) => ({ ...(v && typeof v === "object" ? v : {}), _key: k })); };
const tName = (t) => t._key || t.full_name || (t.schema ? `${t.schema}.${t.name}` : t.name || t.table);
const colsOf = (t) => { const c = t.columns || []; return Array.isArray(c) ? c : Object.entries(c).map(([k, v]) => ({ ...(v && typeof v === "object" ? v : { type: v }), name: (v && v.name) || k })); };

async function service(svc) {
  if (!svc.baseUrl || !svc.key) return out("SERVICE_SKIPPED", { service: svc.name });
  const full = await call(svc, "GET", "/spectra/schema", null, { include_descriptions: true });
  if (full.status !== 200) return out("SCHEMA_ERROR", { service: svc.name, ...errInfo(full) });
  const tables = tablesOf(full.data);
  out("ALL_TABLES", { service: svc.name, count: tables.length, names: tables.map(tName) });
  // tables whose NAME or DESCRIPTION looks like a cycle / plan / audit; and any COLUMN anywhere that does
  const byName = tables.filter((t) => CYCLE_RE.test(tName(t)) || /audit|cycle|stock take|stocktake|physical/i.test(String(t.description || "")));
  const colHits = [];
  for (const t of tables) for (const c of colsOf(t)) if (/cycle|campaign|audit_plan|audit_id|plan_id|deadline|due_date|assortment|round_id|stock_take/i.test(c.name)) colHits.push(`${tName(t)}.${c.name}`);
  out("COLUMN_HITS", { service: svc.name, n: colHits.length, columns: colHits });
  for (const t of byName) {
    out("TABLE_DETAIL", { service: svc.name, table: tName(t), tags: t.tags || null, description: t.description ? String(t.description).slice(0, 400) : null,
      relations: t.relations || t.foreign_keys || null,
      columns: colsOf(t).map((c) => ({ n: c.name, ty: c.type || c.data_type, d: c.description ? String(c.description).slice(0, 160) : undefined })) });
  }
  // samples of the candidate tables (count + 5 rows)
  for (const t of byName.slice(0, 25)) {
    const name = tName(t);
    await sleep(700);
    const cnt = await call(svc, "POST", "/spectra/query", { query: `SELECT COUNT(*) AS n FROM ${name}`, page: 1, size: 1 });
    await sleep(700);
    const cols = colsOf(t).map((c) => c.name);
    const order = cols.includes("updated_at") ? "updated_at DESC" : cols.includes("created_at") ? "created_at DESC" : cols[0];
    const s = await call(svc, "POST", "/spectra/query", { query: `SELECT * FROM ${name} ORDER BY ${order} LIMIT 5`, page: 1, size: 5 });
    out("SAMPLE", { service: svc.name, table: name, count: cnt.status === 200 ? (cnt.data.data || [])[0] : errInfo(cnt), rows: s.status === 200 ? (s.data.data || []).map(clean) : errInfo(s) });
  }
  // MOSAIC reports: the index if there is one, then definitions 1..60
  const idx = await call(svc, "GET", "/spectra/reports");
  out("REPORT_INDEX", { service: svc.name, status: idx.status, body: idx.status === 200 ? JSON.stringify(idx.data).slice(0, 6000) : errInfo(idx) });
  let misses = 0;
  for (let n = 1; n <= 60; n++) {
    await sleep(1100);
    const r = await call(svc, "GET", `/spectra/reports/${n}`);
    if (r.status !== 200 || !r.data || typeof r.data !== "object") { if (r.status === 401 || r.status === 403 || ++misses >= 12) break; continue; }
    misses = 0;
    const d = r.data.report || r.data;
    const vis = (d.visuals || r.data.visuals || []).map((v) => (v.viz_config || v).slug || (v.viz_config || v).title || null);
    out("REPORT", { service: svc.name, n, name: d.name || null, section: d.section || null, params: d.bind_param_schema || r.data.bind_param_schema || null, visuals: vis });
    const text = JSON.stringify(r.data);
    if (/audit|cycle|stock.?take|physical|count_session|assort/i.test(text)) out("REPORT_AUDIT_DEF", { service: svc.name, n, def: text.slice(0, 15000) });
  }
}
(async () => {
  out("START", { at: new Date().toISOString() });
  // the count-session table: EVERY column RetailPilot exposes (the sync selects only some)
  const runway = SERVICES[0];
  const one = await call(runway, "POST", "/spectra/query", { query: "SELECT * FROM public.stock_audit_count_session ORDER BY updated_at DESC LIMIT 3", page: 1, size: 3 });
  out("SESSION_ALL_COLUMNS", one.status === 200 ? { columns: Object.keys((one.data.data || [])[0] || {}), meta: one.data.meta || null, rows: (one.data.data || []).map(clean) } : errInfo(one));
  const line = await call(runway, "POST", "/spectra/query", { query: "SELECT * FROM public.stock_audit_count_line ORDER BY updated_at DESC LIMIT 2", page: 1, size: 2 });
  out("LINE_ALL_COLUMNS", line.status === 200 ? { columns: Object.keys((line.data.data || [])[0] || {}) } : errInfo(line));
  for (const svc of SERVICES) { try { await service(svc); } catch (e) { out("SERVICE_FAIL", { service: svc.name, error: e.message }); } }
  out("END", { at: new Date().toISOString() });
})();
