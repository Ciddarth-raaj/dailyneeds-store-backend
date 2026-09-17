const logger = require("../utils/logger");
const { employedOn } = require("../utils/attendance_eligibility");
const { istDateOf } = require("../utils/istDate");
const { matchesDimension } = require("../utils/telegram_group_mapping");
const { isTelegramMember } = require("../utils/telegram_membership");
const { removalReadiness, canRemove, REMOVAL_READINESS } = require("../utils/telegram_removal_readiness");
const {
  ACTION,
  decideGroup,
  endEmployment,
  removalWanted,
} = require("../utils/telegram_membership_reconcile");
const {
  TelegramMembershipRetryableError,
  retryAfterOf,
} = require("../utils/telegram_membership_errors");
const {
  REMOVAL_OUTCOME,
  CLAIM_SOURCE,
  CLAIM_STATE,
  CLOSE_OUTCOME,
  INTENT_REASON,
  MEMBERSHIP_EVENT,
  DETAIL_CODE,
  REMOVAL_REFUSAL,
} = require("../constants/telegram_membership_claim");

/**
 * RECONCILING MANAGED TELEGRAM MEMBERSHIP. Phase 3C.
 *
 * RECONCILIATION, NOT EVENT HANDLING - the same discipline C1c's employment
 * reconciler uses, for the same reasons. A job says "recompute employee 42";
 * what 42 looks like is read HERE, when the job runs. A job that waited an
 * hour behind a rate limit therefore reconciles what is true now, a second
 * delivery finds nothing to do, and an interrupted run is repaired by
 * running it again.
 *
 * ============================= TWO HALVES, DELIBERATELY SEPARATED ==========
 *
 *   CLAIMS are local truth and are maintained WHETHER OR NOT TELEGRAM CAN BE
 *   REACHED. Mapping says this person belongs in that group: that fact does
 *   not depend on an API being up, and making it depend on one would mean an
 *   outage quietly unmanaging people.
 *
 *   TELEGRAM WORK happens afterwards, outside every transaction, and only
 *   decides two things: whether somebody already in a group can be adopted,
 *   and whether somebody nobody claims any more is removed.
 *
 * ================================= WHAT THIS PHASE STILL CANNOT DO =========
 *
 * IT CANNOT ADD ANYBODY TO A GROUP. No Bot API method exists for it - a bot
 * cannot put a user in a chat, only invite them. So an ACTIVE claim for
 * somebody not yet in the group is not an action here; it is Phase 3B's join
 * flow, unchanged, with its seven-check approval. Phase 3C never sends an
 * invite link by itself either.
 */
class TelegramMembershipReconcileUsecase {
  /**
   * @param {object} deps
   * @param {object} deps.claimRepo      managed claims + typed events
   * @param {object} deps.jobRepo        the queue (for follow-up enqueues only)
   * @param {object} deps.mappingRepo    Phase 3A - mappings and employee facts
   * @param {object} deps.registryRepo   the group registry (chat ids)
   * @param {object} deps.identityRepo   Phase 2 - Telegram identities
   * @param {object} deps.telegram       the Telegram service
   * @param {object} deps.config         {removalsEnabled, removalCapPerTick, ...}
   * @param {function} deps.now
   */
  constructor({
    claimRepo,
    jobRepo,
    mappingRepo,
    registryRepo,
    identityRepo,
    telegram,
    config = {},
    now,
  } = {}) {
    this.claimRepo = claimRepo;
    this.registryRepo = registryRepo;
    this.jobRepo = jobRepo;
    this.mappingRepo = mappingRepo;
    this.identityRepo = identityRepo;
    this.telegram = telegram;
    this.config = config;
    this.now = typeof now === "function" ? now : () => new Date();
  }

  _log(level, code, description, ref = {}) {
    logger.Log({
      level,
      component: "USECASE.TELEGRAM_MEMBERSHIP_RECONCILE",
      code: `USECASE.TELEGRAM_MEMBERSHIP_RECONCILE.${code}`,
      description,
      category: "",
      ref,
    });
  }

