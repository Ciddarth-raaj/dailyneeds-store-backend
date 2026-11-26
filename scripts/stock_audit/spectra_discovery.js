/**
 * Stock Audit - RetailPilot SPECTRA / MOSAIC read-only DISCOVERY.
 *
 * Runs on the production host from ~/dailyneeds-store-backend (piped to
 * `node -` by .github/workflows/stock-audit-spectra-discovery.yml) so it uses
 * the existing config/retailpilot.js (.env) and the same headers as
 * services/retailpilot_spectra.js. It never writes anything anywhere:
 *   GET  /spectra/schema            (documented, 60/min)
 *   POST /spectra/query             (documented, SELECT only, 120/min)
 *   GET  /spectra/reports/{n}       (documented report definition)
 * Keys, URLs' hosts and request headers are never printed. Sample values of
 * personal columns are redacted.
 */
const axios = require("axios");
const rp = require("./config/retailpilot");

const MODE = process.env.DISCOVERY_MODE || "full";
const REPORT_MAX = parseInt(process.env.DISCOVERY_REPORT_MAX || "60", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (label, obj) => console.log(`@@${label} ${JSON.stringify(obj)}`);

const SERVICES = [
  { name: "runway", baseUrl: rp.baseUrl, key: rp.apiKey, product: rp.product },
  { name: "masterhub", baseUrl: rp.masterhubBaseUrl, key: rp.apiKey, product: rp.masterhubProduct },
  { name: "Mandapam", baseUrl: rp.salesBaseUrl, key: rp.salesApiKey, product: rp.salesProduct },
];

const AUDIT_RE = /audit|count|physical|inventor|stock|verif|allot|assign|adjust|varian|recount|cycle|shrink|damage|movement|ledger|user|staff|employee|member|role|reconcil|discrep|tally|check/i;
const PII_RE = /name|phone|mobile|email|mail|address|pan|aadhaar|aadhar|password|passwd|token|secret|api_?key|otp|dob|birth|salary|account|ifsc|photo|image|signature/i;
const KEEP_RE = /(_id|_code|_no|_number|_status|_type|uuid)$|^id$|article_name|store_name|^status$/i;

function pathOnly(u) { try { return new URL(u).pathname; } catch (e) { return "(unparsable)"; } }

async function call(svc, method, path, data, params) {
  const t0 = Date.now();
  try {
    const r = await axios({
      method, url: `${svc.baseUrl}${path}`, data, params,
      headers: { "X-Authentication": svc.key, "X-Product": svc.product, "Content-Type": "application/json" },
      timeout: 60000, maxContentLength: 200 * 1024 * 1024,
      validateStatus: () => true,
    });
    return { status: r.status, ms: Date.now() - t0, data: r.data,
      encoding: r.headers["content-encoding"] || null, type: r.headers["content-type"] || null,
      retryAfter: r.headers["retry-after"] || null };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: e.code || e.message };
  }
}

function errInfo(r) {
  const d = r.data && typeof r.data === "object" ? r.data : {};
  return { status: r.status, error: d.error || r.error || null,
    message: String(d.message || d.detail || "").slice(0, 600), hint: String(d.hint || "").slice(0, 1500) };
}

function sanitizeRow(row) {
  const o = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null) { o[k] = v; continue; }
    if (PII_RE.test(k) && !KEEP_RE.test(k)) { o[k] = "<redacted>"; continue; }
    if (typeof v === "string" && v.length > 80) { o[k] = v.slice(0, 80) + "..."; continue; }
    if (typeof v === "object") { o[k] = JSON.stringify(v).slice(0, 120); continue; }
    o[k] = v;
  }
  return o;
}

function tablesOf(schema) {
  if (!schema) return [];
  const t = Array.isArray(schema) ? schema : schema.tables || schema.data || [];
  if (Array.isArray(t)) return t;
  // SPECTRA returns { tables: { "<schema.table>": { ...definition } } }
  return Object.entries(t).map(([k, v]) => ({ ...(v && typeof v === "object" ? v : { value: v }), _key: k }));
}
function tName(t) { return t._key || t.full_name || t.qualified_name || (t.schema ? `${t.schema}.${t.name}` : t.name || t.table); }
function colsOf(t) {
  const c = t.columns || [];
  if (Array.isArray(c)) return c;
  return Object.entries(c).map(([k, v]) => ({ ...(v && typeof v === "object" ? v : { type: v }), name: (v && v.name) || k }));
}

