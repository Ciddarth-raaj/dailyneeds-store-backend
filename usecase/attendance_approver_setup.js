const {
  APPROVAL_LEVEL,
  validateApproverSetup,
} = require("../utils/attendance_approval_chain");

/**
 * Attendance Approver Setup - the rules behind the employee-level chain.
 *
 * PER EMPLOYEE, THREE EXPLICIT LEVELS. First Level and Second Level are
 * optional and stay visible as blanks; the Final Approver is mandatory once
 * a mapping exists. The chain a request walks is built from the mapping at
 * creation and snapshotted onto the request's steps by `usecase/
 * attendance_regularization.js`; nothing here rewrites a request that has
 * already been raised except the Replace Approver, and that only ever moves
 * an UNDECIDED step.
 *
 * VALIDATION IS PER EMPLOYEE, ALSO IN BULK. A bulk set that fails for three
 * of forty employees saves the other thirty-seven and reports the three by
 * name; it never reports success for the whole. Each employee's save is its
 * own transaction with its own audit rows, which is what makes an honest
 * partial result possible.
 *
 * REPLACE APPROVER is one atomic operation over the master rows and the
 * undecided pending steps that name the old approver at the chosen level. It
 * never rewrites an APPROVED, REJECTED or SKIPPED step, never touches a
 * request that is no longer PENDING, and refuses to move a step onto the
 * employee whose own request it is. The old approver may be resigned; the
 * new one must be active.
 *
 * NO PAYROLL DATA. Nothing here reads or writes a salary, and the repository
 * selects no such column.
 */

function validationError(message, details = null) {
  const err = new Error(message);
  err.name = "ValidationError";
  if (details) err.details = details;
  return err;
}

const LEVEL_KEY = Object.freeze({
  FIRST: "first_level_approver_employee_id",
  SECOND: "second_level_approver_employee_id",
  FINAL: "final_approver_employee_id",
});
const LEVEL_LABEL = Object.freeze({
  FIRST: "First Level Approver",
  SECOND: "Second Level Approver",
  FINAL: "Final Approver",
});

const idOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

