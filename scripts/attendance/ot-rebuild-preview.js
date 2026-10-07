#!/usr/bin/env node
/**
 * OT REBUILD PREVIEW - READ-ONLY. There is no --apply.
 *
 * For each month asked for (default September and October 2026), every
 * employee/date with OT or potential OT, set side by side:
 *
 *   the existing OT request (id, status, minutes)  vs  the OT the CURRENT
 *   engine computes for that day now (`calculateRange` - in memory, nothing
 *   stored - judged by the auto-OT sync's own `autoOtVerdict`)
 *
 * with the difference, the reason for it, and the action a rebuild WOULD take.
 * It writes NO attendance, OT, approval or payroll row: its only SQL is three
 * SELECTs, and the engine is only asked to calculate. It sends no Telegram.
 *
 * A row is listed when the date has an OT request (any status but CANCELLED),
 * or the fresh day has eligible OT, or the stored or fresh day carries any OT
 * minutes at all (potential OT the verdict did not accept is listed too, with
 * its reason).
 *
 * ================================================ PROPOSED ACTION =======
 *
 *   existing REJECTED                         -> REJECTED - PRESERVE
 *   PENDING / APPROVED, fresh = existing      -> UNCHANGED
 *   PENDING / APPROVED, fresh = 0             -> NO OT AFTER RECALC - WOULD REMOVE
 *   PENDING, fresh != existing                -> PENDING - WOULD REBUILD
 *   APPROVED, fresh != existing               -> APPROVED - WOULD REBUILD
 *   no request, fresh > 0                     -> NO OLD REQUEST - WOULD CREATE
 *   no request, fresh = 0                     -> UNCHANGED
 *
 * "Existing minutes": PENDING and REJECTED the request's candidate minutes,
 * APPROVED its approved minutes. "Fresh": the claimable OT of the fresh day
 * (pre-shift + post-shift, under the shift's own OT rules, unused lunch never
 * OT, shift-authorised OT excluded) - 0 when the day is not eligible.
 *
 * A payroll-locked month is still reported, flagged `payroll_locked`.
 *
 * Usage, on the server, from the repository root:
 *
 *   NODE_ENV=production node scripts/attendance/ot-rebuild-preview.js \
 *     [--month 2026-09 --month 2026-10] [--out-dir logs]
 *
 * Writes <out-dir>/ot-rebuild-preview-<stamp>.json and .csv, and prints the
 * summary and the full CSV to stdout. Exit 1 if any row could not be
 * recalculated.
 */

const fs = require("fs");
const path = require("path");
const { istToday } = require("../../utils/istDate");
const { addDays } = require("../../utils/attendance_engine");

const DEFAULT_MONTHS = ["2026-09", "2026-10"];

const ACTION = Object.freeze({
  REJECTED_PRESERVE: "REJECTED - PRESERVE",
  PENDING_REBUILD: "PENDING - WOULD REBUILD",
  APPROVED_REBUILD: "APPROVED - WOULD REBUILD",
  WOULD_CREATE: "NO OLD REQUEST - WOULD CREATE",
  WOULD_REMOVE: "NO OT AFTER RECALC - WOULD REMOVE",
  UNCHANGED: "UNCHANGED",
  NOT_RECALCULATED: "COULD NOT RECALCULATE",
});

function parseArgs(argv) {
  const out = { months: [], out_dir: "logs" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--preview") continue;
    if (arg === "--month") {
      const m = String(argv[i + 1] || "");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error("--month takes YYYY-MM");
      out.months.push(m);
      i += 1;
    } else if (arg === "--out-dir") {
      if (!argv[i + 1]) throw new Error("--out-dir takes a directory");
      out.out_dir = argv[i + 1];
      i += 1;
    } else {
      // --apply included: this script never writes.
      throw new Error(`unknown argument ${arg} (this preview is read-only; there is no --apply)`);
    }
  }
  if (out.months.length === 0) out.months = DEFAULT_MONTHS.slice();
  out.months = [...new Set(out.months)].sort();
  return out;
}

