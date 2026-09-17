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
const {
  BULK_GRANT_MAX,
  PREVIEW_MESSAGES,
} = require("../constants/telegram_group_mapping");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");

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

  /**
   * Runs `fn` inside the claim repository's transaction when it offers one.
   * Without it - a double in a test, an older wiring - the writes still
   * happen, in order, exactly as they did before; the transaction is what
   * makes them all-or-nothing, not what makes them work.
   */
  async _inTransaction(fn) {
    if (this.claimRepo && typeof this.claimRepo.withTransaction === "function") {
      return this.claimRepo.withTransaction(fn);
    }
    return fn(undefined);
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

    // ONE TRANSACTION: the claim, its audit row and the job that will act on
    // it. Three separate writes could leave a granted claim with no job -
    // the group would be required for somebody and nothing would ever
    // reconcile it - or an audit row for a grant that was never written. If
    // the enqueue fails, the grant fails with it and the screen says so.
    // No Telegram call happens here; the worker does that afterwards.
    await this._inTransaction(async (tx) => {
      await this.claimRepo.open(
        {
          employeeId: id,
          telegramGroupId: group.telegram_group_id,
          source: CLAIM_SOURCE.MANUAL,
          actorEmployeeId: actorId,
        },
        { tx }
      );
      await this.claimRepo.recordEvent(
        {
          employeeId: id,
          telegramGroupId: group.telegram_group_id,
          source: CLAIM_SOURCE.MANUAL,
          eventType: MEMBERSHIP_EVENT.CLAIM_OPENED,
          detailCode: DETAIL_CODE.MANUAL_GRANT,
          actorEmployeeId: actorId,
        },
        { tx }
      );
      if (this.jobRepo) {
        await this.jobRepo.enqueueEmployee(
          id,
          JOB_REASON.MANUAL_GRANTED,
          { enqueuedBy: actorId },
          { tx }
        );
      }
    });
    return { code: 200, msg: "Manual membership granted" };
  }

  /**
   * GRANT MANY, IN ONE TRANSACTION AND ONE REQUEST.
   *
   * WHY THIS EXISTS INSTEAD OF A LOOP IN THE BROWSER. "Add the 18 employees I
   * just selected" as 18 uncontrolled requests is 18 independent
   * transactions: a dropped connection halfway leaves nine granted and nine
   * not, with nothing on the screen saying which nine, and the operator's
   * only recourse is to press the button again and hope the repeats are
   * harmless. One request, one transaction - all of them or none.
   *
   * IT IS BOUNDED. `BULK_GRANT_MAX` employees at most, because every one of
   * them is a claim, an audit row and a queue row inside the SAME
   * transaction: an unbounded list is an unbounded transaction holding
   * unbounded locks, and the operator who pasted the whole company would take
   * the mapping screen down for everybody else.
   *
   * EVERY EMPLOYEE MUST BE THE CALLER'S TO GRANT. `manage_telegram_groups`
   * says the operator may configure groups; it does not widen which
   * employees they may reach. The branch scope is resolved server-side and an
   * id outside it fails the WHOLE request rather than being silently dropped
   * - a partial success the operator did not ask for and cannot see is worse
   * than a refusal they can read. A `NONE` scope grants nothing.
   *
   * NO TELEGRAM CALL HAPPENS HERE, inside the transaction or outside it. The
   * claims say the group is required for these people; the worker acts on
   * the queue rows afterwards, and Phase 3B's join is still the only thing
   * that puts anybody in a group.
   *
   * RE-GRANTING SOMEBODY WHO IS ALREADY MANAGED IS NOT AN ERROR.
   * `claimRepo.open` is the same upsert a single grant uses, so selecting a
   * row that is already there is a no-op on the claim and an ordinary audit
   * row - which is what an operator who could not remember expects.
   */
  async grantManualBulk(telegramGroupId, employeeIds, actor = {}, { scope } = {}) {
    const group = await this._requireGroup(telegramGroupId);

    const ids = [
      ...new Set(
        (Array.isArray(employeeIds) ? employeeIds : [])
          .map(Number)
          .filter((id) => Number.isSafeInteger(id) && id > 0)
      ),
    ];
    if (ids.length === 0) throw validationError(PREVIEW_MESSAGES.NO_EMPLOYEES);
    if (ids.length > BULK_GRANT_MAX) throw validationError(PREVIEW_MESSAGES.TOO_MANY_EMPLOYEES);

    const described = await this.claimRepo.describeEmployeesWithBranch(ids);
    for (const id of ids) {
      if (!described.has(id)) throw notFound("Employee not found");
    }

    // FAILS CLOSED. Anything that is not ALL_BRANCHES or a usable
    // OWN_BRANCHES list permits NOTHING - never everything - which is the
    // same rule `TelegramGroupMappingUsecase.visibleEmployees` applies to the
    // preview the operator selected these people from.
    const kind = (scope && scope.kind) || EMPLOYEE_BRANCH_SCOPE.NONE;
    if (kind !== EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES) {
      const allowed =
        kind === EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES
          ? new Set((scope.store_ids || []).map(Number))
          : new Set();
      for (const id of ids) {
        const employee = described.get(id);
        const branch = employee.store_id;
        if (branch === null || !allowed.has(Number(branch))) {
          throw validationError(PREVIEW_MESSAGES.NOT_IN_SCOPE);
        }
      }
    }

    const actorId = actor && actor.employee_id !== undefined ? actor.employee_id : null;

    await this._inTransaction(async (tx) => {
      for (const id of ids) {
        await this.claimRepo.open(
          {
            employeeId: id,
            telegramGroupId: group.telegram_group_id,
            source: CLAIM_SOURCE.MANUAL,
            actorEmployeeId: actorId,
          },
          { tx }
        );
        await this.claimRepo.recordEvent(
          {
            employeeId: id,
            telegramGroupId: group.telegram_group_id,
            source: CLAIM_SOURCE.MANUAL,
            eventType: MEMBERSHIP_EVENT.CLAIM_OPENED,
            detailCode: DETAIL_CODE.MANUAL_GRANT,
            actorEmployeeId: actorId,
          },
          { tx }
        );
        if (this.jobRepo) {
          await this.jobRepo.enqueueEmployee(
            id,
            JOB_REASON.MANUAL_GRANTED,
            { enqueuedBy: actorId },
            { tx }
          );
        }
      }
    });

    return { code: 200, msg: `Added ${ids.length} employee(s)`, granted: ids.length };
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
    // ONE TRANSACTION, for the same reason as the grant - and here the cost
    // of losing the job is higher: a revoked claim with nothing queued is
    // somebody left in a group after their access was taken away, with the
    // record saying it had been.
    await this._inTransaction(async (tx) => {
      const res = await this.claimRepo.requestRemoval(
        {
          employeeId: id,
          telegramGroupId: group.telegram_group_id,
          source: CLAIM_SOURCE.MANUAL,
          intentReason: INTENT_REASON.MANUAL_REVOKED,
          actorEmployeeId: actorId,
        },
        { tx }
      );
      if (!res.changed) throw notFound("No active manual membership for that employee");
      await this.claimRepo.recordEvent(
        {
          employeeId: id,
          telegramGroupId: group.telegram_group_id,
          source: CLAIM_SOURCE.MANUAL,
          eventType: MEMBERSHIP_EVENT.CLAIM_REMOVAL_REQUESTED,
          detailCode: DETAIL_CODE.MANUAL_REVOKE,
          actorEmployeeId: actorId,
        },
        { tx }
      );
      if (this.jobRepo) {
        await this.jobRepo.enqueueEmployee(
          id,
          JOB_REASON.MANUAL_REVOKED,
          { enqueuedBy: actorId },
          { tx }
        );
      }
    });
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
