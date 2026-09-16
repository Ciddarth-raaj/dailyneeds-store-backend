const { istDateOf } = require("../utils/istDate");
const { deriveMatches } = require("../utils/telegram_group_mapping");
const {
  MAPPING_TYPE,
  MAPPING_TYPES,
  MAPPING_TYPE_LABEL,
  TARGETED_MAPPING_TYPES,
  ALL_EMPLOYEES_TARGET_ID,
  TARGET_STATE,
  TARGET_WARNING,
  MAPPING_MESSAGES,
  COUNTS_SCOPE,
} = require("../constants/telegram_group_mapping");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");

/**
 * Telegram Group Mapping - WHO SHOULD BELONG TO A GROUP. Phase 3A.
 *
 * ================================= WHAT THIS FILE MUST NEVER DO ============
 *
 * It stores and reports INTENT. It adds nobody to a Telegram group, removes
 * nobody, creates no group, issues no invite link, approves no join request,
 * bans nobody and sends no message. There is no Telegram service injected
 * here AT ALL - not as an unused constructor argument, not as an import -
 * because the cheapest way to guarantee a membership call cannot appear is
 * for there to be nothing to call it on. A test asserts the diff adds none.
 *
 * ===================================== A GROUP NAME MEANS NOTHING ==========
 *
 * A group called "Cashiers" with no mappings matches NOBODY. Its category,
 * its Used For text and even the outlet on its registry row create no
 * membership intent either. Every one of those is a description somebody
 * typed for humans to read, and inferring staff from prose is how a group
 * ends up containing people nobody chose. Only a mapping row maps.
 *
 * ============ THE RULE IS GLOBAL. EVERY EMPLOYEE NUMBER IS SCOPED. =========
 *
 * A mapping row is configuration and is shown in full to anybody who may open
 * the screen: a branch manager sees that the rule is "All Employees" or
 * "Designation: Store Manager", exactly as HR does. What they do NOT see is
 * anybody else's staff, in any form.
 *
 * THAT INCLUDES COUNTS, AND THIS IS A CORRECTION. An earlier revision showed
 * the company-wide total to everybody on the grounds that a number names
 * nobody. That was wrong: "34 Store Managers company-wide, 9 of them already
 * on Telegram" is a fact about other branches' staffing, inferable one rule
 * at a time by anybody who may open this screen. The existing branch scope
 * governs which EMPLOYEES an endpoint may look at, not merely which names it
 * may print, and a count derived from employees is employee information.
 *
 * SO THE POPULATION IS NARROWED ONCE, BEFORE ANY ARITHMETIC. Everything -
 * the per-rule counts, the union, the connected count and the employee list -
 * is derived from the employees the caller may see. The forbidden total is
 * not hidden or withheld; it is never computed, so there is no path by which
 * a later change could surface it.
 */

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.name = "NotFoundError";
  err.httpCode = 404;
  return err;
}

/** A positive integer, or null. Rejects "3abc", 3.5, -1, 0, "" and objects. */
function positiveId(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "object") return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

class TelegramGroupMappingUsecase {
  /**
   * @param {object} mappingRepo    repository/telegram_group_mapping
   * @param {object} registryRepo   repository/telegram_group_registry, for the group
   * @param {object} [deps]
   * @param {() => Date} [deps.now] injected clock, so the business date is testable
   */
  constructor(mappingRepo, registryRepo, deps = {}) {
    this.repo = mappingRepo;
    this.registryRepo = registryRepo;
    this.now = deps.now || (() => new Date());
  }

  /**
   * TODAY, IN INDIA - never the host's day.
   *
   * `employedOn` compares dates, so which date it is decides whether somebody
   * who joined this morning is in a group and whether somebody who left
   * yesterday is out. Between 18:30 and midnight UTC the server's calendar
   * day is already tomorrow's in neither direction we want; `istDateOf` is
   * the same offset-on-the-epoch helper the work-shift and regularization
   * rules use, so there is one answer to "what day is it" in this backend.
   */
  businessDate() {
    return istDateOf(this.now());
  }

  async requireGroup(telegram_group_id) {
    const group = await this.registryRepo.getById(telegram_group_id);
    if (!group) throw notFound(MAPPING_MESSAGES.GROUP_NOT_FOUND);
    return group;
  }

