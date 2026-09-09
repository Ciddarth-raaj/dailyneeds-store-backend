/**
 * The employee-directory population, in one place.
 *
 * WHY THIS FILE EXISTS. `GET /employee/employees` decides which employees a
 * caller sees, and that decision was expressed inline inside the SELECT that
 * renders the directory. Anything else needing the same population - the C3
 * status summary, and now Reports - would have had to restate the rule, and a
 * second statement of a visibility rule is a second answer to "who may this
 * person see". So the rule moves here and both callers use it.
 *
 * WHAT THE RULE ACTUALLY IS, as of today. It is deliberately transcribed
 * rather than redesigned:
 *
 *   1. `view_employees` gates the route. That is the only permission
 *      involved, and it is applied by the router, not here.
 *
 *   2. Employees whose NAME appears in the `resignation` table are excluded
 *      from the population entirely.
 *
 *   3. `store_ids` and `designation_ids`, when supplied by the caller, narrow
 *      it further.
 *
 * There is NO per-actor row restriction: a caller holding `view_employees`
 * sees every employee, and the store filter is whatever they asked for rather
 * than whatever their own branch is. (That is unlike `GET /employee/directory`,
 * which is scoped to the caller's own outlet from the token.) This module
 * changes none of that; it only stops the rule being written twice.
 *
 * TWO THINGS WORTH KNOWING about rule 2, neither of which is this module's to
 * fix:
 *
 *   `resignation` is keyed by `employee_name`, a VARCHAR - so two employees
 *   sharing a name share the exclusion. It is the same name-keyed weakness
 *   already reported for `employee_family`.
 *
 *   Because the exclusion is by name rather than by `status`, an employee
 *   with a resignation record is absent from the population even when a
 *   caller asks for resigned staff. A status filter therefore selects within
 *   what is left, not across everybody.
 *
 * The SQL below is a transcription of what `repository/employee.js#get` did
 * before this extraction, including the `(... NOT IN (?) OR ? IS NULL)` idiom
 * that makes an empty resignation list a no-op. Its parameter ORDER is part
 * of the contract: the two resignation placeholders come first.
 */

/**
 * @param resignedNames string[] employee names from the `resignation` table
 * @param filters       { store_ids?: number[], designation_ids?: number[] }
 * @returns { where, params } - `where` includes the leading WHERE keyword,
 *          and `params` is ordered to match it.
 */
function buildEmployeeScope(resignedNames = [], filters = {}) {
  const names = Array.isArray(resignedNames) ? resignedNames : [];

  // Both placeholders take the same value. When the list is empty they are
  // both NULL: `NOT IN (NULL)` yields NULL, and the `? IS NULL` arm then
  // makes the predicate true, so nobody is excluded.
  const params = [names.length ? names : null, names.length ? names : null];

  const conditions = [];
  if (filters && Array.isArray(filters.store_ids) && filters.store_ids.length > 0) {
    conditions.push("new_employee.store_id IN (?)");
    params.push(filters.store_ids);
  }
  if (filters && Array.isArray(filters.designation_ids) && filters.designation_ids.length > 0) {
    conditions.push("new_employee.designation_id IN (?)");
    params.push(filters.designation_ids);
  }

  const where =
    `WHERE (new_employee.employee_name NOT IN (?) OR ? IS NULL) ` +
    `${conditions.length > 0 ? "AND " + conditions.join(" AND ") : ""}`;

  return { where, params };
}

module.exports = { buildEmployeeScope };