/** The month's first and last date, the last clamped to yesterday (today is still open). */
function monthRange(month, today) {
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${month}-${String(last).padStart(2, "0")}`;
  const yesterday = addDays(today, -1);
  const to = end < yesterday ? end : yesterday;
  return from > to ? null : { month, from, to };
}

const REQUESTS_SQL = `
  SELECT r.attendance_approval_request_id, r.request_type, r.status,
         r.requested_for_employee_id AS employee_id,
         DATE_FORMAT(r.attendance_date, '%Y-%m-%d') AS attendance_date,
         r.candidate_ot_minutes, r.approved_ot_minutes, r.auto_created,
         r.closure_reason
    FROM attendance_approval_request r
   WHERE r.request_type IN ('OT','REGULARIZATION_WITH_OT')
     AND r.attendance_date BETWEEN ? AND ?
   ORDER BY r.requested_for_employee_id, r.attendance_date, r.attendance_approval_request_id`;

const STORED_SQL = `
  SELECT d.employee_id, DATE_FORMAT(d.attendance_date, '%Y-%m-%d') AS attendance_date,
         d.work_shift_id, d.punch_count, d.raw_punch_ids, d.status, d.worked_minutes,
         d.nrm_minutes, d.base_nrm_minutes, d.break_allowance_minutes, d.actual_gap_minutes,
         d.raw_ot_minutes, d.pre_shift_ot_minutes, d.post_shift_ot_minutes,
         d.candidate_ot_minutes, d.approved_ot_minutes, d.shift_authorised_ot_minutes
    FROM attendance_day_calculation d
   WHERE d.attendance_date BETWEEN ? AND ?
   ORDER BY d.employee_id, d.attendance_date`;

const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));
const json = (v) => {
  if (Array.isArray(v)) return v;
  try {
    return JSON.parse(v || "[]");
  } catch (e) {
    return [];
  }
};

/** Unused lunch on a day: the permitted break minus the OUT -> IN gaps, on 4+ even punches. */
function unusedLunch(d) {
  if (!d) return 0;
  const punches = int(d.punch_count);
  if (punches < 4 || punches % 2 === 1) return 0;
  if (d.actual_gap_minutes === null || d.actual_gap_minutes === undefined) return 0;
  return Math.max(0, int(d.break_allowance_minutes) - int(d.actual_gap_minutes));
}

/** The minutes of unused lunch a STORED day counted as OT under the old rule. */
function lunchCountedInStored(s) {
  const unused = unusedLunch(s);
  if (!unused) return 0;
  const nrm = s.base_nrm_minutes === null || s.base_nrm_minutes === undefined ? s.nrm_minutes : s.base_nrm_minutes;
  const allowed = Math.max(0, int(s.worked_minutes) - int(nrm) - unused);
  return Math.min(unused, Math.max(0, int(s.raw_ot_minutes) - allowed));
}

const claimable = (d) =>
  int(d.excess_ot_minutes === undefined || d.excess_ot_minutes === null ? d.candidate_ot_minutes : d.excess_ot_minutes);

/** Why the existing figure and the fresh one differ, as codes and one readable line. */
function explain({ request, existing, fresh, verdict, stored, day }) {
  const codes = [];
  const text = [];
  const diff = fresh - existing;
  const lunchStored = stored ? lunchCountedInStored(stored) : 0;
  const lunchFresh = unusedLunch(day);

  if (verdict && !verdict.eligible && verdict.reason !== "NO_OT") {
    codes.push(`NOT_ELIGIBLE_${verdict.reason}`);
    text.push(`fresh day not eligible for OT (${verdict.reason}${day && day.status ? `, status ${day.status}` : ""})`);
  }
  if (stored && day) {
    if (stored.work_shift_id !== null && day.work_shift_id !== undefined && Number(stored.work_shift_id) !== Number(day.work_shift_id)) {
      codes.push("SHIFT_CHANGED");
      text.push(`shift changed (stored #${stored.work_shift_id} -> #${day.work_shift_id})`);
    }
    const storedPunches = json(stored.raw_punch_ids).map(String).sort().join(",");
    const freshPunches = (day.raw_punch_ids || []).map(String).sort().join(",");
    if (int(stored.punch_count) !== int(day.punch_count) || storedPunches !== freshPunches) {
      codes.push("PUNCHES_CHANGED");
      text.push(`punches changed (${int(stored.punch_count)} -> ${int(day.punch_count)})`);
    }
  }
  if (diff < 0 && (lunchStored > 0 || (lunchFresh > 0 && -diff <= lunchFresh))) {
    const removed = lunchStored > 0 ? Math.min(lunchStored, -diff) : -diff;
    codes.push("UNUSED_LUNCH");
    text.push(
      `unused/shortened lunch: break taken ${int((stored || day).actual_gap_minutes)} of ${int((stored || day).break_allowance_minutes)} min allowed; ` +
        `${removed} min of unused lunch no longer OT` +
        (lunchStored > 0 ? "" : " (consistent with the lunch rule; stored day already corrected)")
    );
  }
  if (stored && day) {
    const preDiff = int(day.pre_shift_ot_minutes) - int(stored.pre_shift_ot_minutes);
    if (preDiff !== 0) {
      codes.push("PRE_SHIFT_OT_CHANGED");
      text.push(`pre-shift OT ${int(stored.pre_shift_ot_minutes)} -> ${int(day.pre_shift_ot_minutes)}`);
    }
    const postDiff = int(day.post_shift_ot_minutes) - int(stored.post_shift_ot_minutes) + lunchStored;
    if (postDiff !== 0) {
      codes.push("POST_SHIFT_OT_CHANGED");
      text.push(`post-shift OT ${int(stored.post_shift_ot_minutes)} -> ${int(day.post_shift_ot_minutes)}${lunchStored ? " (beyond the lunch minutes)" : ""}`);
    }
  }
  if (!stored && day) {
    codes.push("NO_STORED_DAY");
    text.push("no stored day row; figures are the engine's fresh calculation");
  }
  if (day && int(day.shift_authorised_ot_minutes) > 0) {
    codes.push("SHIFT_AUTHORISED_OT_EXCLUDED");
    text.push(`${int(day.shift_authorised_ot_minutes)} min shift-authorised OT is outside the OT request`);
  }
  if (request && request.status === "APPROVED" && int(request.approved_ot_minutes) !== int(request.candidate_ot_minutes)) {
    codes.push("APPROVER_CHANGED_MINUTES");
    text.push(`approver approved ${int(request.approved_ot_minutes)} of ${int(request.candidate_ot_minutes)} requested`);
  }
  if (request && stored && diff !== 0 && claimable(stored) === fresh && !codes.includes("UNUSED_LUNCH")) {
    codes.push("REQUEST_STALE");
    text.push(`request carries ${existing} min but the stored day already shows ${fresh}`);
  }
  if (diff !== 0 && codes.length === 0) {
    codes.push("OTHER");
    text.push("figures differ; no single cause identified - check the day");
  }
  return { reason_codes: codes, reason: text.join("; ") || (diff === 0 ? "no difference" : "") };
}

