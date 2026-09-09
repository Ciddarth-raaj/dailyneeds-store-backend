/**
 * Employee query scope, as three SEPARATE concepts.
 *
 * ================================== WHY THESE ARE NOT ONE THING ==========
 *
 * The HR directory's WHERE clause mixed two ideas that only look alike:
 *
 *   ACCESS SCOPE          which employee rows this caller is AUTHORIZED to
 *                         reach - outlet restrictions, the admin bypass, and
 *                         any other genuine authorization constraint.
 *
 *   DIRECTORY POPULATION  a legacy rule specific to the directory screen: it
 *                         hides anyone whose NAME appears in `resignation`.
 *
 * Treating the second as authorization would be a real defect in Reports. A
 * report with a "Resigned" status filter that inherits an exclusion of
 * resigned people returns nothing, and "All" quietly means "all except the
 * ones who left" - both semantically wrong, and wrong in a way a reader of the
 * spreadsheet cannot see.
 *
 * So they are separate units here. The directory composes both, exactly as it
 * always has. Reports composes ACCESS SCOPE ONLY and decides its own
 * population from the explicit status filter.
 *
 * ------------------------------------------------------ what access is today
 * `accessScope` is deliberately EMPTY, and that is a finding rather than an
 * omission: there is no per-actor row restriction on the HR directory today.
 * `view_employees` gates the route, and a caller holding it sees every
 * employee; the store filter is whatever they asked for, not whatever branch
 * they belong to. (`GET /employee/directory` is different - it IS scoped to
 * the caller's own outlet from the token - but that is a separate endpoint
 * with a separate rule.)
 *
 * The unit exists anyway, empty, because it is where an outlet restriction
 * belongs when one is introduced. Adding it here would then apply to the
 * directory and to Reports at once, which is the point.
 *
 * ------------------------------------------------------------- KNOWN DEBT
 * `resignation` is keyed by `employee_name`, a VARCHAR. Two employees sharing
 * a name share the exclusion, and renaming somebody detaches it. This is
 * pre-existing and is NOT fixed here - doing so would change the directory's
 * production behaviour, which this work must not. It is recorded as debt: the
 * table should be keyed by the permanent `employee_id`, alongside the same
 * fix already reported for `employee_family`.
 */

/* ------------------------------------------------------------ the units */

/**
 * ACCESS SCOPE — which rows this caller is authorized to reach.
 *
 * Empty today (see above). Shared by the directory and by Reports, so that a
 * future restriction cannot be applied to one and forgotten on the other.
 *
 * @param actor { userId, employeeId, storeId, userType, permissions, isAdmin }
 */
// eslint-disable-next-line no-unused-vars
function accessScope(actor) {
  return { conditions: [], params: [] };
}

/**
 * DIRECTORY POPULATION — the legacy resignation-name exclusion.
 *
 * Directory-only. Reports must not use this.
 *
 * This carries the hotfix deployed to production as `1f7c11a`. The clause used
 * to read `(... NOT IN (?) OR ? IS NULL)` with the SAME array bound to both
 * placeholders; the `mysql` driver expands an array into a comma list, so at
 * two or more names the second arm rendered as `'Ada', 'Grace' IS NULL`, which
 * MySQL rejects with ER_OPERAND_COLUMNS (1241). Nothing needs the second arm:
 * when there is nobody to exclude, the predicate is simply omitted.
 *
 * The `employee_name` keying is deliberately left alone - see KNOWN DEBT.
 */
function directoryPopulation(resignedNames) {
  const names = Array.isArray(resignedNames) ? resignedNames : [];
  if (names.length === 0) {
    return { conditions: [], params: [] };
  }
  return {
    conditions: ["new_employee.employee_name NOT IN (?)"],
    params: [names],
  };
}

/**
 * LOOKUP FILTERS — caller-supplied narrowing by outlet and designation.
 *
 * Not authorization: these are what the user asked to see, and they can only
 * ever narrow. Shared, because the directory's filter and the report's filter
 * must mean the same thing.
 */
function lookupFilters(filters = {}) {
  const conditions = [];
  const params = [];
  const f = filters || {};

  if (Array.isArray(f.store_ids) && f.store_ids.length > 0) {
    conditions.push("new_employee.store_id IN (?)");
    params.push(f.store_ids);
  }
  if (Array.isArray(f.designation_ids) && f.designation_ids.length > 0) {
    conditions.push("new_employee.designation_id IN (?)");
    params.push(f.designation_ids);
  }
  return { conditions, params };
}

/** Join parts in order into one clause, keeping parameter order with it. */
function compose(parts) {
  const conditions = [];
  const params = [];
  for (const part of parts) {
    if (!part) continue;
    conditions.push(...part.conditions);
    params.push(...part.params);
  }
  return { conditions, params };
}

/* ---------------------------------------------------- the directory's own */

/**
 * The HR directory's scope: access + the legacy population + lookup filters.
 *
 * The string this returns, and the order of its parameters, are identical to
 * what `repository/employee.js#get` builds inline in production after the
 * `1f7c11a` hotfix. Swapping the store and designation parameters would filter
 * stores by designation ids and vice versa - a silently wrong population
 * rather than an error - so the order is pinned by a test.
 *
 * With nothing to exclude and no filters there are no conditions at all, and
 * the clause is empty: `WHERE` on its own is a syntax error, not a wide query.
 */
function buildEmployeeScope(resignedNames = [], filters = {}, actor = null) {
  const { conditions, params } = compose([
    accessScope(actor),
    directoryPopulation(resignedNames),
    lookupFilters(filters),
  ]);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return { where, params };
}

/* ------------------------------------------------------------- Reports's */

/**
 * The scope a REPORT starts from: authorization and the caller's lookup
 * filters, and NOTHING about who has resigned.
 *
 * A report's population is decided by its explicit status filter, which the
 * resolver adds. That is what lets "Resigned" actually return resigned
 * employees and "All" actually mean all.
 *
 * Returns raw parts rather than a finished clause, because the resolver has
 * further conditions of its own to add.
 */
function buildReportAccessScope(filters = {}, actor = null) {
  return compose([accessScope(actor), lookupFilters(filters)]);
}

module.exports = {
  accessScope,
  directoryPopulation,
  lookupFilters,
  compose,
  buildEmployeeScope,
  buildReportAccessScope,
};