  businessDate() {
    return istDateOf(this.now());
  }

  /* ===================================================== derivation ===== */

  /**
   * THE RULE SIDE, from Phase 3A's matcher and nothing else.
   *
   * Deliberately NOT `requiredGroups()`: that now unions MANUAL claims so
   * Phase 3B can show them, and feeding it back in here would make a manual
   * grant look like a rule match and keep re-opening a RULE claim nobody
   * asked for.
   */
  async ruleGroups(employee) {
    if (!employee) return new Map();
    if (!employedOn(employee, this.businessDate())) return new Map();
    const mappings = await this.mappingRepo.getAllMappingsWithGroups();
    const byGroup = new Map();
    for (const mapping of mappings) {
      if (!matchesDimension(employee, mapping)) continue;
      if (!byGroup.has(mapping.telegram_group_id)) {
        byGroup.set(Number(mapping.telegram_group_id), mapping.group);
      }
    }
    return byGroup;
  }

  /** Groups that carry at least one mapping - part of "employee-managed". */
  async mappedGroups() {
    const mappings = await this.mappingRepo.getAllMappingsWithGroups();
    const byGroup = new Map();
    for (const mapping of mappings) {
      byGroup.set(Number(mapping.telegram_group_id), mapping.group);
    }
    return byGroup;
  }

  static _claimsByGroup(claims) {
    const map = new Map();
    for (const claim of claims) {
      const key = Number(claim.telegram_group_id);
      if (!map.has(key)) map.set(key, {});
      map.get(key)[claim.source] = claim;
    }
    return map;
  }

  /* ================================================ employee scope ====== */

  /**
   * ONE EMPLOYEE, EVERY GROUP THAT CONCERNS THEM.
   *
   * @returns a summary the worker turns into a job outcome.
   */
  async reconcileEmployee(employeeId, { jobId = null, budget = null } = {}) {
    const employee = await this.mappingRepo.getEmployeeForMatching(employeeId);
    if (!employee) {
      return { employeeId, skipped: "UNKNOWN_EMPLOYEE", claimsChanged: 0, removals: [] };
    }

    const employed = employedOn(employee, this.businessDate());
    const claims = await this.claimRepo.getForEmployee(employeeId);

    const claimsChanged = employed
      ? await this._applyEmployedClaims(employeeId, employee, claims, jobId)
      : await this._applyEndedClaims(employeeId, claims, jobId);

    // Re-read: the decisions above are what the Telegram half acts on, and
    // reading them back means it acts on what was actually committed rather
    // than on what was intended.
    const after = await this.claimRepo.getForEmployee(employeeId);
    const telegram = await this._telegramPass(employeeId, after, {
      jobId,
      budget,
      includeUnclaimedManagedGroups: !employed,
    });

    // THE CLAIMS ARE ALREADY COMMITTED, so raising here loses nothing and
    // costs nothing to repeat: the next attempt re-reads truth and finds the
    // claim work done. What it buys is that the QUEUE knows this job did not
    // finish - it retries, backs off, and ends in the dead-letter list where
    // somebody can see it, instead of being marked SUCCEEDED over a person
    // still sitting in a group they were removed from on paper.
    if (telegram.retryable) throw telegram.retryable;

    return { employeeId, employed, claimsChanged, ...telegram };
  }

