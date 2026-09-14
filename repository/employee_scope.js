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
 * ------------------------------------------------------- what access is now
 * `accessScope` USED to be deliberately empty, and that emptiness was recorded
 * here as a finding: `view_employees` gated the route and a caller holding it
 * saw every employee in the company, with the store filter being whatever they
 * asked for rather than whatever branch they belong to.
 *
 * IT IS NOW THE BRANCH RESTRICTION. The unit was left in place precisely so
 * that adding one would apply to the directory and to Reports at once, and
 * that is what happened: an actor carries a resolved `branch_scope` (see
 * `middlewares/employee_branch_scope.js`) and this renders it as a predicate.
 *
 * AND IT FAILS CLOSED ON A CALLER WHO SKIPPED THE RESOLVER. An actor that
 * arrives without a `branch_scope` is not treated as company-wide - it renders
 * `1 = 0`. A new employee query that forgets to resolve the scope therefore
 * returns nothing and is noticed, rather than quietly returning everybody.
 * `accessScope(null)` is still empty, and that is for INTERNAL callers with no
 * actor at all (a cron job, a sync) which are not user requests.
 *
 * ------------------------------------------------------------- KNOWN DEBT
 * `resignation` is keyed by `employee_name`, a VARCHAR. Two employees sharing
 * a name share the exclusion, and renaming somebody detaches it. This is
 * pre-existing and is NOT fixed here - doing so would change the directory's
 * production behaviour, which this work must not. It is recorded as debt: the
 * table should be keyed by the permanent `employee_id`, alongside the same
 * fix already reported for `employee_family`.
 */

const {
  EMPLOYEE_BRANCH_SCOPE,
  branchIds,
} = require("../utils/employee_branch_scope");

/* ------------------------------------------------------------ the units */

/**
 * ACCESS SCOPE — which rows this caller is authorized to reach.
 *
 * THE BRANCH RESTRICTION. Shared by the HR directory, the work-shift
 * assignment population and Reports, so it cannot be applied to one and
 * forgotten on another.
 *
 * Three outcomes, and the difference between the last two is the whole safety
 * property:
 *
 *   no actor at all       no conditions. An INTERNAL caller - a cron job, a
 *                         sync - which is not a user request and has no branch.
 *   ALL_BRANCHES          no conditions. HR and administrators, unrestricted.
 *   anything else         `store_id IN (...)` for the authorized branches, or
 *                         `1 = 0` when there are none. NEVER an empty clause:
 *                         an unresolved or empty scope must return no rows, not
 *                         every row.
 *
 * AN ACTOR WITH NO `branch_scope` IS `1 = 0`. That is deliberate. A future
 * employee query that passes `permissions.actorFor(req)` instead of
 * `employeeBranchScope.actorFor(req)` returns an empty list - visibly wrong and
 * quickly found - rather than silently disclosing every branch.
 *
 * @param actor { userId, employeeId, userType, permissions, isAdmin,
 *                branch_scope: { kind, store_ids } }
 * @param options.alias the table or alias holding `store_id`. The directory
 *   and Reports query `new_employee` unaliased; the work-shift population
 *   aliases it `ne`. Passing the wrong one is a SQL error rather than a silent
 *   widening, which is the safe direction for a mistake here.
 */
function accessScope(actor, { alias = "new_employee" } = {}) {
  if (!actor) return { conditions: [], params: [] };

  const scope = actor.branch_scope;
  if (scope && scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) {
    return { conditions: [], params: [] };
  }

  const ids = scope ? branchIds(scope.store_ids || []) : [];
  if (scope && scope.kind === EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES && ids.length > 0) {
    return { conditions: [`${alias}.store_id IN (?)`], params: [ids] };
  }

  return { conditions: ["1 = 0"], params: [] };
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
