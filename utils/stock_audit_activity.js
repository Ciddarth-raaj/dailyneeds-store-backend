/**
 * Stock Audit - ACTUAL audit activity, from finalized RetailPilot counts. Pure.
 *
 * Without RetailPilot's allotment, nobody knows how many articles each
 * employee or store was SUPPOSED to count. So this reports only what was
 * actually counted - unique articles per employee per day, per store per day
 * - and returns allotted, pending and completion % as UNAVAILABLE cells.
 * It never assumes 1,000 articles per employee or 15,000 per store.
 *
 * Programme stores only: the warehouse is outside the incentive programme.
 */

const S = require("./stock_audit_status");
const { toUtc } = require("./stock_audit_queries");
const { DEFAULT_POLICY } = require("./stock_audit_policy");

/** India date (YYYY-MM-DD) of a timestamp. */
function istDate(ts) {
  const ms = Date.parse(toUtc(ts).iso.slice(0, 23) + "Z") + 330 * 60000;
  return new Date(ms).toISOString().slice(0, 10);
}

const unavailableAllotment = () => ({
  allotted: S.unavailable(S.REASON.ALLOTMENT_UNAVAILABLE),
  pending: S.unavailable(S.REASON.ALLOTMENT_UNAVAILABLE),
  completion_pct: S.unavailable(S.REASON.ALLOTMENT_UNAVAILABLE),
});

/**
 * @param sessions mirrored sessions (any status; only FINALIZED are counted)
 * @param ctx.outletOf (rpStoreId) => outlet_id | null
 * @param ctx.employeeOf (rpUserId) => employee_id | null
 * @param ctx.allotment null (unavailable) - the hook for when it can be read
 */
function summarize(sessions, { outletOf, employeeOf, allotment = null }, policy = DEFAULT_POLICY) {
  const inProgramme = (o) => o != null && policy.programme.outletIds.includes(o);
  const empDay = new Map();
  const storeDay = new Map();
  const emp = new Map();
  const store = new Map();
  let excluded = 0;

  for (const s of sessions) {
    if (s.status !== "FINALIZED" || !s.finalized_at) continue;
    const outletId = outletOf(s.rp_store_id);
    if (!inProgramme(outletId)) { excluded += 1; continue; }
    const user = s.finalized_by || s.initiated_by || null;
    const day = istDate(s.finalized_at);

    const ek = `${day}|${outletId}|${user}`;
    if (!empDay.has(ek)) empDay.set(ek, { date: day, outlet_id: outletId, rp_user_id: user, employee_id: user ? employeeOf(user) : null, articles: new Set(), sessions: 0 });
    const ed = empDay.get(ek);
    ed.articles.add(s.article_id);
    ed.sessions += 1;

    const sk = `${day}|${outletId}`;
    if (!storeDay.has(sk)) storeDay.set(sk, { date: day, outlet_id: outletId, articles: new Set(), counters: new Set(), sessions: 0 });
    const sd = storeDay.get(sk);
    sd.articles.add(s.article_id);
    sd.counters.add(user);
    sd.sessions += 1;

    const tk = `${outletId}|${user}`;
    if (!emp.has(tk)) emp.set(tk, { outlet_id: outletId, rp_user_id: user, employee_id: user ? employeeOf(user) : null, articles: new Set(), days: new Set(), sessions: 0 });
    const t = emp.get(tk);
    t.articles.add(s.article_id);
    t.days.add(day);
    t.sessions += 1;

    if (!store.has(outletId)) store.set(outletId, { outlet_id: outletId, articles: new Set(), counters: new Set(), sessions: 0 });
    const st = store.get(outletId);
    st.articles.add(s.article_id);
    st.counters.add(user);
    st.sessions += 1;
  }

  const allot = allotment ? null : unavailableAllotment();
  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  return {
    employee_daily: [...empDay.values()]
      .map((r) => ({ date: r.date, outlet_id: r.outlet_id, rp_user_id: r.rp_user_id, employee_id: r.employee_id, unique_articles: r.articles.size, finalized_counts: r.sessions }))
      .sort((a, b) => byDateDesc(a, b) || b.unique_articles - a.unique_articles),
    store_daily: [...storeDay.values()]
      .map((r) => ({ date: r.date, outlet_id: r.outlet_id, unique_articles: r.articles.size, counters: r.counters.size, finalized_counts: r.sessions }))
      .sort((a, b) => byDateDesc(a, b) || a.outlet_id - b.outlet_id),
    employees: [...emp.values()]
      .map((r) => ({ outlet_id: r.outlet_id, rp_user_id: r.rp_user_id, employee_id: r.employee_id, mapped: r.employee_id != null, unique_articles: r.articles.size, active_days: r.days.size, finalized_counts: r.sessions, ...allot }))
      .sort((a, b) => b.unique_articles - a.unique_articles),
    stores: [...store.values()]
      .map((r) => ({ outlet_id: r.outlet_id, unique_articles: r.articles.size, counters: r.counters.size, finalized_counts: r.sessions, ...allot }))
      .sort((a, b) => a.outlet_id - b.outlet_id),
    excluded_outside_programme: excluded,
    allotment: allotment ? S.available(true) : S.unavailable(S.REASON.ALLOTMENT_UNAVAILABLE),
  };
}

module.exports = { summarize, istDate };