  /** Employed: RULE follows the mappings, MANUAL is left to people. */
  async _applyEmployedClaims(employeeId, employee, claims, jobId) {
    const desired = await this.ruleGroups(employee);
    const byGroup = TelegramMembershipReconcileUsecase._claimsByGroup(claims);
    const groupIds = new Set([...desired.keys()]);
    for (const [groupId, pair] of byGroup) {
      const live =
        (pair.RULE && pair.RULE.state !== CLAIM_STATE.CLOSED) ||
        (pair.MANUAL && pair.MANUAL.state !== CLAIM_STATE.CLOSED);
      if (live) groupIds.add(groupId);
    }

    let changed = 0;
    for (const groupId of groupIds) {
      const pair = byGroup.get(groupId) || {};
      const decisions = decideGroup({
        ruleClaim: pair.RULE || null,
        manualClaim: pair.MANUAL || null,
        ruleDesired: desired.has(groupId),
        reason: INTENT_REASON.RULE_NO_LONGER_MATCHES,
      });
      for (const decision of decisions) {
        changed += await this._applyDecision(employeeId, groupId, decision, jobId);
      }
    }
    return changed;
  }

  /**
   * NOT EMPLOYED: every source ends, MANUAL included.
   *
   * This is the one path that closes a manual grant without a human, and it
   * is deliberate - a grant says "this person, in this job". There is no
   * partner source to retain them, because every partner is ending too, so
   * the retained-by-other-source rule cannot fire here.
   */
  async _applyEndedClaims(employeeId, claims, jobId) {
    let changed = 0;
    for (const decision of endEmployment(claims)) {
      changed += await this._applyDecision(
        employeeId,
        decision.telegram_group_id,
        decision,
        jobId,
        DETAIL_CODE.EMPLOYMENT_ENDED
      );
    }
    return changed;
  }

  async _applyDecision(employeeId, groupId, decision, jobId, detailCode = null) {
    const base = { employeeId, telegramGroupId: groupId, source: decision.source };
    if (decision.action === ACTION.OPEN) {
      const res = await this.claimRepo.open(base);
      if (res.changed) {
        await this.claimRepo.recordEvent({
          ...base,
          eventType: res.reopened ? MEMBERSHIP_EVENT.CLAIM_REOPENED : MEMBERSHIP_EVENT.CLAIM_OPENED,
          detailCode: detailCode || DETAIL_CODE.RULE_MATCHED,
          jobId,
        });
      }
      return res.changed ? 1 : 0;
    }
    if (decision.action === ACTION.CANCEL_REMOVAL) {
      const res = await this.claimRepo.cancelRemoval(base);
      if (res.changed) {
        await this.claimRepo.recordEvent({
          ...base,
          eventType: MEMBERSHIP_EVENT.CLAIM_REMOVAL_CANCELLED,
          detailCode: DETAIL_CODE.ELIGIBILITY_RETURNED,
          jobId,
        });
      }
      return res.changed ? 1 : 0;
    }
    if (decision.action === ACTION.REQUEST_REMOVAL) {
      const res = await this.claimRepo.requestRemoval({
        ...base,
        intentReason: decision.intent_reason,
      });
      if (res.changed) {
        await this.claimRepo.recordEvent({
          ...base,
          eventType: MEMBERSHIP_EVENT.CLAIM_REMOVAL_REQUESTED,
          detailCode: detailCode || DETAIL_CODE.RULE_UNMATCHED,
          jobId,
        });
      }
      return res.changed ? 1 : 0;
    }
    if (decision.action === ACTION.CLOSE_RETAINED) {
      // NOBODY IS REMOVED HERE, and that is the whole point: the other
      // source still wants them in the group, so this source simply stops
      // claiming them. No Telegram call is made on this path at all.
      const res = await this.claimRepo.close({
        ...base,
        closeOutcome: CLOSE_OUTCOME.RETAINED_BY_OTHER_SOURCE,
        intentReason: INTENT_REASON.RETAINED_BY_OTHER_SOURCE,
        fromStates: [CLAIM_STATE.ACTIVE, CLAIM_STATE.REMOVAL_PENDING],
      });
      if (res.changed) {
        await this.claimRepo.recordEvent({
          ...base,
          eventType: MEMBERSHIP_EVENT.CLAIM_CLOSED,
          detailCode: DETAIL_CODE.RETAINED_BY_OTHER_SOURCE,
          jobId,
        });
      }
      return res.changed ? 1 : 0;
    }
    return 0;
  }