function classify({ request, existing, fresh }) {
  if (request && request.status === "REJECTED") return ACTION.REJECTED_PRESERVE;
  if (!request) return fresh > 0 ? ACTION.WOULD_CREATE : ACTION.UNCHANGED;
  if (fresh === existing) return ACTION.UNCHANGED;
  if (fresh === 0) return ACTION.WOULD_REMOVE;
  return request.status === "APPROVED" ? ACTION.APPROVED_REBUILD : ACTION.PENDING_REBUILD;
}

/**
 * @param {object} deps
 * @param {Function} deps.listEmployees  ({from,to}) -> [{employee_id, employee_name}]
 * @param {Function} deps.listRequests   ({from,to}) -> OT request rows
 * @param {Function} deps.listStored     ({from,to}) -> stored day rows
 * @param {Function} deps.findLocked     (rows) -> [{employee_id, year, month}]
 * @param {Function} deps.calculateRange ({employee_id, from_date, to_date}) -> days (in memory)
 * @param {Function} deps.autoOtVerdict  (day, {now, today}) -> {eligible, minutes, reason}
 */
async function run({ listEmployees, listRequests, listStored, findLocked, calculateRange, autoOtVerdict, months, today, setting = null, log = () => {} }) {
  const ranges = months.map((m) => monthRange(m, today)).filter(Boolean);
  const report = {
    mode: "PREVIEW_READ_ONLY",
    generated_for_today: today,
    cutover: setting && setting.auto_pending_from_date ? String(setting.auto_pending_from_date).slice(0, 10) : null,
    ranges,
    rows: [],
    cancelled_requests_ignored: [],
    summary: {},
  };

  for (const range of ranges) {
    /* eslint-disable no-await-in-loop */
    const [employees, requests, stored] = await Promise.all([
      listEmployees(range),
      listRequests(range),
      listStored(range),
    ]);
    const key = (e, d) => `${Number(e)}|${d}`;
    const names = new Map((employees || []).map((e) => [Number(e.employee_id), e.employee_name || null]));
    const reqBy = new Map();
    (requests || []).forEach((r) => {
      if (r.status === "CANCELLED") {
        report.cancelled_requests_ignored.push({ month: range.month, ...r });
        return;
      }
      const k = key(r.employee_id, r.attendance_date);
      if (!reqBy.has(k)) reqBy.set(k, []);
      reqBy.get(k).push(r);
    });
    const storedBy = new Map((stored || []).map((s) => [key(s.employee_id, s.attendance_date), s]));

    // Everyone the engine calculates, plus anyone with a request or a stored row.
    const ids = new Set((employees || []).map((e) => Number(e.employee_id)));
    (requests || []).forEach((r) => ids.add(Number(r.employee_id)));
    (stored || []).forEach((s) => ids.add(Number(s.employee_id)));

    const lockProbe = [...ids].map((id) => ({ employee_id: id, attendance_date: range.from }));
    const locked = new Set(
      ((lockProbe.length ? await findLocked(lockProbe) : []) || []).map(
        (p) => `${Number(p.employee_id)}|${Number(p.year !== undefined ? p.year : p.period_year)}-${Number(p.month !== undefined ? p.month : p.period_month)}`
      )
    );
    const [ry, rm] = range.month.split("-").map(Number);
    log(`${range.month}: ${ids.size} employee(s), ${(requests || []).length} OT request(s), ${range.from}..${range.to}`);

    for (const employeeId of [...ids].sort((a, b) => a - b)) {
      let days = null;
      let failure = null;
      try {
        days = (await calculateRange({ employee_id: employeeId, from_date: range.from, to_date: range.to })) || [];
      } catch (err) {
        failure = err && err.message ? err.message : String(err);
      }
      const dayBy = new Map((days || []).map((d) => [d.attendance_date, d]));
      const dates = new Set([...dayBy.keys()]);
      for (const k of [...reqBy.keys(), ...storedBy.keys()]) {
        const [e, d] = k.split("|");
        if (Number(e) === employeeId) dates.add(d);
      }
      for (const date of [...dates].sort()) {
        const k = key(employeeId, date);
        const reqs = reqBy.get(k) || [];
        const request = reqs[0] || null; // the one the OT sync governs: the oldest live request
        const s = storedBy.get(k) || null;
        const day = dayBy.get(date) || null;
        const verdict = day ? autoOtVerdict(day, { now: null, today: null }) : null;
        const fresh = verdict && verdict.eligible ? int(verdict.minutes) : 0;
        const freshAny = day ? claimable(day) : 0;
        const storedAny = s ? Math.max(int(s.candidate_ot_minutes), int(s.raw_ot_minutes)) : 0;
        if (!request && fresh === 0 && freshAny === 0 && storedAny === 0) continue;

        const existing = !request ? 0 : request.status === "APPROVED" ? int(request.approved_ot_minutes) : int(request.candidate_ot_minutes);
        const isLocked = locked.has(`${employeeId}|${ry}-${rm}`);
        const base = {
          month: range.month,
          employee_id: employeeId,
          employee_name: names.get(employeeId) || (day && day.employee_name) || null,
          attendance_date: date,
          shift: (day && day.shift_name) || (day && day.work_shift_id ? `#${day.work_shift_id}` : s && s.work_shift_id ? `#${s.work_shift_id}` : null),
          existing_ot_request_id: request ? Number(request.attendance_approval_request_id) : null,
          existing_ot_request_type: request ? request.request_type : null,
          existing_ot_status: request ? request.status : null,
          existing_ot_minutes: existing,
          existing_ot_requested_minutes: request ? int(request.candidate_ot_minutes) : null,
          other_live_requests_on_date: reqs.slice(1).map((r) => `#${r.attendance_approval_request_id} ${r.status}`),
          stored_ot_minutes: s ? claimable(s) : null,
          stored_pre_shift_ot: s ? int(s.pre_shift_ot_minutes) : null,
          stored_post_shift_ot: s ? int(s.post_shift_ot_minutes) : null,
          payroll_locked: isLocked,
        };
        if (!day) {
          report.rows.push({
            ...base,
            fresh_ot_minutes: null,
            difference_minutes: null,
            reason_codes: ["NOT_RECALCULATED"],
            reason: failure ? `engine error: ${failure}` : "the engine returned no day for this date",
            proposed_action: request && request.status === "REJECTED" ? ACTION.REJECTED_PRESERVE : ACTION.NOT_RECALCULATED,
            could_not_recalculate: true,
          });
          continue;
        }
        const why = explain({ request, existing, fresh, verdict, stored: s, day });
        report.rows.push({
          ...base,
          fresh_ot_minutes: fresh,
          fresh_pre_shift_ot: int(day.pre_shift_ot_minutes),
          fresh_post_shift_ot: int(day.post_shift_ot_minutes),
          fresh_verdict: verdict.eligible ? "ELIGIBLE" : verdict.reason,
          break_allowance_minutes: int(day.break_allowance_minutes),
          break_taken_minutes: day.actual_gap_minutes === null || day.actual_gap_minutes === undefined ? null : int(day.actual_gap_minutes),
          unused_lunch_minutes: unusedLunch(day),
          punch_count: int(day.punch_count),
          difference_minutes: fresh - existing,
          ...why,
          proposed_action: classify({ request, existing, fresh }),
          could_not_recalculate: false,
        });
      }
    }
    /* eslint-enable no-await-in-loop */
  }

  for (const range of ranges) report.summary[range.month] = summarize(report.rows.filter((r) => r.month === range.month));
  return report;
}

