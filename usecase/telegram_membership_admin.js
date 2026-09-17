const logger = require("../utils/logger");
const {
  CLAIM_SOURCE,
  CLAIM_STATE,
  INTENT_REASON,
  MEMBERSHIP_EVENT,
  DETAIL_CODE,
  JOB_REASON,
  JOB_STATUS,
} = require("../constants/telegram_membership_claim");

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

/**
 * MANUAL MEMBERSHIP, AND THE QUEUE'S ADMIN VIEW. Phase 3C.
 *
 * ============================ WHY THIS IS NOT AN EMPLOYEE-EDIT ACTION ======
 *
 * Granting somebody a company Telegram group is granting ACCESS, not
 * recording a detail about them. `employee_edit` is held by everybody who
 * maintains employee records; `manage_telegram_groups` is held by the people
 * who decide what the groups are for. Putting a manual grant behind the
 * first would mean an ordinary record edit could hand out access to a group
 * its owners never agreed to - so it lives in the Group Map, beside the
 * mappings it complements, and Employee Master shows it READ-ONLY.
 *
 * A MANUAL GRANT SURVIVES TRANSFERS. That is its purpose: the rules follow
 * branch and designation, and this is how somebody stays in a group when the
 * rules say they should not. It ends when a person revokes it, or when
 * employment ends.
 */
class TelegramMembershipAdminUsecase {
  constructor({ claimRepo, jobRepo, registryRepo, employeeRepo } = {}) {
    this.claimRepo = claimRepo;
    this.jobRepo = jobRepo;
    this.registryRepo = registryRepo;
    this.employeeRepo = employeeRepo;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "USECASE.TELEGRAM_MEMBERSHIP_ADMIN",
      code: `USECASE.TELEGRAM_MEMBERSHIP_ADMIN.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  async _requireGroup(telegramGroupId) {
    const group = await this.registryRepo.getById(telegramGroupId);
    if (!group) throw notFound("Telegram group not found");
    return group;
  }

  /** Who this group manages, both sources, for the Group Map. */
  async listForGroup(telegramGroupId) {
    await this._requireGroup(telegramGroupId);
    const claims = await this.claimRepo.getLiveForGroup(telegramGroupId);
    const employees = await this.claimRepo.describeEmployees(
      claims.map((claim) => claim.employee_id)
    );
    return {
      code: 200,
      data: claims.map((claim) => ({
        employee_id: claim.employee_id,
        employee_name: employees.get(claim.employee_id) || null,
        source: claim.source,
        state: claim.state,
        adopted_from_existing_member: claim.adopted_from_existing_member,
        intent_reason: claim.intent_reason,
      })),
    };
  }

  /**
   * GRANT. The claim is opened here and the join itself is Phase 3B's, which
   * is the only thing that can put somebody in a group: this makes the group
   * REQUIRED for them, so the employee's Telegram panel offers the join and
   * reports the status exactly as it does for a rule-matched group.
   */
  async grantManual(telegramGroupId, employeeId, actor = {}) {
    const group = await this._requireGroup(telegramGroupId);
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("employee_id is required");
    const employee = await this.claimRepo.describeEmployees([id]);
    if (!employee.has(id)) throw notFound("Employee not found");

    const actorId = actor && actor.employee_id !== undefined ? actor.employee_id : null;
    await this.claimRepo.open({
      employeeId: id,
      telegramGroupId: group.telegram_group_id,
      source: CLAIM_SOURCE.MANUAL,
      actorEmployeeId: actorId,
    });
    await this.claimRepo.recordEvent({
      employeeId: id,
      telegramGroupId: group.telegram_group_id,
      source: CLAIM_SOURCE.MANUAL,
      eventType: MEMBERSHIP_EVENT.CLAIM_OPENED,
      detailCode: DETAIL_CODE.MANUAL_GRANT,
      actorEmployeeId: actorId,
    });
    if (this.jobRepo) {
      await this.jobRepo.enqueueEmployee(id, JOB_REASON.MANUAL_GRANTED, { enqueuedBy: actorId });
    }
    return { code: 200, msg: "Manual membership granted" };
  }

  /**
   * REVOKE. The claim goes to REMOVAL_PENDING rather than straight to
   * CLOSED, because whether anybody is removed is not this screen's decision:
   * if a RULE still wants them there, reconciliation closes this claim as
   * RETAINED_BY_OTHER_SOURCE and nobody is touched.
   */
  async revokeManual(telegramGroupId, employeeId, actor = {}) {
    const group = await this._requireGroup(telegramGroupId);
    const id = Number(employeeId);
    const actorId = actor && actor.employee_id !== undefined ? actor.employee_id : null;
    const res = await this.claimRepo.requestRemoval({
      employeeId: id,
      telegramGroupId: group.telegram_group_id,
      source: CLAIM_SOURCE.MANUAL,
      intentReason: INTENT_REASON.MANUAL_REVOKED,
      actorEmployeeId: actorId,
    });
    if (!res.changed) throw notFound("No active manual membership for that employee");
    await this.claimRepo.recordEvent({
      employeeId: id,
      telegramGroupId: group.telegram_group_id,
      source: CLAIM_SOURCE.MANUAL,
      eventType: MEMBERSHIP_EVENT.CLAIM_REMOVAL_REQUESTED,
      detailCode: DETAIL_CODE.MANUAL_REVOKE,
      actorEmployeeId: actorId,
    });
    if (this.jobRepo) {
      await this.jobRepo.enqueueEmployee(id, JOB_REASON.MANUAL_REVOKED, { enqueuedBy: actorId });
    }
    return { code: 200, msg: "Manual membership revoked" };
  }

  /** READ-ONLY, for Employee Master. Names groups, never Telegram ids. */
  async listForEmployee(employeeId) {
    const claims = await this.claimRepo.getForEmployee(employeeId);
    const live = claims.filter((claim) => claim.state !== CLAIM_STATE.CLOSED);
    return {
      code: 200,
      data: await Promise.all(
        live.map(async (claim) => {
          const group = await this.registryRepo.getById(claim.telegram_group_id);
          return {
            telegram_group_id: claim.telegram_group_id,
            group_name: group ? group.group_name : null,
            source: claim.source,
            state: claim.state,
          };
        })
      ),
    };
  }

  /** Queue health. Counts and the dead-letter list, nothing sensitive. */
  async queueHealth() {
    const counts = await this.jobRepo.counts();
    const dead = await this.jobRepo.listByStatus(JOB_STATUS.DEAD, { limit: 50 });
    return {
      code: 200,
      data: {
        counts,
        dead: dead.map((job) => ({
          telegram_membership_job_id: job.telegram_membership_job_id,
          scope_type: job.scope_type,
          scope_id: job.scope_id,
          reason: job.reason,
          failure_count: job.failure_count,
          last_error_code: job.last_error_code,
          finished_at: job.finished_at,
        })),
      },
    };
  }

  /** A DEAD job is never revived; a fresh one is queued for its scope. */
  async requeue(jobId, actor = {}) {
    const actorId = actor && actor.employee_id !== undefined ? actor.employee_id : null;
    const res = await this.jobRepo.requeueDead(jobId, {
      enqueuedBy: actorId,
      reason: JOB_REASON.ADMIN_REQUEUE,
    });
    if (!res.requeued) throw notFound("No dead job with that id");
    return { code: 200, msg: "Re-queued" };
  }
}

module.exports = (deps) => new TelegramMembershipAdminUsecase(deps);
module.exports.TelegramMembershipAdminUsecase = TelegramMembershipAdminUsecase;
