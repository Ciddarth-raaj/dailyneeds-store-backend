/**
 * READ-ONLY: why is a one-day shift change (e.g. 09:00-18:00 -> 09:00-21:00)
 * not available for THIS employee on THIS date?
 *
 *   NODE_ENV=production DN_CONFIG=~/dailyneeds-store-backend/config.json \
 *     node scripts/diagnostics/shift-change-trace.js --employee 1234 --date 2026-09-26 [--shift 17]
 *
 * Without `--shift` every shift whose LIVE weekly schedule has a 09:00-21:00
 * row is traced. Everything is answered by the production code itself - the
 * calculation usecase's `shiftForDate` (dated history + the configuration
 * version the engine reads), `listDateShiftOptions`, `shiftChangeOptions`,
 * `shiftChangeEligibilityFor` - over a database handle that cannot write
 * (`lib/read_only_db.js`). Nothing is raised; the submit path's gates are
 * REPLAYED in production's order and the first refusal is reported.
 */
const { openReadOnly, arg, out } = require("./lib/read_only_db");
const eligibility = require("../../utils/shift_change_eligibility");
const { istToday } = require("../../utils/istDate");
const shiftChangeBlock = require("../../utils/shift_change_block");

const employeeId = Number(arg("employee"));
const date = arg("date");
const onlyShift = arg("shift") ? Number(arg("shift")) : null;
if (!Number.isInteger(employeeId) || employeeId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
  console.error("usage: --employee <employee_id> --date YYYY-MM-DD [--shift <work_shift_id>]");
  process.exit(2);
}