function summarize(rows) {
  const by = (status) => rows.filter((r) => r.existing_ot_status === status);
  const sum = (list, f) => list.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  const changing = rows.filter((r) => r.proposed_action !== ACTION.REJECTED_PRESERVE && !r.could_not_recalculate);
  const count = (a) => rows.filter((r) => r.proposed_action === a).length;
  return {
    rows_listed: rows.length,
    employees_listed: new Set(rows.map((r) => r.employee_id)).size,
    employees_affected: new Set(rows.filter((r) => r.proposed_action !== ACTION.UNCHANGED && r.proposed_action !== ACTION.REJECTED_PRESERVE).map((r) => r.employee_id)).size,
    ot_days: rows.filter((r) => r.existing_ot_minutes > 0 || r.fresh_ot_minutes > 0).length,
    existing_pending: { count: by("PENDING").length, minutes: sum(by("PENDING"), "existing_ot_minutes") },
    existing_approved: { count: by("APPROVED").length, minutes: sum(by("APPROVED"), "existing_ot_minutes") },
    existing_rejected: { count: by("REJECTED").length, minutes: sum(by("REJECTED"), "existing_ot_minutes") },
    fresh_ot_total_minutes: sum(rows, "fresh_ot_minutes"),
    fresh_ot_total_minutes_excluding_rejected: sum(changing, "fresh_ot_minutes"),
    total_minutes_reduced: -changing.filter((r) => r.difference_minutes < 0).reduce((a, r) => a + r.difference_minutes, 0),
    total_minutes_increased: changing.filter((r) => r.difference_minutes > 0).reduce((a, r) => a + r.difference_minutes, 0),
    reductions_due_to_unused_lunch: changing.filter((r) => r.difference_minutes < 0 && (r.reason_codes || []).includes("UNUSED_LUNCH")).length,
    rejected_rows_preserved: count(ACTION.REJECTED_PRESERVE),
    pending_would_rebuild: count(ACTION.PENDING_REBUILD),
    approved_would_rebuild: count(ACTION.APPROVED_REBUILD),
    rows_would_remove: count(ACTION.WOULD_REMOVE),
    rows_would_create: count(ACTION.WOULD_CREATE),
    rows_unchanged: count(ACTION.UNCHANGED),
    rows_payroll_locked: rows.filter((r) => r.payroll_locked).length,
    rows_could_not_recalculate: rows.filter((r) => r.could_not_recalculate).length,
  };
}

