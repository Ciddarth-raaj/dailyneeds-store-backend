/**
 * READ-ONLY LIVE TRACE: what the production code itself answers for one
 * employee and date - the one-day shift change options and verdict, the live
 * day calculation (OT available / requested / approved / closed), and every
 * approval request's visibility to its current approver.
 *
 *   NODE_ENV=production node scripts/diagnostics/attendance-live-trace.js \
 *     --employee 106 --date 2026-09-20 [--shift 42]
 *
 * It builds the SAME repositories and usecases `server.js` builds, on the same
 * `config.json` credentials, and calls only their READ paths. It cannot write:
 * the pool is opened with `SET SESSION TRANSACTION READ ONLY` on every
 * connection, and every statement is checked before it is sent - anything
 * that is not a SELECT (or the session setting itself) throws instead of
 * reaching the server. `--shift` asks whether that ONE shift would be accepted
 * by `raiseShiftChangeRequest`, by replaying its gates, never by calling it.
 */
const mysql = require("mysql");

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const employeeId = Number(arg("employee"));
const date = arg("date");
const shiftId = arg("shift") ? Number(arg("shift")) : null;
if (!Number.isInteger(employeeId) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
  console.error("usage: --employee <id> --date YYYY-MM-DD [--shift <work_shift_id>]");
  process.exit(2);
}

global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
const config = require("../../config.json");
const db = config.db.mysql[global.env];

const pool = mysql.createPool({
  connectionLimit: 2,
  host: db.host,
  user: db.username,
  password: db.password,
  database: db.database,
  port: db.port,
  supportBigNumbers: true,
  bigNumberStrings: true,
});
pool.on("connection", (connection) => connection.query("SET SESSION TRANSACTION READ ONLY"));

/** Only SELECT reaches the server. Anything else is a bug in this script. */
const readOnly = {
  query(sql, params, cb) {
    const text = String(typeof sql === "object" && sql ? sql.sql : sql).trim();
    const callback = typeof params === "function" ? params : cb;
    if (!/^(SELECT|\(SELECT|WITH)\b/i.test(text)) {
      callback(new Error(`READ-ONLY TRACE refused a non-SELECT statement: ${text.slice(0, 80)}`));
      return;
    }
    pool.query(sql, typeof params === "function" ? [] : params, callback);
  },
  getConnection() {
    throw new Error("READ-ONLY TRACE: transactions are not available");
  },
};

const out = (label, value) => console.log(`\n=== ${label}\n${JSON.stringify(value, null, 2)}`);

(async () => {
  const calcRepo = require("../../repository/attendance_calculation")(readOnly);
  const regRepo = require("../../repository/attendance_regularization")(readOnly);
  const setupRepo = require("../../repository/attendance_approver_setup")(readOnly);
  const blockRepo = require("../../repository/attendance_shift_change_block")(readOnly);
  const calculation = require("../../usecase/attendance_calculation")(calcRepo);
  const regularization = require("../../usecase/attendance_regularization")(regRepo, calculation, setupRepo, blockRepo);

  // 1. Identity, as the approval chain resolves it.
  out("identity", await regularization.resolveIdentity(employeeId));

  // 2. The live day: shift, NRM, worked, OT available and its claim state.
  const [day] = await calculation.calculateRange({ employee_id: employeeId, from_date: date, to_date: date });
  out("live day", day && {
    attendance_date: day.attendance_date, status: day.status, is_final: day.is_final,
    work_shift_id: day.work_shift_id, shift: day.shift_snapshot && {
      in: day.shift_snapshot.in_time, out: day.shift_snapshot.out_time, break: day.shift_snapshot.break_minutes,
    },
    punch_count: day.punch_count, nrm_minutes: day.nrm_minutes, base_nrm_minutes: day.base_nrm_minutes,
    worked_minutes: day.worked_minutes, regular_minutes: day.regular_minutes,
    shortage_minutes: day.shortage_minutes, candidate_ot_minutes: day.candidate_ot_minutes,
    excess_ot_minutes: day.excess_ot_minutes, shift_authorised_ot_minutes: day.shift_authorised_ot_minutes,
    approved_ot_minutes: day.approved_ot_minutes, ot_claim_state: day.ot_claim_state,
    ot_request_id: day.ot_request_id, correction_state: day.correction_state,
    attendance_day_state: calculation.attendanceDayState ? calculation.attendanceDayState(day) : null,
  });

  // 3. The one-day shift change: base, options, and the system verdict.
  const probe = await regularization.shiftChangeEligibilityFor({ employee_id: employeeId, attendance_date: date });
  out("shift change: base, options, verdict", probe);
  if (shiftId) {
    const resolved = await calculation.shiftForDate({ employee_id: employeeId, attendance_date: date, work_shift_id: shiftId });
    const active = (await calculation.listDateShiftOptions()).some((s) => Number(s.work_shift_id) === shiftId);
    out(`shift change: shift ${shiftId} as the submit path sees it`, {
      active,
      is_working_day: resolved.is_working_day,
      in_time: resolved.in_time, out_time: resolved.out_time, break_minutes: resolved.break_minutes,
      requested_nrm_minutes: resolved.nrm_minutes,
      base: resolved.base,
      longer: resolved.nrm_minutes !== null && Number(resolved.nrm_minutes) > Number(resolved.base.nrm_minutes),
    });
  }

  // 4. Every request for the employee, and whether its current approver's
  //    queue shows it - asked of `countApprovals` with the approver's own
  //    resolved scope, exactly as the route resolves it.
  const requests = await regRepo.listForEmployee({ employee_id: employeeId, from_date: "2000-01-01", to_date: "2999-12-31", limit: 50 });
  for (const r of requests) {
    /* eslint-disable no-await-in-loop */
    const full = await regRepo.getRequest(r.attendance_approval_request_id);
    const step = (full.steps || []).find((s) => Number(s.stage_no) === Number(full.current_stage_no));
    let visibility = null;
    if (full.status === "PENDING" && step && step.approver_employee_id) {
      const approver = await regularization.resolveIdentity(Number(step.approver_employee_id));
      visibility = await regRepo.countApprovals({
        request_type: [full.request_type],
        status: "PENDING",
        approver_roles: approver.approver_roles,
        outlet_id: approver.outlet_id,
        actor_employee_id: approver.employee_id,
        is_admin: false,
        // OWN_BRANCHES of a non-admin without the all-branches key - the
        // case the defect is about. An administrator or an all-branches
        // holder is never narrowed and would see it regardless.
        permitted_outlet_ids: approver.outlet_id === null ? [] : [approver.outlet_id],
        filter_employee_id: employeeId,
      });
    }
    out(`request #${r.attendance_approval_request_id}`, {
      request_type: full.request_type, status: full.status, attendance_date: full.attendance_date,
      outlet_id: full.outlet_id, chain_source: full.chain_source,
      current_stage_no: full.current_stage_no, total_stages: full.total_stages,
      steps: (full.steps || []).map((s) => ({
        stage_no: s.stage_no, approver_role: s.approver_role, outlet_id: s.outlet_id,
        approval_level: s.approval_level, approver_employee_id: s.approver_employee_id, decision: s.decision,
      })),
      current_approver_queue_count_for_this_employee: visibility,
    });
    /* eslint-enable no-await-in-loop */
  }
})()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