(async () => {
  const { db, select, end } = openReadOnly();
  try {
    const calcRepo = require("../../repository/attendance_calculation")(db);
    const regRepo = require("../../repository/attendance_regularization")(db);
    const setupRepo = require("../../repository/attendance_approver_setup")(db);
    const blockRepo = require("../../repository/attendance_shift_change_block")(db);
    const calc = require("../../usecase/attendance_calculation")(calcRepo);
    const reg = require("../../usecase/attendance_regularization")(regRepo, calc, setupRepo, blockRepo);
    const today = istToday();

    // --- the employee and the dated history the base is resolved from.
    const [employee] = await select(
      `SELECT employee_id, employee_name, status, store_id, designation_id, default_work_shift_id, attendance_required
         FROM new_employee WHERE employee_id = ?`,
      [employeeId]
    );
    out("employee", employee || `No such employee: ${employeeId}`);
    out(
      "dated assignment history (base = greatest effective_from <= date, then greatest id)",
      await select(
        `SELECT a.employee_work_shift_assignment_id, a.work_shift_id, w.shift_code,
                DATE_FORMAT(a.effective_from, '%Y-%m-%d') AS effective_from, a.source,
                (a.effective_from <= ?) AS applies_on_or_before_date
           FROM employee_work_shift_assignment a LEFT JOIN work_shift w ON w.work_shift_id = a.work_shift_id
          WHERE a.employee_id = ? ORDER BY a.effective_from, a.employee_work_shift_assignment_id`,
        [date, employeeId]
      )
    );

    // --- the base, as the engine resolves it. `shiftForDate` without a shift
    // gives the base's id and NRM; asking it about the base shift itself gives
    // the base's break (the `base` block does not carry one).
    const own = await calc.shiftForDate({ employee_id: employeeId, attendance_date: date });
    const baseId = own.base.work_shift_id;
    const baseAsShift = baseId
      ? await calc.shiftForDate({ employee_id: employeeId, attendance_date: date, work_shift_id: baseId })
      : null;
    const base = {
      dated_base_work_shift_id: baseId,
      resolution_status: own.base.status,
      shift_code: own.base.shift_code,
      shift_name: own.base.shift_name,
      in_time: own.base.in_time,
      out_time: own.base.out_time,
      is_working_day: own.base.is_working_day,
      break_minutes: baseAsShift ? baseAsShift.break_minutes : null,
      calculated_base_nrm_minutes: own.base.nrm_minutes,
      date_already_resolves_to_work_shift_id: own.work_shift_id,
    };
    out("BASE (dated permanent shift for the date)", base);

    // --- which shifts to trace.
    let shiftIds = onlyShift ? [onlyShift] : [];
    if (!onlyShift) {
      const rows = await select(
        `SELECT DISTINCT work_shift_id FROM work_shift_weekly_schedule
          WHERE TIME_FORMAT(in_time, '%H:%i') = '09:00' AND TIME_FORMAT(out_time, '%H:%i') = '21:00'
          ORDER BY work_shift_id`
      );
      shiftIds = rows.map((r) => Number(r.work_shift_id));
      if (shiftIds.length === 0) out("requested shift", "NO shift has a 09:00-21:00 row in its live weekly schedule");
    }

    // --- facts that do not depend on the requested shift.
    const active = await calc.listDateShiftOptions();
    const activeIds = new Set(active.map((s) => Number(s.work_shift_id)));
    const locked = await calc.findPayrollLockedPeriods([{ employee_id: employeeId, attendance_date: date }]);
    const existing = await regRepo.findRequestsForDates(employeeId, [date]);
    const priorShift = (existing || []).find((r) => r.request_type === "SHIFT_CHANGE") || null;
    const block = await blockRepo.findActive(employeeId, date);
    const options = await reg.shiftChangeOptions({ actor: { employee_id: employeeId }, attendance_date: date });
    const verdict = await reg.shiftChangeEligibilityFor({ employee_id: employeeId, attendance_date: date });

    out("gates for the date", {
      today_ist: today,
      payroll_lock_result: locked.length ? locked : "NOT LOCKED",
      existing_shift_change_request: priorShift || "NONE",
      other_requests_on_date: (existing || []).filter((r) => r.request_type !== "SHIFT_CHANGE"),
      active_hr_block: block || "NONE",
      dropdown_options_returned: options.options,
      dropdown_can_raise: options.can_raise,
      dropdown_reason: options.reason,
    });

    const summary = [];
    for (const shiftId of shiftIds) {
      /* eslint-disable no-await-in-loop */
      const [master] = await select(`SELECT work_shift_id, shift_code, shift_name, active FROM work_shift WHERE work_shift_id = ?`, [shiftId]);
      const [liveRow] = await select(
        `SELECT day_of_week, is_working_day, TIME_FORMAT(in_time, '%H:%i:%s') AS in_time,
                TIME_FORMAT(out_time, '%H:%i:%s') AS out_time, break_minutes, normal_work_minutes
           FROM work_shift_weekly_schedule WHERE work_shift_id = ? AND day_of_week = DAYOFWEEK(?) - 1`,
        [shiftId, date]
      );
      const t = await calc.shiftForDate({ employee_id: employeeId, attendance_date: date, work_shift_id: shiftId });

      // THE SUBMIT PATH, REPLAYED in `raiseShiftChangeRequest`'s order.
      const pre = eligibility.decidePreconditions({
        attendance_date: date,
        today,
        payroll_locked: locked,
        existing_request: priorShift,
        base_work_shift_id: baseId === null || baseId === undefined ? null : Number(baseId),
      });
      let submit;
      if (pre) submit = { code: pre.reason_code, reason: pre.reason };
      else if (shiftChangeBlock.isActive(block)) submit = { code: "HR_BLOCKED", reason: block.reason };
      else if (Number(baseId) === shiftId) submit = { code: "ALREADY_YOUR_SHIFT", reason: `That is already your shift for ${date}` };
      else if (t.work_shift_id === null || t.nrm_minutes === null) submit = { code: "NO_SCHEDULE", reason: `That work shift has no schedule for ${date} (${t.status})` };
      else if (!t.is_working_day) submit = { code: "NOT_WORKING_DAY", reason: `That work shift does not run on ${date}` };
      else if (!(Number(t.nrm_minutes) > Number(own.base.nrm_minutes))) submit = { code: eligibility.SHIFT_CHANGE_REASON.NO_LONGER_SHIFT, reason: eligibility.REASON_TEXT.NO_LONGER_SHIFT };
      else submit = { code: "ELIGIBLE", reason: "production would accept this request" };

      const row = {
        employee_id: employeeId,
        attendance_date: date,
        dated_base_work_shift_id: baseId,
        base_shift: `${own.base.shift_code || ""} ${own.base.shift_name || ""}`.trim(),
        base_in: own.base.in_time,
        base_out: own.base.out_time,
        base_break_minutes: base.break_minutes,
        base_nrm: own.base.nrm_minutes,
        requested_work_shift_id: shiftId,
        requested_shift: master ? `${master.shift_code} ${master.shift_name}` : "NO SUCH SHIFT",
        requested_active: master ? Number(master.active) : null,
        requested_is_working_day: t.is_working_day,
        requested_in: t.in_time,
        requested_out: t.out_time,
        requested_break_minutes: t.break_minutes,
        requested_nrm: t.nrm_minutes,
        in_listDateShiftOptions: activeIds.has(shiftId),
        offered_in_dropdown: (options.options || []).some((o) => Number(o.work_shift_id) === shiftId),
        existing_shift_change: priorShift ? `#${priorShift.attendance_approval_request_id} ${priorShift.status}` : "NONE",
        payroll_locked: locked.length > 0,
        submit_reason_code: submit.code,
        submit_reason: submit.reason,
      };
      summary.push(row);
      out(`REQUESTED shift ${shiftId}`, {
        ...row,
        engine_resolution_status: t.status,
        live_schedule_row_for_weekday: liveRow || "NO ROW for this weekday in the live schedule",
        live_vs_engine_differ:
          !!liveRow &&
          (String(liveRow.in_time) !== String(t.in_time) ||
            String(liveRow.out_time) !== String(t.out_time) ||
            Number(liveRow.break_minutes) !== Number(t.break_minutes)),
        note_inactive:
          master && Number(master.active) !== 1
            ? "INACTIVE: production hides it from the dropdown but its submit path does not check `active`; the fix branch refuses it on submit too"
            : null,
      });
      /* eslint-enable no-await-in-loop */
    }

    out("FINAL ELIGIBILITY for the date (shiftChangeEligibilityFor - the report's and the HR screen's verdict)", {
      system_reason_code: verdict.system.reason_code,
      system_reason: verdict.system.reason,
      effective_can_raise: verdict.effective ? verdict.effective.can_raise : null,
      effective_reason_code: verdict.effective ? verdict.effective.reason_code : null,
      effective_reason: verdict.effective ? verdict.effective.reason : null,
      request_state: verdict.request_state,
    });
    out("SUMMARY", "");
    console.table(summary);
  } finally {
    await end();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
