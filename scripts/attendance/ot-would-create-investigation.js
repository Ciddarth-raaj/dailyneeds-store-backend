#!/usr/bin/env node
/**
 * WHY HAS THIS DATE NO OT REQUEST? - READ-ONLY. There is no --apply.
 *
 * Takes the rows the OT rebuild preview (`ot-rebuild-preview.js`) marked
 * `NO OLD REQUEST - WOULD CREATE` and, for each, collects the facts that
 * decide whether the automatic OT sync SHOULD have raised a request:
 *
 *   the cutover (and when automatic OT went live), the payroll lock (and
 *   when), the STORED day the sync last saw (status, FINAL, punches, its OT,
 *   when it was calculated), the fresh day, every approval request on the
 *   date in any state (OT, regularization, shift change, permission), the
 *   automatic-OT audit log, and the deferred-OT marker.
 *
 * and classifies the row:
 *
 *   EXPECTED NO REQUEST - REJECTED/PRESERVED   an OT request on the date was
 *                                              rejected, or cancelled by a person
 *   EXPECTED NO REQUEST - LOCKED               the month's payroll is locked
 *   EXPECTED NO REQUEST - ATTENDANCE NOT FINAL a correction is pending, a deferred
 *                                              marker waits, or the stored day is
 *                                              not FINAL / complete
 *   EXPECTED NO REQUEST - PRE-CUTOVER          date before automatic OT began
 *   EXPECTED NO REQUEST - SHIFT CHANGE COVERED an approved one-day shift change
 *                                              authorised the OT the stored day had
 *   VALID MISSING OT - SHOULD CREATE           the stored day was FINAL with OT,
 *                                              after the cutover, unlocked, no
 *                                              correction, no request ever
 *   UNKNOWN - NEEDS MANUAL REVIEW              anything else (e.g. the stored day
 *                                              had no OT and only the fresh one does)
 *
 * It writes no row and sends nothing: SELECTs and an in-memory calculation.
 *
 * Usage, on the server, from the repository root:
 *
 *   NODE_ENV=production node scripts/attendance/ot-would-create-investigation.js \
 *     [--from-json logs/ot-rebuild-preview-XXXX.json] [--month 2026-09 --month 2026-10] [--out-dir logs]
 *
 * --from-json takes the exact rows of an earlier preview; without it the
 * preview is run again now.
 */

const fs = require("fs");
const path = require("path");
const { istToday } = require("../../utils/istDate");
const preview = require("./ot-rebuild-preview");

const CLASS = Object.freeze({
  VALID: "VALID MISSING OT - SHOULD CREATE",
  PRE_CUTOVER: "EXPECTED NO REQUEST - PRE-CUTOVER",
  LOCKED: "EXPECTED NO REQUEST - LOCKED",
  NOT_FINAL: "EXPECTED NO REQUEST - ATTENDANCE NOT FINAL",
  REJECTED: "EXPECTED NO REQUEST - REJECTED/PRESERVED",
  SHIFT_CHANGE: "EXPECTED NO REQUEST - SHIFT CHANGE COVERED",
  UNKNOWN: "UNKNOWN - NEEDS MANUAL REVIEW",
});
const CORRECTION_TYPES = ["REGULARIZATION", "REGULARIZATION_WITH_OT", "SHIFT_CHANGE", "PERMISSION"];
const SYSTEM_WITHDRAWAL = /^Withdrawn by the system/i;