async function discoverService(svc) {
  if (!svc.baseUrl || !svc.key) { out("SERVICE_SKIPPED", { service: svc.name, reason: "not configured" }); return; }
  out("SERVICE", { service: svc.name, path: pathOnly(svc.baseUrl), product: svc.product });

  // 1. Full schema with descriptions
  const full = await call(svc, "GET", "/spectra/schema", null, { include_descriptions: true });
  out("SCHEMA_STATUS", { service: svc.name, status: full.status, ms: full.ms, encoding: full.encoding, type: full.type,
    topKeys: full.data && typeof full.data === "object" ? Object.keys(full.data).slice(0, 20) : typeof full.data });
  if (full.status !== 200) { out("SCHEMA_ERROR", { service: svc.name, ...errInfo(full) }); return; }
  const tables = tablesOf(full.data);
  out("TABLE_LIST", { service: svc.name, count: tables.length,
    tables: tables.map((t) => ({ t: tName(t), tags: t.tags || t.scope_tags || null, cols: colsOf(t).length,
      d: t.description ? String(t.description).slice(0, 160) : null })) });
  if (tables[0]) out("TABLE_SHAPE_EXAMPLE", { service: svc.name, keys: Object.keys(tables[0]),
    columnKeys: colsOf(tables[0])[0] ? Object.keys(colsOf(tables[0])[0]) : null,
    raw: JSON.stringify(tables[0]).slice(0, 2500), cached_at: full.data.cached_at || null });

  // 2. Tag scopes (names only)
  for (const tags of ["store", "chain", "store,transactions", "store,staff", "chain,catalog", "store,inventory", "store,audit"]) {
    await sleep(1100);
    const r = await call(svc, "GET", "/spectra/schema", null, { tags });
    out("TAG_SCOPE", { service: svc.name, tags, status: r.status,
      tables: r.status === 200 ? tablesOf(r.data).map(tName) : errInfo(r) });
  }

  // 3. Full detail of candidate tables
  const cands = tables.filter((t) => AUDIT_RE.test(tName(t)) || AUDIT_RE.test(String(t.description || "")));
  for (const t of cands) {
    out("TABLE_DETAIL", { service: svc.name, table: tName(t), tags: t.tags || null, description: t.description || null,
      primary_key: t.primary_key || t.primary_keys || null, relations: t.relations || t.foreign_keys || null, other_keys: Object.keys(t).filter((k) => !['columns','description','tags','relations','constraints','primary_key','_key'].includes(k)),
      constraints: t.constraints || null,
      columns: colsOf(t).map((c) => ({ n: c.name, ty: c.type || c.data_type, nul: c.nullable, pk: c.primary_key || c.is_primary_key || undefined,
        d: c.description ? String(c.description).slice(0, 200) : undefined })) });
  }

  if (MODE === "schema") return;

  // 4. Samples + counts (10 rows, stable order on the first PK / id column)
  for (const t of cands.slice(0, 40)) {
    const name = tName(t);
    const cols = colsOf(t).map((c) => c.name);
    const pk = colsOf(t).filter((c) => c.primary_key || c.is_primary_key).map((c) => c.name);
    const order = pk.length ? pk : cols.includes("id") ? ["id"] : cols.slice(0, 1);
    await sleep(600);
    const cnt = await call(svc, "POST", "/spectra/query", { query: `SELECT COUNT(*) AS n FROM ${name}`, page: 1, size: 1 });
    await sleep(600);
    const q = `SELECT * FROM ${name} ORDER BY ${order.join(", ")} LIMIT 10`;
    const s = await call(svc, "POST", "/spectra/query", { query: q, page: 1, size: 10 });
    out("SAMPLE", { service: svc.name, table: name,
      count: cnt.status === 200 && cnt.data.data ? cnt.data.data[0] : errInfo(cnt),
      query: q, status: s.status, encoding: s.encoding,
      pagination: s.status === 200 ? s.data.pagination : undefined,
      rows: s.status === 200 ? (s.data.data || []).map(sanitizeRow) : errInfo(s) });
  }

  // 5. MOSAIC report definitions (documented GET /spectra/reports/{n})
  const found = [];
  let misses = 0;
  for (let n = 1; n <= REPORT_MAX; n++) {
    await sleep(1100);
    const r = await call(svc, "GET", `/spectra/reports/${n}`);
    if (r.status === 200 && r.data && typeof r.data === "object") {
      misses = 0;
      const d = r.data.report || r.data;
      const visuals = (d.visuals || r.data.visuals || []).map((v, i) => ({ i, kind: (v.viz_config || v).kind, slug: (v.viz_config || v).slug || null, title: (v.viz_config || v).title || null }));
      const rec = { service: svc.name, report_no: n, name: d.name || null, section: d.section || null,
        keys: Object.keys(r.data).slice(0, 30), bind_param_schema: d.bind_param_schema || r.data.bind_param_schema || null,
        bind_constraints: d.bind_constraints || r.data.bind_constraints || null, visuals };
      found.push(rec);
      out("REPORT", rec);
      if (/audit|stock|count|inventor|physical|verif|varian/i.test(`${rec.name} ${rec.section}`)) {
        out("REPORT_FULL_DEF", { service: svc.name, report_no: n, def: JSON.stringify(r.data).slice(0, 20000) });
      }
    } else {
      out("REPORT_MISS", { service: svc.name, report_no: n, ...errInfo(r) });
      if (r.status === 401 || r.status === 403) { out("REPORT_STOP", { service: svc.name, reason: "auth" }); break; }
      if (++misses >= 15) break;
    }
  }
  out("REPORT_SUMMARY", { service: svc.name, found: found.length });
}

(async () => {
  out("START", { mode: MODE, at: new Date().toISOString() });
  for (const svc of SERVICES) {
    try { await discoverService(svc); } catch (e) { out("SERVICE_FAIL", { service: svc.name, error: e.message }); }
  }
  out("END", { at: new Date().toISOString() });
})();