  /* ================================================ Telegram pass ======= */

  /**
   * THE ONLY PLACE THIS PHASE TALKS TO TELEGRAM, and it runs outside every
   * transaction.
   *
   * Adoption asks Telegram LIVE and never reads the verification cache: that
   * cache is explicitly last-verified rather than authoritative, and
   * adopting from it would record "they were already in" on the strength of
   * something nobody checked today.
   */
  async _telegramPass(employeeId, claims, { jobId, budget, includeUnclaimedManagedGroups }) {
    const removals = [];
    const adopted = [];
    const skipped = [];
    let capReached = false;
    let deferred = false;
    let retryable = null;

    const identities = await this._identities(employeeId);
    const active = identities.find((i) => !i.disconnected_at) || null;

    const byGroup = TelegramMembershipReconcileUsecase._claimsByGroup(claims);
    const targets = new Map();

    for (const [groupId, pair] of byGroup) {
      const wantsRemoval = removalWanted({
        ruleClaim: pair.RULE || null,
        manualClaim: pair.MANUAL || null,
      });
      const hasActive =
        (pair.RULE && pair.RULE.state === CLAIM_STATE.ACTIVE) ||
        (pair.MANUAL && pair.MANUAL.state === CLAIM_STATE.ACTIVE);
      if (wantsRemoval) targets.set(groupId, { remove: true, pair });
      else if (hasActive) targets.set(groupId, { remove: false, pair });
    }

    // EMPLOYMENT ENDED REACHES FURTHER THAN THE CLAIMS. A group we never
    // claimed can still hold somebody who has left, and leaving them there
    // is the one case where "we did not manage this" is not a good enough
    // answer. During ordinary employment the opposite rule holds and an
    // unclaimed membership is never touched.
    if (includeUnclaimedManagedGroups) {
      for (const [groupId, group] of await this.mappedGroups()) {
        if (!targets.has(groupId)) targets.set(groupId, { remove: true, pair: {}, group });
      }
    }

    for (const [groupId, target] of targets) {
      if (!target.remove) {
        if (!active) continue;
        const adoptedHere = await this._tryAdopt(employeeId, groupId, target.pair, active, jobId, budget);
        if (adoptedHere) adopted.push(groupId);
        continue;
      }

      const result = await this._removeFromGroup(employeeId, groupId, identities, jobId, budget);
      switch (result.outcome) {
        case REMOVAL_OUTCOME.REMOVED:
        case REMOVAL_OUTCOME.ALREADY_ABSENT:
          removals.push(groupId);
          break;
        case REMOVAL_OUTCOME.CAPPED:
          capReached = true;
          skipped.push({ telegram_group_id: groupId, reason: REMOVAL_REFUSAL.CAP_REACHED });
          break;
        case REMOVAL_OUTCOME.DEFERRED:
          deferred = true;
          skipped.push({ telegram_group_id: groupId, reason: result.reason });
          break;
        default:
          // RETRYABLE. The FIRST failure is kept and raised once the whole
          // pass has finished: every other group still gets its chance, and
          // the claims already written stay written - the job simply is not
          // finished, which is exactly what the queue is for.
          retryable = retryable || result.error || new Error("removal failed");
          skipped.push({ telegram_group_id: groupId, reason: result.reason });
          break;
      }
    }

    return { removals, adopted, skipped, capReached, deferred, retryable };
  }

  async _identities(employeeId) {
    if (typeof this.identityRepo.getAllIdentitiesForEmployee === "function") {
      return (await this.identityRepo.getAllIdentitiesForEmployee(employeeId)) || [];
    }
    const active = await this.identityRepo.getActiveIdentityByEmployee(employeeId);
    return active ? [active] : [];
  }