function parseArgs(argv) {
  const out = { months: [], out_dir: "logs", from_json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--month") {
      out.months.push(argv[i + 1]);
      i += 1;
    } else if (arg === "--out-dir") {
      out.out_dir = argv[i + 1];
      i += 1;
    } else if (arg === "--from-json") {
      out.from_json = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument ${arg} (this investigation is read-only; there is no --apply)`);
    }
  }
  if (out.months.length === 0) out.months = ["2026-09", "2026-10"];
  return out;
}

const SQL = {
  requests: `
    SELECT r.attendance_approval_request_id, r.request_type, r.status, r.auto_created,
           r.candidate_ot_minutes, r.approved_ot_minutes, r.closure_reason, r.requested_by_employee_id,
           DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i') AS created_at,
           DATE_FORMAT(r.decided_at, '%Y-%m-%d %H:%i') AS decided_at
      FROM attendance_approval_request r
     WHERE r.requested_for_employee_id = ? AND r.attendance_date = ?
     ORDER BY r.attendance_approval_request_id`,
  autoLog: `
    SELECT attendance_approval_request_id, action, previous_ot_minutes, new_ot_minutes, trigger_source,
           DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
      FROM attendance_ot_auto_pending_log
     WHERE employee_id = ? AND attendance_date = ?
     ORDER BY attendance_ot_auto_pending_log_id`,
  deferred: `
    SELECT deferred_sync_id, status, reason, resolution, source, blocking_request_id, blocking_request_type,
           eligible_ot_minutes, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
      FROM attendance_ot_deferred_sync
     WHERE employee_id = ? AND attendance_date = ?`,
  stored: `
    SELECT status, is_final, punch_count, candidate_ot_minutes, pre_shift_ot_minutes, post_shift_ot_minutes,
           shift_authorised_ot_minutes, work_shift_id,
           DATE_FORMAT(calculated_at, '%Y-%m-%d %H:%i') AS calculated_at
      FROM attendance_day_calculation
     WHERE employee_id = ? AND attendance_date = ?`,
  lock: `
    SELECT status, DATE_FORMAT(locked_at, '%Y-%m-%d %H:%i') AS locked_at
      FROM payrun_employee_calculation
     WHERE employee_id = ? AND period_year = ? AND period_month = ?`,
  setting: `
    SELECT enabled, DATE_FORMAT(auto_pending_from_date, '%Y-%m-%d') AS auto_pending_from_date,
           DATE_FORMAT(created_at, '%Y-%m-%d %H:%i') AS created_at
      FROM attendance_ot_auto_pending_setting WHERE setting_id = 1`,
};

const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));
const yesNo = (b) => (b ? "YES" : "NO");

/** Pure: the facts of one row -> its answers and classification. */
function classify(f) {
  const { row, setting, stored, fresh, verdict, requests, autoLog, deferred, lock } = f;
  const date = row.attendance_date;
  const cutover = setting ? setting.auto_pending_from_date : null;
  const otReqs = requests.filter((r) => r.request_type === "OT" || r.request_type === "REGULARIZATION_WITH_OT");
  const corrections = requests.filter((r) => CORRECTION_TYPES.includes(r.request_type));
  const pendingCorrections = corrections.filter((r) => r.status === "PENDING");
  const approvedShiftChange = requests.filter((r) => r.request_type === "SHIFT_CHANGE" && r.status === "APPROVED");
  const rejectedOt = otReqs.filter((r) => r.status === "REJECTED");
  const cancelledOt = otReqs.filter((r) => r.status === "CANCELLED");
  const cancelledByPerson = cancelledOt.filter((r) => !SYSTEM_WITHDRAWAL.test(r.closure_reason || ""));
  const loggedIds = new Set(autoLog.map((l) => Number(l.attendance_approval_request_id)));
  const presentIds = new Set(otReqs.map((r) => Number(r.attendance_approval_request_id)));
  const deletedIds = [...loggedIds].filter((id) => !presentIds.has(id));

  const beforeCutover = Boolean(cutover && date < cutover);
  const lockedNow = Boolean(lock && lock.status === "APPROVED_LOCKED");
  const storedOt = stored ? int(stored.candidate_ot_minutes) : null;
  const storedFinal = Boolean(stored && Number(stored.is_final) === 1 && stored.status === "FINAL" && int(stored.punch_count) % 2 === 0);
  const freshFinal = Boolean(fresh && fresh.is_final === true && fresh.status === "FINAL" && int(fresh.punch_count) % 2 === 0);
  const freshAuthorised = fresh ? int(fresh.shift_authorised_ot_minutes) : 0;
  const storedAuthorised = stored ? int(stored.shift_authorised_ot_minutes) : 0;
  const deferredWaiting = Boolean(deferred && deferred.status === "WAITING_FOR_CORRECTION");
  const lockedBeforeCalc = Boolean(lockedNow && lock.locked_at && stored && stored.calculated_at && lock.locked_at <= stored.calculated_at);
  const calcBeforeAutoOt = Boolean(stored && setting && setting.created_at && stored.calculated_at < setting.created_at);

  const eligibleAtTime = Boolean(stored && storedFinal && storedOt > 0 && !beforeCutover && !lockedBeforeCalc);
  const answers = {
    eligible_for_auto_ot_at_the_time: stored
      ? `${yesNo(eligibleAtTime)} (stored day ${stored.status}, OT ${storedOt}, calculated ${stored.calculated_at})`
      : "NO STORED DAY",
    cutover: cutover ? `${beforeCutover ? "BEFORE" : "ON/AFTER"} cutover ${cutover}` : "no cutover row",
    payroll_locked: lockedNow ? `YES - locked ${lock.locked_at || "?"}` : lock ? `NO (${lock.status})` : "NO (no payrun row)",
    attendance_final_and_complete: `stored ${stored ? (storedFinal ? "YES" : `NO (${stored.status}, ${int(stored.punch_count)} punches)`) : "n/a"}; fresh ${freshFinal ? "YES" : `NO (${fresh ? fresh.status : "?"})`}`,
    pending_correction:
      pendingCorrections.length > 0
        ? `YES - ${pendingCorrections.map((r) => `#${r.attendance_approval_request_id} ${r.request_type}`).join(", ")}`
        : corrections.length > 0
        ? `NO (decided: ${corrections.map((r) => `#${r.attendance_approval_request_id} ${r.request_type} ${r.status}`).join(", ")})`
        : "NO",
    old_ot_request:
      otReqs.length || deletedIds.length
        ? [
            ...otReqs.map((r) => `#${r.attendance_approval_request_id} ${r.status}${r.closure_reason ? ` (${String(r.closure_reason).slice(0, 80)})` : ""}`),
            ...deletedIds.map((id) => `#${id} DELETED (in auto-OT log, no request row)`),
          ].join("; ")
        : "NONE ever",
    shift_change_covered:
      approvedShiftChange.length || freshAuthorised || storedAuthorised
        ? `${approvedShiftChange.map((r) => `#${r.attendance_approval_request_id} APPROVED`).join(", ") || "no approved shift change"}; authorised OT stored ${storedAuthorised} / fresh ${freshAuthorised} min`
        : "NO",
    deferred_marker: deferred ? `${deferred.status} ${deferred.reason} (${deferred.source}${deferred.resolution ? `, ${deferred.resolution}` : ""})` : "none",
  };

  let classification;
  let reason;
  if (rejectedOt.length || cancelledByPerson.length) {
    classification = CLASS.REJECTED;
    reason = rejectedOt.length
      ? `OT request #${rejectedOt[0].attendance_approval_request_id} was rejected; a rejection is never re-raised`
      : `OT request #${cancelledByPerson[0].attendance_approval_request_id} was cancelled by a person (${cancelledByPerson[0].closure_reason || "no reason"})`;
  } else if (lockedNow) {
    classification = CLASS.LOCKED;
    reason = `payroll for ${date.slice(0, 7)} is APPROVED_LOCKED (${lock.locked_at || "time unknown"}); the sync raises nothing in a locked month`;
  } else if (pendingCorrections.length || deferredWaiting) {
    classification = CLASS.NOT_FINAL;
    reason = pendingCorrections.length
      ? `correction ${pendingCorrections.map((r) => `#${r.attendance_approval_request_id} ${r.request_type}`).join(", ")} is pending; OT waits for its decision`
      : `deferred marker waiting (${deferred.reason}); OT is re-evaluated when the correction/attendance completes`;
  } else if (stored && !storedFinal) {
    classification = CLASS.NOT_FINAL;
    reason = `the stored day is ${stored.status} (${int(stored.punch_count)} punches, is_final ${Number(stored.is_final)}); the sync raises OT only on a FINAL complete day${freshFinal ? " - the fresh day is now FINAL, so a recalculation would raise it" : ""}`;
  } else if (beforeCutover) {
    classification = CLASS.PRE_CUTOVER;
    reason = `${date} is before the automatic-OT cutover ${cutover}; only the deploy backfill (5 attendance days) could raise it`;
  } else if (approvedShiftChange.length && storedAuthorised > 0 && (storedOt || 0) === 0) {
    classification = CLASS.SHIFT_CHANGE;
    reason = `approved shift change #${approvedShiftChange[0].attendance_approval_request_id} authorised ${storedAuthorised} min; the stored day had no OT beyond it`;
  } else if (!stored) {
    classification = CLASS.UNKNOWN;
    reason = "no stored day row: the date was never stored, so the sync never saw it";
  } else if (deletedIds.length) {
    classification = CLASS.UNKNOWN;
    reason = `automatic OT #${deletedIds.join(", #")} was logged for this date but its request row no longer exists (deleted)`;
  } else if (storedOt > 0 && storedFinal && !otReqs.length) {
    classification = CLASS.VALID;
    reason = calcBeforeAutoOt
      ? `stored FINAL day has ${storedOt} min OT but was last calculated ${stored.calculated_at}, before automatic OT went live (${setting.created_at}), and never recalculated since`
      : `stored FINAL day has ${storedOt} min OT after the cutover, unlocked, no correction - the sync should have raised it and did not`;
  } else if (cancelledOt.length) {
    classification = CLASS.UNKNOWN;
    reason = `OT #${cancelledOt[0].attendance_approval_request_id} was withdrawn by the system (${cancelledOt[0].closure_reason}); the fresh day now finds ${row.fresh_ot_minutes} min`;
  } else {
    classification = CLASS.UNKNOWN;
    reason = `the stored day (calculated ${stored.calculated_at}) has 0 min claimable OT, so the sync correctly raised nothing then; the fresh engine finds ${row.fresh_ot_minutes} min - the day's data or the rules changed since and it has not been recalculated`;
  }
  return {
    employee_id: row.employee_id,
    employee_name: row.employee_name,
    attendance_date: date,
    shift: row.shift,
    fresh_ot_minutes: row.fresh_ot_minutes,
    fresh_pre_shift_ot: fresh ? int(fresh.pre_shift_ot_minutes) : row.fresh_pre_shift_ot,
    fresh_post_shift_ot: fresh ? int(fresh.post_shift_ot_minutes) : row.fresh_post_shift_ot,
    stored_ot_minutes: storedOt,
    fresh_verdict: verdict ? (verdict.eligible ? "ELIGIBLE" : verdict.reason) : row.fresh_verdict,
    ...answers,
    why_no_request: reason,
    classification,
  };
}

