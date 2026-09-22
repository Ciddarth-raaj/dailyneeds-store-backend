/**
 * THE HR SHIFT CHANGE BLOCK LEDGER, FAKED - once, and shared.
 *
 * Used by the block suite and by the cross-feature propagation compatibility
 * suite, so both assert against the SAME modelled invariant rather than two
 * copies that could drift apart. `now` is injected because the two suites pin
 * different business dates.
 *
* THE LEDGER, WITH THE REAL TABLE'S INVARIANT.
 *
 * `create` refuses a second ACTIVE row for one employee/date exactly as
 * `uq_ascb_active_per_employee_date` does - by returning `{duplicate:true}`
 * rather than throwing - and `remove` matches only a row whose `removed_at` is
 * still null, exactly as the UPDATE's `AND removed_at IS NULL` does. Rows are
 * never dropped, so history accumulates here as it does there.
 *
 * IT ALSO MODELS THE LOCKED BRANCH CHECK. Both writes authorize the scope
 * they are handed against the employee's CURRENT store and stamp that store
 * as the audit snapshot, exactly as the real repository does under the
 * employee row lock. A fake that skipped it would let these tests pass while
 * the authorization boundary was missing - the interleaved proof lives in
 * `repository/attendance_shift_change_block_concurrency.test.js`.
 */

const { isEmployeeInScope } = require("../utils/employee_branch_scope");

function fakeBlockRepo(state = {}) {
  const NOW = state.now || "2026-09-19";
  const rows = [];
  let nextId = 1;
  const employees = state.employees || [];

  return {
    rows,
    getEmployeeForBlock: async (employeeId) =>
      employees.find((e) => Number(e.employee_id) === Number(employeeId)) || null,
    findActive: async (employeeId, date) =>
      rows.find(
        (r) =>
          Number(r.employee_id) === Number(employeeId) &&
          r.attendance_date === date &&
          !r.removed_at
      ) || null,
    listActiveForPopulation: async ({ employee_ids, from_date, to_date }) =>
      rows.filter(
        (r) =>
          employee_ids.map(Number).includes(Number(r.employee_id)) &&
          r.attendance_date >= from_date &&
          r.attendance_date <= to_date &&
          !r.removed_at
      ),
    listHistory: async (employeeId, date) =>
      rows
        .filter(
          (r) => Number(r.employee_id) === Number(employeeId) && r.attendance_date === date
        )
        .sort((a, b) => b.attendance_shift_change_block_id - a.attendance_shift_change_block_id),
    create: async (row) => {
      // THE LOCKED BRANCH CHECK, modelled.
      const subject = employees.find((e) => Number(e.employee_id) === Number(row.employee_id));
      if (!subject) return { created: false, duplicate: false, missing_employee: true };
      if (!isEmployeeInScope(row.scope, subject.store_id)) {
        const err = new Error("You do not have access to this employee's branch.");
        err.name = "ForbiddenError";
        err.code = 403;
        err.out_of_scope = true;
        throw err;
      }
      // THE UNIQUE KEY, in memory.
      const clash = rows.find(
        (r) =>
          Number(r.employee_id) === Number(row.employee_id) &&
          r.attendance_date === row.attendance_date &&
          !r.removed_at
      );
      if (clash) return { created: false, duplicate: true, insert_id: null };
      const id = nextId;
      nextId += 1;
      rows.push({
        attendance_shift_change_block_id: id,
        ...row,
        // The audit snapshot is the LIVE store, as the real insert records it.
        outlet_id: subject.store_id,
        blocked_at: `${NOW} 11:00:00`,
        blocked_by_employee_name: `Employee ${row.blocked_by_employee_id}`,
        removed_at: null,
        removed_by_employee_id: null,
        removed_by_user_id: null,
        removal_reason: null,
      });
      return { created: true, duplicate: false, insert_id: id };
    },
    remove: async ({ employee_id, attendance_date, ...rest }) => {
      const subject = employees.find((e) => Number(e.employee_id) === Number(employee_id));
      if (!subject) return { removed: false, missing_employee: true };
      if (!isEmployeeInScope(rest.scope, subject.store_id)) {
        const err = new Error("You do not have access to this employee's branch.");
        err.name = "ForbiddenError";
        err.code = 403;
        err.out_of_scope = true;
        throw err;
      }
      const active = rows.find(
        (r) =>
          Number(r.employee_id) === Number(employee_id) &&
          r.attendance_date === attendance_date &&
          !r.removed_at
      );
      if (!active) return { removed: false };
      active.removed_at = `${NOW} 12:00:00`;
      active.removed_by_employee_id = rest.removed_by_employee_id;
      active.removed_by_user_id = rest.removed_by_user_id;
      active.removal_reason = rest.removal_reason;
      return { removed: true };
    },
  };
}

module.exports = { fakeBlockRepo };
