/**
 * PF FOR A WAGE MONTH, ACROSS AN EFFECTIVE-DATED CEILING CHANGE.
 *
 * WHY THIS EXISTS. EPFO revised the statutory wage ceiling from 15,000 to
 * 25,000 with effect from 17-09-2026 - part-way through a wage month. The
 * EPFO FAQ on the revision says the September 2026 contribution of an existing
 * employee is calculated SEPARATELY for two periods:
 *
 *   Period 1   01-09-2026 to 16-09-2026   subject to the 15,000 ceiling
 *   Period 2   17-09-2026 to 30-09-2026   subject to the 25,000 ceiling
 *
 * and filed in ONE ECR for the month. From October the 25,000 ceiling applies
 * to the whole month. This module is the one implementation of that rule. It
 * is pure - no database, no clock - and it does not restate any statutory
 * arithmetic: each period is charged by `salary_engine.calculatePf`, which
 * remains the PF authority, with that period's own ceilings.
 *
 * ================================================================ THE RULE
 *
 *   1. SEGMENTS. The month is cut at every ceiling-schedule boundary that
 *      falls inside it, and at the date PF coverage starts if the employee is
 *      brought into the scheme part-way through the month
 *      (`pf_applicable_from`). An ordinary month is ONE segment, and a
 *      one-segment month is charged exactly as before: the full monthly
 *      ceiling, on the whole earned Basic. That is the no-regression rule.
 *
 *   2. THE WAGE IS EARNED, THEN APPORTIONED. The month's earned PF wage is
 *      decided exactly as it always was - Basic x Salary Days / 26 - and is
 *      then divided between the segments in proportion to the PAID calendar
 *      days in each: the employed days of the segment less the loss-of-pay
 *      days that fell in it. Full attendance in September 2026 therefore
 *      splits 16/30 and 14/30; a loss-of-pay day on the 10th shrinks
 *      Period 1 and not Period 2; a joiner on the 20th has no Period 1 at all.
 *
 *   3. THE CEILING IS PRORATED BY THE SEGMENT'S CALENDAR LENGTH. A monthly
 *      ceiling applied to part of a month is that part of it: 15,000 x 16/30 =
 *      8,000 for Period 1 and 25,000 x 14/30 for Period 2. It is the length of
 *      the period - not the days the employee worked in it - that prorates the
 *      ceiling, for the same reason a whole month's 15,000 ceiling is not cut
 *      for a month with loss of pay.
 *
 *   4. EPS IS DECIDED PER SEGMENT. Membership is tested on the employee's
 *      monthly contractual Basic against THAT SEGMENT'S monthly pension
 *      ceiling, and age is taken at the segment's end. So a post-cutoff
 *      PF-only member on 20,000 has no EPS in Period 1 and EPS from 17-09-2026
 *      - the FAQ's own example.
 *
 *   5. CONTRIBUTIONS ARE ROUNDED PER SEGMENT AND SUMMED, because the FAQ asks
 *      for the contribution to be calculated for each period. The EPF share is
 *      always the employer total less EPS, so the halves still add up.
 *
 * NOTHING HERE ENROLS ANYBODY. `pf_applicable` is read, never decided; an
 * employee recorded as not in the scheme stays out of it until a person
 * changes that, and the affected-employee report is how they find out who to
 * look at.
 */

const CONFIG = require("../config/statutory");
const engine = require("./salary_engine");

const { toDateOnly, STATUS } = engine;

const toPaise = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const toRupees = (paise) => (paise === null || paise === undefined ? null : Math.round(paise) / 100);

