// Stock Audit Stage 5 - READ-ONLY shortage / excess reconciliation, second pass (backend dir, server).
global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
const cwd = process.cwd(); const R = (p) => require(cwd + p);
const out = (k, v) => console.log(`@@${k} ${JSON.stringify(v)}`);
const SINCE = "2026-11-24 18:30:00";
(async () => {
  const db = await R("/drivers/mysql")().connect();
  const q = (sql, p = []) => new Promise((res) => db.connection.query(sql, p, (e, r) => res(e ? { error: e.code, msg: String(e.sqlMessage || "").slice(0, 160) } : r)));
  try {
    const base = `SELECT s.*, ROW_NUMBER() OVER (PARTITION BY s.outlet_id, s.article_id ORDER BY s.finalized_at, s.rp_slug) AS rn,
        FIRST_VALUE(s.var_qty) OVER (PARTITION BY s.outlet_id, s.article_id ORDER BY s.finalized_at, s.rp_slug) AS first_qty,
        MIN(s.finalized_at) OVER (PARTITION BY s.outlet_id, s.article_id) AS first_at
      FROM sa_rp_session s WHERE s.status = 'FINALIZED' AND s.outlet_id IN (3,4,5,6,7)`;
    // a. how the screen files VALUE: by the sign of the QUANTITY. Where the two signs disagree:
    out("SIGN_MISMATCH_ORIGINALS", await q(`SELECT outlet_id,
        SUM(COALESCE(var_qty,0) = 0 AND COALESCE(var_value,0) <> 0) AS qty0_value_nonzero, ROUND(SUM(CASE WHEN COALESCE(var_qty,0) = 0 THEN var_value END), 2) AS qty0_value_net,
        SUM(var_qty < 0 AND var_value > 0) AS short_qty_but_value_up, ROUND(SUM(CASE WHEN var_qty < 0 AND var_value > 0 THEN var_value END), 2) AS short_qty_value_up_sum,
        SUM(var_qty > 0 AND var_value < 0) AS excess_qty_but_value_down, ROUND(SUM(CASE WHEN var_qty > 0 AND var_value < 0 THEN var_value END), 2) AS excess_qty_value_down_sum,
        ROUND(SUM(CASE WHEN var_qty < 0 THEN -var_value END), 2) AS screen_style_short_value, ROUND(SUM(CASE WHEN var_qty > 0 THEN var_value END), 2) AS screen_style_excess_value,
        ROUND(SUM(CASE WHEN var_value < 0 THEN -var_value END), 2) AS value_sign_short_value, ROUND(SUM(CASE WHEN var_value > 0 THEN var_value END), 2) AS value_sign_excess_value
      FROM (${base}) x WHERE rn = 1 AND first_at >= ? GROUP BY outlet_id ORDER BY outlet_id`, [SINCE]));
    // b. per ARTICLE, every finalized count netted (what RetailPilot's stock moved by, in total)
    out("NET_PER_ARTICLE", await q(`SELECT outlet_id, COUNT(*) AS articles,
        ROUND(SUM(CASE WHEN nq < 0 THEN -nq END), 3) AS net_short_qty, ROUND(SUM(CASE WHEN nq > 0 THEN nq END), 3) AS net_excess_qty,
        ROUND(SUM(CASE WHEN nv < 0 THEN -nv END), 2) AS net_short_value, ROUND(SUM(CASE WHEN nv > 0 THEN nv END), 2) AS net_excess_value,
        ROUND(SUM(nq), 3) AS net_qty, ROUND(SUM(nv), 2) AS net_value
      FROM (SELECT outlet_id, article_id, SUM(COALESCE(var_qty,0)) AS nq, SUM(COALESCE(var_value,0)) AS nv FROM (${base}) x WHERE first_at >= ? GROUP BY outlet_id, article_id) a
      GROUP BY outlet_id ORDER BY outlet_id`, [SINCE]));
    // c. repeat counts: reversal of the first count's difference, or more of the same direction?
    out("REPEAT_DIRECTION", await q(`SELECT outlet_id,
        SUM(SIGN(COALESCE(var_qty,0)) = 0) AS repeat_no_difference,
        SUM(SIGN(COALESCE(var_qty,0)) <> 0 AND SIGN(COALESCE(var_qty,0)) = -SIGN(COALESCE(first_qty,0))) AS reverses_first,
        SUM(SIGN(COALESCE(var_qty,0)) <> 0 AND SIGN(COALESCE(var_qty,0)) = SIGN(COALESCE(first_qty,0))) AS same_direction,
        SUM(SIGN(COALESCE(var_qty,0)) <> 0 AND COALESCE(first_qty,0) = 0) AS after_nil_first, COUNT(*) AS repeats
      FROM (${base}) x WHERE rn > 1 AND first_at >= ? GROUP BY outlet_id ORDER BY outlet_id`, [SINCE]));
    out("REPEAT_GROUPS", await q(`SELECT outlet_id, times AS finalized_times, COUNT(*) AS articles FROM (SELECT outlet_id, article_id, MAX(rn) AS times FROM (${base}) x WHERE first_at >= ? GROUP BY outlet_id, article_id) g WHERE times > 1 GROUP BY outlet_id, times ORDER BY outlet_id, times`, [SINCE]));
    // d. the 5,607 stock-adjustment rows with no audit-session link: do they line up with counts
    //    (same store + article, within 5 minutes after the finalize) - i.e. the stock the count booked?
    out("LEDGER_TRACE_KEYS", await q(`SELECT JSON_KEYS(CAST(traceability AS JSON)) AS keys_, COUNT(*) AS n FROM sa_rp_adjustment WHERE is_marker = 0 GROUP BY keys_ ORDER BY n DESC LIMIT 6`));
    out("LEDGER_MATCH", await q(`SELECT s.outlet_id, COUNT(DISTINCT s.rp_slug) AS counts_with_matching_rows, COUNT(*) AS ledger_rows, ROUND(SUM(a.quantity), 3) AS ledger_qty
      FROM sa_rp_session s JOIN sa_rp_adjustment a ON a.is_marker = 0 AND a.rp_store_id = s.rp_store_id AND a.article_id = s.article_id
        AND a.ts >= s.finalized_at - INTERVAL 1 MINUTE AND a.ts <= s.finalized_at + INTERVAL 5 MINUTE
      WHERE s.status = 'FINALIZED' AND s.finalized_at >= ? AND s.outlet_id IN (3,4,5,6,7) GROUP BY s.outlet_id ORDER BY s.outlet_id`, [SINCE]));
    out("LEDGER_MATCH_VS_BOOKED", await q(`SELECT s.outlet_id, COUNT(*) AS counts, SUM(ABS(m.qty - COALESCE(s.var_qty,0)) < 0.0005) AS ledger_equals_booked, SUM(ABS(m.qty - COALESCE(s.var_qty,0)) >= 0.0005) AS differs
      FROM sa_rp_session s JOIN (SELECT s2.rp_slug, SUM(a.quantity) AS qty FROM sa_rp_session s2 JOIN sa_rp_adjustment a ON a.is_marker = 0 AND a.rp_store_id = s2.rp_store_id AND a.article_id = s2.article_id AND a.ts >= s2.finalized_at - INTERVAL 1 MINUTE AND a.ts <= s2.finalized_at + INTERVAL 5 MINUTE WHERE s2.status = 'FINALIZED' AND s2.finalized_at >= ? GROUP BY s2.rp_slug) m ON m.rp_slug = s.rp_slug
      WHERE s.outlet_id IN (3,4,5,6,7) GROUP BY s.outlet_id ORDER BY s.outlet_id`, [SINCE]));
    out("LEDGER_UNMATCHED", await q(`SELECT a.rp_store_id, COUNT(*) AS rows_n, ROUND(SUM(a.quantity), 3) AS qty, MIN(a.ts) AS first, MAX(a.ts) AS last FROM sa_rp_adjustment a
      WHERE a.is_marker = 0 AND NOT EXISTS (SELECT 1 FROM sa_rp_session s WHERE s.status = 'FINALIZED' AND s.rp_store_id = a.rp_store_id AND s.article_id = a.article_id AND a.ts >= s.finalized_at - INTERVAL 1 MINUTE AND a.ts <= s.finalized_at + INTERVAL 5 MINUTE)
      GROUP BY a.rp_store_id ORDER BY a.rp_store_id`));
    out("MARKERS", await q(`SELECT COUNT(*) AS markers, COUNT(DISTINCT session_slug) AS sessions, SUM(var_qty IS NULL) AS no_delta FROM sa_rp_adjustment WHERE is_marker = 1`));
  } finally { db.close(); }
})().catch((e) => { console.log("@@FAIL " + String(e.stack || e.message).slice(0, 400)); process.exitCode = 1; });
