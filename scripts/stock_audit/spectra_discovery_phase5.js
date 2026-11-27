/**
 * Stock Audit - read-only discovery, phase 5: probe for an UNPUBLISHED audit-cycle
 * table (the audit tables themselves are queryable but absent from /spectra/schema).
 * SELECT only; each probe is one LIMIT-1 query; the error tells "no such table"
 * from "not allowed". Writes nothing. Values redacted except ids / dates / status.
 */
const axios = require("axios");
const rp = require("./config/retailpilot");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (label, obj) => console.log(`@@${label} ${JSON.stringify(obj)}`);
const svc = { baseUrl: rp.baseUrl, key: rp.apiKey, product: rp.product };
const KEEP = /(_id|_at|_date|_on|_code|_no|status|slug|^id$|name|title|deadline|start|end|store)/i;
const query = async (sql) => {
  try {
    const r = await axios({ method: "POST", url: `${svc.baseUrl}/spectra/query`, data: { query: sql, page: 1, size: 5 }, timeout: 60000, validateStatus: () => true,
      headers: { "X-Authentication": svc.key, "X-Product": svc.product, "Content-Type": "application/json" } });
    const d = r.data || {};
    if (r.status === 200 && Array.isArray(d.data)) return { ok: true, rows: d.data.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, KEEP.test(k) ? (typeof v === "object" && v ? JSON.stringify(v).slice(0, 160) : v) : v == null ? null : "<value>"]))), columns: d.meta && d.meta.columns };
    return { ok: false, status: r.status, error: d.error || null, detail: String(d.detail || d.message || "").slice(0, 220) };
  } catch (e) { return { ok: false, error: e.code || e.message }; }
};
const NAMES = [];
for (const s of ["public", "audit", "inventory", "stock_audit"]) for (const t of ["stock_audit_cycle", "stock_audit_cycles", "stock_audit_plan", "stock_audit_plans", "stock_audit_campaign", "stock_audit_campaigns", "stock_audit_round", "stock_audit_rounds", "stock_audit_schedule", "stock_audit_schedules", "stock_audit_assignment", "stock_audit_assignments", "stock_audit_assortment", "stock_audit_assortments", "stock_audit_allotment", "stock_audit_allotments", "stock_audit_task", "stock_audit_tasks", "stock_audit_event", "stock_audits", "stock_audit", "audit_cycles", "audit_cycle", "audit_plans", "stock_takes", "stock_take", "cycle_counts", "count_cycles", "stock_audit_effective", "assortment_effective", "stock_audit_recount", "stock_audit_recounts"]) NAMES.push(`${s}.${t}`);
(async () => {
  out("START", { at: new Date().toISOString(), probes: NAMES.length });
  for (const sql of [
    "SELECT table_schema, table_name FROM information_schema.tables WHERE table_name LIKE '%audit%' OR table_name LIKE '%cycle%' OR table_name LIKE '%assort%' ORDER BY 1, 2",
    "SELECT schemaname, tablename FROM pg_catalog.pg_tables WHERE tablename LIKE '%audit%' OR tablename LIKE '%cycle%' ORDER BY 1, 2",
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'stock_audit%' ORDER BY 1, 2",
  ]) { await sleep(700); out("CATALOG", { sql: sql.slice(0, 70), r: await query(sql) }); }
  const found = [];
  for (const t of NAMES) {
    await sleep(600);
    const r = await query(`SELECT * FROM ${t} LIMIT 3`);
    if (r.ok) { found.push(t); out("FOUND", { table: t, ...r }); }
    else out("PROBE", { table: t, status: r.status, error: r.error, detail: r.detail });
  }
  // the session slug format: does it embed a cycle / plan reference? and recount_slug usage
  out("SESSION_SLUGS", await query("SELECT slug, recount_slug, marker_ledger_slug, net_adj_action, stock_location FROM public.stock_audit_count_session WHERE finalized_at >= '2026-11-25' ORDER BY finalized_at LIMIT 3"));
  out("END", { found });
})();
