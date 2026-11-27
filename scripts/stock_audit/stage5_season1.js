// Stock Audit - create Season 1 with the APPLICATION'S OWN functions (management-instructed 27 Nov 2026).
// Data only, no code change: the audit period (one row per retail store) + the Premier League season.
// Stops, changing nothing, if any audit period or season already exists.
global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
const cwd = process.cwd(); const R = (p) => require(cwd + p);
const out = (k, v) => console.log(`@@${k} ${JSON.stringify(v)}`);
(async () => {
  const db = await R("/drivers/mysql")().connect();
  const q = (sql, p = []) => new Promise((res, rej) => db.connection.query(sql, p, (e, r) => (e ? rej(e) : res(r))));
  try {
    const [c] = await q("SELECT (SELECT COUNT(*) FROM sa_cycle) AS cycles, (SELECT COUNT(*) FROM sa_sapl_season) AS seasons");
    if (Number(c.cycles) || Number(c.seasons)) { out("STOP", { reason: "an audit period or season already exists - nothing changed", ...c }); process.exitCode = 1; return; }
    const repo = R("/repository/stock_audit")(db.connection);
    const U = R("/usecase/stock_audit")(repo, {});
    const SEASON = { period_code: "SEASON-1", name: "Season 1", start_date: "2026-11-25", end_date: "2026-12-31", deadline: "2026-12-31" };
    out("PERIOD", await U.createPeriod({ ...SEASON, outlet_ids: [3, 4, 5, 6, 7], by: null }));
    out("SEASON", await U.createSeason({ name: SEASON.name, period_code: SEASON.period_code, deadline: SEASON.deadline, prize_amount: 10000, by: null }));
    out("CHECK_CYCLES", await q("SELECT cycle_id, outlet_id, name, period_code, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, DATE_FORMAT(end_date,'%Y-%m-%d') AS end_date, DATE_FORMAT(deadline,'%Y-%m-%d') AS deadline, status FROM sa_cycle ORDER BY outlet_id"));
    out("CHECK_SEASON", await q("SELECT season_id, name, period_code, DATE_FORMAT(start_date,'%Y-%m-%d') AS start_date, DATE_FORMAT(deadline,'%Y-%m-%d') AS deadline, prize_amount, status, JSON_EXTRACT(rules_json, '$.weights') AS weights, JSON_EXTRACT(rules_json, '$.weights_confirmed') AS weights_confirmed FROM sa_sapl_season"));
  } finally { db.close(); }
})().catch((e) => { console.log("@@FAIL " + String(e.message).slice(0, 300)); process.exitCode = 1; });