  /**
   * THE EMPLOYEES THIS CALLER MAY SEE. The single scoping rule.
   *
   * Applied ONCE to the snapshot, before any matching, so every number in the
   * response is arithmetic over the same permitted population. One
   * derivation rather than a filter at each count is the point: four places
   * each remembering to scope is four places one can be forgotten, and the
   * one that is forgotten is a disclosure.
   *
   * FAILS CLOSED. Anything that is not ALL_BRANCHES or a usable
   * OWN_BRANCHES list yields NOTHING - not everything. An employee with no
   * branch is invisible to a branch-scoped caller, because there is no branch
   * on which they could be authorized.
   */
  static visibleEmployees(employees, scope) {
    const kind = (scope && scope.kind) || EMPLOYEE_BRANCH_SCOPE.NONE;
    if (kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) return employees || [];
    if (kind !== EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES) return [];
    const allowed = new Set((scope.store_ids || []).map(Number));
    if (allowed.size === 0) return [];
    return (employees || []).filter(
      (employee) =>
        employee.store_id !== null &&
        employee.store_id !== undefined &&
        allowed.has(Number(employee.store_id))
    );
  }

  /**
   * What the numbers in this response count, stated plainly for the screen.
   *
   * A branch-scoped caller is told `BRANCH` so the UI can say the count is
   * limited to their scope rather than presenting it as the company figure.
   * `NONE` reports `BRANCH` too: its numbers are limited as well, just to
   * nothing.
   */
  static countsScope(scope) {
    const kind = (scope && scope.kind) || EMPLOYEE_BRANCH_SCOPE.NONE;
    return kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES ? COUNTS_SCOPE.ALL : COUNTS_SCOPE.BRANCH;
  }

  /**
   * Group information for the Map screen header.
   *
   * Exactly the registry fields the approved screen shows. No chat id: the
   * mapping screen is about people, and a chat id is the one registry field
   * that is a credential-shaped identifier for the group itself.
   */
  static groupSummary(group) {
    return {
      telegram_group_id: group.telegram_group_id,
      group_name: group.group_name,
      group_type: group.group_type || null,
      category: group.category,
      used_for: group.used_for,
      outlet_id: group.outlet_id,
      outlet_name: group.outlet_name,
      bot_is_admin: Boolean(group.bot_is_admin),
      is_active: Boolean(group.is_active),
      // The banner's words live in constants so the screen does not invent
      // its own wording for a state the backend decided.
      inactive_notice: group.is_active ? null : MAPPING_MESSAGES.INACTIVE_GROUP_BANNER,
    };
  }

  /** The ids each targeted type needs resolved, grouped by type. */
  static targetIdsByType(mappings) {
    const out = {};
    for (const type of TARGETED_MAPPING_TYPES) out[type] = [];
    for (const mapping of mappings || []) {
      if (out[mapping.mapping_type]) out[mapping.mapping_type].push(mapping.target_id);
    }
    return out;
  }

  /**
   * Decorate one mapping with what its target IS right now.
   *
   * THREE OUTCOMES, AND THE THIRD IS THE ONE THAT MATTERS. Active is
   * ordinary. Inactive keeps the mapping and warns. Missing keeps the mapping
   * and warns differently - a target that has been deleted is not the same as
   * a target that is merely quiet, and a mapping is NEVER removed or hidden
   * because of either. Erasing configuration on somebody's behalf is how a
   * group silently loses a rule its owner still believes is there.
   */
  static describeTarget(mapping, resolved) {
    if (mapping.mapping_type === MAPPING_TYPE.ALL_EMPLOYEES) {
      return {
        target_name: MAPPING_TYPE_LABEL.ALL_EMPLOYEES,
        target_state: TARGET_STATE.NOT_APPLICABLE,
        target_warning: null,
      };
    }
    const found = resolved.get(mapping.mapping_type);
    const row = found ? found.get(Number(mapping.target_id)) : undefined;
    if (!row) {
      return {
        target_name: null,
        target_state: TARGET_STATE.MISSING,
        target_warning: TARGET_WARNING.MISSING,
      };
    }
    return {
      target_name: row.name,
      target_state: row.active ? TARGET_STATE.ACTIVE : TARGET_STATE.INACTIVE,
      target_warning: row.active ? null : TARGET_WARNING.INACTIVE,
    };
  }

