/**
 * Telegram Group Mapping - the fixed vocabulary, in one place.
 *
 * WHY A CONSTANTS FILE AND NOT FOUR STRING LITERALS. The mapping type appears
 * in the ENUM, the Joi schema, the usecase's validation, the matcher, the
 * frontend dropdown and every test. A typo in any one of those is a mapping
 * that silently matches nobody, which looks exactly like a correct mapping
 * whose target has no staff. So the vocabulary is declared once, the way
 * `constants/telegram_group_registry.js` declares the category list.
 */

/**
 * The only four. There is no SELECTED_EMPLOYEES, no MANUAL, no ROLE and no
 * rule builder, and that is a product decision rather than a first cut:
 * each of those is a rule somebody must read and re-verify before they can
 * trust who is in a group, and the whole point of these four is that a row
 * can be understood at a glance and re-derived from the employee master.
 */
const MAPPING_TYPE = {
  ALL_EMPLOYEES: "ALL_EMPLOYEES",
  OUTLET: "OUTLET",
  DESIGNATION: "DESIGNATION",
  DEPARTMENT: "DEPARTMENT",
};

/** Display order, which is also the order the Add Mapping dropdown uses. */
const MAPPING_TYPES = [
  MAPPING_TYPE.ALL_EMPLOYEES,
  MAPPING_TYPE.OUTLET,
  MAPPING_TYPE.DESIGNATION,
  MAPPING_TYPE.DEPARTMENT,
];

/** Human labels. The API sends these so the screen never maps enums to words. */
const MAPPING_TYPE_LABEL = {
  ALL_EMPLOYEES: "All Employees",
  OUTLET: "Outlet",
  DESIGNATION: "Designation",
  DEPARTMENT: "Department",
};

/**
 * ALL_EMPLOYEES' target, and the reason it is not NULL.
 *
 * MySQL treats NULLs as DISTINCT in a UNIQUE index, so a nullable target
 * would let "All Employees" be added to one group any number of times with
 * the index raising no objection - and the duplicate rows would each be
 * counted, each be deletable separately, and look like a bug nobody could
 * explain. Zero cannot collide with a real target: `outlets`, `designation`
 * and `department` are all AUTO_INCREMENT and start at 1.
 */
const ALL_EMPLOYEES_TARGET_ID = 0;

/** The three types that name a row in a master table. */
const TARGETED_MAPPING_TYPES = [
  MAPPING_TYPE.OUTLET,
  MAPPING_TYPE.DESIGNATION,
  MAPPING_TYPE.DEPARTMENT,
];

/**
 * Which master each targeted type reads, and WHICH COLUMN SAYS IT IS ACTIVE.
 *
 * THE TWO SPELLINGS ARE NOT A MISTAKE. `outlets` calls it `is_active`; the
 * other two call it `status`. `repository/report_template.js` already
 * discovered this and pins the same map with a test, because getting the
 * column wrong here does not fail loudly - it marks every target inactive and
 * quietly decorates every correct mapping with a warning. A test asserts that
 * this map and that one still agree.
 */
const MAPPING_TARGET_SOURCE = {
  OUTLET: { table: "outlets", id: "outlet_id", name: "outlet_name", active: "is_active" },
  DESIGNATION: {
    table: "designation",
    id: "designation_id",
    name: "designation_name",
    active: "status",
  },
  DEPARTMENT: {
    table: "department",
    id: "department_id",
    name: "department_name",
    active: "status",
  },
};

/**
 * What the screen must be able to tell apart.
 *
 * ZERO MATCHES IS NOT A BROKEN MAPPING. An outlet that is open and staffed by
 * nobody today is an ACTIVE target with a count of zero, and a mapping whose
 * outlet was deleted last year is something else entirely. Collapsing the two
 * into "0 employees" would hide real misconfiguration behind an ordinary
 * number, so they are separate states and the UI renders them differently.
 */
