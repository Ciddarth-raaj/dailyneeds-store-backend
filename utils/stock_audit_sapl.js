/**
 * DNDS Stock Audit Premier League (SAPL) - SCORING and RANKING. Pure.
 *
 * Confirmed 27 Nov 2026: 100 points = completion 35 + physical counting
 * accuracy 40 + independent recount completion 20 + employee participation 5.
 * Shortage / excess values are NOT an input anywhere here.
 *
 * NOT yet confirmed by management, so CONFIGURABLE per season (rules_json)
 * and marked `confirmed: false` until someone with manage_sapl_competition
 * records a decision:
 *   - qualification   (minimum KPIs measured / minimum participation)
 *   - tie-breakers    (order of KPIs compared when totals are equal)
 *   - prize method    (how the winning store's prize is shared)
 *
 * A KPI that cannot be measured yet (allotment not imported, no recounts)
 * scores NO points and leaves the standing provisional: it is never 0% and
 * never 100%. Standings are provisional every day; they are final only once
 * the season is independently verified.
 */
const S = require("./stock_audit_status");
const { DEFAULT_POLICY } = require("./stock_audit_policy");

const KPI_LABEL = Object.freeze({
  completion: "Audit completion",
  accuracy: "Physical counting accuracy",
  recount: "Independent recount completion",
  participation: "Employee participation",
});

const PRIZE_METHODS = Object.freeze(["EQUAL", "BY_ARTICLES_AUDITED", "MANUAL"]);

/** Rules a new season starts with. Weights are the confirmed ones; the rest is a PROPOSAL. */
function defaultRules(policy = DEFAULT_POLICY) {
  return {
    weights: { ...policy.sapl.weights },
    weights_confirmed: true,
    qualification: { confirmed: false, requireAllKpisMeasured: true, minParticipationPct: 0 },
    tie_breakers: { confirmed: false, order: ["accuracy", "completion", "recount", "participation"] },
    prize: { confirmed: false, amount: policy.sapl.prize, method: "EQUAL", excludeUnmapped: true, minArticlesAudited: 1 },
  };
}

/** Rejects anything that would change the confirmed scoring. */
function validateRules(rules, policy = DEFAULT_POLICY) {
  const errors = [];
  const w = (rules && rules.weights) || {};
  const confirmed = policy.sapl.weights;
  for (const k of Object.keys(confirmed)) if (w[k] !== confirmed[k]) errors.push(`weights.${k} is confirmed at ${confirmed[k]}`);
  for (const k of Object.keys(w)) if (!(k in confirmed)) errors.push(`weights.${k} is not a Premier League KPI (shortage / excess never score)`);
  const order = (rules && rules.tie_breakers && rules.tie_breakers.order) || [];
  if (!Array.isArray(order) || order.some((k) => !(k in confirmed)) || new Set(order).size !== order.length) errors.push("tie_breakers.order must list distinct Premier League KPIs");
  const prize = (rules && rules.prize) || {};
  if (!PRIZE_METHODS.includes(prize.method)) errors.push(`prize.method must be one of ${PRIZE_METHODS.join(", ")}`);
  if (!(Number(prize.amount) > 0)) errors.push("prize.amount must be positive");
  const q = (rules && rules.qualification) || {};
  if (q.minParticipationPct != null && !(q.minParticipationPct >= 0 && q.minParticipationPct <= 100)) errors.push("qualification.minParticipationPct must be 0-100");
  return { ok: errors.length === 0, errors };
}

/** Points per KPI from comparable percentages (0-100), rounded to 0.1. */
function points(kpis, weights) {
  const rows = Object.keys(weights).map((key) => {
    const measure = kpis[key] || S.pending(S.REASON.NO_DATA);
    if (!S.isKnown(measure)) return { key, label: KPI_LABEL[key], max: weights[key], measure, points: null };
    const pct = Math.max(0, Math.min(100, Number(measure.value)));
    return { key, label: KPI_LABEL[key], max: weights[key], measure, points: Math.round(((weights[key] * pct) / 100) * 10) / 10 };
  });
  const decided = rows.filter((r) => r.points != null);
  const total = Math.round(decided.reduce((t, r) => t + r.points, 0) * 10) / 10;
  return { rows, total, complete: decided.length === rows.length };
}