const CSV_COLUMNS = [
  "month", "employee_id", "employee_name", "attendance_date", "shift",
  "existing_ot_request_id", "existing_ot_request_type", "existing_ot_status", "existing_ot_minutes", "existing_ot_requested_minutes",
  "stored_ot_minutes", "fresh_ot_minutes", "difference_minutes",
  "stored_pre_shift_ot", "fresh_pre_shift_ot", "stored_post_shift_ot", "fresh_post_shift_ot",
  "break_allowance_minutes", "break_taken_minutes", "unused_lunch_minutes", "punch_count", "fresh_verdict",
  "reason_codes", "reason", "proposed_action", "payroll_locked", "other_live_requests_on_date",
];

function toCsv(rows) {
  const cell = (v) => {
    const s = Array.isArray(v) ? v.join(" ") : v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(","))].join("\n");
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
    const query = (sql, params) =>
      new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));
    const report = await run({
      listEmployees: ({ from, to }) => calcRepo.listEmployeesForRecalculation({ from_date: from, to_date: to }),
      listRequests: ({ from, to }) => query(REQUESTS_SQL, [from, to]),
      listStored: ({ from, to }) => query(STORED_SQL, [from, to]),
      findLocked: (rows) => calcRepo.findPayrollLockedPeriodsBulk(rows),
      calculateRange: calculation.calculateRange,
      autoOtVerdict: regularization.autoOtVerdict,
      setting: await regRepo.getAutoOtSetting(),
      months: args.months,
      today: istToday(),
      log: (line) => console.error(line),
    });
    fs.mkdirSync(args.out_dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const base = path.join(args.out_dir, `ot-rebuild-preview-${stamp}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
    fs.writeFileSync(`${base}.csv`, toCsv(report.rows));
    console.log(`Full report: ${base}.json and ${base}.csv`);
    console.log(`SUMMARY ${JSON.stringify(report.summary)}`);
    console.log("=== OT REBUILD PREVIEW CSV BEGIN ===");
    console.log(toCsv(report.rows));
    console.log("=== OT REBUILD PREVIEW CSV END ===");
    return report.rows.some((r) => r.could_not_recalculate) ? 1 : 0;
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

module.exports = { parseArgs, monthRange, run, summarize, toCsv, classify, explain, ACTION, REQUESTS_SQL, STORED_SQL };