  /**
   * ALREADY IN THE GROUP? Then the claim is satisfied and we say so once.
   * Absent is not a failure and not an action: joining is Phase 3B's flow.
   */
  async _tryAdopt(employeeId, groupId, pair, identity, jobId, budget) {
    const claim = pair.RULE && pair.RULE.state === CLAIM_STATE.ACTIVE ? pair.RULE : pair.MANUAL;
    if (!claim || claim.adopted_from_existing_member) return false;
    const group = await this._group(groupId);
    if (!group) return false;
    if (budget && budget.spend && !budget.spend(1)) return false;
    try {
      const member = await this.telegram.getChatMember(group.chat_id, Number(identity.telegram_user_id));
      if (!isTelegramMember(member)) return false;
      await this.claimRepo.markAdopted({
        employeeId,
        telegramGroupId: groupId,
        source: claim.source,
      });
      await this.claimRepo.recordEvent({
        employeeId,
        telegramGroupId: groupId,
        source: claim.source,
        employeeTelegramId: identity.employee_telegram_id,
        eventType: MEMBERSHIP_EVENT.ADOPTED,
        detailCode: DETAIL_CODE.ALREADY_IN_GROUP,
        jobId,
      });
      return true;
    } catch (err) {
      this._log(logger.LEVEL.WARN, "ADOPT", `could not confirm membership: ${err.toString()}`, {
        telegram_group_id: groupId,
        employee_id: employeeId,
      });
      return false;
    }
  }