  /**
   * THE MAP SCREEN'S READ. At most SIX bounded queries, whatever it contains:
   * the mapping rows (1), one per master actually referenced (at most 3, and
   * only for the types present), ONE employee snapshot (1) and ONE
   * active-identity read (1). Never one per mapping, never one per employee.
   *
   * EVERY COUNT HERE IS SCOPED TO THE CALLER, and comes from one snapshot and
   * one business date - both reported as `as_of_date` - so the rows cannot
   * disagree with each other or with the total. The mapping rules themselves
   * are returned in full to anybody who may open the screen; only the
   * employee arithmetic narrows.
   */
  async getMappings(telegram_group_id, { scope } = {}) {
    const group = await this.requireGroup(telegram_group_id);
    const mappings = await this.repo.getByGroup(telegram_group_id);
    const businessDate = this.businessDate();

    const [resolved, employees] = await Promise.all([
      this.repo.resolveTargets(TelegramGroupMappingUsecase.targetIdsByType(mappings)),
      this.repo.getEmployeeSnapshot(),
    ]);

    // NARROWED BEFORE ANY MATCHING. The company-wide figure is never
    // computed for a branch-scoped caller, so it cannot leak from here.
    const visible = TelegramGroupMappingUsecase.visibleEmployees(employees, scope);
    const { perMapping, union } = deriveMatches(visible, mappings, businessDate);
    const connected = await this.repo.getConnectedEmployeeIds(union);

    return {
      group: TelegramGroupMappingUsecase.groupSummary(group),
      as_of_date: businessDate,
      // What the numbers below count. The UI says so out loud rather than
      // presenting a branch figure as the company's.
      counts_scope: TelegramGroupMappingUsecase.countsScope(scope),
      mappings: mappings.map((mapping) => ({
        telegram_group_mapping_id: mapping.telegram_group_mapping_id,
        mapping_type: mapping.mapping_type,
        mapping_type_label: MAPPING_TYPE_LABEL[mapping.mapping_type] || mapping.mapping_type,
        target_id:
          mapping.mapping_type === MAPPING_TYPE.ALL_EMPLOYEES ? null : mapping.target_id,
        // The RULE, unnarrowed: a manager sees that an Outlet mapping names
        // Moolakulam even when no Moolakulam employee is theirs to count.
        ...TelegramGroupMappingUsecase.describeTarget(mapping, resolved),
        matched_employees: (perMapping.get(mapping.telegram_group_mapping_id) || []).length,
        created_at: mapping.created_at,
      })),
      // The union, deduplicated: somebody matched by three rules is one
      // person in this group.
      total_matched: union.length,
      total_connected: union.filter((id) => connected.has(id)).length,
    };
  }

