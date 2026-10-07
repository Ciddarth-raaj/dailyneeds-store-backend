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
 *   another PENDING request on the date        -> NOT raised (the date's one
 *   (a regularization or permission)              open slot is taken); listed
 *                                                under blocked_by_open_request
 *                                                with its minutes - re-run once
 *                                                that request is decided
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
 *   # 2. apply (after migration 20261124120000 has run)
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

/**
 * Plan every employee's window, then sync it (dry run unless `apply`). One
 * failure never stops the rest.
 */
async function run({
  calculateRange,
  syncAutoOt,
  listEmployees,
  listApprovalAuthority = async () => null,
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
      "Automatic pending OT is not enabled (migration 20261124120000 not run, or its setting row is disabled) - run the migration first, or preview without --apply"
    );
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
  };
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
        })
      );

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
        blocked.length;

      // Every new record must have somebody active to decide it.
      for (const c of created) {
        const problem = c.chain_error || (authority ? chainProblem(c.chain, authority) : null);
        if (problem) chainProblems.push({ employee_id: plan.employee_id, attendance_date: c.attendance_date, problem });
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
    },
    employees_without_valid_approval_chain: chainProblems,
    // Eligible OT on a date another PENDING request holds: NOT raised. Decide
    // the blocking request, then re-run the backfill while the date is still
    // in the employee's window.
    blocked_by_open_request: blockedByOpenRequest,
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
      listEmployees: ({ from_date, to_date }) => calcRepo.listEmployeesForRecalculation({ from_date, to_date }),
      listApprovalAuthority: () => regRepo.listApprovalAuthority(),
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

module.exports = { parseArgs, windowFor, chainProblem, punched, run, DEFAULT_DAYS, DEFAULT_LOOKBACK };