  /**
   * REMOVE EVERY IDENTITY THIS EMPLOYEE HAS FROM ONE GROUP.
   *
   * Every identity, because the account somebody reconnected away from is
   * still in the groups it joined; and a guard before each historical one,
   * because a Telegram account can be re-used by a different employee later
   * and removing "their old account" would then remove SOMEBODY ELSE.
   */
  async _removeFromGroup(employeeId, groupId, identities, jobId, budget) {
    if (!this.config.removalsEnabled) {
      // DELIBERATELY OFF, so this is not a failure and must burn no retry -
      // but the work is NOT done, and the job must not report that it is.
      await this.claimRepo.recordEvent({
        employeeId,
        telegramGroupId: groupId,
        eventType: MEMBERSHIP_EVENT.SKIPPED_NOT_READY,
        detailCode: DETAIL_CODE.REMOVAL_DISABLED,
        jobId,
      });
      return { outcome: REMOVAL_OUTCOME.DEFERRED, reason: REMOVAL_REFUSAL.REMOVAL_DISABLED };
    }
    if (!identities.length) {
      // Nobody to remove: there is no Telegram account to act on. Retrying
      // cannot fix it, so it is deferred rather than failed - and it is not
      // reported as cleanup either, because none happened.
      await this.claimRepo.recordEvent({
        employeeId,
        telegramGroupId: groupId,
        eventType: MEMBERSHIP_EVENT.SKIPPED_NO_IDENTITY,
        jobId,
      });
      return { outcome: REMOVAL_OUTCOME.DEFERRED, reason: REMOVAL_REFUSAL.NO_IDENTITY };
    }

    // THE CAP IS CHECKED BEFORE THE GROUP IS TOUCHED, not after. Starting a
    // removal we cannot finish spends Telegram calls to achieve nothing.
    if (budget && typeof budget.removalsLeft === "number" && budget.removalsLeft <= 0) {
      await this.claimRepo.recordEvent({
        employeeId,
        telegramGroupId: groupId,
        eventType: MEMBERSHIP_EVENT.SKIPPED_NOT_READY,
        detailCode: DETAIL_CODE.REMOVAL_CAP_REACHED,
        jobId,
      });
      return { outcome: REMOVAL_OUTCOME.CAPPED, reason: REMOVAL_REFUSAL.CAP_REACHED };
    }

    const group = await this._group(groupId);
    if (!group) {
      return {
        outcome: REMOVAL_OUTCOME.RETRYABLE,
        reason: REMOVAL_REFUSAL.NOT_READY,
        error: new TelegramMembershipRetryableError("the group could not be read", {
          code: "GROUP_NOT_READABLE",
        }),
      };
    }

    // REGISTRY `is_active` IS NOT CONSULTED. Retiring a group must not strand
    // the people inside it - that is exactly when cleanup matters most.
    const readiness = await this._removalReadiness(group, budget);
    if (readiness.status === REMOVAL_READINESS.CAPPED) {
      return { outcome: REMOVAL_OUTCOME.CAPPED, reason: REMOVAL_REFUSAL.CAP_REACHED };
    }
    if (!canRemove(readiness)) {
      await this.claimRepo.recordEvent({
        employeeId,
        telegramGroupId: groupId,
        eventType: MEMBERSHIP_EVENT.SKIPPED_NOT_READY,
        detailCode:
          readiness.status === REMOVAL_READINESS.TELEGRAM_UNAVAILABLE
            ? DETAIL_CODE.TELEGRAM_UNAVAILABLE
            : DETAIL_CODE.REMOVAL_NOT_READY,
        jobId,
      });
      // A GROUP WE CANNOT CLEAN IS A JOB THAT IS NOT DONE. Unavailable is
      // temporary and a missing right is a configuration fault somebody has
      // to fix - both are retried, and both end in the dead-letter list
      // where they can be seen, rather than in a claim nobody looks at.
      return {
        outcome: REMOVAL_OUTCOME.RETRYABLE,
        reason: REMOVAL_REFUSAL.NOT_READY,
        readiness,
        error:
          readiness.error ||
          new TelegramMembershipRetryableError(`group not ready for removal: ${readiness.status}`, {
            code: `REMOVAL_${readiness.status}`,
          }),
      };
    }

    let anyPresent = false;
    let failure = null;
    let capped = false;
    for (const identity of identities) {
      const result = await this._removeIdentity(employeeId, group, identity, jobId, budget);
      if (result.removed) anyPresent = true;
      if (result.capped) {
        // EVERY IDENTITY COSTS ITS OWN BUDGET. The second account in the
        // same group cannot be removed on the first one's allowance.
        capped = true;
        break;
      }
      if (!result.settled) failure = failure || result.error;
    }

    if (failure) {
      return { outcome: REMOVAL_OUTCOME.RETRYABLE, reason: REMOVAL_REFUSAL.TELEGRAM_UNAVAILABLE, error: failure };
    }
    if (capped) return { outcome: REMOVAL_OUTCOME.CAPPED, reason: REMOVAL_REFUSAL.CAP_REACHED };

    await this._closeClaimsFor(employeeId, groupId, anyPresent, jobId);
    return {
      outcome: anyPresent ? REMOVAL_OUTCOME.REMOVED : REMOVAL_OUTCOME.ALREADY_ABSENT,
    };
  }