async function run({ rows, setting, query, calculateRange, autoOtVerdict }) {
  const out = [];
  for (const row of rows) {
    /* eslint-disable no-await-in-loop */
    const e = Number(row.employee_id);
    const d = row.attendance_date;
    const [y, m] = d.split("-").map(Number);
    const optional = (sql, p) => query(sql, p).catch((err) => (err && err.code === "ER_NO_SUCH_TABLE" ? [] : Promise.reject(err)));
    const [requests, autoLog, deferred, stored, lock] = await Promise.all([
      query(SQL.requests, [e, d]),
      optional(SQL.autoLog, [e, d]),
      optional(SQL.deferred, [e, d]),
      query(SQL.stored, [e, d]),
      query(SQL.lock, [e, y, m]),
    ]);
    let fresh = null;
    try {
      [fresh] = (await calculateRange({ employee_id: e, from_date: d, to_date: d })) || [];
    } catch (err) {
      fresh = null;
    }
    const verdict = fresh ? autoOtVerdict(fresh, { now: null, today: null }) : null;
    out.push(
      classify({
        row,
        setting,
        stored: stored[0] || null,
        fresh,
        verdict,
        requests: requests || [],
        autoLog: autoLog || [],
        deferred: (deferred || [])[0] || null,
        lock: (lock || [])[0] || null,
      })
    );
  }
  const totals = {};
  Object.values(CLASS).forEach((c) => {
    const list = out.filter((r) => r.classification === c);
    totals[c] = { rows: list.length, minutes: list.reduce((a, r) => a + (Number(r.fresh_ot_minutes) || 0), 0) };
  });
  return { setting, rows: out, totals };
}

