const { employedOn } = require("./attendance_eligibility");
const {
  MAPPING_TYPE,
  ALL_EMPLOYEES_TARGET_ID,
  RULE_DIMENSIONS,
  RULE_DIMENSION,
  ANY_TARGET_ID,
  ANY_LABEL,
  ALL_EMPLOYEES_LABEL,
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
 * THE ONE PLACE A STORED ROW BECOMES A RULE.
 *
 * Returns `{OUTLET, DEPARTMENT, DESIGNATION}` of ids, where 0 means the
 * dimension is unrestricted. Everything downstream - matching, labelling,
 * duplicate detection, the preview - reads THIS, so there is exactly one
 * understanding of what a row means.
 *
 * IT ACCEPTS THE LEGACY SHAPE TOO, and that is not a second rule: a
 * `{mapping_type, target_id}` pair is an ENCODING of a composite rule with
 * one dimension narrowed, so it is decoded here and joins the same path. The
 * migration rewrites the stored rows, but request bodies, fixtures and any
 * row read by code that predates this change still arrive in the old shape,
 * and a decoder is cheaper to trust than a second matcher.
 *
 * COMPOSITE COLUMNS WIN when both are present. After the migration they are
 * the truth; a stale `mapping_type` alongside them is a leftover, and reading
 * the leftover is how a two-dimension rule would silently match one.
 */
function ruleOf(mapping) {
  const rule = { OUTLET: ANY_TARGET_ID, DEPARTMENT: ANY_TARGET_ID, DESIGNATION: ANY_TARGET_ID };
  if (!mapping) return rule;

  let sawComposite = false;
  for (const dimension of RULE_DIMENSIONS) {
    const raw = mapping[RULE_DIMENSION[dimension].column];
    if (raw === undefined) continue;
    sawComposite = true;
    const id = toId(raw);
    rule[dimension] = id === null || id < 0 ? ANY_TARGET_ID : id;
  }
  if (sawComposite) return rule;

  // Legacy encoding. ALL_EMPLOYEES narrows nothing, so it is the all-zero
  // rule; a targeted type narrows exactly its own dimension.
  const type = mapping.mapping_type;
  if (!type || type === MAPPING_TYPE.ALL_EMPLOYEES) return rule;
  if (!RULE_DIMENSIONS.includes(type)) return rule;
  const target = toId(mapping.target_id);
  // A targeted legacy row on the sentinel is a row that should never have
  // been written. It stays unrestricted-on-nothing and matches NOBODY below,
  // rather than quietly becoming "everybody".
  rule[type] = target === null || target <= 0 ? -1 : target;
  return rule;
}

/**
 * The DIMENSION half only - does this employee satisfy every narrowed
 * dimension of this rule. Employment is a separate question, asked below, so
 * that neither half can be quietly skipped.
 *
 * AND ACROSS THE THREE, AND UNRESTRICTED MATCHES EVERYONE. An employee with
 * no department sits outside any rule that names one, which is correct: the
 * rule asks for a department and they are in none.
 */
function matchesDimension(employee, mapping) {
  if (!employee || !mapping) return false;
  const rule = ruleOf(mapping);

  for (const dimension of RULE_DIMENSIONS) {
    const want = rule[dimension];
    if (want === ANY_TARGET_ID) continue;
    // The poisoned value `ruleOf` writes for a malformed legacy row. It can
    // equal no employee's id, so the bad row matches nobody and its failure
    // stays visible instead of becoming maximal.
    if (want < 0) return false;
    const have = toId(employee[RULE_DIMENSION[dimension].employeeColumn]);
    if (have === null || have !== want) return false;
  }
  return true;
}

/**
 * The rule as a sentence, from ids already resolved to names.
 *
 * `resolved` IS EXACTLY WHAT `repository#resolveTargets` RETURNS - a
 * `Map<dimension, Map<id, {name, active}>>` - and not a look-alike object,
 * because indexing a Map with `[dimension]` silently yields `undefined` and
 * every rule would then read as "#5" with nothing failing. A test pins the
 * resolved case for that reason.
 *
 * AN ID WITH NO NAME RENDERS AS THE ID, not as nothing: a rule whose outlet
 * was deleted must still read as a rule.
 */
function ruleLabel(mapping, resolved) {
  const rule = ruleOf(mapping);
  const lookup = (dimension) => {
    if (!resolved) return undefined;
    const found = typeof resolved.get === "function" ? resolved.get(dimension) : resolved[dimension];
    return found && typeof found.get === "function" ? found.get(rule[dimension]) : undefined;
  };
  const parts = [];
  for (const dimension of RULE_DIMENSIONS) {
    const id = rule[dimension];
    if (id === ANY_TARGET_ID) continue;
    const found = lookup(dimension);
    const shown = found && found.name ? found.name : `#${id}`;
    parts.push(`${RULE_DIMENSION[dimension].label}: ${shown}`);
  }
  return parts.length === 0 ? ALL_EMPLOYEES_LABEL : parts.join(" + ");
}

/** True when nothing is narrowed - the rule that means everybody. */
function isAllEmployees(mapping) {
  const rule = ruleOf(mapping);
  return RULE_DIMENSIONS.every((dimension) => rule[dimension] === ANY_TARGET_ID);
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
  ruleOf,
  ruleLabel,
  isAllEmployees,
  ANY_LABEL,
  matchesDimension,
  matchesMapping,
  employedEmployees,
  deriveMatches,
};