  async _removeIdentity(employeeId, group, identity, jobId, budget) {
    const groupId = Number(group.telegram_group_id);
    const userId = Number(identity.telegram_user_id);

    if (identity.disconnected_at) {
      // THE REUSE GUARD. A retired identity's Telegram account may since
      // have become somebody else's ACTIVE identity - a shared or handed-on
      // handset. Removing it would eject a current employee in the name of
      // cleaning up after a former one.
      const owner = await this.identityRepo.getActiveIdentityByTelegramUser(userId);
      if (owner && Number(owner.employee_id) !== Number(employeeId)) {
        await this.claimRepo.recordEvent({
          employeeId,
          telegramGroupId: groupId,
          employeeTelegramId: identity.employee_telegram_id,
          eventType: MEMBERSHIP_EVENT.IDENTITY_REUSED_BY_OTHER_EMPLOYEE,
          detailCode: DETAIL_CODE.HISTORICAL_IDENTITY,
          jobId,
        });
        return { removed: false, settled: true };
      }
    }

    // ONE CALL TO LOOK, TWO TO ACT: the whole cost is taken up front, so a
    // removal is never started with a budget that cannot finish it and no
    // ban is ever issued without its unban being affordable.
    if (budget && !budget.spend(3)) return { removed: false, settled: false, capped: true };
    if (budget && typeof budget.takeRemoval === "function" && !budget.takeRemoval()) {
      return { removed: false, settled: false, capped: true };
    }

    try {
      const member = await this.telegram.getChatMember(group.chat_id, userId);
      if (!isTelegramMember(member)) {
        await this.claimRepo.recordEvent({
          employeeId,
          telegramGroupId: groupId,
          employeeTelegramId: identity.employee_telegram_id,
          eventType: MEMBERSHIP_EVENT.ALREADY_ABSENT,
          detailCode: DETAIL_CODE.NOT_IN_GROUP,
          jobId,
        });
        return { removed: false, settled: true };
      }

      await this.claimRepo.recordEvent({
        employeeId,
        telegramGroupId: groupId,
        employeeTelegramId: identity.employee_telegram_id,
        eventType: MEMBERSHIP_EVENT.REMOVE_ATTEMPTED,
        jobId,
      });
      await this.telegram.banChatMember(group.chat_id, userId);
      // UNBAN IMMEDIATELY. They are removed, not banished - a rejoin or a new
      // manual grant must not need somebody to remember to undo this.
      await this.telegram.unbanChatMember(group.chat_id, userId);
      await this.claimRepo.recordEvent({
        employeeId,
        telegramGroupId: groupId,
        employeeTelegramId: identity.employee_telegram_id,
        eventType: MEMBERSHIP_EVENT.REMOVED,
        jobId,
      });
      return { removed: true, settled: true };
    } catch (err) {
      const description = String((err && err.telegramDescription) || err.message || "");
      if (/USER_NOT_PARTICIPANT|PARTICIPANT_ID_INVALID/i.test(description)) {
        // THE DESIRED END STATE ALREADY HOLDS. Not a failure.
        await this.claimRepo.recordEvent({
          employeeId,
          telegramGroupId: groupId,
          employeeTelegramId: identity.employee_telegram_id,
          eventType: MEMBERSHIP_EVENT.ALREADY_ABSENT,
          detailCode: DETAIL_CODE.NOT_IN_GROUP,
          jobId,
        });
        return { removed: false, settled: true };
      }
      this._log(logger.LEVEL.ERROR, "REMOVE", `removal failed: ${err.toString()}`, {
        telegram_group_id: groupId,
        employee_id: employeeId,
      });
      await this.claimRepo.recordEvent({
        employeeId,
        telegramGroupId: groupId,
        employeeTelegramId: identity.employee_telegram_id,
        eventType: MEMBERSHIP_EVENT.REMOVE_FAILED,
        jobId,
      });
      return {
        removed: false,
        settled: false,
        error: new TelegramMembershipRetryableError(`removal failed: ${description || "unknown"}`, {
          code: "TELEGRAM_REMOVAL_FAILED",
          retryAfter: retryAfterOf(err),
          cause: err,
        }),
      };
    }
  }

  /** A claim closes only on a CONFIRMED outcome, never on an assumption. */
  async _closeClaimsFor(employeeId, groupId, removed, jobId) {
    for (const source of [CLAIM_SOURCE.RULE, CLAIM_SOURCE.MANUAL]) {
      const res = await this.claimRepo.close({
        employeeId,
        telegramGroupId: groupId,
        source,
        closeOutcome: removed ? CLOSE_OUTCOME.REMOVED : CLOSE_OUTCOME.ALREADY_ABSENT,
        fromStates: [CLAIM_STATE.REMOVAL_PENDING],
      });
      if (res.changed) {
        await this.claimRepo.recordEvent({
          employeeId,
          telegramGroupId: groupId,
          source,
          eventType: MEMBERSHIP_EVENT.CLAIM_CLOSED,
          detailCode: removed ? null : DETAIL_CODE.NOT_IN_GROUP,
          jobId,
        });
      }
    }
  }