/**
 * WHOSE EMPLOYEES THE NUMBERS ON THIS SCREEN COUNT.
 *
 * `ALL` is the company. `BRANCH` means the caller may only see employees in
 * their own branch, so every employee-derived number counts only those.
 *
 * `NONE` MEANS THE NUMBERS ARE NOT AVAILABLE AT ALL, and it is a THIRD state
 * rather than a flavour of `BRANCH`. The distinction is the difference
 * between two sentences that both render as zero:
 *
 *   BRANCH, 0  "nobody in your branch matches this rule"   - an observation
 *   NONE,   0  "employee information is unavailable to you" - not an
 *              observation about anybody
 *
 * A request resolves to `NONE` when the caller has no employee record, is
 * inactive, has no branch assigned, is unauthenticated, or when the resolver
 * did not run at all. In none of those cases has anything been counted, so
 * presenting a 0 as if it were a finding would be inventing an observation
 * out of a failure - and the most likely reading, "this rule matches nobody,
 * it must be broken", is the one that gets a correct rule deleted.
 *
 * IT REPLACED `scope_limited`, which meant "your list is smaller than the
 * company-wide total" and so required computing a total the caller may not
 * have. This says what the numbers ARE, and needs no forbidden figure.
 */
const COUNTS_SCOPE = {
  ALL: "ALL",
  BRANCH: "BRANCH",
  NONE: "NONE",
};

const TARGET_STATE = {
  /** ALL_EMPLOYEES: there is no target to resolve. */
  NOT_APPLICABLE: "NOT_APPLICABLE",
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
  MISSING: "MISSING",
};

const TARGET_WARNING = {
  INACTIVE: "Mapped target is inactive",
  MISSING: "Mapped target no longer exists",
};


/* ===================================================================== *
 *            MULTI-LEVEL RULES - Outlet AND Department AND Designation
 * ===================================================================== *
 *
 * A mapping is no longer ONE dimension. It is a composite rule with three
 * optional dimensions combined with AND:
 *
 *   Outlet=Moolakulam, Department=ALL, Designation=Cashier
 *     -> cashiers at Moolakulam, whatever department they sit in
 *
 * WHY AND AND NOT OR. "Outlet OR Designation" is a rule nobody can read off
 * the row: it silently includes every cashier in the company the moment you
 * name a designation. Narrowing is the operation this screen exists for, so
 * every dimension added makes the population smaller, never larger - and a
 * reader can predict the direction without knowing the operator.
 *
 * UNRESTRICTED IS STORED AS 0, NOT NULL, and it is the same sentinel and the
 * same reason as the one ALL_EMPLOYEES used: MySQL treats NULLs as DISTINCT
 * in a UNIQUE index, so a rule with three nullable dimensions could be added
 * to one group any number of times and the index would raise no objection.
 * With 0 the four-column UNIQUE key is the real duplicate guard, exactly as
 * the three-column one was before it. `outlets`, `designation` and
 * `department` are AUTO_INCREMENT from 1, so 0 cannot collide with a target.
 *
 * ALL THREE UNRESTRICTED IS "ALL EMPLOYEES". It is not a special type, a
 * special row or a special code path - it is the rule with nothing narrowed,
 * which is what "everybody" means. The legacy ALL_EMPLOYEES row migrated to
 * exactly that, so it kept its meaning without keeping its own concept.
 */

/** The three dimensions, in the order the screen cascades through them. */
const RULE_DIMENSIONS = ["OUTLET", "DEPARTMENT", "DESIGNATION"];

/**
 * Everything each dimension needs, in one place: the mapping column, the
 * employee-master column it compares against, the request field the API
 * accepts, and the master table that resolves its name and active state.
 *
 * ONE ENTRY PER DIMENSION, so a fourth dimension is a row here plus a column,
 * rather than an edit in the matcher, the repository, the validator, the
 * preview, the label builder and the screen.
 */
