const { employedOn } = require("./attendance_eligibility");
const {
  MAPPING_TYPE,
  ALL_EMPLOYEES_TARGET_ID,
} = require("../constants/telegram_group_mapping");

/**
 * WHO A MAPPING MATCHES. Pure functions, no database, no clock, no request.
 *
 * Everything that decides membership intent lives here so it can be tested
 * against plain objects, and so the count on the mapping row and the list
 * behind View Employees are derived by THE SAME CODE from THE SAME snapshot.
 * A screen where the number and the list disagree is worse than either alone.
 *
 * ============================================ EMPLOYMENT IS DATED ==========
 *
 * `status` DOES NOT DECIDE ANYTHING HERE, and that is the single most
 * important line in this file. A resigned employee frequently still carries
 * `status = 1` in `new_employee`; trusting it would keep leavers mapped into
 * store groups indefinitely. The authority is the shared `employedOn()` in
 * `utils/attendance_eligibility.js`, the same rule payroll's queries read.
 *
 * `eligibleOn()` IS THE WRONG FUNCTION and is deliberately not used: it adds
 * the attendance-required test, so an employee exempt from biometric
 * attendance would be dropped from Telegram groups they belong in. Being
 * exempt from punching is not being off the staff.
 *
 * THE KNOWN LIMITATION IS INHERITED, NOT PAPERED OVER. `new_employee` holds
 * one joining date and one resignation date, so a resign-then-rejoin gap is
 * not modelled. `employee_employment_period` is the eventual source and its
 * backfill still carries rows flagged needs_review. Inventing a second
 * employment rule here to cover the gap would mean two rules that disagree,
 * and the one that decides Telegram groups would not be the one that decides
 * pay.
 */

/** The employee-master column each targeted type compares against. */
const DIMENSION_COLUMN = {
  [MAPPING_TYPE.OUTLET]: "store_id",
  [MAPPING_TYPE.DESIGNATION]: "designation_id",
  [MAPPING_TYPE.DEPARTMENT]: "department_id",
};

const toId = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};

/**
 * The DIMENSION half only - does this employee sit in this outlet /
 * designation / department. Employment is a separate question, asked below,
 * so that neither half can be quietly skipped.
 */
function matchesDimension(employee, mapping) {
  if (!employee || !mapping) return false;
  if (mapping.mapping_type === MAPPING_TYPE.ALL_EMPLOYEES) return true;

  const column = DIMENSION_COLUMN[mapping.mapping_type];
  if (!column) return false;

  const target = toId(mapping.target_id);
  // A targeted mapping on the sentinel is not "everybody" - it is a row that
  // should never have been written. It matches nobody rather than everybody,
  // because the failure of a bad row must be visible, not maximal.
  if (target === null || target === ALL_EMPLOYEES_TARGET_ID) return false;

  return toId(employee[column]) === target;
}

/**
 * Both halves. An employee matches when the dimension agrees AND they were
 * employed on the business date.
 *
 * THE TARGET'S OWN STATE IS NOT CONSULTED. A mapping whose outlet has been
 * retired still matches the employees stored against that outlet id, and
 * that is intended: they are really still assigned there, and reporting zero
 * would hide them. The mapping row carries a warning instead - the count and
 * the warning are two different facts and the screen shows both.
 */
function matchesMapping(employee, mapping, businessDate) {
  if (!matchesDimension(employee, mapping)) return false;
  return employedOn(employee, businessDate);
}

/**
 * The employees currently employed on `businessDate`, in input order.
 *
 * Applied ONCE per request and reused for every mapping, so all the counts on
 * one screen are answers about one population. Filtering per mapping would
 * open the door to two mappings disagreeing about who is employed because
 * they evaluated either side of midnight.
 */
function employedEmployees(employees, businessDate) {
  return (employees || []).filter((employee) => employedOn(employee, businessDate));
}

/**
 * THE WHOLE DERIVATION FOR ONE GROUP, from one snapshot.
 *
 * Returns the per-mapping matched employee-id lists AND the deduplicated
 * union, together, because they must come from the same pass: a union
 * computed separately could disagree with the rows above it.
 *
 * ORDER IS THE SNAPSHOT'S ORDER, which the repository fixes by name, so two
 * identical requests return identical bodies.
 */
function deriveMatches(employees, mappings, businessDate) {
  const employed = employedEmployees(employees, businessDate);
  const perMapping = new Map();
  const union = [];
  const seen = new Set();

  for (const mapping of mappings || []) {
    const matched = [];
    for (const employee of employed) {
      if (!matchesDimension(employee, mapping)) continue;
      const id = toId(employee.employee_id);
      if (id === null) continue;
      matched.push(id);
      // Deduplicated by employee_id: somebody matched by three mappings is
      // one person in the group, and appears once in the union while still
      // counting towards all three individual rows.
      if (!seen.has(id)) {
        seen.add(id);
        union.push(id);
      }
    }
    perMapping.set(mapping.telegram_group_mapping_id, matched);
  }

  return { perMapping, union, employed };
}

module.exports = {
  DIMENSION_COLUMN,
  matchesDimension,
  matchesMapping,
  employedEmployees,
  deriveMatches,
};