/** Next calendar day of a `YYYY-MM-DD`, by UTC arithmetic. */
function nextDay(d) {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day + 1));
  return t.toISOString().slice(0, 10);
}
function prevDay(d) {
  const [y, m, day] = d.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, day - 1));
  return t.toISOString().slice(0, 10);
}
/** Inclusive day count between two `YYYY-MM-DD`s; 0 when `to` is before `from`. */
function daysBetween(from, to) {
  if (!from || !to || to < from) return 0;
  const a = Date.UTC(...from.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  const b = Date.UTC(...to.split("-").map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  return Math.round((b - a) / 86400000) + 1;
}

/** First and last date of a calendar month. */
function monthBounds(year, month) {
  const y = Number(year);
  const m = Number(month);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, "0")}`, days: last };
}

/**
 * THE MONTH, CUT INTO THE SEGMENTS ITS PF IS CHARGED IN.
 *
 * Every schedule row whose effective date falls inside the month starts a new
 * segment, as does `pf_applicable_from` when it falls inside it. Each segment
 * carries its calendar length and the ceiling row in force for it.
 */
function segmentMonth({ from, to, pf_applicable_from = null }, config = CONFIG) {
  const schedule = (config.pf && Array.isArray(config.pf.ceilingSchedule) ? config.pf.ceilingSchedule : []) || [];
  const cuts = new Set();
  schedule.forEach((row) => {
    const d = toDateOnly(row.effectiveFrom);
    if (d && d > from && d <= to) cuts.add(d);
  });
  const coverFrom = toDateOnly(pf_applicable_from);
  if (coverFrom && coverFrom > from && coverFrom <= to) cuts.add(coverFrom);

  const starts = [from, ...[...cuts].sort()];
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? prevDay(starts[i + 1]) : to;
    const row = engine.pfCeilingOn(start, config);
    const ceilings = row
      ? row
      : {
          wageCeiling: config.pf.wageCeiling,
          epsWageCeiling: config.pf.epsWageCeiling,
          edliWageCeiling: config.pf.edliWageCeiling,
          version: null,
          effectiveFrom: null,
        };
    return {
      from: start,
      to: end,
      calendar_days: daysBetween(start, end),
      wage_ceiling: ceilings.wageCeiling,
      eps_wage_ceiling: ceilings.epsWageCeiling,
      edli_wage_ceiling: ceilings.edliWageCeiling,
      ceiling_version: ceilings.version,
      ceiling_effective_from: ceilings.effectiveFrom || null,
    };
  });
}

/**
 * PAID CALENDAR DAYS IN EACH SEGMENT - the weights the month's earned PF wage
 * is apportioned by.
 *
 * For each segment:
 *
 *   employed      dates in it on or after joining and on or before leaving
 *   notional offs the segment's share of the month's floor(employed / 7) offs,
 *                 in proportion to its employed days (the attendance engine
 *                 has no explicit weekly-off rows; offs are notional)
 *   base          employed - notional offs
 *   attended      the sum of `attendance_day_count` on its dates
 *   loss of pay   max(0, base - attended)
 *   paid days     employed - loss of pay
 *
 * ANCHORED TO THE MONTH'S OWN LOSS OF PAY. The attendance engine has already
 * decided how many base days the month was short (`month_lop_days` = base days
 * less Salary Days). The per-segment shortfalls above only say WHERE that loss
 * fell: they are scaled so they add up to the month's figure. A full-attendance
 * month therefore has no loss of pay in any segment - even though weekly offs
 * are not spread evenly across 01-16 and 17-30 - and splits exactly 16/30 and
 * 14/30.
 *
 * WITHOUT DAY ROWS (an attendance-exempt employee, or a caller that has none)
 * every employed day is paid: the exemption pays the whole employed period.
 */
function segmentPaidDays({ segments, joined_on = null, ended_on = null, day_rows = null, month_lop_days = null }) {
  const join = toDateOnly(joined_on);
  const end = toDateOnly(ended_on);

  const employedOf = (seg) => {
    const f = join && join > seg.from ? join : seg.from;
    const t = end && end < seg.to ? end : seg.to;
    return { from: f, to: t, days: daysBetween(f, t) };
  };
  const employed = segments.map(employedOf);
  const employedTotal = employed.reduce((s, e) => s + e.days, 0);

  if (!Array.isArray(day_rows)) {
    return segments.map((seg, i) => ({
      employed_days: employed[i].days,
      attended_days: null,
      lop_days: 0,
      paid_days: employed[i].days,
      basis: "EMPLOYED_DAYS",
    }));
  }

  const monthOffs = Math.floor(employedTotal / 7);
  const raw = segments.map((seg, i) => {
    const e = employed[i];
    const attended = day_rows.reduce((sum, row) => {
      const d = toDateOnly(row.attendance_date);
      if (!d || d < e.from || d > e.to) return sum;
      const n = Number(row.attendance_day_count);
      return sum + (Number.isFinite(n) ? Math.max(0, n) : 0);
    }, 0);
    const offs = employedTotal === 0 ? 0 : (monthOffs * e.days) / employedTotal;
    const base = Math.max(0, e.days - offs);
    return { attended, shortfall: Math.max(0, base - attended) };
  });

  const rawTotal = raw.reduce((s, r) => s + r.shortfall, 0);
  const monthLop =
    month_lop_days === null || month_lop_days === undefined || !Number.isFinite(Number(month_lop_days))
      ? rawTotal
      : Math.max(0, Number(month_lop_days));

  return segments.map((seg, i) => {
    const e = employed[i];
    let lop = 0;
    if (monthLop > 0) {
      lop =
        rawTotal > 0
          ? (monthLop * raw[i].shortfall) / rawTotal
          : employedTotal > 0
          ? (monthLop * e.days) / employedTotal
          : 0;
    }
    lop = Math.min(lop, e.days);
    return {
      employed_days: e.days,
      attended_days: raw[i].attended,
      lop_days: Math.round(lop * 100) / 100,
      paid_days: Math.max(0, e.days - lop),
      basis: "ATTENDANCE",
    };
  });
}

/**
 * ONE MONTH'S PF, CHARGED PERIOD BY PERIOD FROM THE EMPLOYEE'S OWN STATUS.
 *
 * EACH PERIOD STARTS FROM WHAT THE EMPLOYEE WAS IN IT, not from the ceiling
 * alone. The EPFO FAQ's three 20,000 examples differ only in that:
 *
 *   A  excluded until 16-09 (no PF at all), member from 17-09
 *        Period 1 EPF 0 / EPS 0;        Period 2 EPF 9,333.33 / EPS 9,333.33
 *   B  EPF + EDLI member already contributing on 20,000 (higher-wage basis),
 *      not an EPS member until 17-09
 *        Period 1 EPF 10,666.67 / EPS 0; Period 2 EPF 9,333.33 / EPS 9,333.33
 *   C  EPF + EPS member capped at 15,000 until 16-09
 *        Period 1 EPF 8,000 / EPS 8,000; Period 2 EPF 9,333.33 / EPS 9,333.33
 *
 * So for every period this function settles, in order:
 *
 *   1. COVERAGE      not employed / excluded (PF not applicable, or before
 *                    `pf_applicable_from`) / covered
 *   2. BASIS         CEILING (EPF wage capped at the period's ceiling) or
 *                    ACTUAL_WAGE (an existing higher-wage contributor: EPF on
 *                    the whole wage share) - the employee's recorded
 *                    `pf_contribution_basis`, else the configured default
 *   3. EPS           `resolveEpsEligibility` against THAT period's monthly
 *                    pension ceiling, on the contractual Basic, age at the
 *                    period's end - giving EPF_ONLY or EPF_EPS
 *
 * and only then charges the period: EPF wage, EPS wage = min(EPF wage, the
 * period's prorated pension ceiling) when EPS applies, EDLI wage, and the
 * contributions.
 *
 * EXACT FIRST, ROUNDED ONCE. Every period is computed to the paisa (the
 * precision of the FAQ's own figures). The month's exact figures are their
 * sum; the payroll / ECR figures are those totals rounded ONCE to whole
 * rupees by the configured convention, with the employer EPF share always the
 * employer total less EPS. An ordinary month is one period and so comes out
 * exactly as before.
 *
 * @param {object} input
 * @param {number} input.year, input.month
 * @param {number} input.monthly_basic          contractual monthly Basic (EPS membership test)
 * @param {number} input.earned_basic           Basic x Salary Days / 26
 * @param {*}      input.pf_applicable          tri-state, as recorded
 * @param {string} [input.pf_applicable_from]   date PF coverage starts, when part-way through
 * @param {string} [input.pf_contribution_basis] CEILING | ACTUAL_WAGE | null (configured default)
 * @param {string} input.dob, input.date_of_joining, input.previous_eps_member
 * @param {string} [input.resignation_date]
 * @param {Array}  [input.day_rows]             `{ attendance_date, attendance_day_count }`
 * @param {number} [input.month_lop_days]       base days less Salary Days
 */
function calculatePfForMonth(input = {}, config = CONFIG) {
  const { from, to, days } = monthBounds(input.year, input.month);
  const segments = segmentMonth({ from, to, pf_applicable_from: input.pf_applicable_from }, config);
  const split = segments.length > 1;
  const basis = resolveBasis(input.pf_contribution_basis, config);
  const coverFrom = toDateOnly(input.pf_applicable_from);

  /*
   * THE EARNED BASIC, APPORTIONED BY PAID DAYS, IN PAISE. One period takes all
   * of it. Several take it in proportion to their paid days; the last weighted
   * period takes the remainder so the parts add back exactly.
   */
  const earnedPaise = toPaise(input.earned_basic);
  const paid = split
    ? segmentPaidDays({
        segments,
        joined_on: input.date_of_joining,
        ended_on: input.resignation_date,
        day_rows: input.day_rows,
        month_lop_days: input.month_lop_days,
      })
    : [{ employed_days: segments[0].calendar_days, attended_days: null, lop_days: null, paid_days: segments[0].calendar_days, basis: "WHOLE_MONTH" }];
  const shares = segments.map(() => 0);
  if (earnedPaise !== null) {
    if (!split) shares[0] = earnedPaise;
    else {
      const weightTotal = paid.reduce((s, p) => s + p.paid_days, 0);
      if (weightTotal > 0) {
        let allocated = 0;
        let lastWeighted = -1;
        paid.forEach((p, i) => {
          if (p.paid_days > 0) lastWeighted = i;
        });
        paid.forEach((p, i) => {
          if (i === lastWeighted) shares[i] = earnedPaise - allocated;
          else {
            shares[i] = Math.round((earnedPaise * p.paid_days) / weightTotal);
            allocated += shares[i];
          }
        });
      }
    }
  }

  /* Exact (paisa) arithmetic per period; the month is rounded once below. */
  const exactConfig = {
    ...config,
    pf: { ...config.pf, applyCeilingToWage: basis === BASIS.CEILING },
    rounding: { ...config.rounding, contributionRounding: "NONE" },
  };

  const results = segments.map((seg, i) => {
    const prorate = (monthly) =>
      split ? toRupees(Math.round((toPaise(monthly) * seg.calendar_days) / days)) : monthly;
    const employed = paid[i].employed_days > 0;
    const coverageStarted = !coverFrom || coverFrom <= seg.from;
    const pfRecorded = engine.triState(input.pf_applicable);
    /*
     * A PERIOD WITH NO PAY IN IT IS NOT CHARGED - before joining, after
     * leaving, before PF coverage starts. In a split month, charging it would
     * ask EPS questions about a period nobody was paid in.
     */
    const charge = coverageStarted && (!split || (employed && shares[i] > 0));
    const edliCeiling =
      basis === BASIS.ACTUAL_WAGE && config.pf.higherWageEdliOnActualWage !== false
        ? Infinity
        : prorate(seg.edli_wage_ceiling);
    const pf = engine.calculatePf(
      {
        basic: earnedPaise === null ? null : toRupees(shares[i]),
        pf_applicable: charge ? input.pf_applicable : 0,
        dob: input.dob,
        date_of_joining: input.date_of_joining,
        previous_eps_member: input.previous_eps_member,
        eps_test_wage: input.monthly_basic,
        as_of: seg.to,
        ceilings: {
          wageCeiling: prorate(seg.wage_ceiling),
          epsWageCeiling: prorate(seg.eps_wage_ceiling),
          edliWageCeiling: edliCeiling,
          epsEligibilityCeiling: seg.eps_wage_ceiling,
          version: seg.ceiling_version,
        },
      },
      exactConfig
    );

    let state;
    if (!employed) state = STATE.NOT_EMPLOYED;
    else if (!coverageStarted || pfRecorded === false) state = STATE.EXCLUDED;
    else if (pfRecorded === null) state = STATE.PF_NOT_RECORDED;
    else if (!charge) state = STATE.NO_PAY;
    else if (pf.eps_eligibility && pf.eps_eligibility.eligible === true) state = STATE.EPF_EPS;
    else if (pf.eps_eligibility && pf.eps_eligibility.eligible === false) state = STATE.EPF_ONLY;
    else state = STATE.EPS_UNRESOLVED;

    return {
      seg,
      pf,
      record: segmentRecord(seg, pf, {
        prorated: split,
        wage_share: toRupees(shares[i]),
        paid: split ? paid[i] : null,
        covered: charge,
        state,
        basis,
        applied_ceiling: prorate(seg.wage_ceiling),
        applied_eps_ceiling: prorate(seg.eps_wage_ceiling),
      }),
    };
  });

  /* ---------------------------------------------------- the month, exact */
  const sumPaise = (key) => {
    let total = 0;
    for (const r of results) {
      if (r.pf.status === STATUS.NOT_APPLICABLE) continue;
      const v = r.pf[key];
      if (v === null || v === undefined) return null;
      total += toPaise(v);
    }
    return total;
  };
  const exact = {
    pf_wage: sumPaise("pf_wage"),
    eps_wage: sumPaise("eps_wage"),
    edli_wage: sumPaise("edli_wage"),
    employee_pf: sumPaise("employee_pf"),
    employer_pf_total: sumPaise("employer_pf_total"),
    employer_eps: sumPaise("employer_eps"),
    edli: sumPaise("edli"),
    pf_admin_charge: sumPaise("pf_admin_charge"),
  };
  exact.employer_epf =
    exact.employer_pf_total === null || exact.employer_eps === null ? null : exact.employer_pf_total - exact.employer_eps;
  exact.total_remittance = [exact.employee_pf, exact.employer_pf_total, exact.edli, exact.pf_admin_charge].some((v) => v === null)
    ? null
    : exact.employee_pf + exact.employer_pf_total + exact.edli + exact.pf_admin_charge;

  /* ------------------------------------- the month, rounded ONCE, to file */
  const mode = config.rounding.contributionRounding;
  const round = (p) => (p === null ? null : engine.roundContributionPaise(p, mode));
  const employeePf = round(exact.employee_pf);
  const employerTotal = round(exact.employer_pf_total);
  const employerEps = round(exact.employer_eps);
  const employerEpf = employerTotal === null || employerEps === null ? null : employerTotal - employerEps;
  const edli = round(exact.edli);
  const admin = round(exact.pf_admin_charge);

  const pending = results.some((r) => r.pf.status === STATUS.PENDING);
  const anyApplied = results.some((r) => r.pf.status === STATUS.APPLIED);
  /*
   * A MEMBER WITH NOTHING PAID IN THE MONTH IS STILL A MEMBER: APPLIED with
   * zero contributions, so the ECR still carries them with their NCP days.
   */
  const memberAllMonth = engine.triState(input.pf_applicable) === true && (!coverFrom || coverFrom <= to);
  const status = pending ? STATUS.PENDING : anyApplied || memberAllMonth ? STATUS.APPLIED : STATUS.NOT_APPLICABLE;

  const unresolved = [];
  results.forEach((r) =>
    (r.pf.unresolved || []).forEach((u) => {
      if (!unresolved.some((x) => x.code === u.code && x.component === u.component)) {
        unresolved.push(split ? { ...u, period_from: r.seg.from, period_to: r.seg.to } : { ...u });
      }
    })
  );

  const states = results.map((r) => r.record.state);
  const scenario = scenarioOf(states, basis, split);

  const rupees = (p) => toRupees(p);
  return {
    status,
    unresolved,
    pf_wage: rupees(exact.pf_wage),
    eps_wage: rupees(exact.eps_wage),
    edli_wage: rupees(exact.edli_wage),
    employee_pf: rupees(employeePf),
    employer_pf_total: rupees(employerTotal),
    employer_epf: rupees(employerEpf),
    employer_eps: rupees(employerEps),
    edli: rupees(edli),
    pf_admin_charge: rupees(admin),
    total_remittance:
      [employeePf, employerTotal, edli, admin].some((v) => v === null) ? null : rupees(employeePf + employerTotal + edli + admin),
    exact: Object.fromEntries(Object.entries(exact).map(([k, v]) => [k, rupees(v)])),
    pf_contribution_basis: basis,
    pf_scenario: scenario,
    wage_ceiling: split ? null : segments[0].wage_ceiling,
    ceiling_version: [...new Set(segments.map((s) => s.ceiling_version).filter(Boolean))].join("+") || null,
    eps_eligibility: split
      ? results.map((r) => ({ period_from: r.seg.from, period_to: r.seg.to, ...(r.pf.eps_eligibility || {}) }))
      : results[0].pf.eps_eligibility,
    split,
    segments: results.map((r) => r.record),
  };
}

/* ------------------------------------------------- states and scenarios */

const BASIS = { CEILING: "CEILING", ACTUAL_WAGE: "ACTUAL_WAGE" };

/** The employee's recorded contribution basis, else the configured default. */
function resolveBasis(value, config = CONFIG) {
  const v = value === null || value === undefined ? "" : String(value).trim().toUpperCase();
  if (v === BASIS.ACTUAL_WAGE) return BASIS.ACTUAL_WAGE;
  if (v === BASIS.CEILING) return BASIS.CEILING;
  return config.pf.applyCeilingToWage === false ? BASIS.ACTUAL_WAGE : BASIS.CEILING;
}

/** What the employee WAS in one period. */
const STATE = {
  NOT_EMPLOYED: "NOT_EMPLOYED",
  EXCLUDED: "EXCLUDED",
  PF_NOT_RECORDED: "PF_NOT_RECORDED",
  NO_PAY: "NO_PAY",
  EPF_ONLY: "EPF_ONLY",
  EPF_EPS: "EPF_EPS",
  EPS_UNRESOLVED: "EPS_UNRESOLVED",
};

/**
 * THE MONTH'S SCENARIO LABEL - stored with the calculation so a September
 * figure says which case it was. A split month is `<P1 state> > <P2 state>`
 * with the basis, prefixed by the FAQ letter where it is one of the three:
 *
 *   FAQ_A  EXCLUDED > EPF_EPS
 *   FAQ_B  EPF_ONLY (ACTUAL_WAGE) > EPF_EPS
 *   FAQ_C  EPF_EPS (CEILING) > EPF_EPS
 */
function scenarioOf(states, basis, split) {
  const body = `${states.join(">")}|${basis}`;
  if (!split) return body;
  const [p1, p2] = [states[0], states[states.length - 1]];
  let faq = null;
  if (p1 === STATE.EXCLUDED && p2 === STATE.EPF_EPS) faq = "FAQ_A";
  else if (p1 === STATE.EPF_ONLY && p2 === STATE.EPF_EPS && basis === BASIS.ACTUAL_WAGE) faq = "FAQ_B";
  else if (p1 === STATE.EPF_EPS && p2 === STATE.EPF_EPS && basis === BASIS.CEILING) faq = "FAQ_C";
  return faq ? `${faq}:${body}` : body;
}

/** The audit record of one period: what it was, what it was charged on, and what came out (exact). */
function segmentRecord(seg, pf, extra = {}) {
  return {
    from: seg.from,
    to: seg.to,
    calendar_days: seg.calendar_days,
    ceiling_version: seg.ceiling_version,
    monthly_wage_ceiling: seg.wage_ceiling,
    monthly_eps_wage_ceiling: seg.eps_wage_ceiling,
    applied_wage_ceiling: extra.applied_ceiling,
    applied_eps_wage_ceiling: extra.applied_eps_ceiling,
    prorated: Boolean(extra.prorated),
    state: extra.state,
    contribution_basis: extra.basis,
    pf_covered: extra.covered === undefined ? true : extra.covered,
    earned_basic_share: extra.wage_share === undefined ? null : extra.wage_share,
    employed_days: extra.paid ? extra.paid.employed_days : null,
    attended_days: extra.paid ? extra.paid.attended_days : null,
    lop_days: extra.paid ? extra.paid.lop_days : null,
    paid_days: extra.paid ? extra.paid.paid_days : null,
    status: pf.status,
    pf_wage: pf.pf_wage,
    eps_wage: pf.eps_wage ?? (pf.status === STATUS.NOT_APPLICABLE ? 0 : null),
    edli_wage: pf.edli_wage ?? (pf.status === STATUS.NOT_APPLICABLE ? 0 : null),
    employee_pf: pf.employee_pf,
    employer_pf_total: pf.employer_pf_total,
    employer_epf: pf.employer_epf,
    employer_eps: pf.employer_eps,
    edli: pf.edli ?? null,
    pf_admin_charge: pf.pf_admin_charge ?? null,
    eps_eligible: pf.eps_eligibility ? pf.eps_eligibility.eligible : null,
    eps_reason: pf.eps_eligibility ? pf.eps_eligibility.reason || pf.eps_eligibility.unresolved || null : null,
  };
}

module.exports = {
  BASIS,
  STATE,
  resolveBasis,
  scenarioOf,
  monthBounds,
  segmentMonth,
  segmentPaidDays,
  calculatePfForMonth,
  daysBetween,
  nextDay,
};