const RULE_DIMENSION = {
  OUTLET: {
    column: "rule_outlet_id",
    employeeColumn: "store_id",
    // The name the employee SNAPSHOT already carries for this dimension, so
    // the cascade can label an option without a second query per level.
    nameColumn: "outlet_name",
    field: "outlet_id",
    label: "Outlet",
    source: MAPPING_TARGET_SOURCE.OUTLET,
  },
  DEPARTMENT: {
    column: "rule_department_id",
    employeeColumn: "department_id",
    // The name the employee SNAPSHOT already carries for this dimension, so
    // the cascade can label an option without a second query per level.
    nameColumn: "department_name",
    field: "department_id",
    label: "Department",
    source: MAPPING_TARGET_SOURCE.DEPARTMENT,
  },
  DESIGNATION: {
    column: "rule_designation_id",
    employeeColumn: "designation_id",
    // The name the employee SNAPSHOT already carries for this dimension, so
    // the cascade can label an option without a second query per level.
    nameColumn: "designation_name",
    field: "designation_id",
    label: "Designation",
    source: MAPPING_TARGET_SOURCE.DESIGNATION,
  },
};

/** Unrestricted, on any dimension. The sentinel ALL_EMPLOYEES already used. */
const ANY_TARGET_ID = ALL_EMPLOYEES_TARGET_ID;

/** What a dimension left unrestricted is called on screen and in labels. */
const ANY_LABEL = "All";

/** The label a rule with nothing narrowed carries. */
const ALL_EMPLOYEES_LABEL = MAPPING_TYPE_LABEL.ALL_EMPLOYEES;

/**
 * How many employees ONE bulk MANUAL grant may name.
 *
 * A bound rather than "however many the browser sent", because this endpoint
 * writes a claim, an event and a queue row per employee inside ONE
 * transaction: an unbounded list is an unbounded transaction holding
 * unbounded locks, and the operator who pasted the whole company would find
 * out by taking the mapping screen down for everybody else. Two hundred is
 * comfortably larger than any real outlet and small enough that the
 * transaction is measured in milliseconds.
 */
const BULK_GRANT_MAX = 200;

const PREVIEW_MESSAGES = {
  DIMENSION_NOT_POSITIVE: (label) => `Select a valid ${label.toLowerCase()}`,
  dimensionMissing: (label) => `That ${label.toLowerCase()} no longer exists`,
  DUPLICATE_RULE: "An identical rule is already on this group",
  NO_EMPLOYEES: "Select at least one employee",
  TOO_MANY_EMPLOYEES: `Select at most ${BULK_GRANT_MAX} employees at a time`,
  NOT_IN_SCOPE: "Some selected employees are not yours to add",
};

const MAPPING_MESSAGES = {
  UNSUPPORTED_TYPE: `Mapping Type must be one of: ${MAPPING_TYPES.join(", ")}`,
  TARGET_REQUIRED: "Select what this mapping applies to",
  TARGET_NOT_ALLOWED: "All Employees covers everybody, so it takes no target",
  TARGET_NOT_POSITIVE: "Select what this mapping applies to",
  DUPLICATE: "That mapping is already on this group",
  GROUP_NOT_FOUND: "Telegram group not found",
  MAPPING_NOT_FOUND: "Mapping not found on this Telegram group",
  targetMissing: (label) => `That ${label.toLowerCase()} no longer exists`,
  INACTIVE_GROUP_BANNER:
    "This Telegram group is inactive. Mapping configuration is preserved. No Telegram membership action will be performed.",
};

module.exports = {
  COUNTS_SCOPE,
  RULE_DIMENSIONS,
  RULE_DIMENSION,
  ANY_TARGET_ID,
  ANY_LABEL,
  ALL_EMPLOYEES_LABEL,
  BULK_GRANT_MAX,
  PREVIEW_MESSAGES,
  MAPPING_TYPE,
  MAPPING_TYPES,
  MAPPING_TYPE_LABEL,
  TARGETED_MAPPING_TYPES,
  ALL_EMPLOYEES_TARGET_ID,
  MAPPING_TARGET_SOURCE,
  TARGET_STATE,
  TARGET_WARNING,
  MAPPING_MESSAGES,
};