module.exports = (approverSetupRepo) => {
  /** The employees named anywhere in a setup, looked up once. */
  const factsFor = async (ids) => {
    const rows = await approverSetupRepo.getEmployeesByIds(ids);
    const byId = new Map(rows.map((r) => [Number(r.employee_id), r]));
    return {
      byId,
      exists: (id) => byId.has(Number(id)),
      isActive: (id) => byId.has(Number(id)) && Number(byId.get(Number(id)).status) === 1,
    };
  };

  /** Which levels changed between the previous row and the new one. */
  const auditFor = (previous, next) =>
    Object.values(APPROVAL_LEVEL)
      .map((level) => {
        const key = LEVEL_KEY[level];
        const oldId = previous ? idOrNull(previous[key]) : null;
        const newId = idOrNull(next[key]);
        if (oldId === newId && previous && Number(previous.is_active) === 1) return null;
        if (oldId === null && newId === null) return null;
        return { approval_level: level, old_approver_employee_id: oldId, new_approver_employee_id: newId };
      })
      .filter(Boolean);

  const shapeSetup = (row) =>
    row
      ? {
          employee_id: Number(row.employee_id),
          first_level_approver_employee_id: idOrNull(row.first_level_approver_employee_id),
          first_level_approver_name: row.first_level_approver_name || null,
          second_level_approver_employee_id: idOrNull(row.second_level_approver_employee_id),
          second_level_approver_name: row.second_level_approver_name || null,
          final_approver_employee_id: idOrNull(row.final_approver_employee_id),
          final_approver_name: row.final_approver_name || null,
          is_active: row.is_active === undefined ? true : Number(row.is_active) === 1,
          updated_at: row.updated_at || null,
        }
      : null;

  /**
   * Validate and save ONE employee's mapping. Shared by the single edit and
   * the bulk set, which differ only in the audit's action type.
   */
  const saveOne = async ({ actor, setup, action_type }) => {
    const employeeId = Number(setup.employee_id);
    const previous = Number.isInteger(employeeId) ? await approverSetupRepo.getSetup(employeeId) : null;
    const facts = await factsFor([
      setup.employee_id,
      setup.first_level_approver_employee_id,
      setup.second_level_approver_employee_id,
      setup.final_approver_employee_id,
    ]);
    const verdict = validateApproverSetup(setup, {
      exists: facts.exists,
      isActive: facts.isActive,
      // An approver already on the ACTIVE row is not "newly assigned".
      previous: previous && Number(previous.is_active) === 1 ? previous : {},
    });
    if (!verdict.ok) throw validationError(verdict.errors.join("; "), verdict.errors);

    const audit = auditFor(previous, verdict.normalized);
    await approverSetupRepo.saveSetup({
      setup: verdict.normalized,
      action_type,
      actor_employee_id: actor ? actor.employee_id : null,
      audit,
    });
    return { employee_id: employeeId, changed_levels: audit.map((a) => a.approval_level) };
  };

  /** The setup screen's list: employees with their mapping, filtered. */
  const list = async (filters = {}) => {
    const clean = {
      department_id: idOrNull(filters.department_id),
      store_id: idOrNull(filters.store_id),
      designation_id: idOrNull(filters.designation_id),
      employee_id: idOrNull(filters.employee_id),
      search: filters.search || null,
      limit: Number(filters.limit) > 0 ? Number(filters.limit) : 200,
      offset: Number(filters.offset) > 0 ? Number(filters.offset) : 0,
    };
    const [rows, total] = await Promise.all([
      approverSetupRepo.listEmployeesWithSetup(clean),
      approverSetupRepo.countEmployeesWithSetup(clean),
    ]);
    return {
      rows: rows.map((r) => ({
        employee_id: Number(r.employee_id),
        employee_name: r.employee_name,
        store_id: idOrNull(r.store_id),
        store_name: r.store_name || null,
        designation_id: idOrNull(r.designation_id),
        designation_name: r.designation_name || null,
        department_id: idOrNull(r.department_id),
        department_name: r.department_name || null,
        has_setup: r.attendance_approver_setup_id !== null && r.attendance_approver_setup_id !== undefined,
        first_level_approver_employee_id: idOrNull(r.first_level_approver_employee_id),
        first_level_approver_name: r.first_level_approver_name || null,
        first_level_approver_active: r.first_level_approver_status === null || r.first_level_approver_status === undefined ? null : Number(r.first_level_approver_status) === 1,
        second_level_approver_employee_id: idOrNull(r.second_level_approver_employee_id),
        second_level_approver_name: r.second_level_approver_name || null,
        second_level_approver_active: r.second_level_approver_status === null || r.second_level_approver_status === undefined ? null : Number(r.second_level_approver_status) === 1,
        final_approver_employee_id: idOrNull(r.final_approver_employee_id),
        final_approver_name: r.final_approver_name || null,
        final_approver_active: r.final_approver_status === null || r.final_approver_status === undefined ? null : Number(r.final_approver_status) === 1,
        setup_updated_at: r.setup_updated_at || null,
      })),
      total,
      limit: clean.limit,
      offset: clean.offset,
    };
  };

  const get = async (employeeId) => {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("employee_id must be an employee id");
    const [employee] = await approverSetupRepo.getEmployeesByIds([id]);
    if (!employee) throw validationError(`No such employee: ${id}`);
    const setup = await approverSetupRepo.getSetup(id);
    return {
      employee: {
        employee_id: id,
        employee_name: employee.employee_name,
        store_name: employee.store_name || null,
        designation_name: employee.designation_name || null,
        department_name: employee.department_name || null,
        is_active: Number(employee.status) === 1,
      },
      setup: setup && Number(setup.is_active) === 1 ? shapeSetup(setup) : null,
    };
  };

  /** Save or update one employee: SET. */
  const save = async ({ actor, employee_id, first_level_approver_employee_id, second_level_approver_employee_id, final_approver_employee_id }) => {
    const result = await saveOne({
      actor,
      action_type: "SET",
      setup: { employee_id, first_level_approver_employee_id, second_level_approver_employee_id, final_approver_employee_id },
    });
    return { code: 200, ...result, ...(await get(employee_id)) };
  };

  /**
   * BULK_SET: the same three approvers for many employees, each validated
   * and saved on its own. The result says exactly who was updated and who
   * was not, and why.
   */
  const bulkSet = async ({ actor, employee_ids, first_level_approver_employee_id, second_level_approver_employee_id, final_approver_employee_id }) => {
    const ids = [...new Set((employee_ids || []).map(Number))];
    if (ids.length === 0) throw validationError("Select at least one employee");
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw validationError("employee_ids must be employee ids");

    const updated = [];
    const failed = [];
    for (const employee_id of ids) {
      try {
        /* eslint-disable no-await-in-loop */
        const one = await saveOne({
          actor,
          action_type: "BULK_SET",
          setup: { employee_id, first_level_approver_employee_id, second_level_approver_employee_id, final_approver_employee_id },
        });
        /* eslint-enable no-await-in-loop */
        updated.push(one);
      } catch (err) {
        failed.push({ employee_id, message: err.message, errors: err.details || [err.message] });
      }
    }
    return {
      code: 200,
      status: failed.length === 0 ? "COMPLETED" : updated.length === 0 ? "FAILED" : "COMPLETED_WITH_ERRORS",
      requested: ids.length,
      success_count: updated.length,
      failed_count: failed.length,
      updated,
      failed,
    };
  };

  /**
   * REPLACE APPROVER: `current` -> `replacement` at `level`, on every active
   * master row and every undecided pending step. `preview: true` computes
   * the plan and writes nothing, for the confirmation dialog.
   */
  const replace = async ({ actor, current_approver_employee_id, approval_level, new_approver_employee_id, preview = false }) => {
    const oldId = Number(current_approver_employee_id);
    const newId = Number(new_approver_employee_id);
    if (!Number.isInteger(oldId) || oldId <= 0) throw validationError("current_approver_employee_id must be an employee id");
    if (!Number.isInteger(newId) || newId <= 0) throw validationError("new_approver_employee_id must be an employee id");
    if (!Object.values(APPROVAL_LEVEL).includes(approval_level)) {
      throw validationError("approval_level must be FIRST, SECOND or FINAL");
    }
    if (oldId === newId) throw validationError("The new approver must be a different employee from the current approver");

    const facts = await factsFor([oldId, newId]);
    // The CURRENT approver may be resigned - that is the usual reason to
    // replace them - so only existence is required of them.
    if (!facts.exists(oldId)) throw validationError(`No such employee: ${oldId}`);
    if (!facts.exists(newId)) throw validationError(`No such employee: ${newId}`);
    if (!facts.isActive(newId)) throw validationError(`Employee ${newId} is not active and cannot be assigned as an approver`);

    const [setups, steps] = await Promise.all([
      approverSetupRepo.findSetupsWithApprover(approval_level, oldId),
      approverSetupRepo.findPendingStepsWithApprover(approval_level, oldId),
    ]);

    // Nobody becomes their own approver, and nobody holds two levels of one
    // chain - on a master row or on a live request.
    const setupIds = [];
    const skippedSetups = [];
    setups.forEach((s) => {
      const employeeId = Number(s.employee_id);
      const otherLevels = Object.values(APPROVAL_LEVEL)
        .filter((level) => level !== approval_level)
        .filter((level) => idOrNull(s[LEVEL_KEY[level]]) === newId);
      if (employeeId === newId) {
        skippedSetups.push({ employee_id: employeeId, message: `${LEVEL_LABEL[approval_level]}: an employee cannot be their own approver` });
      } else if (otherLevels.length > 0) {
        skippedSetups.push({ employee_id: employeeId, message: `${LEVEL_LABEL[approval_level]}: employee ${newId} is already the ${LEVEL_LABEL[otherLevels[0]]} - the three approvers must be different people` });
      } else setupIds.push(employeeId);
    });
    const stepIds = [];
    const skippedSteps = [];
    steps.forEach((st) => {
      const forId = Number(st.requested_for_employee_id);
      const byId = Number(st.requested_by_employee_id);
      const others = String(st.other_approver_ids || "").split(",").map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0);
      const skip = (message) =>
        skippedSteps.push({ attendance_approval_request_id: Number(st.attendance_approval_request_id), request_type: st.request_type, message });
      if (forId === newId || byId === newId) {
        skip("The new approver is the subject or raiser of this request and cannot approve it");
      } else if (others.includes(newId)) {
        skip("The new approver already holds another stage of this request and cannot hold two");
      } else stepIds.push(Number(st.attendance_approval_step_id));
    });

    const plan = {
      approval_level,
      current_approver_employee_id: oldId,
      current_approver_name: facts.byId.get(oldId).employee_name,
      current_approver_active: facts.isActive(oldId),
      new_approver_employee_id: newId,
      new_approver_name: facts.byId.get(newId).employee_name,
      setups_matched: setups.length,
      pending_steps_matched: steps.length,
      pending_regularization_steps: steps.filter((s) => s.request_type === "REGULARIZATION" && stepIds.includes(Number(s.attendance_approval_step_id))).length,
      pending_ot_steps: steps.filter((s) => s.request_type === "OT" && stepIds.includes(Number(s.attendance_approval_step_id))).length,
      skipped_setups: skippedSetups,
      skipped_steps: skippedSteps,
    };
    if (preview) return { code: 200, preview: true, ...plan, setups_updated: 0, pending_steps_updated: 0 };

    const written = await approverSetupRepo.replaceApprover({
      level: approval_level,
      old_approver_employee_id: oldId,
      new_approver_employee_id: newId,
      setup_employee_ids: setupIds,
      step_ids: stepIds,
      actor_employee_id: actor ? actor.employee_id : null,
    });
    return {
      code: 200,
      preview: false,
      ...plan,
      setups_updated: written.setups_updated,
      pending_steps_updated: written.pending_steps_updated,
    };
  };

  const options = async ({ include_inactive = false, search = null } = {}) => {
    const rows = await approverSetupRepo.listApproverOptions({ include_inactive, search });
    return rows.map((r) => ({
      employee_id: Number(r.employee_id),
      employee_name: r.employee_name,
      designation_name: r.designation_name || null,
      store_name: r.store_name || null,
      is_active: Number(r.status) === 1,
    }));
  };

  const currentApprovers = async () => {
    const rows = await approverSetupRepo.listCurrentApprovers();
    return rows.map((r) => ({
      employee_id: Number(r.employee_id),
      employee_name: r.employee_name,
      designation_name: r.designation_name || null,
      store_name: r.store_name || null,
      is_active: Number(r.status) === 1,
      first_level_count: Number(r.first_level_count) || 0,
      second_level_count: Number(r.second_level_count) || 0,
      final_count: Number(r.final_count) || 0,
      pending_step_count: Number(r.pending_step_count) || 0,
    }));
  };

  const audit = (filters) => approverSetupRepo.listAudit(filters || {});

  return { APPROVAL_LEVEL, LEVEL_LABEL, list, get, save, bulkSet, replace, options, currentApprovers, audit };
};