/**
 * @param stores [{ outlet_id, name, kpis: { completion, accuracy, recount, participation } }]
 * @param opts.final true only for a VERIFIED season
 * @param opts.previous Map outlet_id -> previous rank (yesterday)
 */
function standings(stores, rules = defaultRules(), { final = false, previous = new Map() } = {}) {
  const q = rules.qualification || {};
  const scored = stores.map((s) => {
    const p = points(s.kpis, rules.weights);
    const part = s.kpis.participation;
    const why = [];
    if (q.requireAllKpisMeasured && !p.complete) why.push("NOT_ALL_KPIS_MEASURED");
    if (q.minParticipationPct && !(S.isKnown(part) && part.value >= q.minParticipationPct)) why.push("PARTICIPATION_BELOW_MINIMUM");
    return { outlet_id: s.outlet_id, name: s.name, kpis: s.kpis, ...p, qualified: why.length === 0, not_qualified_reasons: why };
  });
  const order = (rules.tie_breakers && rules.tie_breakers.order) || [];
  const val = (r, k) => {
    const row = r.rows.find((x) => x.key === k);
    return row && row.points != null ? row.points : -1;
  };
  const cmp = (a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    if (b.total !== a.total) return b.total - a.total;
    for (const k of order) if (val(b, k) !== val(a, k)) return val(b, k) - val(a, k);
    return 0;
  };
  const ranked = [...scored].sort((a, b) => cmp(a, b) || String(a.name).localeCompare(String(b.name)));
  let rank = 0;
  return ranked.map((r, i) => {
    // equal on total AND every tie-breaker -> shared rank (never decided by name)
    if (i === 0 || cmp(ranked[i - 1], r) !== 0) rank = i + 1;
    const isFinal = final === true && r.complete && r.qualified;
    return { ...r, rank, previous_rank: previous.get(r.outlet_id) ?? null, provisional: !isFinal, final: isFinal, comparable: r.complete };
  });
}

/**
 * The season winner, only when it can be decided: season verified, the top
 * store qualified and complete, and no shared first place.
 */
function winnerOf(rows) {
  const top = rows.filter((r) => r.rank === 1);
  if (!top.length) return { winner: null, reason: "NO_STANDINGS" };
  if (top.length > 1) return { winner: null, reason: "TIE_FOR_FIRST" };
  if (!top[0].final) return { winner: null, reason: top[0].complete ? "NOT_VERIFIED" : "KPIS_PENDING" };
  return { winner: top[0].outlet_id, reason: null };
}

/**
 * Prize shares for the winning store's team, in paise so the shares add up
 * exactly to the prize. DRAFT only: this module never posts to payroll.
 * @param team [{ employee_id | null, articles_audited }]
 */
function prizeShares(team, prize) {
  const method = prize.method;
  const eligible = team.filter((m) => (!prize.excludeUnmapped || m.employee_id != null) && (m.articles_audited || 0) >= (prize.minArticlesAudited || 0));
  if (method === "MANUAL") return { method, shares: [], eligible: eligible.length, note: "Shares are entered by management" };
  if (!eligible.length) return { method, shares: [], eligible: 0 };
  const totalPaise = Math.round(Number(prize.amount) * 100);
  const weightOf = (m) => (method === "BY_ARTICLES_AUDITED" ? m.articles_audited : 1);
  const weightSum = eligible.reduce((t, m) => t + weightOf(m), 0);
  const raw = eligible.map((m) => ({ m, exact: (totalPaise * weightOf(m)) / weightSum }));
  const shares = raw.map((r) => ({ employee_id: r.m.employee_id, paise: Math.floor(r.exact), frac: r.exact - Math.floor(r.exact) }));
  let left = totalPaise - shares.reduce((t, s) => t + s.paise, 0);
  // largest remainder, then lowest employee id: deterministic
  [...shares].sort((a, b) => b.frac - a.frac || a.employee_id - b.employee_id).forEach((s) => { if (left > 0) { s.paise += 1; left -= 1; } });
  return {
    method,
    eligible: eligible.length,
    shares: shares.map((s) => ({ employee_id: s.employee_id, amount: s.paise / 100 })),
  };
}

module.exports = { KPI_LABEL, PRIZE_METHODS, defaultRules, validateRules, points, standings, winnerOf, prizeShares };
