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
 * their own branch scope, so every employee-derived number - the per-rule
 * count, the union, the connected count and the list - counts only those.
 *
 * IT REPLACES `scope_limited`, WHICH ANSWERED A QUESTION NOBODY MAY ASK ANY
 * MORE. That flag meant "your list is smaller than the company-wide total",
 * which required computing a company-wide total for somebody not entitled to
 * one. This says what the numbers ARE rather than what they are not, and it
 * needs no forbidden figure to derive.
 */
const COUNTS_SCOPE = {
  ALL: "ALL",
  BRANCH: "BRANCH",
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
