// READ-ONLY: the feature branch's season code (extracted to /tmp/sa_season, not deployed) reading
// production's existing Season 1. Nothing is written; the season rows are fingerprinted before and after.
global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
const cwd = process.cwd(); const NEW = "/tmp/sa_season";
const out = (k, v) => console.log(`@@${k} ${JSON.stringify(v)}`);
(async () => {
  const db = await require(cwd + "/drivers/mysql")().connect();
  const q = (sql, p = []) => new Promise((res, rej) => db.connection.query(sql, p, (e, r) => (e ? rej(e) : res(r))));
  const fp = async () => (await q(`SELECT
      (SELECT SHA1(GROUP_CONCAT(CONCAT_WS('|', cycle_id, outlet_id, name, period_code, start_date, end_date, deadline, status, IFNULL(created_by,''), created_at) ORDER BY cycle_id)) FROM sa_cycle) AS cycles,
      (SELECT SHA1(GROUP_CONCAT(CONCAT_WS('|', season_id, name, period_code, start_date, deadline, prize_amount, rules_json, status, updated_at) ORDER BY season_id)) FROM sa_sapl_season) AS seasons,
      (SELECT COUNT(*) FROM sa_cycle) AS n_cycles, (SELECT COUNT(*) FROM sa_sapl_season) AS n_seasons`))[0];
  try {
    const before = await fp();
    const repo = require(NEW + "/repository/stock_audit")(db.connection);
    const U = require(NEW + "/usecase/stock_audit")(repo, {});
    const meta = await U.meta({ outlets: null, canManageSeasons: false });
    out("META_SEASONS", { current_period: meta.current_period, seasons: meta.seasons, can_manage_seasons: meta.can_manage_seasons });
    out("SEASONS", (await U.seasons()).map((s) => ({ season_id: s.season_id, name: s.name, period_code: s.period_code, start: s.start, end: s.end, deadline: s.deadline, prize: s.prize, weights: s.rules && s.rules.weights, status: s.status, current: s.current })));
    const stores = await U.stores({ period: null, outlets: null });
    out("STORES_DEFAULT_SEASON", stores.map((s) => ({ outlet_id: s.outlet_id, cycle: s.cycle && s.cycle.period_code, audited: s.audited, completion: s.completion && s.completion.status })));
    const after = await fp();
    out("UNCHANGED", { before, after, same: JSON.stringify(before) === JSON.stringify(after) });
  } finally { db.close(); }
})().catch((e) => { console.log("@@FAIL " + String(e.stack || e.message).slice(0, 400)); process.exitCode = 1; });
