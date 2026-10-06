/**
 * Attendance PERMISSION - DIRECT (management) grants.
 *
 * The management decision "these people may leave at 19:00 today without a
 * deduction" - one employee, several, whole outlets, or everybody inside the
 * grantor's outlet scope (the festival early release). A REQUESTED permission
 * is the approval usecase's (`attendance_regularization.js#raisePermissionRequest`);
 * both origins feed the very same calculation.
 *
 * WHY A DIRECT GRANT IS EFFECTIVE AT ONCE. Running hundreds of individual
 * approval chains for a company decision would be theatre: the chain exists
 * so that somebody other than the employee agrees, and here the authorised
 * management user IS that agreement - exactly as a direct single-date shift
 * edit needs no request. What replaces the chain is:
 *
 *   rights    `grant_attendance_permission` (and `_bulk` for more than one
 *             employee, an outlet or everybody), checked by the route;
 *   scope     only employees inside the grantor's outlet scope are ever
 *             candidates, and the grantor's own attendance never is;
 *   lock      a payroll-locked month is skipped at preview and refused again
 *             at the write under the row lock;
 *   preview   nothing is written until the grantor has seen the affected
 *             count, the date and the times, and the apply must present the
 *             preview's fingerprint - if anything moved since, it is refused
 *             and the new preview returned instead;
 *   audit     every row records who granted it and when, the reason, and the
 *             bulk operation it belonged to; every employee considered -
 *             granted, skipped or failed - has an item row saying so;
 *   revoke    `revoke_attendance_permission`, per row or per bulk grant,
 *             scoped and locked the same way, recorded on the row.
 *
 * ONE EMPLOYEE, ONE TRANSACTION. A festival grant to four hundred people is
 * not one transaction: one locked month or one overlapping request must not
 * cancel everybody else's early release. Each employee is granted (and their
 * closed day recalculated) atomically, and the outcome is reported per
 * employee - the approval centre's bulk convention.
 */
const crypto = require("crypto");
const { toDateOnly } = require("../utils/shiftResolution");
const { addDays } = require("../utils/attendance_engine");
const { istToday } = require("../utils/istDate");
const { exclusionReason } = require("../utils/attendance_eligibility");
const { payrollLockedActionError } = require("../utils/attendance_payroll_lock");
const { MAX_BACKDATE_DAYS, MAX_FORWARD_DAYS } = require("../utils/shift_change_eligibility");
const {
  PERMISSION_STATE,
  resolvePermissionWindows,
  resolvePermissionRows,
  permissionForDisplay,
  PERMISSION_NOT_APPLICABLE_CODE,
  PERMISSION_NOT_APPLICABLE_MESSAGE,
} = require("../utils/attendance_permission");
const { isPresentAbsentOnly } = require("../utils/attendance_calculation_mode");

const TARGET_MODE = Object.freeze({ EMPLOYEES: "EMPLOYEES", OUTLETS: "OUTLETS", ALL: "ALL" });
const OUTCOME = Object.freeze({ SUCCEEDED: "SUCCEEDED", SKIPPED: "SKIPPED", FAILED: "FAILED" });

/** Why an employee was left out of a grant. The screen shows the message. */
const SKIP = Object.freeze({
  NOT_IN_SCOPE: "Not an employee in your outlets on this date",
  ATTENDANCE_NOT_REQUIRED: "Not required to punch - there is no shortage to forgive",
  BEFORE_JOINING_DATE: "Had not joined on this date",
  AFTER_RESIGNATION_DATE: "Had left before this date",
  SELF: "Your own attendance - somebody else must grant it",
  PAYROLL_LOCKED: "Payroll for this month is approved and locked",
  NO_SHIFT: "No work shift for this date",
  NOT_WORKING_DAY: "Not a working day on their shift",
  OUTSIDE_SHIFT: "The window falls outside their shift",
  WHOLE_SHIFT: "The window covers their whole shift - that is leave, not permission",
  OVERLAP: "Already has a permission overlapping this window",
  PRESENT_ABSENT_ONLY: PERMISSION_NOT_APPLICABLE_MESSAGE,
});