  /**
   * Add a mapping.
   *
   * VALIDATION IS THE TYPE FIRST, THEN THE TARGET, and the target rules are
   * opposite for the two shapes: ALL_EMPLOYEES must NOT carry one (a client
   * sending `{ALL_EMPLOYEES, target_id: 5}` has misunderstood something, and
   * silently ignoring the 5 would store a row that does not mean what they
   * sent), and a targeted type must carry a positive id that EXISTS.
   *
   * THE EXISTENCE CHECK IS AT CREATE TIME ONLY. A target may be deleted later
   * and the mapping survives it, with a warning - that asymmetry is
   * deliberate: refusing to CREATE a rule against a target that was never
   * there is catching a mistake, while deleting a rule whose target vanished
   * afterwards is destroying a decision somebody made.
   */
  async addMapping(telegram_group_id, body = {}, actor = {}) {
    const group = await this.requireGroup(telegram_group_id);

    const type = String(body.mapping_type || "").trim();
    if (!MAPPING_TYPES.includes(type)) {
      throw validationError(MAPPING_MESSAGES.UNSUPPORTED_TYPE);
    }

    let target_id;
    if (type === MAPPING_TYPE.ALL_EMPLOYEES) {
      if (body.target_id !== undefined && body.target_id !== null && body.target_id !== "") {
        throw validationError(MAPPING_MESSAGES.TARGET_NOT_ALLOWED);
      }
      target_id = ALL_EMPLOYEES_TARGET_ID;
    } else {
      target_id = positiveId(body.target_id);
      if (target_id === null) throw validationError(MAPPING_MESSAGES.TARGET_REQUIRED);

      const resolved = await this.repo.resolveTargets({ [type]: [target_id] });
      const found = resolved.get(type);
      if (!found || !found.has(target_id)) {
        throw validationError(MAPPING_MESSAGES.targetMissing(MAPPING_TYPE_LABEL[type]));
      }
      // An INACTIVE target is allowed to be mapped: retiring a department
      // does not retire the people still assigned to it, and refusing here
      // would block the very configuration somebody needs to reach them.
    }

    const duplicate = await this.repo.findDuplicate(telegram_group_id, type, target_id);
    if (duplicate) throw validationError(MAPPING_MESSAGES.DUPLICATE);

    try {
      const created = await this.repo.create({
        telegram_group_id: group.telegram_group_id,
        mapping_type: type,
        target_id,
        created_by: actor && actor.employee_id !== undefined ? actor.employee_id : null,
      });
      return { code: 200, msg: "Mapping added", ...created };
    } catch (err) {
      // THE INDEX IS THE REAL GUARANTEE. Two requests can both pass the
      // duplicate check above in the same instant; only the UNIQUE key
      // decides, and the loser must read the same sentence as anybody else
      // rather than a driver error.
      if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
        throw validationError(MAPPING_MESSAGES.DUPLICATE);
      }
      throw err;
    }
  }

  /** Remove a mapping, which can only ever be one belonging to this group. */
  async deleteMapping(telegram_group_id, telegram_group_mapping_id) {
    await this.requireGroup(telegram_group_id);
    const id = positiveId(telegram_group_mapping_id);
    if (id === null) throw notFound(MAPPING_MESSAGES.MAPPING_NOT_FOUND);

    const result = await this.repo.delete(telegram_group_id, id);
    if (!result || !result.affectedRows) {
      throw notFound(MAPPING_MESSAGES.MAPPING_NOT_FOUND);
    }
    return { code: 200, msg: "Mapping removed" };
  }

  /**
   * THE MATCHED EMPLOYEES - the union, or one mapping's own population.
   *
   * THE COUNT AND THE LIST NOW AGREE, and both are the caller's own. There is
   * no company-wide total in this response because none is calculated: the
   * snapshot is narrowed to the employees this caller may see and everything
   * is derived from that.
   *
   * THE SCOPE COMES FROM THE SERVER'S OWN LOOKUP, never from the request. It
   * is resolved live by `middlewares/employee_branch_scope.js` from the
   * caller's current branch assignment - not from `store_id` in the JWT,
   * which is a copy taken at login that nothing refreshes, so a transferred
   * manager would keep authority over the branch they left.
   *
   * A SCOPE OF `NONE` RETURNS NOTHING AND COUNTS NOTHING. Failing closed
   * matters most in the branch a reader is least likely to test.
   */
  async getMatchedEmployees(telegram_group_id, { mapping_id, scope } = {}) {
    await this.requireGroup(telegram_group_id);
    const mappings = await this.repo.getByGroup(telegram_group_id);
    const businessDate = this.businessDate();

    let selected = mappings;
    if (mapping_id !== undefined && mapping_id !== null && mapping_id !== "") {
      const id = positiveId(mapping_id);
      // Verified to belong to THIS group, so a mapping id cannot be used to
      // read another group's population.
      const one = id === null ? null : await this.repo.getByIdForGroup(telegram_group_id, id);
      if (!one) throw notFound(MAPPING_MESSAGES.MAPPING_NOT_FOUND);
      selected = mappings.filter((m) => m.telegram_group_mapping_id === one.telegram_group_mapping_id);
    }

    const employees = await this.repo.getEmployeeSnapshot();
    const visible = TelegramGroupMappingUsecase.visibleEmployees(employees, scope);
    const { union } = deriveMatches(visible, selected, businessDate);
    const matchedIds = new Set(union);
    const connected = await this.repo.getConnectedEmployeeIds(union);

    return {
      as_of_date: businessDate,
      counts_scope: TelegramGroupMappingUsecase.countsScope(scope),
      // Scoped, like every other employee number in this phase.
      total_matched: union.length,
      employees: visible
        .filter((employee) => matchedIds.has(employee.employee_id))
        .map((employee) => TelegramGroupMappingUsecase.safeEmployee(employee, connected)),
    };
  }

  /**
   * THE ONLY EMPLOYEE FIELDS THIS PHASE EVER RETURNS.
   *
   * Built by naming what goes IN rather than deleting what must stay out. A
   * denylist has to be updated every time the employee table gains a column;
   * this cannot leak a column that did not exist when it was written. No
   * mobile, no Telegram user id, chat id or username, no Aadhaar, PAN, PF,
   * ESI, bank, salary, address, date of birth, token or token hash.
   *
   * `telegram_connected` IS A BOOLEAN AND NOTHING MORE. It answers how much
   * of this population is ready for the membership phase. It does not decide
   * whether somebody matches the mapping, and it names no Telegram account.
   */
  static safeEmployee(employee, connected) {
    return {
      employee_id: employee.employee_id,
      employee_name: employee.employee_name,
      outlet_name: employee.outlet_name,
      designation_name: employee.designation_name,
      department_name: employee.department_name,
      telegram_connected: connected.has(employee.employee_id),
    };
  }
}

module.exports = (mappingRepo, registryRepo, deps) =>
  new TelegramGroupMappingUsecase(mappingRepo, registryRepo, deps);
module.exports.TelegramGroupMappingUsecase = TelegramGroupMappingUsecase;
