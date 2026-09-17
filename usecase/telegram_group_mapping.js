const { istDateOf } = require("../utils/istDate");
const { JOB_REASON } = require("../constants/telegram_membership_claim");
const { deriveMatches, ruleOf, ruleLabel, isAllEmployees } = require("../utils/telegram_group_mapping");
const {
  TARGET_STATE,
  TARGET_WARNING,
  MAPPING_MESSAGES,
  COUNTS_SCOPE,
  RULE_DIMENSIONS,
  RULE_DIMENSION,
  ANY_TARGET_ID,
  ANY_LABEL,
  PREVIEW_MESSAGES,
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
    /** Phase 3C queue. Optional - unset, nothing is enqueued. */
    this.membershipQueue = deps.membershipQueue || null;
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
   * THREE STATES, BECAUSE TWO OF THEM RENDER AS ZERO AND MEAN DIFFERENT
   * THINGS. `BRANCH` with a count of 0 is an observation - nobody in your
   * branch matches this rule. `NONE` with a count of 0 is not an observation
   * about anybody: nothing was counted, because the caller has no employee
   * record, no branch, an inactive record, no session, or the resolver never
   * ran. Telling somebody "0 employees in your branch match" when the truth
   * is "we could not look" invents a finding out of a failure, and invites
   * them to delete a rule that is working.
   *
   * AN OWN_BRANCHES SCOPE WITH NO USABLE BRANCH IDS IS `NONE`, not `BRANCH`.
   * It cannot be a branch answer, because there is no branch.
   *
   * This mirrors `visibleEmployees` exactly - the same three cases in the
   * same order - so the label can never describe a different rule from the
   * one that produced the numbers.
   */
  static countsScope(scope) {
    const kind = (scope && scope.kind) || EMPLOYEE_BRANCH_SCOPE.NONE;
    if (kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) return COUNTS_SCOPE.ALL;
    if (kind !== EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES) return COUNTS_SCOPE.NONE;
    const usable = (scope.store_ids || []).map(Number).filter((id) => Number.isInteger(id));
    return usable.length > 0 ? COUNTS_SCOPE.BRANCH : COUNTS_SCOPE.NONE;
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

  /**
   * The ids each DIMENSION needs resolved, grouped by dimension.
   *
   * Only narrowed dimensions contribute, so a group whose rules all leave
   * department unrestricted costs no department query at all - the same
   * "one read per master actually referenced" bound the single-dimension
   * screen had, now counted per dimension instead of per type.
   */
  static ruleTargetIds(mappings) {
    const out = {};
    for (const dimension of RULE_DIMENSIONS) out[dimension] = [];
    for (const mapping of mappings || []) {
      const rule = ruleOf(mapping);
      for (const dimension of RULE_DIMENSIONS) {
        if (rule[dimension] > ANY_TARGET_ID) out[dimension].push(rule[dimension]);
      }
    }
    return out;
  }

  /**
   * Decorate ONE dimension of a rule with what its target IS right now.
   *
   * Unrestricted is a fourth answer and not a missing one: `NOT_APPLICABLE`
   * with the label "All". The other three are the states the single-dimension
   * screen already had, and they still mean what they meant - a target that
   * is merely retired and a target that has been deleted look different, and
   * NEITHER removes or hides the rule. Erasing configuration on somebody's
   * behalf is how a group silently loses a rule its owner still believes is
   * there.
   */
  static describeDimension(dimension, id, resolved) {
    const meta = RULE_DIMENSION[dimension];
    if (!id || id === ANY_TARGET_ID) {
      return {
        dimension,
        label: meta.label,
        id: null,
        name: ANY_LABEL,
        state: TARGET_STATE.NOT_APPLICABLE,
        warning: null,
      };
    }
    const found = resolved.get(dimension);
    const row = found ? found.get(Number(id)) : undefined;
    if (!row) {
      return {
        dimension,
        label: meta.label,
        id,
        name: null,
        state: TARGET_STATE.MISSING,
        warning: TARGET_WARNING.MISSING,
      };
    }
    return {
      dimension,
      label: meta.label,
      id,
      name: row.name,
      state: row.active ? TARGET_STATE.ACTIVE : TARGET_STATE.INACTIVE,
      warning: row.active ? null : TARGET_WARNING.INACTIVE,
    };
  }

  /**
   * THE WHOLE RULE, described: one entry per dimension plus a sentence.
   *
   * The screen renders the three entries as columns and the sentence as the
   * row's title, and both come from the same resolution pass so they cannot
   * disagree about whether an outlet still exists.
   */
  static describeRule(mapping, resolved) {
    const rule = ruleOf(mapping);
    const dimensions = RULE_DIMENSIONS.map((dimension) =>
      TelegramGroupMappingUsecase.describeDimension(dimension, rule[dimension], resolved)
    );
    const warnings = dimensions.map((d) => d.warning).filter(Boolean);
    return {
      rule: RULE_DIMENSIONS.reduce((acc, dimension) => {
        acc[RULE_DIMENSION[dimension].field] =
          rule[dimension] === ANY_TARGET_ID ? null : rule[dimension];
        return acc;
      }, {}),
      rule_dimensions: dimensions,
      rule_label: ruleLabel(mapping, resolved),
      is_all_employees: isAllEmployees(mapping),
      // Kept singular so the existing row renderer keeps working: the FIRST
      // problem is the one shown beside the rule, and every one of them is in
      // `rule_dimensions` for a screen that wants all three.
      target_warning: warnings.length ? warnings[0] : null,
    };
  }

  /**
   * VALIDATE A SUBMITTED RULE, dimension by dimension, and return the stored
   * shape.
   *
   * EACH DIMENSION IS INDEPENDENTLY OPTIONAL. Absent, null and empty string
   * all mean "All" - the screen's own dropdown sends an empty value for it -
   * and all three absent is the rule that means everybody, which is exactly
   * what the legacy ALL_EMPLOYEES row migrated to. There is no separate
   * "select a type" step to get wrong any more.
   *
   * A NARROWED DIMENSION MUST NAME SOMETHING THAT EXISTS, and that check is
   * at CREATE TIME ONLY - the same asymmetry the single-dimension screen had.
   * Refusing to create a rule against a target that was never there catches a
   * mistake; deleting a rule whose target vanished afterwards destroys a
   * decision somebody made.
   *
   * AN INACTIVE TARGET IS ALLOWED. Retiring a department does not retire the
   * people still assigned to it, and refusing here would block the very
   * configuration somebody needs to reach them.
   */
  async validateRule(body = {}) {
    return (await this.validateRuleResolved(body)).rule;
  }

  /**
   * The same validation, but handing back the RESOLUTION it already did.
   *
   * The preview needs both the stored rule and the names of its targets, and
   * resolving twice is a second round trip whose answer could differ from the
   * first - so the rule the preview describes could name an outlet the rule
   * it validated did not. One pass, one answer.
   */
  async validateRuleResolved(body = {}) {
    const wanted = {};
    for (const dimension of RULE_DIMENSIONS) {
      const meta = RULE_DIMENSION[dimension];
      const raw = body[meta.field];
      if (raw === undefined || raw === null || raw === "") {
        wanted[dimension] = ANY_TARGET_ID;
        continue;
      }
      const id = positiveId(raw);
      if (id === null) {
        throw validationError(PREVIEW_MESSAGES.DIMENSION_NOT_POSITIVE(meta.label));
      }
      wanted[dimension] = id;
    }

    const toResolve = {};
    for (const dimension of RULE_DIMENSIONS) {
      if (wanted[dimension] > ANY_TARGET_ID) toResolve[dimension] = [wanted[dimension]];
    }
    const resolved =
      Object.keys(toResolve).length > 0 ? await this.repo.resolveTargets(toResolve) : new Map();
    for (const dimension of Object.keys(toResolve)) {
      const found = resolved.get(dimension);
      if (!found || !found.has(wanted[dimension])) {
        throw validationError(PREVIEW_MESSAGES.dimensionMissing(RULE_DIMENSION[dimension].label));
      }
    }

    // The stored shape, keyed by column, which is also the shape `ruleOf`
    // reads - so what is validated and what is matched are one object.
    const stored = {};
    for (const dimension of RULE_DIMENSIONS) {
      stored[RULE_DIMENSION[dimension].column] = wanted[dimension];
    }
    return { rule: stored, resolved };
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
      this.repo.resolveTargets(TelegramGroupMappingUsecase.ruleTargetIds(mappings)),
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
        // The RULE, unnarrowed: a manager sees that a rule names Moolakulam
        // even when no Moolakulam employee is theirs to count.
        ...TelegramGroupMappingUsecase.describeRule(mapping, resolved),
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
   * Add a mapping - ONE composite rule.
   *
   * There is no type to choose any more. The body carries up to three
   * optional dimensions; `validateRule` owns every refusal, so this method is
   * the transaction and nothing else, and the rule that decides what is valid
   * is the same one the preview already showed the operator.
   *
   * THE RULE THAT NARROWS NOTHING IS ALLOWED, because that is "All
   * Employees" - the thing the old ALL_EMPLOYEES type meant - and it is
   * guarded against being added twice by the same UNIQUE key as every other
   * rule rather than by a sentinel of its own.
   */
  async addMapping(telegram_group_id, body = {}, actor = {}) {
    const group = await this.requireGroup(telegram_group_id);
    const rule = await this.validateRule(body);

    const duplicate = await this.repo.findDuplicateRule(telegram_group_id, rule);
    if (duplicate) throw validationError(PREVIEW_MESSAGES.DUPLICATE_RULE);

    try {
      // ONE TRANSACTION, Phase 3C. The mapping and the reconciliation job it
      // creates commit together: a mapping that exists always has its work
      // queued, and a mapping that rolled back queued none. No Telegram call
      // happens here - the queue row is a local write and the worker does
      // the rest afterwards.
      const created = await this.repo.withTransaction(async (tx) => {
        const row = await this.repo.create(
          {
            telegram_group_id: group.telegram_group_id,
            rule,
            created_by: actor && actor.employee_id !== undefined ? actor.employee_id : null,
          },
          { tx }
        );
        await this._enqueueGroup(tx, group.telegram_group_id, JOB_REASON.MAPPING_ADDED, actor);
        return row;
      });
      return { code: 200, msg: "Mapping added", ...created };
    } catch (err) {
      // THE INDEX IS THE REAL GUARANTEE. Two requests can both pass the
      // duplicate check above in the same instant; only `uq_tgm_group_rule`
      // decides, and the loser must read the same sentence as anybody else
      // rather than a driver error.
      if (err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)) {
        throw validationError(PREVIEW_MESSAGES.DUPLICATE_RULE);
      }
      throw err;
    }
  }

  /**
   * Phase 3C enqueue, in the caller's transaction. Skipped entirely when no
   * queue is wired, which is how the mapping screens behave exactly as they
   * did before Phase 3C until it is switched on.
   */
  async _enqueueGroup(tx, telegramGroupId, reason, actor = null) {
    if (!this.membershipQueue) return;
    await this.membershipQueue.enqueueGroup(
      telegramGroupId,
      reason,
      { enqueuedBy: actor && actor.employee_id !== undefined ? actor.employee_id : null },
      { tx }
    );
  }

  /** Remove a mapping, which can only ever be one belonging to this group. */
  async deleteMapping(telegram_group_id, telegram_group_mapping_id) {
    await this.requireGroup(telegram_group_id);
    const id = positiveId(telegram_group_mapping_id);
    if (id === null) throw notFound(MAPPING_MESSAGES.MAPPING_NOT_FOUND);

    const result = await this.repo.withTransaction(async (tx) => {
      const deleted = await this.repo.delete(telegram_group_id, id, { tx });
      if (!deleted || !deleted.affectedRows) return deleted;
      // Removing a rule is how people stop being required to be in a group,
      // so this is the change that can lead to a removal. Queued with it.
      await this._enqueueGroup(tx, telegram_group_id, JOB_REASON.MAPPING_REMOVED);
      return deleted;
    });
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
   * PREVIEW - who a rule WOULD cover, before anybody saves it.
   *
   * This is the multi-level screen's whole point: you narrow Outlet, then
   * Department, then Designation, and the list under the form answers "who is
   * that" at every step. Saving a rule you have not seen the population of is
   * how a group ends up containing people nobody chose.
   *
   * IT MAKES NO TELEGRAM CALL AND WRITES NOTHING. Not one request to
   * Telegram, not a row, not a claim. It is arithmetic over the same employee
   * snapshot and the same `employedOn()` rule the saved rules use - so the
   * number under the form and the number on the row afterwards are produced
   * by the same code from the same snapshot, and cannot disagree.
   *
   * THE SCOPE IS THE CALLER'S, resolved server-side, and it FAILS CLOSED.
   * There is no branch parameter to send. A `NONE` scope returns no names and
   * counts nothing, so a wiring mistake cannot publish the staff list.
   *
   * `search` NARROWS WHAT IS SHOWN, NEVER WHAT IS COUNTED. `total_matched` is
   * the rule's population; typing in the search box must not make the
   * operator believe the rule got smaller.
   *
   * THE FIELDS ARE `safeEmployee`'s and nothing else - no salary, no Aadhaar,
   * no bank, no mobile, no Telegram user id, chat id or username.
   * `telegram_connected` is a boolean and answers only how much of this
   * population is ready for the membership phase.
   */
  async previewEmployees(telegram_group_id, { scope, search, ...body } = {}) {
    await this.requireGroup(telegram_group_id);
    // ONE resolution pass, reused for the description below.
    const { rule, resolved } = await this.validateRuleResolved(body);
    const businessDate = this.businessDate();

    const employees = await this.repo.getEmployeeSnapshot();

    const visible = TelegramGroupMappingUsecase.visibleEmployees(employees, scope);
    const { union } = deriveMatches(visible, [rule], businessDate);
    const matchedIds = new Set(union);
    const connected = await this.repo.getConnectedEmployeeIds(union);

    const needle = String(search === undefined || search === null ? "" : search)
      .trim()
      .toLowerCase();
    const matched = visible.filter((employee) => matchedIds.has(employee.employee_id));
    const shown = needle
      ? matched.filter((employee) =>
          String(employee.employee_name || "").toLowerCase().includes(needle)
        )
      : matched;

    return {
      as_of_date: businessDate,
      counts_scope: TelegramGroupMappingUsecase.countsScope(scope),
      ...TelegramGroupMappingUsecase.describeRule(rule, resolved),
      // The RULE's population, unaffected by the search box.
      total_matched: union.length,
      total_connected: union.filter((id) => connected.has(id)).length,
      // Whether an identical rule already exists, so the screen can say so
      // before the operator presses Save rather than after.
      duplicate_rule: Boolean(await this.repo.findDuplicateRule(telegram_group_id, rule)),
      employees: shown.map((employee) =>
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