const COLUMNS = [
  "employee_id", "employee_name", "attendance_date", "shift", "fresh_ot_minutes", "fresh_pre_shift_ot", "fresh_post_shift_ot",
  "stored_ot_minutes", "eligible_for_auto_ot_at_the_time", "cutover", "payroll_locked", "attendance_final_and_complete",
  "pending_correction", "old_ot_request", "shift_change_covered", "deferred_marker", "why_no_request", "classification",
];
const toCsv = (rows) => {
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [COLUMNS.join(","), ...rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","))].join("\n");
};

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
    const [setting] = await query(SQL.setting, []).catch(() => [null]);

    let previewRows;
    if (args.from_json) {
      previewRows = JSON.parse(fs.readFileSync(args.from_json, "utf8")).rows;
    } else {
      const report = await preview.run({
        listEmployees: ({ from, to }) => calcRepo.listEmployeesForRecalculation({ from_date: from, to_date: to }),
        listRequests: ({ from, to }) => query(preview.REQUESTS_SQL, [from, to]),
        listStored: ({ from, to }) => query(preview.STORED_SQL, [from, to]),
        findLocked: (rows) => calcRepo.findPayrollLockedPeriodsBulk(rows),
        calculateRange: calculation.calculateRange,
        autoOtVerdict: regularization.autoOtVerdict,
        setting,
        months: args.months,
        today: istToday(),
        log: (line) => console.error(line),
      });
      previewRows = report.rows;
    }
    const rows = previewRows.filter((r) => r.proposed_action === preview.ACTION.WOULD_CREATE);
    console.error(`${rows.length} NO OLD REQUEST - WOULD CREATE row(s) to investigate`);

    const result = await run({ rows, setting, query, calculateRange: calculation.calculateRange, autoOtVerdict: regularization.autoOtVerdict });
    fs.mkdirSync(args.out_dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const base = path.join(args.out_dir, `ot-would-create-investigation-${stamp}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2));
    fs.writeFileSync(`${base}.csv`, toCsv(result.rows));
    console.log(`Full report: ${base}.json and ${base}.csv`);
    console.log(`SETTING ${JSON.stringify(setting)}`);
    console.log(`TOTALS ${JSON.stringify(result.totals)}`);
    console.log("=== OT WOULD-CREATE INVESTIGATION CSV BEGIN ===");
    console.log(toCsv(result.rows));
    console.log("=== OT WOULD-CREATE INVESTIGATION CSV END ===");
    return 0;
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

module.exports = { parseArgs, classify, run, toCsv, CLASS, SQL };
