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
 * ================================== COUNTS ARE GLOBAL, NAMES ARE NOT =======
 *
 * The matched count is a company-wide fact about the configuration, and it is
 * the same number for everybody: a store manager checking whether an Outlet
 * rule is right needs to know it covers 34 people, and a number discloses
 * nobody. The NAMES behind it obey the existing employee branch scope, live -
 * so the same screen can honestly say "34 match, 12 are visible to you"
 * rather than either lying about the total or listing the company.
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
   * THE MAP SCREEN'S ONE READ.
   *
   * Four bounded queries: the mappings, the referenced masters, the employee
   * snapshot, and - only when employees matched - the Telegram identities.
   * Never one per mapping, never one per employee.
   *
   * Every count in this response comes from ONE snapshot and ONE business
   * date, both reported as `as_of_date`, so the rows cannot disagree with
   * each other or with the total.
   */
  async getMappings(telegram_group_id) {
    const group = await this.requireGroup(telegram_group_id);
    const mappings = await this.repo.getByGroup(telegram_group_id);
    const businessDate = this.businessDate();

    const [resolved, employees] = await Promise.all([
      this.repo.resolveTargets(TelegramGroupMappingUsecase.targetIdsByType(mappings)),
      this.repo.getEmployeeSnapshot(),
    ]);

    const { perMapping, union } = deriveMatches(employees, mappings, businessDate);
    const connected = await this.repo.getConnectedEmployeeIds(union);

    return {
      group: TelegramGroupMappingUsecase.groupSummary(group),
      as_of_date: businessDate,
      mappings: mappings.map((mapping) => ({
        telegram_group_mapping_id: mapping.telegram_group_mapping_id,
        mapping_type: mapping.mapping_type,
        mapping_type_label: MAPPING_TYPE_LABEL[mapping.mapping_type] || mapping.mapping_type,
        target_id:
          mapping.mapping_type === MAPPING_TYPE.ALL_EMPLOYEES ? null : mapping.target_id,
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
   * `total_matched` IS COMPANY-WIDE AND IDENTICAL FOR EVERY CALLER. Only the
   * rows are scoped. That split is the whole design: the count answers "is
   * this rule right", which needs the truth, and the list answers "who are
   * they", which is where an employee's name actually gets disclosed.
   *
   * THE SCOPE COMES FROM THE SERVER'S OWN LOOKUP, never from the request. It
   * is resolved live by `middlewares/employee_branch_scope.js` from the
   * caller's current branch assignment - not from `store_id` in the JWT,
   * which is a copy taken at login that nothing refreshes, so a transferred
   * manager would keep authority over the branch they left.
   *
   * A SCOPE OF `NONE` RETURNS NO ROWS - never all of them. Failing closed
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
    const { union } = deriveMatches(employees, selected, businessDate);
    const matchedIds = new Set(union);

    const connected = await this.repo.getConnectedEmployeeIds(union);

    const kind = (scope && scope.kind) || EMPLOYEE_BRANCH_SCOPE.NONE;
    const allowedBranches =
      kind === EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES
        ? new Set((scope.store_ids || []).map(Number))
        : null;

    const visible = employees.filter((employee) => {
      if (!matchedIds.has(employee.employee_id)) return false;
      if (kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) return true;
      if (kind !== EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES) return false;
      return employee.store_id !== null && allowedBranches.has(Number(employee.store_id));
    });

    return {
      as_of_date: businessDate,
      // Company-wide. Identical for a store manager and for HR.
      total_matched: union.length,
      visible_count: visible.length,
      scope_limited: visible.length !== union.length,
      employees: visible.map((employee) =>
        TelegramGroupMappingUsecase.safeEmployee(employee, connected)
      ),
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
