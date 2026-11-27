// Stock Audit Stage 4 - READ-ONLY validation ON THE SERVER (backend dir).
// RetailPilot source (SPECTRA SELECTs) vs the DNDS mirror, plus the figures the
// screens / HR PDF would show for 25 Nov - today, computed by the application's
// own usecase over an IN-MEMORY audit window (no cycle is created or stored).
// Also: schema check of the three source streams, and the administrator
// account review. Prints counts and ids only - no names.
// Usage: node stage4_validate.js <source|full>
global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
const cwd = process.cwd(); const R = (p) => require(cwd + p);
const out = (k, v) => console.log(`@@${k} ${JSON.stringify(v)}`);
const PROGRAMME = [3, 4, 5, 6, 7];
const SINCE_ISO = "2026-11-24T18:30:00.000000Z"; const SINCE_SQL = "2026-11-24 18:30:00";
const EXPECTED = {
  session: "slug,store_id,article_id,stock_location,status,initiated_by,finalized_by,started_at,finalized_at,updated_at,net_adj_action,marker_ledger_slug,recount_slug,cancel_reason",
  line: "slug,session_slug,stock_location,batch_id,mrp,counted_qty,snapshot_qty,snapshot_cells,source,holding_type,status,created_at,updated_at",
};
(async () => {
  const mode = process.argv[2] || "source";
  const db = await R("/drivers/mysql")().connect();
  const q = (sql, p = []) => new Promise((res) => db.connection.query(sql, p, (e, r) => res(e ? { error: e.code } : r)));
  const F = R("/services/retailpilot_spectra");
  const spectra = F({ ...R("/config/retailpilot"), retry: F.DEFAULT_RETRY });
  const { STREAMS, startCursor, toUtc } = R("/utils/stock_audit_queries");
  const { istDate } = R("/utils/stock_audit_activity");
  const agg = async (sql) => { try { return await spectra.queryAll(sql, 50); } catch (e) { return { error: String(e.message).slice(0, 160) }; } };
  try {
    const outlets = await q("SELECT outlet_id, retailpilot_id AS rp FROM outlets WHERE retailpilot_id IS NOT NULL AND retailpilot_id <> ''");
    const rpOf = new Map(outlets.map((o) => [String(o.rp), Number(o.outlet_id)]));
    const lastRun = await q("SELECT run_id, kind, status, started_at, finished_at FROM sa_sync_run ORDER BY run_id DESC LIMIT 1");
    // one cut-off for both sides: the start of the last successful HISTORICAL run (else now - 1 min)
    const hist = await q("SELECT DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.000000Z') AS t FROM sa_sync_run WHERE kind = 'HISTORICAL' AND status = 'SUCCESS' ORDER BY run_id DESC LIMIT 1");
    const AS_OF = mode === "full" && hist.length ? hist[0].t : new Date(Date.now() - 60000).toISOString();
    const AS_OF_SQL = toUtc(AS_OF).sql;
    out("WINDOW", { since_ist: "2026-11-25 00:00", as_of_utc: AS_OF, last_run: lastRun });

    // ---- 1. source schema: each stream's columns and the session statuses seen
    for (const s of ["session", "line"]) {
      const rows = await agg(STREAMS[s].build(startCursor(null, { since: SINCE_ISO }), 1));
      const got = Array.isArray(rows) && rows[0] ? Object.keys(rows[0]).join(",") : (rows && rows.error) || "no rows";
      out("SCHEMA", { stream: s, ok: got === EXPECTED[s], got: got === EXPECTED[s] ? "as expected" : got });
    }
    const adj = await agg(STREAMS.adjustment.build(startCursor(null, { since: SINCE_ISO }), 1));
    out("SCHEMA", { stream: "adjustment", columns: Array.isArray(adj) && adj[0] ? Object.keys(adj[0]).join(",") : adj });

    // ---- 2. source aggregates (RetailPilot's own database)
    const S = "public.stock_audit_count_session"; const L = "public.stock_audit_count_line";
    const src = {};
    src.by_store_status = await agg(`SELECT store_id, status, COUNT(*) AS n FROM ${S} WHERE updated_at >= '${SINCE_ISO}' AND updated_at < '${AS_OF}' GROUP BY store_id, status ORDER BY store_id, status`);
    src.finalized = await agg(`SELECT store_id, COUNT(*) AS sessions, COUNT(DISTINCT article_id) AS articles, COUNT(DISTINCT finalized_by) AS counters FROM ${S} WHERE status = 'FINALIZED' AND finalized_at >= '${SINCE_ISO}' AND finalized_at < '${AS_OF}' GROUP BY store_id ORDER BY store_id`);
    src.recounts = await agg(`SELECT store_id, COUNT(*) AS n FROM ${S} WHERE updated_at >= '${SINCE_ISO}' AND updated_at < '${AS_OF}' AND recount_slug IS NOT NULL AND recount_slug <> '' GROUP BY store_id ORDER BY store_id`);
    src.lines = await agg(`SELECT COUNT(*) AS n FROM ${L} WHERE updated_at >= '${SINCE_ISO}' AND updated_at < '${AS_OF}'`);
    src.per_user = await agg(`SELECT store_id, finalized_by, COUNT(*) AS sessions, COUNT(DISTINCT article_id) AS articles FROM ${S} WHERE status = 'FINALIZED' AND finalized_at >= '${SINCE_ISO}' AND finalized_at < '${AS_OF}' GROUP BY store_id, finalized_by ORDER BY store_id, finalized_by`);
    const named = (rows) => (Array.isArray(rows) ? rows.map((r) => ({ ...r, outlet_id: rpOf.has(String(r.store_id)) ? rpOf.get(String(r.store_id)) : null })) : rows);
    out("SRC_STORE_STATUS", named(src.by_store_status));
    out("SRC_FINALIZED", named(src.finalized));
    out("SRC_RECOUNTS", src.recounts);
    out("SRC_LINES", src.lines);
    const nonProgramme = Array.isArray(src.by_store_status) ? src.by_store_status.filter((r) => !PROGRAMME.includes(rpOf.get(String(r.store_id)))) : [];
    out("SRC_WAREHOUSE_OR_OTHER", { sessions: nonProgramme.reduce((t, r) => t + Number(r.n), 0), stores: [...new Set(nonProgramme.map((r) => `${r.store_id}->outlet ${rpOf.get(String(r.store_id)) ?? "none"}`))] });
    // daily unique articles per store, per IST day (source)
    const srcDays = {};
    for (let t = Date.parse("2026-11-25T00:00:00+05:30"); t < Date.parse(AS_OF); t += 86400000) {
      const from = new Date(t).toISOString(); const to = new Date(Math.min(t + 86400000, Date.parse(AS_OF))).toISOString();
      const r = await agg(`SELECT store_id, COUNT(DISTINCT article_id) AS articles FROM ${S} WHERE status = 'FINALIZED' AND finalized_at >= '${from}' AND finalized_at < '${to}' GROUP BY store_id ORDER BY store_id`);
      srcDays[istDate(new Date(t + 3600000).toISOString())] = Array.isArray(r) ? Object.fromEntries(r.map((x) => [rpOf.get(String(x.store_id)) ?? x.store_id, Number(x.articles)])) : r;
    }
    out("SRC_DAYS", srcDays);
    if (mode !== "full") return;

    // ---- 3. the DNDS mirror, same window
    const M = {};
    M.dupes = await q("SELECT (SELECT COUNT(*) - COUNT(DISTINCT rp_slug) FROM sa_rp_session) AS session_dupes, (SELECT COUNT(*) - COUNT(DISTINCT rp_slug) FROM sa_rp_line) AS line_dupes, (SELECT COUNT(*) - COUNT(DISTINCT rp_ledger_slug) FROM sa_rp_adjustment) AS adj_dupes, (SELECT COUNT(*) FROM sa_rp_session) AS sessions, (SELECT COUNT(*) FROM sa_rp_line) AS lines_n, (SELECT COUNT(*) FROM sa_rp_adjustment) AS adjustments, (SELECT COUNT(*) FROM sa_rp_user) AS rp_users");
    M.by_store_status = await q("SELECT rp_store_id AS store_id, outlet_id, status, COUNT(*) AS n FROM sa_rp_session WHERE rp_updated_at >= ? AND rp_updated_at < ? GROUP BY rp_store_id, outlet_id, status ORDER BY rp_store_id, status", [SINCE_SQL, AS_OF_SQL]);
    M.finalized = await q("SELECT rp_store_id AS store_id, outlet_id, COUNT(*) AS sessions, COUNT(DISTINCT article_id) AS articles, COUNT(DISTINCT finalized_by) AS counters FROM sa_rp_session WHERE status = 'FINALIZED' AND finalized_at >= ? AND finalized_at < ? GROUP BY rp_store_id, outlet_id ORDER BY rp_store_id", [SINCE_SQL, AS_OF_SQL]);
    M.per_user = await q("SELECT rp_store_id AS store_id, finalized_by, COUNT(*) AS sessions, COUNT(DISTINCT article_id) AS articles FROM sa_rp_session WHERE status = 'FINALIZED' AND finalized_at >= ? AND finalized_at < ? GROUP BY rp_store_id, finalized_by", [SINCE_SQL, AS_OF_SQL]);
    M.recounts = await q("SELECT rp_store_id AS store_id, COUNT(*) AS n FROM sa_rp_session WHERE recount_slug IS NOT NULL AND recount_slug <> '' GROUP BY rp_store_id");
    M.variance = await q("SELECT outlet_id, SUM(var_qty < 0) AS short_sessions, SUM(var_qty > 0) AS excess_sessions, SUM(var_qty = 0) AS nil_sessions, SUM(var_qty IS NULL) AS no_booked_difference, ROUND(SUM(CASE WHEN var_qty < 0 THEN var_qty END), 3) AS short_qty, ROUND(SUM(CASE WHEN var_qty > 0 THEN var_qty END), 3) AS excess_qty, ROUND(SUM(CASE WHEN var_value < 0 THEN var_value END), 2) AS short_value, ROUND(SUM(CASE WHEN var_value > 0 THEN var_value END), 2) AS excess_value FROM sa_rp_session WHERE status = 'FINALIZED' AND finalized_at >= ? AND finalized_at < ? GROUP BY outlet_id ORDER BY outlet_id", [SINCE_SQL, AS_OF_SQL]);
    M.unmapped = await q("SELECT u.last_rp_store_id AS store_id, COUNT(*) AS rp_users, SUM(m.employee_id IS NULL) AS unmapped FROM sa_rp_user u LEFT JOIN wh_rp_staff_map m ON m.rp_user_id = u.rp_user_id GROUP BY u.last_rp_store_id ORDER BY u.last_rp_store_id");
    M.unmapped_work = await q("SELECT s.outlet_id, COUNT(*) AS sessions, COUNT(DISTINCT s.article_id) AS articles, COUNT(DISTINCT s.finalized_by) AS counters FROM sa_rp_session s LEFT JOIN wh_rp_staff_map m ON m.rp_user_id = s.finalized_by WHERE s.status = 'FINALIZED' AND s.finalized_at >= ? AND s.finalized_at < ? AND m.employee_id IS NULL GROUP BY s.outlet_id ORDER BY s.outlet_id", [SINCE_SQL, AS_OF_SQL]);
    M.issues = await q("SELECT i.kind, COUNT(*) AS n FROM sa_sync_issue i WHERE i.run_id = (SELECT MAX(run_id) FROM sa_sync_run WHERE kind = 'HISTORICAL') GROUP BY i.kind");
    for (const [k, v] of Object.entries(M)) if (k !== "per_user") out("MIRROR_" + k.toUpperCase(), v);
    // per-user comparison (ids only)
    const key = (r) => `${r.store_id}|${r.finalized_by}`;
    const sm = new Map((Array.isArray(src.per_user) ? src.per_user : []).map((r) => [key(r), r]));
    const mm = new Map((Array.isArray(M.per_user) ? M.per_user : []).map((r) => [key(r), r]));
    const diffs = [...new Set([...sm.keys(), ...mm.keys()])].filter((k) => { const a = sm.get(k), b = mm.get(k); return !a || !b || Number(a.sessions) !== Number(b.sessions) || Number(a.articles) !== Number(b.articles); });
    out("PER_USER_COMPARE", { source_users: sm.size, mirror_users: mm.size, differences: diffs.length, sample: diffs.slice(0, 10) });
    // store comparison
    const sf = new Map((Array.isArray(src.finalized) ? src.finalized : []).map((r) => [String(r.store_id), r]));
    out("STORE_COMPARE", (Array.isArray(M.finalized) ? M.finalized : []).map((m) => { const s = sf.get(String(m.store_id)) || {}; return { outlet_id: m.outlet_id, sessions: [Number(s.sessions), Number(m.sessions)], articles: [Number(s.articles), Number(m.articles)], counters: [Number(s.counters), Number(m.counters)], match: Number(s.sessions) === Number(m.sessions) && Number(s.articles) === Number(m.articles) && Number(s.counters) === Number(m.counters) }; }));
    // daily, mirror side
    const mdays = await q("SELECT DATE(CONVERT_TZ(finalized_at, '+00:00', '+05:30')) AS d, outlet_id, COUNT(DISTINCT article_id) AS articles FROM sa_rp_session WHERE status = 'FINALIZED' AND finalized_at >= ? AND finalized_at < ? GROUP BY d, outlet_id ORDER BY d, outlet_id", [SINCE_SQL, AS_OF_SQL]);
    const mDays = {};
    if (Array.isArray(mdays)) for (const r of mdays) { const d = r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10); (mDays[d] = mDays[d] || {})[r.outlet_id] = Number(r.articles); }
    out("MIRROR_DAYS", mDays);
    out("DAYS_MATCH", Object.keys(srcDays).map((d) => ({ day: d, match: JSON.stringify(Object.entries(srcDays[d] || {}).sort()) === JSON.stringify(Object.entries(mDays[d] || {}).map(([k, v]) => [k, v]).sort()) })));

    // ---- 4. what the screens and the HR PDF show (application usecase, in-memory window, nothing stored)
    const repo = R("/repository/stock_audit")(db.connection);
    const today = istDate(new Date().toISOString());
    const synthetic = PROGRAMME.map((o, i) => ({ cycle_id: -1 - i, outlet_id: o, name: "Stage 4 check", period_code: "S4CHECK", start_date: "2026-11-25", end_date: today, deadline: today, status: "OPEN" }));
    const periods = [{ period_code: "S4CHECK", name: "Stage 4 check", start_date: "2026-11-25", end_date: today, deadline: today, status: "OPEN", stores: PROGRAMME.length }];
    const view = new Proxy(repo, { get: (t, k) => (k === "cycles" ? async () => synthetic : k === "periods" ? async () => periods : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
    const U = R("/usecase/stock_audit")(view, {});
    const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (/name|^employee$|label/i.test(k) && typeof x === "string" ? undefined : x)));
    const stores = await U.stores({ period: "S4CHECK", outlets: PROGRAMME });
    out("SCREEN_STORES", strip(stores));
    const emps = await U.employees({ period: "S4CHECK", outlets: PROGRAMME, size: 500 });
    const list = emps.rows || emps.items || emps.data || emps.list || (Array.isArray(emps) ? emps : []);
    out("SCREEN_EMPLOYEES", { keys: Object.keys(emps || {}), total: emps.total ?? list.length, mapped: list.filter((e) => e.mapped).length, unmapped: list.filter((e) => e.mapped === false).length, statuses: list.reduce((t, e) => { for (const f of ["completion_status", "accuracy_status", "incentive_status", "status", "estimated_status"]) if (e[f] != null && typeof e[f] !== "object") t[`${f}=${e[f]}`] = (t[`${f}=${e[f]}`] || 0) + 1; return t; }, {}), sample_fields: list[0] ? Object.keys(list[0]) : [] });
    const hr = await U.hrReport({ period: "S4CHECK", date: today });
    out("SCREEN_HR_REPORT", strip(hr));
  } finally {
    // ---- 5. administrator accounts (read-only)
    const admins = await q("SELECT u.user_id, u.status AS account_status, u.is_service_account, u.is_system_account, u.employee_id IS NOT NULL AS has_employee, ne.status AS employee_status, DATE_FORMAT(u.last_login_at, '%Y-%m-%d %H:%i') AS last_login_utc, DATE_FORMAT(u.locked_until, '%Y-%m-%d %H:%i') AS locked_until, u.ip_policy, DATE_FORMAT(u.created_at, '%Y-%m-%d') AS created FROM `user` u LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id WHERE u.user_type = 2 ORDER BY u.user_id");
    out("ADMIN_ACCOUNTS", admins);
    db.close();
  }
})().catch((e) => { console.log("@@FAIL " + String(e.stack || e.message).slice(0, 400)); process.exitCode = 1; });