  async _removalReadiness(group, budget) {
    // A BUDGET THAT CANNOT PAY FOR THE CHECK IS NOT A TELEGRAM OUTAGE.
    // Reporting it as one was the bug: "we could not ask" and "we were not
    // allowed to ask this tick" are different facts, and only the first is a
    // reason to retry with backoff. The second simply resumes next tick.
    if (budget && budget.spend && !budget.spend(2)) {
      return { status: REMOVAL_READINESS.CAPPED };
    }
    try {
      const [chat, botMember] = await Promise.all([
        this.telegram.getChat(group.chat_id),
        this._botMember(group.chat_id),
      ]);
      return removalReadiness({ chat, botMember });
    } catch (err) {
      this._log(logger.LEVEL.WARN, "REMOVAL-READINESS", err.toString(), {
        telegram_group_id: group.telegram_group_id,
      });
      return {
        status: REMOVAL_READINESS.TELEGRAM_UNAVAILABLE,
        // Carried so a 429 here reaches the delay path rather than spending
        // a retry - the readiness calls hit the same rate limit as the rest.
        error: new TelegramMembershipRetryableError(`readiness check failed: ${err.message}`, {
          code: "REMOVAL_READINESS_FAILED",
          retryAfter: retryAfterOf(err),
          cause: err,
        }),
      };
    }
  }

  async _botMember(chatId) {
    if (!this._botId) {
      const me = await this.telegram.getMe();
      this._botId = me && (me.id || me.userId);
    }
    if (!this._botId) return null;
    return this.telegram.getChatMember(chatId, Number(this._botId));
  }

  async _group(groupId) {
    if (!this._groupCache) this._groupCache = new Map();
    const key = Number(groupId);
    if (this._groupCache.has(key)) return this._groupCache.get(key);
    const group = await this.registryRepo.getById(key);
    this._groupCache.set(key, group || null);
    return group || null;
  }

  /* =================================================== group scope ====== */

  /**
   * ONE GROUP, EVERY EMPLOYEE IT CONCERNS: those it matches now, and those it
   * used to manage. A group job never re-opens a claim for somebody who has
   * left - employment is checked per employee, exactly as the employee job
   * checks it.
   */
  async reconcileGroup(telegramGroupId, { jobId = null, budget = null } = {}) {
    const groupId = Number(telegramGroupId);
    const group = await this._group(groupId);
    if (!group) return { telegramGroupId: groupId, skipped: "UNKNOWN_GROUP", employees: 0 };

    // WHO THIS GROUP MATCHES NOW, by Phase 3A's own matcher over the same
    // snapshot the Map screen counts from - so a group job and the Map can
    // never disagree about who belongs.
    const mappings = await this.mappingRepo.getByGroup(groupId);
    const snapshot = await this.mappingRepo.getEmployeeSnapshot();
    const businessDate = this.businessDate();
    const matched = snapshot
      .filter((employee) => employedOn(employee, businessDate))
      .filter((employee) => mappings.some((mapping) => matchesDimension(employee, mapping)))
      .map((employee) => Number(employee.employee_id));

    const live = await this.claimRepo.getLiveForGroup(groupId);
    const ids = new Set([...matched, ...live.map((c) => Number(c.employee_id))]);

    let reconciled = 0;
    for (const employeeId of ids) {
      // Per employee, so the group job cannot invent a different rule from
      // the employee job for the same pair.
      await this.reconcileEmployee(employeeId, { jobId, budget });
      reconciled += 1;
      if (budget && budget.exhausted && budget.exhausted()) break;
    }
    return { telegramGroupId: groupId, employees: reconciled };
  }
}

module.exports = (deps) => new TelegramMembershipReconcileUsecase(deps);
module.exports.TelegramMembershipReconcileUsecase = TelegramMembershipReconcileUsecase;