/** Up to this many employees in one preview or apply. */
const MAX_BULK_EMPLOYEES = 1500;
/** Shift resolutions run this many at a time. */
const CONCURRENCY = 8;

function validationError(message, extra = {}) {
  const err = new Error(message);
  err.name = "ValidationError";
  Object.assign(err, extra);
  return err;
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

const ids = (list) =>
  [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort(
    (a, b) => a - b
  );

module.exports = (permissionRepo, calculationUsecase) => {
  /** The employee's Attendance Calculation Type on the date - the one resolver. */
  const modeOn = async (employeeId, date) =>
    typeof calculationUsecase.attendanceCalculationModeFor === "function"
      ? calculationUsecase.attendanceCalculationModeFor({ employee_id: employeeId, attendance_date: date })
      : undefined;

  /**
   * What the grant asks for, validated and normalised once, so preview and
   * apply cannot read the same body two ways.
   */
  const normalise = ({ attendance_date, from_time, to_time = null, to_shift_end = false, target_mode, employee_ids, outlet_ids, reason, remarks = null, today = null }) => {
    const date = toDateOnly(attendance_date);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");
    const businessToday = istToday(today);
    if (date < addDays(businessToday, -MAX_BACKDATE_DAYS)) {
      throw validationError(`A permission can be granted for at most ${MAX_BACKDATE_DAYS} days back`);
    }
    if (date > addDays(businessToday, MAX_FORWARD_DAYS)) {
      throw validationError(`A permission can be granted at most ${MAX_FORWARD_DAYS} days ahead`);
    }
    if (!Object.values(TARGET_MODE).includes(target_mode)) {
      throw validationError("target_mode must be EMPLOYEES, OUTLETS or ALL");
    }
    const why = typeof reason === "string" ? reason.trim() : "";
    if (why.length < 5) throw validationError("A reason of at least 5 characters is required");
    if (why.length > 500) throw validationError("A reason may be at most 500 characters");
    const employees = ids(employee_ids);
    const outlets = ids(outlet_ids);
    if (target_mode === TARGET_MODE.EMPLOYEES && employees.length === 0) {
      throw validationError("Choose at least one employee");
    }
    if (target_mode === TARGET_MODE.OUTLETS && outlets.length === 0) {
      throw validationError("Choose at least one outlet");
    }
    if (!/^\d{2}:\d{2}$/.test(String(from_time || ""))) throw validationError("from_time must be HH:MM");
    if (!to_shift_end && !/^\d{2}:\d{2}$/.test(String(to_time || ""))) {
      throw validationError("to_time must be HH:MM, or choose until the shift end");
    }
    return {
      attendance_date: date,
      from_time: String(from_time),
      to_time: to_shift_end ? null : String(to_time),
      to_shift_end: Boolean(to_shift_end),
      target_mode,
      employee_ids: target_mode === TARGET_MODE.EMPLOYEES ? employees : null,
      outlet_ids: target_mode === TARGET_MODE.OUTLETS ? outlets : null,
      reason: why,
      remarks: remarks ? String(remarks).trim().slice(0, 500) || null : null,
    };
  };

  /** The rows a live permission could conflict with: pending or approved. */
  const liveWindowsByEmployee = (rows) => {
    const byEmployee = new Map();
    const { all } = resolvePermissionRows(rows || []);
    all
      .filter((r) => r.state === PERMISSION_STATE.PENDING || r.state === PERMISSION_STATE.APPROVED)
      .forEach((r) => {
        const key = Number(r.employee_id);
        if (!byEmployee.has(key)) byEmployee.set(key, []);
        byEmployee.get(key).push([String(r.permission_from), String(r.permission_to)]);
      });
    return byEmployee;
  };
  const overlapsLive = (live, windows) =>
    (live || []).some(([from, to]) => windows.some((w) => w.permission_from < to && w.permission_to > from));

  /**
   * THE PREVIEW: who would be granted what, and who is left out and why.
   * Writes nothing. `scope_store_ids` is the caller's outlet scope as the
   * route resolved it (null = every outlet), already narrowed to the chosen
   * outlets for OUTLETS mode.
   */
  const buildPreview = async ({ actor, scope_store_ids, grant }) => {
    const storeIds =
      grant.target_mode === TARGET_MODE.OUTLETS
        ? Array.isArray(scope_store_ids)
          ? grant.outlet_ids.filter((id) => scope_store_ids.includes(id))
          : grant.outlet_ids
        : scope_store_ids;
    const candidates = await permissionRepo.listCandidates({
      attendance_date: grant.attendance_date,
      store_ids: storeIds,
      employee_ids: grant.employee_ids,
    });
    if (candidates.length > MAX_BULK_EMPLOYEES) {
      throw validationError(
        `This would reach ${candidates.length} employees; a single grant may reach at most ${MAX_BULK_EMPLOYEES}. Choose outlets.`
      );
    }

    const excluded = [];
    const exclude = (c, code) =>
      excluded.push({
        employee_id: Number(c.employee_id),
        employee_name: c.employee_name || null,
        outlet_id: c.store_id === null || c.store_id === undefined ? null : Number(c.store_id),
        outlet_name: c.outlet_name || null,
        code,
        message: SKIP[code] || code,
      });

    // Named employees who did not come back are outside the caller's scope
    // or not employed then. ONE answer for both, so a scoped manager cannot
    // tell which ids exist in other outlets.
    if (grant.target_mode === TARGET_MODE.EMPLOYEES) {
      const found = new Set(candidates.map((c) => Number(c.employee_id)));
      grant.employee_ids
        .filter((id) => !found.has(id))
        .forEach((id) => exclude({ employee_id: id }, "NOT_IN_SCOPE"));
    }

    const actorId = Number(actor && actor.employee_id);
    const stillIn = [];
    for (const c of candidates) {
      const reason = exclusionReason(c, grant.attendance_date);
      if (reason) exclude(c, reason);
      else if (Number(c.employee_id) === actorId) exclude(c, "SELF");
      else stillIn.push(c);
    }

    const locked = stillIn.length
      ? await calculationUsecase.findPayrollLockedPeriodsBulk(
          stillIn.map((c) => ({ employee_id: Number(c.employee_id), attendance_date: grant.attendance_date }))
        )
      : [];
    const lockedIds = new Set((locked || []).map((l) => Number(l.employee_id)));
    const existing = liveWindowsByEmployee(
      await permissionRepo.listForEmployeesOnDate(
        stillIn.map((c) => Number(c.employee_id)),
        grant.attendance_date
      )
    );

    const window = {
      from_time: grant.from_time,
      ...(grant.to_shift_end ? { to_shift_end: true } : { to_time: grant.to_time }),
    };
    const resolved = await inBatches(
      stillIn.filter((c) => !lockedIds.has(Number(c.employee_id))),
      CONCURRENCY,
      async (c) => {
        // PRESENT/ABSENT ONLY ON THE DATE: not applicable, whatever the
        // grantor's rights - their rights decide who they may grant to, the
        // employee's attendance type decides whether a grant applies at all.
        if (isPresentAbsentOnly(await modeOn(Number(c.employee_id), grant.attendance_date))) {
          return { c, notApplicable: true };
        }
        const shift = await calculationUsecase.shiftForDate({
          employee_id: Number(c.employee_id),
          attendance_date: grant.attendance_date,
        });
        return { c, shift, placed: resolvePermissionWindows({ attendance_date: grant.attendance_date, shift, windows: [window], clip: true }) };
      }
    );
    stillIn.filter((c) => lockedIds.has(Number(c.employee_id))).forEach((c) => exclude(c, "PAYROLL_LOCKED"));

    const eligible = [];
    for (const { c, shift, placed, notApplicable } of resolved) {
      if (notApplicable) {
        exclude(c, "PRESENT_ABSENT_ONLY");
        continue;
      }
      if (!placed.ok) {
        exclude(c, placed.code);
        continue;
      }
      if (overlapsLive(existing.get(Number(c.employee_id)), placed.windows)) {
        exclude(c, "OVERLAP");
        continue;
      }
      const w = placed.windows[0];
      eligible.push({
        employee_id: Number(c.employee_id),
        employee_name: c.employee_name || null,
        outlet_id: c.store_id === null || c.store_id === undefined ? null : Number(c.store_id),
        outlet_name: c.outlet_name || null,
        work_shift_id: shift.work_shift_id === undefined ? null : shift.work_shift_id,
        shift_code: shift.shift_code || null,
        shift_from: placed.shift_from,
        shift_to: placed.shift_to,
        permission_from: w.permission_from,
        permission_to: w.permission_to,
        to_shift_end: w.to_shift_end,
        permission_minutes: w.permission_minutes,
      });
    }
    eligible.sort((a, b) => String(a.outlet_name).localeCompare(String(b.outlet_name)) || a.employee_id - b.employee_id);

    const byOutlet = new Map();
    eligible.forEach((e) => {
      const key = e.outlet_id;
      if (!byOutlet.has(key)) byOutlet.set(key, { outlet_id: key, outlet_name: e.outlet_name, eligible: 0, permission_minutes: 0 });
      const o = byOutlet.get(key);
      o.eligible += 1;
      o.permission_minutes += e.permission_minutes;
    });

    // THE FINGERPRINT: everything the grantor confirmed, including exactly
    // who gets which window. If any of it would come out differently at
    // apply time, the apply is refused and shows the new preview.
    const fingerprint = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          ...grant,
          scope_store_ids: Array.isArray(scope_store_ids) ? [...scope_store_ids].sort((a, b) => a - b) : null,
          eligible: eligible.map((e) => [e.employee_id, e.permission_from, e.permission_to]),
        })
      )
      .digest("hex");

    return {
      attendance_date: grant.attendance_date,
      from_time: grant.from_time,
      to_time: grant.to_time,
      to_shift_end: grant.to_shift_end,
      target_mode: grant.target_mode,
      reason: grant.reason,
      counts: {
        considered: eligible.length + excluded.length,
        eligible: eligible.length,
        excluded: excluded.length,
        permission_minutes: eligible.reduce((sum, e) => sum + e.permission_minutes, 0),
      },
      by_outlet: [...byOutlet.values()],
      eligible,
      excluded,
      fingerprint,
      can_apply: eligible.length > 0,
    };
  };

  const preview = async ({ actor, scope_store_ids = null, today = null, ...body }) => {
    const grant = normalise({ ...body, today });
    return { code: 200, ...(await buildPreview({ actor, scope_store_ids, grant })) };
  };

  /** The day as the change will leave it, and whether it may be stored now. */
  const dayRowsFor = async ({ employee_id, attendance_date, assume_permissions, now }) => {
    const [day] = await calculationUsecase.calculateRange({
      employee_id,
      from_date: attendance_date,
      to_date: attendance_date,
      assume_permissions,
    });
    const state = calculationUsecase.attendanceDayState(
      day || { attendance_date, shift_snapshot: null },
      { now }
    );
    return state.closed && day ? [calculationUsecase.toStorageRow(day)] : [];
  };

  /**
   * APPLY what the grantor previewed. One employee (EMPLOYEES with exactly
   * one id) is an individual grant; anything else is a bulk operation with
   * its header and one item per employee considered.
   */
  const apply = async ({ actor, scope_store_ids = null, fingerprint, today = null, now = null, ...body }) => {
    const grant = normalise({ ...body, today });
    const current = await buildPreview({ actor, scope_store_ids, grant });
    if (!fingerprint || fingerprint !== current.fingerprint) {
      return {
        code: 409,
        reason: "PREVIEW_CHANGED",
        msg: "Who this grant reaches has changed since the preview. Review the new preview and confirm again.",
        preview: current,
      };
    }
    if (current.eligible.length === 0) {
      throw validationError("Nobody in this grant can receive the permission");
    }

    const individual = grant.target_mode === TARGET_MODE.EMPLOYEES && grant.employee_ids.length === 1;
    const bulkOperationId = individual ? null : crypto.randomUUID();
    const actorEmployeeId = actor && actor.employee_id !== undefined ? Number(actor.employee_id) || null : null;
    const actorUserId = actor && actor.user_id !== undefined && actor.user_id !== null ? Number(actor.user_id) : null;

    if (bulkOperationId) {
      await permissionRepo.createBulkOperation({
        bulk_operation_id: bulkOperationId,
        target_mode: grant.target_mode,
        target_employee_ids: grant.employee_ids,
        target_outlet_ids: grant.outlet_ids,
        attendance_date: grant.attendance_date,
        from_time: grant.from_time,
        to_time: grant.to_time,
        to_shift_end: grant.to_shift_end,
        reason: grant.reason,
        remarks: grant.remarks,
        preview_fingerprint: current.fingerprint,
        considered_count: current.counts.considered,
        created_by_employee_id: actorEmployeeId,
        created_by_user_id: actorUserId,
      });
    }

    const results = [];
    const record = async (item) => {
      results.push(item);
      if (bulkOperationId) await permissionRepo.recordBulkItem({ ...item, bulk_operation_id: bulkOperationId });
    };

    for (const e of current.excluded) {
      // eslint-disable-next-line no-await-in-loop
      await record({ employee_id: e.employee_id, employee_name: e.employee_name, outlet_id: e.outlet_id, outcome: OUTCOME.SKIPPED, code: e.code, message: e.message });
    }

    for (const e of current.eligible) {
      const windows = [
        {
          permission_from: e.permission_from,
          permission_to: e.permission_to,
          to_shift_end: e.to_shift_end,
          permission_minutes: e.permission_minutes,
        },
      ];
      const header = {
        reason: grant.reason,
        remarks: grant.remarks,
        bulk_operation_id: bulkOperationId,
        outlet_id: e.outlet_id,
        work_shift_id: e.work_shift_id,
        created_by_employee_id: actorEmployeeId,
        created_by_user_id: actorUserId,
      };
      const base = { employee_id: e.employee_id, employee_name: e.employee_name, outlet_id: e.outlet_id };
      try {
        /* eslint-disable no-await-in-loop */
        const calculations = await dayRowsFor({
          employee_id: e.employee_id,
          attendance_date: grant.attendance_date,
          assume_permissions: { add: [{ ...windows[0], ...header, employee_id: e.employee_id, attendance_date: grant.attendance_date, source: "DIRECT", attendance_permission_id: null }] },
          now,
        });
        const saved = await permissionRepo.grant({
          employee_id: e.employee_id,
          attendance_date: grant.attendance_date,
          windows,
          header,
          calculations,
        });
        if (saved.code === 200) {
          const monthRefresh = await refreshMonth(e.employee_id, grant.attendance_date, now);
          await record({ ...base, outcome: OUTCOME.SUCCEEDED, attendance_permission_id: saved.attendance_permission_ids[0], recalculated: calculations.length > 0, permission_minutes: e.permission_minutes, month_refresh: monthRefresh });
        } else {
          await record({ ...base, outcome: OUTCOME.SKIPPED, code: "OVERLAP", message: SKIP.OVERLAP });
        }
        /* eslint-enable no-await-in-loop */
      } catch (err) {
        // The insert guard's refusal - the date became Present/Absent Only
        // after the preview - is a skip with its reason, not a failure.
        if (err && err.code === PERMISSION_NOT_APPLICABLE_CODE) {
          // eslint-disable-next-line no-await-in-loop
          await record({ ...base, outcome: OUTCOME.SKIPPED, code: "PRESENT_ABSENT_ONLY", message: SKIP.PRESENT_ABSENT_ONLY });
          continue;
        }
        const lockedMonth = err && err.code === "PAYROLL_MONTH_LOCKED";
        // eslint-disable-next-line no-await-in-loop
        await record({
          ...base,
          outcome: lockedMonth ? OUTCOME.SKIPPED : OUTCOME.FAILED,
          code: lockedMonth ? "PAYROLL_LOCKED" : "ERROR",
          message: lockedMonth ? SKIP.PAYROLL_LOCKED : err && err.message ? err.message : "The grant could not be saved",
        });
      }
    }

    const summary = {
      considered: results.length,
      succeeded: results.filter((r) => r.outcome === OUTCOME.SUCCEEDED).length,
      skipped: results.filter((r) => r.outcome === OUTCOME.SKIPPED).length,
      failed: results.filter((r) => r.outcome === OUTCOME.FAILED).length,
    };
    if (bulkOperationId) await permissionRepo.finishBulkOperation(bulkOperationId, summary);
    return {
      code: 200,
      bulk_operation_id: bulkOperationId,
      attendance_date: grant.attendance_date,
      summary,
      results,
    };
  };

  /**
   * Re-persist the employee's month after a committed change moved its day -
   * the existing month persist, a no-op while the month has no summary.
   * Reports, never throws: Approve & Lock refuses a stale summary whatever
   * happens here.
   */
  const refreshMonth = async (employee_id, attendance_date, now) => {
    const refreshed =
      typeof calculationUsecase.refreshPersistedMonth === "function"
        ? await calculationUsecase.refreshPersistedMonth({ employee_id, attendance_date, now })
        : { refreshed: false, reason: "NOT_WIRED" };
    // The day the permission moved may carry different eligible OT: its
    // pending OT follows. After the commit; reports, never throws.
    if (typeof calculationUsecase.syncAutoOtAfterWrite === "function") {
      await calculationUsecase.syncAutoOtAfterWrite({
        employee_id,
        dates: [attendance_date],
        now,
        source: "PERMISSION",
      });
    }
    return refreshed;
  };

  /** A permission the caller may act on, or the same "not found" for both. */
  const inScope = (row, scope_store_ids) =>
    row && (!Array.isArray(scope_store_ids) || scope_store_ids.includes(Number(row.employee_store_id)));

  /**
   * REVOKE ONE DIRECT GRANT. A REQUEST permission is refused here: it is
   * revoked through its approval request (the existing admin revoke), so its
   * history stays on the request where the decisions are.
   */
  const revoke = async ({ actor, scope_store_ids = null, attendance_permission_id, reason, revoke_bulk_operation_id = null, now = null, row = null }) => {
    const why = typeof reason === "string" ? reason.trim() : "";
    if (why.length < 5) throw validationError("A revoke reason of at least 5 characters is required");
    if (why.length > 500) throw validationError("A revoke reason may be at most 500 characters");
    const permission = row || (await permissionRepo.getPermission(Number(attendance_permission_id)));
    if (!inScope(permission, scope_store_ids)) {
      return { code: 404, reason: "NOT_FOUND", msg: "No such permission" };
    }
    if (permission.source !== "DIRECT") {
      throw validationError("A requested permission is revoked through its approval request, not here");
    }
    if (permission.revoked_at) throw validationError("This permission has already been revoked");

    const locked = await calculationUsecase.findPayrollLockedPeriods([
      { employee_id: Number(permission.employee_id), attendance_date: permission.attendance_date },
    ]);
    if (locked.length > 0) throw payrollLockedActionError(locked, "This revocation");

    const calculations = await dayRowsFor({
      employee_id: Number(permission.employee_id),
      attendance_date: permission.attendance_date,
      assume_permissions: { exclude_ids: [Number(permission.attendance_permission_id)] },
      now,
    });
    const result = await permissionRepo.revoke({
      attendance_permission_id: Number(permission.attendance_permission_id),
      actor: {
        employee_id: actor && actor.employee_id !== undefined ? Number(actor.employee_id) || null : null,
        user_id: actor && actor.user_id !== undefined && actor.user_id !== null ? Number(actor.user_id) : null,
      },
      reason: why,
      revoke_bulk_operation_id,
      calculations,
    });
    const monthRefresh =
      result && result.code === 200
        ? await refreshMonth(Number(permission.employee_id), permission.attendance_date, now)
        : null;
    return {
      ...result,
      month_refresh: monthRefresh,
      attendance_permission_id: Number(permission.attendance_permission_id),
      employee_id: Number(permission.employee_id),
      attendance_date: permission.attendance_date,
      recalculated: calculations.length > 0,
    };
  };

  /**
   * REVOKE A WHOLE BULK GRANT - every still-active row of it inside the
   * caller's scope, one employee at a time through `revoke`, each row
   * recording who, when, why and the bulk grant it was revoked with.
   * Partial: one locked month does not stop the others.
   */
  const revokeBulkOperation = async ({ actor, scope_store_ids = null, bulk_operation_id, reason, now = null }) => {
    const why = typeof reason === "string" ? reason.trim() : "";
    if (why.length < 5) throw validationError("A revoke reason of at least 5 characters is required");
    const rows = (await permissionRepo.listActiveInBulkOperation(String(bulk_operation_id))).filter((r) =>
      inScope(r, scope_store_ids)
    );
    const results = [];
    for (const row of rows) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await revoke({ actor, scope_store_ids, reason: why, revoke_bulk_operation_id: String(bulk_operation_id), now, row });
        results.push({
          attendance_permission_id: Number(row.attendance_permission_id),
          employee_id: Number(row.employee_id),
          outcome: r.code === 200 ? OUTCOME.SUCCEEDED : OUTCOME.SKIPPED,
          code: r.code === 200 ? null : r.reason,
        });
      } catch (err) {
        const lockedMonth = err && (err.code === "PAYROLL_MONTH_LOCKED" || err.code === "PAYROLL_LOCKED");
        results.push({
          attendance_permission_id: Number(row.attendance_permission_id),
          employee_id: Number(row.employee_id),
          outcome: lockedMonth || (err && err.name === "ValidationError") ? OUTCOME.SKIPPED : OUTCOME.FAILED,
          code: lockedMonth ? "PAYROLL_LOCKED" : "ERROR",
          message: err && err.message,
        });
      }
    }
    return {
      code: 200,
      bulk_operation_id: String(bulk_operation_id),
      summary: {
        considered: results.length,
        succeeded: results.filter((r) => r.outcome === OUTCOME.SUCCEEDED).length,
        skipped: results.filter((r) => r.outcome === OUTCOME.SKIPPED).length,
        failed: results.filter((r) => r.outcome === OUTCOME.FAILED).length,
      },
      results,
    };
  };

  /** THE PERMISSION REGISTER, inside the caller's scope. */
  const list = async ({ scope_store_ids = null, from_date, to_date, employee_id = null, source = null, bulk_operation_id = null, limit = 200, offset = 0 }) => {
    const from = toDateOnly(from_date);
    const to = toDateOnly(to_date);
    if (from === null || to === null || from > to) throw validationError("from_date and to_date must be dates as YYYY-MM-DD");
    if (addDays(from, 92) < to) throw validationError("A register covers at most 93 days");
    const { rows, total } = await permissionRepo.list({
      store_ids: scope_store_ids,
      from_date: from,
      to_date: to,
      employee_id,
      source,
      bulk_operation_id,
      limit,
      offset,
    });
    const { all } = resolvePermissionRows(rows);
    return {
      code: 200,
      total,
      rows: all.map((r) => ({
        ...permissionForDisplay(r),
        employee_id: Number(r.employee_id),
        employee_name: r.employee_name || null,
        outlet_id: r.employee_store_id === null || r.employee_store_id === undefined ? null : Number(r.employee_store_id),
        outlet_name: r.outlet_name || null,
      })),
    };
  };

  const listBulkOperations = async ({ scope_store_ids = null, limit = 50 }) => ({
    code: 200,
    rows: await permissionRepo.listBulkOperations({ store_ids: scope_store_ids, limit }),
  });

  const getBulkOperationItems = async ({ scope_store_ids = null, bulk_operation_id }) => ({
    code: 200,
    bulk_operation_id: String(bulk_operation_id),
    items: await permissionRepo.listBulkItems(String(bulk_operation_id), scope_store_ids),
  });

  return {
    TARGET_MODE,
    MAX_BULK_EMPLOYEES,
    preview,
    apply,
    revoke,
    revokeBulkOperation,
    list,
    listBulkOperations,
    getBulkOperationItems,
  };
};

module.exports.TARGET_MODE = TARGET_MODE;
module.exports.SKIP = SKIP;
