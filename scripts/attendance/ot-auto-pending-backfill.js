#!/usr/bin/env node
/**
 * DEPLOY BACKFILL: each employee's PREVIOUS 5 ATTENDANCE DAYS of eligible OT,
 * into approval - through the SAME `syncAutoOt` the attendance engine calls
 * after every stored day. This script writes no SQL of its own, and never
 * moves the cutover row (see below). Without --apply it writes nothing.
 *
 * ================================== WHAT "5 ATTENDANCE DAYS" MEANS HERE ====
 *
 * Not five calendar days. The source is the one DnDS already uses for
 * attendance and payroll: the PERSISTED day rows with
 * `attendance_day_count > 0` (the rows behind Salary Days and the payrun's
 * "last present date"). A date is one when it has an effective punch - a
 * device punch that was not voided or ignored as a duplicate, or an APPROVED
 * regularized punch. Per employee:
 *
 *   the employee's 5 most recent such dates up to yesterday, looking back at
 *   most `--lookback` days (default 31) - and EVERY date from the oldest of
 *   those five to yesterday is evaluated, so a weekly off, holiday, leave or
 *   absence in between can never hide OT.
 *
 * Fewer than 5 such dates in the lookback: the whole lookback is evaluated.
 * Today is never evaluated (its day is still open). The preview also prints,
 * per employee, the five dates RAW PUNCHES alone would have chosen, and flags
 * every employee where the two differ.
 *
 * ================================================ THE CUTOVER IS NOT MOVED
 *
 * Each employee's sync is allowed to create OT from THEIR window's first
 * date, for THEIR dates only (`allow_creation_from`). The global cutover
 * stays at the deploy date, so no later recalculation of some other date can
 * create OT before it.
 *
 * ========================================================== PER DATE =====
 *
 *   eligible OT, no OT record                 -> created PENDING (auto)
 *   PENDING OT, minutes changed                -> follows the engine
 *   PENDING auto OT, no eligible OT any more   -> withdrawn
 *   APPROVED or REJECTED (incl. payroll-lock
 *   closures)                                  -> PRESERVED, never touched
 *   payroll-locked month                       -> NOT raised; reported with
 *                                                its minutes (and an existing
 *                                                pending one is preserved)
 *   an attendance correction PENDING on the    -> NOT raised from the uncorrected
 *   date (regularization, HR correction,          day; listed under
 *   shift change, permission)                     blocked_by_open_request and, on
 *                                                --apply only, REMEMBERED in
 *                                                attendance_ot_deferred_sync: the
 *                                                correction's final decision
 *                                                re-runs OT for that exact date
 *   INCOMPLETE ATTENDANCE (missing in- or      -> NO OT AT ALL: none raised, a
 *   out-punch, odd punch pair, pending            pending system OT withdrawn,
 *   regularization, calculation open or not       no Telegram card. Listed under
 *   FINAL)                                        incomplete_attendance (never as
 *                                                eligible or blocked minutes)
 *                                                and, on --apply only,
 *                                                REMEMBERED: re-evaluated once
 *                                                the attendance is complete,
 *                                                without moving the cutover
 *
 * Every employee's approval chain is checked (read-only), so an invalid one
 * is named even when no OT is raised for them in this run.
 *
 * NEW PENDING OT CANDIDATES (read-only, always printed, --summary-only too):
 * every record the run would create, with the day's own figures (shift,
 * punches, worked, NRM, break deducted, pre/post-shift OT), the approver and
 * flags - PRE_SHIFT_OT, EARLY_ARRIVAL_BEFORE_SHIFT, OT_OVER_120_MIN,
 * INVALID_APPROVAL_CHAIN (BREAK_SHORTER_THAN_ALLOWED_ADDS_TO_SURPLUS no longer
 * fires: an unused lunch is never OT) - plus a summary (count, minutes, min/max/avg,
 * >=60/120/180, top 20). The count and minutes must reconcile exactly with
 * totals.new_pending_*; if not, the preview reports a failure, and --apply
 * runs this preview first and refuses to write anything. --apply also takes
 * --expect-candidates N --expect-minutes M (the figures the reviewer
 * approved) and refuses unless the fresh preview matches them.
 *
 * IDEMPOTENT: a second run creates nothing. TELEGRAM: no per-date cards - each
 * named first approver gets ONE summary ("12 OT approvals pending from
 * previous days ... send /ot"); the records stay individual.
 *
 * Usage, on the server, from the repository root:
 *
 *   # 1. PREVIEW (default) - read-only: the exact dates per employee, counts
 *   NODE_ENV=production node scripts/attendance/ot-auto-pending-backfill.js
 *
 *   # 2. apply (after migration 20261125120000 has run)
 *   NODE_ENV=production node scripts/attendance/ot-auto-pending-backfill.js --apply
 *
 * Options: --days <n> attendance days (1..31, default 5), --lookback <n>
 * calendar days (5..45, default 31), --employee <id> (repeatable), --today
 * YYYY-MM-DD (default IST today; PREVIEW ONLY, never in the future - --apply
 * always runs on the real IST today), --no-telegram, --summary-only (omit the
 * per-employee detail from the JSON). Exit code 1 if anything failed.
 */

const { istToday } = require("../../utils/istDate");
const { addDays } = require("../../utils/attendance_engine");

const DEFAULT_DAYS = 5;
const DEFAULT_LOOKBACK = 31;

