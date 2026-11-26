/**
 * Stock Audit - which counts earn the per-article incentive.
 *
 * Rule: one credit per (audit cycle, store, article), whoever counted it and
 * however many times it was counted. RetailPilot can finalize the same
 * article more than once (128 store x article x location combinations were
 * finalized 2-4 times by 27 Nov 2026), so the FIRST finalized count in the
 * cycle - by finalized_at, then slug, both exact - takes the credit and the
 * rest are reported as duplicates. Re-running with the same input gives the
 * same answer; `alreadyCredited` (keys from sa_incentive_article) makes a
 * later run skip what an earlier one credited.
 *
 * The credited user is finalized_by (falling back to initiated_by), the same
 * "audit credit" RetailPilot's own report 6 uses.
 *
 * RECOUNTS ARE PENDING: how RetailPilot records a recount is not known until
 * real recounts are inspected. `isRecount` is the hook for that; it defaults
 * to "nothing is a recount". Once the shape is confirmed, recount sessions
 * will be excluded from the count credit here and fed to verification.
 *
 * Pure: no database, no RetailPilot calls.
 */

const { compareTs } = require("./stock_audit_queries");

const REASON = {
  NOT_FINALIZED: "not_finalized",
  UNMAPPED_STORE: "unmapped_store",
  UNMAPPED_USER: "unmapped_user",
  NO_CYCLE: "no_cycle",
  RECOUNT: "recount",
  ALREADY_CREDITED: "already_credited",
  DUPLICATE: "duplicate_in_cycle",
};

const keyOf = (cycleId, outletId, articleId) => `${cycleId}|${outletId}|${articleId}`;

/**
 * @param sessions mirrored sessions: { rp_slug, rp_store_id, article_id, status,
 *                 finalized_by, initiated_by, finalized_at }
 * @param deps.outletOf   (rpStoreId) => outlet_id | null      (Branch Master)
 * @param deps.employeeOf (rpUserId) => employee_id | null     (wh_rp_staff_map)
 * @param deps.cycleOf    (outletId, finalizedAt) => cycle_id | null
 * @param deps.isRecount  (session) => boolean                 (pending; default false)
 * @param deps.alreadyCredited Set of keyOf(cycle, outlet, article)
 * @returns { credited: [...], duplicates: [...], skipped: [{ rp_slug, reason, ... }] }
 */
function creditArticles(sessions, { outletOf, employeeOf, cycleOf, isRecount = () => false, alreadyCredited = new Set() }) {
  const credited = [];
  const duplicates = [];
  const skipped = [];
  const taken = new Map(); // key -> credited row

  const finalized = [];
  for (const s of sessions) {
    if (s.status !== "FINALIZED" || !s.finalized_at) { skipped.push({ rp_slug: s.rp_slug, reason: REASON.NOT_FINALIZED, status: s.status }); continue; }
    finalized.push(s);
  }
  finalized.sort((a, b) => compareTs(a.finalized_at, b.finalized_at) || (a.rp_slug < b.rp_slug ? -1 : a.rp_slug > b.rp_slug ? 1 : 0));

  for (const s of finalized) {
    if (isRecount(s)) { skipped.push({ rp_slug: s.rp_slug, reason: REASON.RECOUNT }); continue; }
    const outletId = outletOf(s.rp_store_id);
    if (outletId == null) { skipped.push({ rp_slug: s.rp_slug, reason: REASON.UNMAPPED_STORE, rp_store_id: s.rp_store_id }); continue; }
    const rpUser = s.finalized_by || s.initiated_by || null;
    const employeeId = rpUser ? employeeOf(rpUser) : null;
    if (employeeId == null) { skipped.push({ rp_slug: s.rp_slug, reason: REASON.UNMAPPED_USER, rp_user_id: rpUser }); continue; }
    const cycleId = cycleOf(outletId, s.finalized_at);
    if (cycleId == null) { skipped.push({ rp_slug: s.rp_slug, reason: REASON.NO_CYCLE, outlet_id: outletId }); continue; }

    const key = keyOf(cycleId, outletId, s.article_id);
    if (alreadyCredited.has(key)) { skipped.push({ rp_slug: s.rp_slug, reason: REASON.ALREADY_CREDITED, key }); continue; }
    const first = taken.get(key);
    if (first) { duplicates.push({ rp_slug: s.rp_slug, reason: REASON.DUPLICATE, credited_to: first.session_slug, rp_user_id: rpUser }); continue; }

    const row = { cycle_id: cycleId, outlet_id: outletId, article_id: s.article_id, employee_id: employeeId, rp_user_id: rpUser, session_slug: s.rp_slug, finalized_at: s.finalized_at };
    taken.set(key, row);
    credited.push(row);
  }
  return { credited, duplicates, skipped };
}

/** Credited articles per employee per cycle: { "<cycle>|<employee>": count } */
function countByEmployee(credited) {
  const out = {};
  for (const c of credited) {
    const k = `${c.cycle_id}|${c.employee_id}`;
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

module.exports = { creditArticles, countByEmployee, keyOf, REASON };
