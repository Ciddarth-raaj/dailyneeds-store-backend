// Stock Audit Stage 5 preparation - READ-ONLY review ON THE SERVER (backend dir).
// Nothing is written: every "what if" (a mapping, an audit window) exists only
// in memory. Prints counts and ids only - no names.
global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
const cwd = process.cwd(); const R = (p) => require(cwd + p);
const out = (k, v) => console.log(`@@${k} ${JSON.stringify(v)}`);
const PROGRAMME = [3, 4, 5, 6, 7]; const SINCE = "2026-11-24 18:30:00";
(async () => {
  const db = await R("/drivers/mysql")().connect();
  const q = (sql, p = []) => new Promise((res) => db.connection.query(sql, p, (e, r) => res(e ? { error: e.code, msg: String(e.sqlMessage || "").slice(0, 140) } : r)));
  try {
    // ================================================= 1. shortage / excess reconciliation
    const base = `SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.outlet_id, s.article_id ORDER BY s.finalized_at, s.rp_slug) AS rn,
        FIRST_VALUE(s.finalized_by) OVER (PARTITION BY s.outlet_id, s.article_id ORDER BY s.finalized_at, s.rp_slug) AS first_user,
        MIN(s.finalized_at) OVER (PARTITION BY s.outlet_id, s.article_id) AS first_at,
        LAG(s.rp_slug) OVER (PARTITION BY s.outlet_id, s.article_id ORDER BY s.finalized_at, s.rp_slug) AS prev_slug
      FROM sa_rp_session s WHERE s.status = 'FINALIZED' AND s.outlet_id IN (3,4,5,6,7)`;
    const sums = (w) => `COUNT(*) AS sessions, ROUND(SUM(CASE WHEN ${w} AND var_qty < 0 THEN -var_qty END), 3) AS short_qty, ROUND(SUM(CASE WHEN ${w} AND var_value < 0 THEN -var_value END), 2) AS short_value, ROUND(SUM(CASE WHEN ${w} AND var_qty > 0 THEN var_qty END), 3) AS excess_qty, ROUND(SUM(CASE WHEN ${w} AND var_value > 0 THEN var_value END), 2) AS excess_value`;
    out("VAR_PLAIN_IN_WINDOW", await q(`SELECT outlet_id, ${sums("1")} FROM (${base}) x WHERE finalized_at >= ? GROUP BY outlet_id ORDER BY outlet_id`, [SINCE]));
    out("VAR_ORIGINAL_ONLY", await q(`SELECT outlet_id, ${sums("1")} FROM (${base}) x WHERE rn = 1 AND first_at >= ? GROUP BY outlet_id ORDER BY outlet_id`, [SINCE]));
    out("VAR_REPEATS", await q(`SELECT outlet_id, finalized_by = first_user AS same_user, ${sums("1")} FROM (${base}) x WHERE rn > 1 AND finalized_at >= ? GROUP BY outlet_id, same_user ORDER BY outlet_id, same_user`, [SINCE]));
    out("VAR_BEFORE_PROGRAMME", await q(`SELECT outlet_id, ${sums("1")} FROM (${base}) x WHERE first_at < ? AND finalized_at >= ? GROUP BY outlet_id ORDER BY outlet_id`, [SINCE, SINCE]));
    out("REPEAT_GROUPS", await q(`SELECT outlet_id, MAX(rn) AS finalized_times, COUNT(*) AS articles FROM (SELECT outlet_id, article_id, MAX(rn) AS rn FROM (${base}) x WHERE first_at >= ? GROUP BY outlet_id, article_id HAVING MAX(rn) > 1) g GROUP BY outlet_id, finalized_times ORDER BY outlet_id, finalized_times`, [SINCE]));
    // the stock-adjustment ledger: each finalized count's non-marker STK_ADJ rows vs its booked difference
    out("LEDGER_VS_BOOKED", await q(`SELECT x.outlet_id, x.rn = 1 AS original, COUNT(*) AS sessions,
        SUM(l.session_slug IS NULL) AS no_ledger_rows,
        SUM(l.session_slug IS NOT NULL AND ABS(COALESCE(x.var_qty,0) - l.qty) < 0.0005) AS ledger_equals_booked,
        SUM(l.session_slug IS NOT NULL AND ABS(COALESCE(x.var_qty,0) - l.qty) >= 0.0005) AS ledger_differs,
        ROUND(SUM(l.qty), 3) AS ledger_net_qty, ROUND(SUM(x.var_qty), 3) AS booked_net_qty
      FROM (${base}) x LEFT JOIN (SELECT session_slug, SUM(quantity) AS qty FROM sa_rp_adjustment WHERE is_marker = 0 AND session_slug IS NOT NULL GROUP BY session_slug) l ON l.session_slug = x.rp_slug
      WHERE x.first_at >= ? GROUP BY x.outlet_id, original ORDER BY x.outlet_id, original`, [SINCE]));
    out("LEDGER_ROWS", await q(`SELECT is_marker, session_slug IS NOT NULL AS from_audit, COUNT(*) AS n FROM sa_rp_adjustment GROUP BY is_marker, from_audit`));
    // does a repeat count start from the stock the previous count left (a follow-up correction),
    // or from the same stock the previous count started from (a re-count of uncorrected stock)?
    const lines = `(SELECT session_slug, SUM(snapshot_qty) AS snap, SUM(counted_qty) AS counted FROM sa_rp_line GROUP BY session_slug)`;
    out("REPEAT_CHAIN", await q(`SELECT x.outlet_id,
        SUM(cl.session_slug IS NULL OR pl.session_slug IS NULL) AS no_line_detail,
        SUM(ABS(cl.snap - pl.counted) < 0.0005) AS starts_from_previous_count,
        SUM(ABS(cl.snap - pl.snap) < 0.0005 AND ABS(cl.snap - pl.counted) >= 0.0005) AS starts_from_previous_snapshot,
        SUM(ABS(cl.snap - pl.counted) >= 0.0005 AND ABS(cl.snap - pl.snap) >= 0.0005) AS stock_moved_between,
        SUM(ABS(cl.counted - pl.counted) < 0.0005) AS same_counted_qty
      FROM (${base}) x LEFT JOIN ${lines} cl ON cl.session_slug = x.rp_slug LEFT JOIN ${lines} pl ON pl.session_slug = x.prev_slug
      WHERE x.rn > 1 AND x.first_at >= ? GROUP BY x.outlet_id ORDER BY x.outlet_id`, [SINCE]));
    out("SESSIONS_WITH_LINES", await q(`SELECT outlet_id, SUM(has_lines = 1) AS with_lines, COUNT(*) AS finalized FROM sa_rp_session WHERE status = 'FINALIZED' AND finalized_at >= ? AND outlet_id IN (3,4,5,6,7) GROUP BY outlet_id`, [SINCE]));

    // ================================================= 2. screens: warehouse exclusion, and retrospective mapping (in memory)
    const repo = R("/repository/stock_audit")(db.connection);
    const { istDate } = R("/utils/stock_audit_activity");
    const today = istDate(new Date().toISOString());
    const synthetic = PROGRAMME.map((o, i) => ({ cycle_id: -1 - i, outlet_id: o, name: "Stage 5 check", period_code: "S5CHECK", start_date: "2026-11-25", end_date: today, deadline: today, status: "OPEN" }));
    const periods = [{ period_code: "S5CHECK", name: "Stage 5 check", start_date: "2026-11-25", end_date: today, deadline: today, status: "OPEN", stores: 5 }];
    const realPeople = await repo.people();
    const view = (people) => R("/usecase/stock_audit")(new Proxy(repo, { get: (t, k) => (k === "cycles" ? async () => synthetic : k === "periods" ? async () => periods : k === "people" ? async () => people : typeof t[k] === "function" ? t[k].bind(t) : t[k]) }), {});
    const snapshot = async (people) => {
      const U = view(people);
      const stores = await U.stores({ period: "S5CHECK", outlets: PROGRAMME });
      const emps = (await U.employees({ period: "S5CHECK", outlets: PROGRAMME, size: 1000 })).rows;
      const hr = await U.hrReport({ period: "S5CHECK", date: today });
      return { stores, emps, hr };
    };
    const A = await snapshot(realPeople);
    out("WAREHOUSE_EXCLUSION", {
      store_outlets: A.stores.map((s) => s.outlet_id), employee_row_outlets: [...new Set(A.emps.map((e) => e.outlet_id))].sort(),
      hr_pdf_outlets: (A.hr.stores || []).map((s) => s.outlet_id), standings_outlets: (A.hr.standings || []).map((s) => s.outlet_id),
      outlet2_anywhere: JSON.stringify({ s: A.stores, e: A.emps.map((e) => e.outlet_id), h: (A.hr.stores || []).map((s) => s.outlet_id) }).includes('"outlet_id":2,'),
    });
    out("SCREEN_VARIANCE", A.stores.map((s) => ({ outlet_id: s.outlet_id, shortage_qty: s.shortage_qty, shortage_value: s.shortage_value, excess_qty: s.excess_qty, excess_value: s.excess_value })));
    // pick the two unmapped auditors with the most articles in one store
    const un = A.emps.filter((e) => !e.mapped).sort((a, b) => (b.audited || 0) - (a.audited || 0));
    const store = un.length ? un[0].outlet_id : null;
    const pair = un.filter((e) => e.outlet_id === store).slice(0, 2);
    if (pair.length === 2) {
      const sum = (rows, o) => rows.filter((e) => e.outlet_id === o).reduce((t, e) => t + (e.audited || 0), 0);
      const st = (snap) => snap.stores.find((s) => s.outlet_id === store);
      const ids = pair.map((e) => e.rp_user_id);
      const E = -901; // an in-memory employee only
      const one = new Map(realPeople); one.set(ids[0], { employee_id: E, name: null, designation: null, store_id: store });
      const B = await snapshot(one);
      const two = new Map(one); two.set(ids[1], { employee_id: E, name: null, designation: null, store_id: store });
      const C = await snapshot(two);
      const rowE = (snap) => snap.emps.find((e) => e.employee_id === E) || null;
      const brief = (r) => r && { rows_for_employee: 1, rp_user_ids: r.rp_user_ids, mapped: r.mapped, mapping_status: r.mapping_status, audited: r.audited, estimated: r.estimated && (r.estimated.status || r.estimated), provisional: r.provisional };
      out("RETRO_MAPPING", {
        store, auditors: ids, before: pair.map((e) => ({ rp_user_id: e.rp_user_id, mapped: e.mapped, audited: e.audited, mapping_status: e.mapping_status })),
        store_audited: [st(A).audited, st(B).audited, st(C).audited], store_counters: [st(A).employees.filter((e) => e.audited > 0).length, st(B).employees.filter((e) => e.audited > 0).length, st(C).employees.filter((e) => e.audited > 0).length],
        rows_in_store: [A.emps.filter((e) => e.outlet_id === store).length, B.emps.filter((e) => e.outlet_id === store).length, C.emps.filter((e) => e.outlet_id === store).length],
        sum_of_row_audited: [sum(A.emps, store), sum(B.emps, store), sum(C.emps, store)],
        after_mapping_first: brief(rowE(B)), after_mapping_both_to_one_employee: brief(rowE(C)),
        participation: [st(A).participation, st(B).participation, st(C).participation].map((p) => p && `${p.status}:${p.value}${p.provisional ? "(provisional)" : ""}`),
      });
    } else out("RETRO_MAPPING", { skipped: "fewer than two unmapped auditors in one store" });

    // ================================================= 3. HR setup progress and recounts
    out("HR_SETUP", await q(`SELECT (SELECT COUNT(*) FROM sa_cycle) AS cycles, (SELECT GROUP_CONCAT(DISTINCT period_code) FROM sa_cycle) AS periods,
      (SELECT COUNT(*) FROM sa_allotment_batch) AS upload_batches, (SELECT GROUP_CONCAT(DISTINCT status) FROM sa_allotment_batch) AS batch_statuses,
      (SELECT COUNT(*) FROM sa_allotment) AS allotted_rows, (SELECT COUNT(*) FROM sa_cycle_snapshot) AS headcount_snapshots,
      (SELECT COUNT(*) FROM sa_role_assignment) AS role_assignments, (SELECT COUNT(*) FROM sa_sapl_season) AS seasons,
      (SELECT COUNT(*) FROM sa_setting) AS settings_changed, (SELECT COUNT(*) FROM sa_rp_user u JOIN wh_rp_staff_map m ON m.rp_user_id = u.rp_user_id AND m.employee_id IS NOT NULL) AS rp_users_mapped,
      (SELECT COUNT(*) FROM sa_rp_user) AS rp_users`));
    out("SYNC_RUNS", await q("SELECT run_id, kind, run_trigger, started_by IS NOT NULL AS by_user, status, started_at, finished_at FROM sa_sync_run ORDER BY run_id"));
    out("RECOUNTS_IN_MIRROR", await q("SELECT COUNT(*) AS sessions_with_recount_ref FROM sa_rp_session WHERE recount_slug IS NOT NULL AND recount_slug <> ''"));

    // ================================================= 4. account 197 (read-only)
    const acct = await q("SELECT u.user_id, u.user_type, u.status, u.is_service_account, u.is_system_account, u.employee_id, ne.status AS employee_status, u.password_hash IS NOT NULL AS has_password_hash, u.password_algo, u.must_change_password, u.failed_login_count, u.last_login_at, u.last_failed_login_at, u.locked_until, u.token_valid_from, u.credential_rotated_at, u.ip_policy, u.allowed_ips IS NOT NULL AND u.allowed_ips <> '' AS has_ip_list, u.created_at, u.updated_at FROM `user` u LEFT JOIN new_employee ne ON ne.employee_id = u.employee_id WHERE u.user_id = 197");
    out("ACCOUNT_197", acct);
    out("ACCOUNT_197_AUTH_LOG", await q("SELECT event, COUNT(*) AS n, MIN(created_at) AS first, MAX(created_at) AS last FROM user_auth_log WHERE user_id = 197 OR actor_user_id = 197 GROUP BY event ORDER BY last DESC"));
    out("AUTH_LOG_COVERAGE", await q("SELECT MIN(created_at) AS first_entry, COUNT(*) AS entries FROM user_auth_log"));
    const empId = Array.isArray(acct) && acct[0] ? acct[0].employee_id : null;
    out("ACCOUNT_197_EMPLOYEE_SHARED", empId == null ? null : await q("SELECT COUNT(*) AS other_accounts_for_same_employee FROM `user` WHERE employee_id = ? AND user_id <> 197", [empId]));
    // columns that hold a USER id, on tables under 1 GB: rows pointing at 197, and the latest such row
    const cols = await q(`SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, (SELECT COLUMN_NAME FROM information_schema.COLUMNS c2 WHERE c2.TABLE_SCHEMA = c.TABLE_SCHEMA AND c2.TABLE_NAME = c.TABLE_NAME AND c2.COLUMN_NAME IN ('created_at','updated_at','created_on') ORDER BY c2.COLUMN_NAME LIMIT 1) AS ts
      FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE' AND (t.DATA_LENGTH + t.INDEX_LENGTH) < 1073741824
        AND (c.COLUMN_NAME IN ('user_id','actor_user_id','owner_user_id','service_user_id','api_user_id') OR c.COLUMN_NAME LIKE '%\\_user\\_id')
        AND c.TABLE_NAME NOT IN ('user')`);
    const refs = [];
    if (Array.isArray(cols)) for (const r of cols) {
      const x = await q(`SELECT COUNT(*) AS n${r.ts ? `, MAX(\`${r.ts}\`) AS last` : ""} FROM \`${r.t}\` WHERE \`${r.c}\` = 197`);
      if (Array.isArray(x) && Number(x[0].n) > 0) refs.push({ table: r.t, column: r.c, rows: Number(x[0].n), last: x[0].last || null });
    }
    out("ACCOUNT_197_REFERENCES", { user_id_columns_scanned: Array.isArray(cols) ? cols.length : cols, tables_referencing: refs });
  } finally { db.close(); }
})().catch((e) => { console.log("@@FAIL " + String(e.stack || e.message).slice(0, 400)); process.exitCode = 1; });