function parseArgs(argv) {
  const out = {
    apply: false,
    days: DEFAULT_DAYS,
    lookback: DEFAULT_LOOKBACK,
    employee_ids: [],
    today: null,
    telegram: true,
    summary_only: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--preview") out.apply = false;
    else if (arg === "--no-telegram") out.telegram = false;
    else if (arg === "--summary-only") out.summary_only = true;
    else if (arg === "--days") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error("--days takes a whole number from 1 to 31");
      out.days = n;
      i += 1;
    } else if (arg === "--lookback") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 5 || n > 45) throw new Error("--lookback takes a whole number from 5 to 45");
      out.lookback = n;
      i += 1;
    } else if (arg === "--employee") {
      const id = Number(argv[i + 1]);
      if (!Number.isInteger(id) || id <= 0) throw new Error("--employee takes a positive employee id");
      out.employee_ids.push(id);
      i += 1;
    } else if (arg === "--expect-candidates" || arg === "--expect-minutes") {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${arg} takes a whole number`);
      out[arg === "--expect-candidates" ? "expect_candidates" : "expect_minutes"] = n;
      i += 1;
    } else if (arg === "--today") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(argv[i + 1] || "")) throw new Error("--today takes YYYY-MM-DD");
      out.today = argv[i + 1];
      i += 1;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (out.days > out.lookback) throw new Error("--days cannot exceed --lookback");
  // --today only re-points a PREVIEW. A future date would judge open days as
  // closed, and a past one would let --apply raise OT for an arbitrary old
  // window, so --apply always runs on the real IST today.
  if (out.today !== null && out.apply) throw new Error("--today is for a preview only; --apply runs on today's IST date");
  if (out.today !== null && out.today > istToday()) throw new Error("--today cannot be in the future");
  return out;
}

/** Source A (comparison only): any raw device punch on the calculated day. */
const punched = (day) =>
  !!day &&
  ((Array.isArray(day.raw_punches) && day.raw_punches.length > 0) ||
    (Array.isArray(day.excluded_punches) && day.excluded_punches.length > 0) ||
    Number(day.punch_count) > 0);

/**
 * One employee's window: the oldest of their last `days` ATTENDANCE dates
 * (`attendedDates` - the persisted rows DnDS counts), or the whole lookback
 * when there are fewer, to yesterday; every calculated date in between.
 *
 * @param {object[]} calculated     the engine's days for [today-lookback, yesterday]
 * @param {string[]} attendedDates  persisted attendance dates (attendance_day_count > 0)
 */
function windowFor({ calculated, attendedDates, today, days, lookback }) {
  const yesterday = addDays(today, -1);
  const lookbackStart = addDays(today, -lookback);
  const inRange = (calculated || [])
    .filter((d) => d && d.attendance_date >= lookbackStart && d.attendance_date <= yesterday)
    .sort((a, b) => (a.attendance_date < b.attendance_date ? -1 : 1));
  const attended = [...new Set(attendedDates || [])]
    .filter((d) => d >= lookbackStart && d <= yesterday)
    .sort();
  const counted = attended.slice(-days);
  const from = counted.length >= days ? counted[0] : lookbackStart;
  const evaluated = inRange.filter((d) => d.attendance_date >= from);
  // SOURCE A, for the comparison only: the last N dates with any raw punch.
  const punchDates = inRange.filter(punched).map((d) => d.attendance_date).slice(-days);
  return {
    from_date: from,
    to_date: yesterday,
    complete: counted.length >= days,
    attendance_dates_counted: counted,
    punch_dates_last_n: punchDates,
    sources_differ: punchDates.join(",") !== counted.join(","),
    dates_evaluated: evaluated.map((d) => d.attendance_date),
    days: evaluated,
  };
}

/**
 * Can somebody ACTIVE decide every stage? A named approver must be active; a
 * role stage needs an active holder of the role (Store Manager: at that
 * outlet). Returns the problem as a sentence, or null.
 */
function chainProblem(chain, authority) {
  if (!Array.isArray(chain) || chain.length === 0) return "no approval chain";
  const active = new Set(authority.map((a) => Number(a.employee_id)));
  for (const st of chain) {
    if (st.approver_employee_id) {
      if (!active.has(Number(st.approver_employee_id))) {
        return `stage ${st.stage_no}: named approver ${st.approver_employee_id} is not an active employee`;
      }
      continue;
    }
    const holders = authority.filter(
      (a) =>
        a.approver_role === st.approver_role &&
        (st.approver_role !== "STORE_MANAGER" || Number(a.outlet_id) === Number(st.outlet_id))
    );
    if (holders.length === 0) {
      return st.approver_role === "STORE_MANAGER"
        ? `stage ${st.stage_no}: no active Store Manager mapped for outlet ${st.outlet_id} (only an administrator can decide it)`
        : `stage ${st.stage_no}: nobody active holds the ${st.approver_role} approval role (only an administrator can decide it)`;
    }
  }
  return null;
}

/* ------------------------------------------------ NEW PENDING OT CANDIDATES */

/** "10:00" from "2026-09-14 10:00:00" / "10:00:00". */
const hhmm = (v) => {
  if (!v) return null;
  const m = /(\d{2}:\d{2})(:\d{2})?$/.exec(String(v));
  return m ? m[1] : String(v);
};
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Candidates over this many minutes are flagged for a closer look. */
const HIGH_OT_MINUTES = 120;

/**
 * One NEW system Pending OT the run would create, described from the very day
 * the engine calculated for it - READ-ONLY: every figure is the engine's own
 * stored field, nothing is recalculated here.
 */
function describeCandidate({ employee_id, created, day, identity, chainProblemText, approver, shiftName = null }) {
  const d = day || {};
  const snap = d.shift_snapshot || {};
  const punches = Array.isArray(d.effective_punches) ? d.effective_punches : [];
  const punchCount = num(d.punch_count) === null ? punches.length : num(d.punch_count);
  const breakAllowed = num(d.break_allowance_minutes);
  const breakCharged = num(d.break_charged_minutes);
  const preShiftOt = num(d.pre_shift_ot_minutes) || 0;
  const postShiftOt = num(d.post_shift_ot_minutes) || 0;
  const preShiftTime = num(d.pre_shift_minutes) || 0;
  const minutes = Number(created.ot_minutes) || 0;
  // LUNCH SAVINGS NEVER BECOME OT. The engine reserves the whole permitted
  // break for OT on every punch count, so a break taken shorter than allowed
  // adds nothing to the surplus: its contribution is 0 by rule, and the two
  // break flags below can no longer fire. Kept so the report's shape (and
  // any reader of it) is unchanged.
  const breakContribution = 0;
  const flags = [];
  if (preShiftOt > 0) flags.push("PRE_SHIFT_OT");
  if (preShiftTime > 0) flags.push("EARLY_ARRIVAL_BEFORE_SHIFT");
  if (breakContribution > 0) flags.push("BREAK_SHORTER_THAN_ALLOWED_ADDS_TO_SURPLUS");
  if (preShiftTime > 0 && breakContribution > 0) flags.push("EARLY_ARRIVAL_WITH_BREAK_CONTRIBUTION");
  if (minutes > HIGH_OT_MINUTES) flags.push("OT_OVER_120_MIN");
  if (chainProblemText) flags.push("INVALID_APPROVAL_CHAIN");
  const category =
    preShiftOt > 0 && postShiftOt > 0
      ? "PRE_AND_POST_SHIFT_OT"
      : preShiftOt > 0
      ? "PRE_SHIFT_OT"
      : "POST_SHIFT_OT";
  return {
    employee_id,
    employee_name: identity ? identity.employee_name : null,
    attendance_date: created.attendance_date,
    outlet_id: identity ? identity.outlet_id : null,
    outlet_name: identity ? identity.outlet_name : null,
    shift_code: snap.shift_code || null,
    shift_name: shiftName || snap.shift_name || null,
    shift_start: hhmm(snap.in_time),
    shift_end: hhmm(snap.out_time),
    first_punch: punches.length > 0 ? hhmm(punches[0].io_time) : null,
    last_punch: punches.length > 1 ? hhmm(punches[punches.length - 1].io_time) : null,
    punch_count: punchCount,
    span_minutes: num(d.span_minutes),
    worked_minutes: num(d.worked_minutes),
    nrm_minutes: num(d.nrm_minutes),
    payroll_nrm_minutes: num(d.base_nrm_minutes),
    break_allowed_minutes: breakAllowed,
    break_deducted_minutes: breakCharged,
    actual_break_gap_minutes: num(d.actual_gap_minutes),
    pre_shift_time_minutes: preShiftTime,
    pre_shift_ot_minutes: preShiftOt,
    post_shift_ot_minutes: postShiftOt,
    ot_offset_minutes: num(d.ot_offset_minutes) || 0,
    raw_ot_minutes: num(d.raw_ot_minutes),
    shift_authorised_ot_minutes: num(d.shift_authorised_ot_minutes) || 0,
    unused_break_minutes_in_surplus: breakContribution,
    final_eligible_ot_minutes: minutes,
    payroll_month_locked: Boolean(created.source_payroll_locked),
    approver: approver || null,
    approval_chain_problem: chainProblemText || null,
    eligibility_category: category,
    flags,
  };
}

/**
 * The candidate summary, and the reconciliation that must hold before any
 * --apply: the candidate list IS the records the run would create.
 */
function summarizeCandidates(candidates, expected) {
  const minutes = candidates.map((c) => c.final_eligible_ot_minutes);
  const total = minutes.reduce((a, b) => a + b, 0);
  const keys = new Set(candidates.map((c) => `${c.employee_id}|${c.attendance_date}`));
  const problems = [];
  if (candidates.length !== expected.count) problems.push(`candidate_count ${candidates.length} != new_pending ${expected.count}`);
  if (total !== expected.minutes) problems.push(`candidate_minutes ${total} != new_pending_ot_minutes ${expected.minutes}`);
  if (keys.size !== candidates.length) problems.push(`${candidates.length - keys.size} duplicate employee/date candidate(s)`);
  const flagCount = (f) => candidates.filter((c) => c.flags.includes(f)).length;
  return {
    candidate_count: candidates.length,
    candidate_minutes: total,
    min_ot_minutes: minutes.length ? Math.min(...minutes) : null,
    max_ot_minutes: minutes.length ? Math.max(...minutes) : null,
    avg_ot_minutes: minutes.length ? Math.round((total / minutes.length) * 10) / 10 : null,
    count_ge_60: minutes.filter((m) => m >= 60).length,
    count_ge_120: minutes.filter((m) => m >= 120).length,
    count_ge_180: minutes.filter((m) => m >= 180).length,
    flagged: {
      pre_shift_ot: flagCount("PRE_SHIFT_OT"),
      early_arrival_before_shift: flagCount("EARLY_ARRIVAL_BEFORE_SHIFT"),
      break_shorter_than_allowed_adds_to_surplus: flagCount("BREAK_SHORTER_THAN_ALLOWED_ADDS_TO_SURPLUS"),
      early_arrival_with_break_contribution: flagCount("EARLY_ARRIVAL_WITH_BREAK_CONTRIBUTION"),
      ot_over_120_min: flagCount("OT_OVER_120_MIN"),
      invalid_approval_chain: flagCount("INVALID_APPROVAL_CHAIN"),
    },
    top_20_by_ot_minutes: [...candidates]
      .sort((a, b) => b.final_eligible_ot_minutes - a.final_eligible_ot_minutes || a.employee_id - b.employee_id || (a.attendance_date < b.attendance_date ? -1 : 1))
      .slice(0, 20)
      .map((c) => ({ employee_id: c.employee_id, employee_name: c.employee_name, attendance_date: c.attendance_date, final_eligible_ot_minutes: c.final_eligible_ot_minutes, flags: c.flags })),
    reconciliation: {
      ok: problems.length === 0,
      expected_new_pending: expected.count,
      expected_new_pending_minutes: expected.minutes,
      problems,
    },
  };
}

/**
 * Plan every employee's window, then sync it (dry run unless `apply`). One
 * failure never stops the rest.
 */
async function run({
  calculateRange,
  syncAutoOt,
  // --apply only: re-sync remembered dates whose correction is already decided.
  resolveDeferredOt = null,
  listEmployees,
  listApprovalAuthority = async () => null,
  // Read-only: the chain an employee's OT would follow, so an invalid chain
  // is named even for an employee with no OT raised in this run.
  previewChain = null,
  // Read-only: an employee's name and outlet, for the candidate list.
  describeEmployee = async () => null,
  // Read-only: a Work Shift's name (the day's snapshot carries only its code).
  describeShift = async () => null,
  // --apply only: the candidate count and minutes the reviewer approved from
  // the preview. --apply refuses to write anything unless they match.
  expect_candidates = null,
  expect_minutes = null,
  listAttendedDates,
  setting = null,
  notifySummary = null,
  today,
  days = DEFAULT_DAYS,
  lookback = DEFAULT_LOOKBACK,
  employee_ids = [],
  apply = false,
  telegram = true,
  summary_only = false,
  log = () => {},
}) {
  const enabled = !!setting && (setting.enabled === true || Number(setting.enabled) === 1);
  if (apply && !enabled) {
    throw new Error(
      "Automatic pending OT is not enabled (migration 20261125120000 not run, or its setting row is disabled) - run the migration first, or preview without --apply"
    );
  }
  /*
   * --apply IS PRECEDED BY ITS OWN PREVIEW. The same run, read-only, first:
   * the candidate list must reconcile exactly with the records it would
   * create, and - when given - with the count and minutes the reviewer
   * approved. Anything else and nothing is written.
   */
  if (apply) {
    const dry = await run({
      calculateRange, syncAutoOt, listEmployees, listApprovalAuthority, previewChain, describeEmployee, describeShift, listAttendedDates,
      setting, today, days, lookback, employee_ids, apply: false, telegram: false, summary_only: true, log,
    });
    const rec = dry.new_pending_candidates.summary;
    const mismatch = [...rec.reconciliation.problems];
    if (expect_candidates !== null && rec.candidate_count !== Number(expect_candidates)) {
      mismatch.push(`preview now finds ${rec.candidate_count} candidates, ${expect_candidates} were approved`);
    }
    if (expect_minutes !== null && rec.candidate_minutes !== Number(expect_minutes)) {
      mismatch.push(`preview now finds ${rec.candidate_minutes} minutes, ${expect_minutes} were approved`);
    }
    if (mismatch.length > 0) {
      throw new Error(`Refusing --apply: the candidate preview does not reconcile - ${mismatch.join("; ")}`);
    }
  }
  const yesterday = addDays(today, -1);
  const lookbackStart = addDays(today, -lookback);

  const population =
    employee_ids.length > 0
      ? employee_ids.map((employee_id) => ({ employee_id }))
      : await listEmployees({ from_date: lookbackStart, to_date: yesterday });

  // ---- 1. the windows: persisted attendance days, evaluated on the engine's live days ----
  const attendedRows = await listAttendedDates({
    employee_ids: population.map((p) => Number(p.employee_id)),
    from_date: lookbackStart,
    to_date: yesterday,
  });
  const attendedOf = new Map();
  (attendedRows || []).forEach((r) => {
    const id = Number(r.employee_id);
    if (!attendedOf.has(id)) attendedOf.set(id, []);
    attendedOf.get(id).push(String(r.attendance_date).slice(0, 10));
  });
  const plans = [];
  const failures = [];
  for (const { employee_id } of population) {
    /* eslint-disable no-await-in-loop */
    try {
      const calculated = await calculateRange({ employee_id, from_date: lookbackStart, to_date: yesterday });
      const w = windowFor({ calculated, attendedDates: attendedOf.get(Number(employee_id)) || [], today, days, lookback });
      plans.push({ employee_id: Number(employee_id), ...w });
    } catch (err) {
      failures.push({ employee_id, stage: "WINDOW", message: String((err && err.message) || err) });
    }
    /* eslint-enable no-await-in-loop */
  }
  // Anyone with a persisted attendance day - or, so nothing is missed where
  // days were never persisted, any punch at all (their window is then the
  // whole lookback, because they have fewer than N persisted days).
  const withAttendance = plans.filter((p) => p.attendance_dates_counted.length > 0 || p.punch_dates_last_n.length > 0);
  const earliest = withAttendance.reduce((m, p) => (m === null || p.from_date < m ? p.from_date : m), null);

  // ---- 2. the global cutover is NOT moved (see the header) ----
  const cutover = setting ? setting.auto_pending_from_date : null;

  const authority = await listApprovalAuthority();

  // ---- 3. the sync, per employee, over exactly the planned dates ----
  const counts = {
    eligible_ot_days: 0,
    already_approved: 0,
    already_rejected: 0,
    already_pending_unchanged: 0,
    pending_minutes_would_change: 0,
    pending_held_for_approver: 0,
    new_pending: 0,
    new_pending_minutes: 0,
    changed_pending_minutes_delta: 0,
    auto_pending_withdrawn: 0,
    locked_month_eligible_days: 0,
    locked_month_eligible_minutes: 0,
    locked_month_pending_preserved: 0,
    blocked_by_open_request_days: 0,
    blocked_by_open_request_minutes: 0,
    pending_waiting_for_correction: 0,
    deferred_dates: 0,
    deferred_newly_recorded: 0,
    deferred_eligible_minutes: 0,
    deferred_incomplete_dates: 0,
    incomplete_attendance_days: 0,
  };
  // Incomplete days by whether they have a realistic OT correction path.
  const incompleteByCategory = {};
  // Remembered incomplete dates, by why they are worth re-evaluating.
  const deferredByCategory = {};
  const incompleteAttendance = [];
  const chainChecked = new Set();
  // Every NEW Pending OT the run would create, described for review.
  const candidates = [];
  const nameOf = new Map();
  const identityOf = async (id) => {
    if (!nameOf.has(id)) nameOf.set(id, await describeEmployee(id));
    return nameOf.get(id);
  };
  const shiftNames = new Map();
  const shiftNameOf = async (id) => {
    if (!id) return null;
    if (!shiftNames.has(id)) {
      try {
        shiftNames.set(id, await describeShift(id));
      } catch (err) {
        shiftNames.set(id, null);
      }
    }
    return shiftNames.get(id);
  };
  const deferredByKind = {};
  const chainProblems = [];
  const blockedByOpenRequest = [];
  const detail = [];
  const summaryByApprover = new Map();
  let roleChainNotMessaged = 0;

  for (const plan of withAttendance) {
    /* eslint-disable no-await-in-loop */
    try {
      const result = await syncAutoOt({
        employee_id: plan.employee_id,
        days: plan.days,
        today,
        source: "BACKFILL",
        dry_run: !apply,
        // NO PER-DATE CARDS: one summary per approver is sent below.
        notify: false,
        // THIS employee's window, for THIS call only.
        allow_creation_from: plan.from_date,
        // Dates an attendance correction holds open are REMEMBERED (on --apply
        // only) so the correction's decision re-runs OT for them.
        track_deferred: true,
        assume_setting: apply ? null : setting && enabled ? setting : { enabled: 1, auto_pending_from_date: plan.from_date },
      });
      if (!result.enabled) {
        failures.push({ employee_id: plan.employee_id, stage: "SYNC", message: "automatic pending OT is disabled" });
        continue;
      }
      const pos = (n) => Number(n) > 0;
      const created = result.created || [];
      const updated = result.updated || [];
      const unchanged = (result.unchanged || []).filter((u) => !u.legacy && !u.duplicate_prevented);
      const approved = result.preserved_approved || [];
      const rejected = result.preserved_rejected || [];
      const held = result.held || [];
      const locked = (result.skipped || []).filter((s) => s.reason === "PAYROLL_LOCKED");
      const blocked = (result.skipped || []).filter((s) => s.reason === "BLOCKED_BY_OPEN_REQUEST");
      counts.blocked_by_open_request_days += blocked.length;
      counts.blocked_by_open_request_minutes += blocked.reduce((n, b) => n + (Number(b.eligible_ot_minutes) || 0), 0);
      blocked.forEach((b) =>
        blockedByOpenRequest.push({
          employee_id: plan.employee_id,
          attendance_date: b.attendance_date,
          eligible_ot_minutes: b.eligible_ot_minutes,
          blocking_request_id: b.blocking_request_id,
          blocking_request_type: b.blocking_request_type,
          // EMPLOYEE_REGULARIZATION / HR_CORRECTION / PERMISSION / SHIFT_CHANGE / OTHER
          blocking_request_kind: b.blocking_request_kind || null,
        })
      );
      counts.pending_waiting_for_correction += (result.unchanged || []).filter((u) => u.waiting_for_correction).length;
      (result.deferred || []).forEach((d) => {
        counts.deferred_dates += 1;
        if (d.recorded) counts.deferred_newly_recorded += 1;
        counts.deferred_eligible_minutes += Number(d.eligible_ot_minutes) || 0;
        if (d.deferred_reason === "INCOMPLETE_ATTENDANCE") {
          counts.deferred_incomplete_dates += 1;
          deferredByKind.INCOMPLETE_ATTENDANCE = (deferredByKind.INCOMPLETE_ATTENDANCE || 0) + 1;
          const cat = d.ot_reevaluation_category || "OTHER";
          deferredByCategory[cat] = (deferredByCategory[cat] || 0) + 1;
          return;
        }
        const kind = d.blocking_request_kind || "OTHER";
        deferredByKind[kind] = (deferredByKind[kind] || 0) + 1;
      });

      /*
       * INCOMPLETE ATTENDANCE - reported on its own: no OT exists for it (none
       * raised; a pending system OT already on it is withdrawn), and it is
       * never counted as eligible or blocked minutes. Its window date is
       * remembered (--apply) for re-evaluation once attendance is complete.
       */
      const deferredOn = new Map((result.deferred || []).map((d) => [d.attendance_date, d]));
      [
        ...(result.skipped || []).filter((x) => x.attendance_incomplete).map((x) => ({ x, existing: null })),
        ...(result.withdrawn || []).filter((x) => x.attendance_incomplete).map((x) => ({ x, existing: "WITHDRAWN" })),
        ...(result.held || []).filter((x) => x.attendance_incomplete).map((x) => ({ x, existing: "HELD_FOR_APPROVER" })),
      ].forEach(({ x, existing }) => {
        const d = deferredOn.get(x.attendance_date) || null;
        // Remembered: a backfill marker (missing punches or an active
        // correction only - never an ordinary absence), or one written when
        // a pending system OT was withdrawn. A locked month's date is not.
        const remembers = existing === "WITHDRAWN" ? (apply ? Boolean(x.remembered) : true) : Boolean(d);
        const category =
          existing === "WITHDRAWN"
            ? "SYSTEM_OT_WITHDRAWN"
            : existing === "HELD_FOR_APPROVER"
            ? "PENDING_OT_HELD_FOR_APPROVER"
            : x.ot_reevaluation_category || "OTHER_NOT_FINAL_NO_OT_REEVALUATION";
        incompleteByCategory[category] = (incompleteByCategory[category] || 0) + 1;
        // A withdrawn system OT's date is remembered on --apply too: tracked.
        if (existing === "WITHDRAWN" && remembers) {
          counts.deferred_dates += 1;
          counts.deferred_incomplete_dates += 1;
          deferredByCategory.SYSTEM_OT_WITHDRAWN = (deferredByCategory.SYSTEM_OT_WITHDRAWN || 0) + 1;
        }
        counts.incomplete_attendance_days += 1;
        incompleteAttendance.push({
          employee_id: plan.employee_id,
          attendance_date: x.attendance_date,
          // ATTENDANCE_OPEN / MISSING_IN_OR_OUT_PUNCH / INCOMPLETE_PUNCH_PAIR /
          // REGULARIZATION_PENDING / CALCULATION_NOT_FINAL
          incomplete_reason: x.incomplete_reason,
          // MISSING_PUNCH_INCOMPLETE / ACTIVE_CORRECTION / SYSTEM_OT_WITHDRAWN
          // (remembered) or ORDINARY_ABSENT_NO_OT_REEVALUATION /
          // OTHER_NOT_FINAL_NO_OT_REEVALUATION (reported only).
          ot_reevaluation_category: category,
          attendance_status: x.attendance_status || null,
          punch_count: x.punch_count === undefined ? null : x.punch_count,
          review_reasons: x.review_reasons || [],
          blocking_request_id: x.blocking_request_id || null,
          blocking_request_type: x.blocking_request_type || null,
          blocking_request_kind: x.blocking_request_kind || null,
          existing_pending_ot: existing
            ? { attendance_approval_request_id: x.attendance_approval_request_id, ot_minutes: x.previous_ot_minutes !== undefined ? x.previous_ot_minutes : x.ot_minutes, action: existing }
            : null,
          ot_created: false,
          [apply ? "remembered_for_reevaluation" : "would_be_remembered_for_reevaluation"]: remembers,
        });
      });

      counts.new_pending += created.length;
      counts.new_pending_minutes += created.reduce((n, c) => n + (Number(c.ot_minutes) || 0), 0);
      counts.pending_minutes_would_change += updated.length;
      counts.changed_pending_minutes_delta += updated.reduce((n, u) => n + (u.ot_minutes - u.previous_ot_minutes), 0);
      counts.already_pending_unchanged += unchanged.length;
      counts.pending_held_for_approver += held.length;
      counts.already_approved += approved.length;
      counts.already_rejected += rejected.length;
      counts.auto_pending_withdrawn += (result.withdrawn || []).length;
      counts.locked_month_eligible_days += locked.filter((l) => pos(l.eligible_ot_minutes)).length;
      counts.locked_month_eligible_minutes += locked.reduce((n, l) => n + (Number(l.eligible_ot_minutes) || 0), 0);
      counts.locked_month_pending_preserved += locked.filter((l) => l.existing_status === "PENDING").length;
      counts.eligible_ot_days +=
        created.length +
        updated.length +
        unchanged.length +
        approved.filter((a) => pos(a.eligible_ot_minutes)).length +
        rejected.filter((r) => pos(r.eligible_ot_minutes)).length +
        held.filter((h) => pos(h.eligible_ot_minutes)).length +
        locked.filter((l) => pos(l.eligible_ot_minutes)).length +
        blocked.filter((b) => pos(b.eligible_ot_minutes)).length;

      // Every new record must have somebody active to decide it.
      if (created.length > 0) chainChecked.add(plan.employee_id);
      for (const c of created) {
        const problem = c.chain_error || (authority ? chainProblem(c.chain, authority) : null);
        if (problem) chainProblems.push({ employee_id: plan.employee_id, attendance_date: c.attendance_date, problem });
        // THE CANDIDATE, from the very day the engine calculated for it.
        const stage1 = (c.chain || []).find((st) => Number(st.stage_no) === 1) || null;
        let approver = null;
        if (stage1 && stage1.approver_employee_id) {
          const who = await identityOf(Number(stage1.approver_employee_id));
          approver = { employee_id: Number(stage1.approver_employee_id), employee_name: who ? who.employee_name : null };
        } else if (stage1) {
          const holders = (authority || []).filter(
            (a) => a.approver_role === stage1.approver_role && (stage1.approver_role !== "STORE_MANAGER" || Number(a.outlet_id) === Number(stage1.outlet_id))
          );
          approver = {
            role: stage1.approver_role,
            outlet_id: stage1.outlet_id === undefined ? null : stage1.outlet_id,
            holders: await Promise.all(holders.map(async (h) => {
              const who = await identityOf(Number(h.employee_id));
              return { employee_id: Number(h.employee_id), employee_name: who ? who.employee_name : null };
            })),
          };
        }
        const candidateDay = (plan.days || []).find((dd) => dd && dd.attendance_date === c.attendance_date);
        candidates.push(
          describeCandidate({
            employee_id: plan.employee_id,
            created: c,
            day: candidateDay,
            shiftName: await shiftNameOf(candidateDay && candidateDay.shift_snapshot ? Number(candidateDay.shift_snapshot.work_shift_id) : null),
            identity: await identityOf(plan.employee_id),
            chainProblemText: problem,
            approver,
          })
        );
        if (c.first_approver_employee_id) {
          const key = Number(c.first_approver_employee_id);
          const entry = summaryByApprover.get(key) || { count: 0, from: null, to: null };
          entry.count += 1;
          entry.from = entry.from === null || c.attendance_date < entry.from ? c.attendance_date : entry.from;
          entry.to = entry.to === null || c.attendance_date > entry.to ? c.attendance_date : entry.to;
          summaryByApprover.set(key, entry);
        } else {
          roleChainNotMessaged += 1;
        }
      }
      (result.errors || []).forEach((e) => failures.push({ employee_id: plan.employee_id, stage: "SYNC", ...e }));

      const row = {
        employee_id: plan.employee_id,
        from_date: plan.from_date,
        to_date: plan.to_date,
        attendance_dates_counted: plan.attendance_dates_counted,
        dates_evaluated: plan.dates_evaluated,
        punch_dates_last_n: plan.punch_dates_last_n,
        sources_differ: plan.sources_differ,
      };
      ["created", "updated", "withdrawn", "preserved_approved", "preserved_rejected", "held"].forEach((c) => {
        if ((result[c] || []).length > 0) {
          row[c] = result[c].map(({ chain, ...rest }) => rest); // eslint-disable-line no-unused-vars
        }
      });
      if (locked.length > 0) row.payroll_locked = locked;
      const incompleteHere = incompleteAttendance.filter((i) => i.employee_id === plan.employee_id);
      if (incompleteHere.length > 0) row.incomplete_attendance = incompleteHere.map(({ employee_id, ...rest }) => rest); // eslint-disable-line no-unused-vars
      detail.push(row);
      if (created.length > 0) {
        log(`${apply ? "created" : "would create"} ${created.length} pending OT for employee ${plan.employee_id}`);
      }
    } catch (err) {
      failures.push({ employee_id: plan.employee_id, stage: "SYNC", message: String((err && err.message) || err) });
      log(`FAILED employee ${plan.employee_id}: ${(err && err.message) || err}`);
    }
    /* eslint-enable no-await-in-loop */
  }

  // ---- 3a. every other employee's chain: an invalid one is named even when
  // no OT is raised for them in this run (their incomplete or remembered
  // dates, and all future OT, would land on it) ----
  if (typeof previewChain === "function" && authority) {
    for (const plan of withAttendance) {
      if (chainChecked.has(plan.employee_id)) continue;
      /* eslint-disable no-await-in-loop */
      let problem;
      try {
        const { chain } = await previewChain(plan.employee_id);
        problem = chainProblem(chain, authority);
      } catch (err) {
        problem = String((err && err.message) || err);
      }
      /* eslint-enable no-await-in-loop */
      if (problem) {
        chainProblems.push({
          employee_id: plan.employee_id,
          attendance_date: null,
          problem,
          // No OT is raised for them in this run; these dates would reach the
          // chain once their attendance is complete.
          no_new_ot_in_this_run: true,
          incomplete_or_remembered_dates: incompleteAttendance
            .filter((i) => i.employee_id === plan.employee_id)
            .map((i) => i.attendance_date),
        });
      }
    }
  }

  // ---- 3b. remembered dates whose correction is already decided (apply only) ----
  let deferredSweep = null;
  if (apply && typeof resolveDeferredOt === "function") {
    try {
      deferredSweep = await resolveDeferredOt({ source: "BACKFILL_SWEEP" });
    } catch (err) {
      failures.push({ employee_id: null, stage: "DEFERRED_SWEEP", message: String((err && err.message) || err) });
    }
  }

  // ---- 4. Telegram: ONE summary per named first approver (apply only) ----
  const telegramPlan = [...summaryByApprover.entries()].map(([approver_employee_id, e]) => ({
    approver_employee_id,
    count: e.count,
    from_date: e.from,
    to_date: e.to,
  }));
  const telegramSent = [];
  if (apply && telegram && notifySummary) {
    for (const t of telegramPlan) {
      /* eslint-disable no-await-in-loop */
      telegramSent.push({ ...t, outcome: await notifySummary(t) });
      /* eslint-enable no-await-in-loop */
    }
  }

  const allDates = new Set(withAttendance.flatMap((p) => p.dates_evaluated));
  const candidateSummary = summarizeCandidates(candidates, { count: counts.new_pending, minutes: counts.new_pending_minutes });
  if (!candidateSummary.reconciliation.ok) {
    failures.push({ employee_id: null, stage: "CANDIDATE_RECONCILIATION", message: candidateSummary.reconciliation.problems.join("; ") });
  }
  return {
    applied: apply,
    today,
    attendance_days: days,
    lookback_days: lookback,
    dates_covered: {
      from_date: earliest,
      to_date: yesterday,
      distinct_dates: [...allDates].sort(),
      rule: `per employee: from the oldest of their last ${days} dates with punches (max ${lookback} days back) to yesterday; every date in between is evaluated`,
    },
    // Unchanged by the backfill: ongoing automatic OT starts at the deploy cutover.
    global_cutover: cutover,
    attendance_day_source: "attendance_day_calculation.attendance_day_count > 0 (persisted)",
    source_comparison: {
      employees_where_raw_punch_dates_differ: plans.filter((p) => p.sources_differ).map((p) => ({
        employee_id: p.employee_id,
        persisted_attendance_dates: p.attendance_dates_counted,
        raw_punch_dates: p.punch_dates_last_n,
      })),
    },
    employees_checked: population.length,
    employees_with_attendance: withAttendance.length,
    employees_with_short_history: withAttendance.filter((p) => !p.complete).map((p) => p.employee_id),
    totals: {
      eligible_ot_days_found: counts.eligible_ot_days,
      already_approved: counts.already_approved,
      already_rejected: counts.already_rejected,
      already_pending_unchanged: counts.already_pending_unchanged,
      already_pending_held_for_approver: counts.pending_held_for_approver,
      [apply ? "new_pending_created" : "new_pending_would_be_created"]: counts.new_pending,
      [apply ? "pending_minutes_changed" : "pending_minutes_would_change"]: counts.pending_minutes_would_change,
      new_pending_ot_minutes: counts.new_pending_minutes,
      changed_pending_minutes_net: counts.changed_pending_minutes_delta,
      total_ot_minutes_added_to_queue: counts.new_pending_minutes + counts.changed_pending_minutes_delta,
      [apply ? "auto_pending_withdrawn" : "auto_pending_would_be_withdrawn"]: counts.auto_pending_withdrawn,
      payroll_locked_eligible_days_not_raised: counts.locked_month_eligible_days - counts.locked_month_pending_preserved,
      payroll_locked_pending_preserved: counts.locked_month_pending_preserved,
      payroll_locked_eligible_minutes: counts.locked_month_eligible_minutes,
      blocked_by_open_request_days: counts.blocked_by_open_request_days,
      blocked_by_open_request_minutes: counts.blocked_by_open_request_minutes,
      // Never eligible, never blocked minutes: listed under incomplete_attendance.
      incomplete_attendance_days: counts.incomplete_attendance_days,
      incomplete_attendance_by_category: incompleteByCategory,
      ordinary_absent_excluded_from_reevaluation: incompleteByCategory.ORDINARY_ABSENT_NO_OT_REEVALUATION || 0,
    },
    employees_without_valid_approval_chain: chainProblems,
    // READ-ONLY: every NEW system Pending OT this run would create (always
    // listed, --summary-only included), with the day's own figures and the
    // flags a reviewer must look at. Reconciles exactly with
    // totals.new_pending_* - else a failure, and --apply refuses.
    new_pending_candidates: {
      summary: candidateSummary,
      candidates: candidates.sort((a, b) => a.employee_id - b.employee_id || (a.attendance_date < b.attendance_date ? -1 : 1)),
    },
    // A date an ATTENDANCE CORRECTION (regularization, HR correction, shift
    // change, permission) holds open: no OT is raised from the uncorrected
    // day. Each is REMEMBERED (--apply only) so the correction's final
    // decision re-runs OT for that exact date, before the cutover if need be.
    blocked_by_open_request: blockedByOpenRequest,
    // A day with a missing in- or out-punch, an odd punch pair, a pending
    // regularization or a calculation still open / not FINAL: NO OT AT ALL -
    // none raised, a pending system OT withdrawn, no Telegram card, no
    // approval row. Remembered (--apply) and re-evaluated once complete.
    incomplete_attendance: incompleteAttendance,
    deferred_historical_ot: {
      [apply ? "dates_tracked" : "dates_would_be_tracked"]: counts.deferred_dates,
      newly_recorded: apply ? counts.deferred_newly_recorded : 0,
      eligible_minutes_on_uncorrected_days: counts.deferred_eligible_minutes,
      // Of those, dates remembered because their attendance is incomplete.
      incomplete_attendance_dates: counts.deferred_incomplete_dates,
      // MISSING_PUNCH_INCOMPLETE / ACTIVE_CORRECTION / SYSTEM_OT_WITHDRAWN.
      // An ordinary absence is never among them.
      incomplete_by_reevaluation_category: deferredByCategory,
      by_blocking_request_kind: deferredByKind,
      // A pending OT already raised on a date whose correction is now open:
      // kept, not approvable until the correction is decided.
      pending_ot_waiting_for_correction: counts.pending_waiting_for_correction,
      sweep: deferredSweep ? { checked: deferredSweep.checked, resolved: deferredSweep.resolved.length } : null,
    },
    telegram: {
      mode: "ONE_SUMMARY_PER_APPROVER",
      summaries: apply ? telegramSent : telegramPlan,
      new_pending_on_role_chains_not_messaged: roleChainNotMessaged,
    },
    detail: summary_only ? undefined : detail,
    failures,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
  const mysql = await require("../../drivers/mysql")().connect();
  const pool = mysql.connection;
  try {
    const calcRepo = require("../../repository/attendance_calculation")(pool);
    const regRepo = require("../../repository/attendance_regularization")(pool);
    const approverSetupRepo = require("../../repository/attendance_approver_setup")(pool);
    const calculation = require("../../usecase/attendance_calculation")(calcRepo);
    const regularization = require("../../usecase/attendance_regularization")(regRepo, calculation, approverSetupRepo);
    const otTelegram =
      args.apply && args.telegram
        ? require("../../usecase/attendance_ot_telegram")({
            regularizationUsecase: regularization,
            employeeTelegramRepo: require("../../repository/employee_telegram")(pool),
            telegram: require("../../services/telegram")(),
            webBaseUrl: process.env.WEB_APP_BASE_URL || null,
          })
        : null;
    const report = await run({
      calculateRange: calculation.calculateRange,
      syncAutoOt: regularization.syncAutoOt,
      resolveDeferredOt: regularization.resolveDeferredOt,
      listEmployees: ({ from_date, to_date }) => calcRepo.listEmployeesForRecalculation({ from_date, to_date }),
      listApprovalAuthority: () => regRepo.listApprovalAuthority(),
      previewChain: regularization.previewOtApprovalChain,
      describeEmployee: regularization.previewApprovalIdentity,
      describeShift: async (id) => {
        const shift = await calcRepo.getWorkShiftWithSchedule(id);
        return shift && shift.config ? shift.config.shift_name || null : null;
      },
      expect_candidates: args.expect_candidates,
      expect_minutes: args.expect_minutes,
      listAttendedDates: (args) => regRepo.listAttendedDates(args),
      setting: await regRepo.getAutoOtSetting(),
      notifySummary: otTelegram ? otTelegram.notifyBacklogSummary : null,
      today: istToday(args.today),
      days: args.days,
      lookback: args.lookback,
      employee_ids: args.employee_ids,
      apply: args.apply,
      telegram: args.telegram,
      summary_only: args.summary_only,
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify(report, null, 2));
    return report.failures.length === 0 ? 0 : 1;
  } finally {
    mysql.close();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    }
  );
}

module.exports = { parseArgs, windowFor, chainProblem, punched, run, describeCandidate, summarizeCandidates, DEFAULT_DAYS, DEFAULT_LOOKBACK };
