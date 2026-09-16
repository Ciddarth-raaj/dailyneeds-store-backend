const crypto = require("crypto");
const logger = require("../utils/logger");
const { istDateOf } = require("../utils/istDate");
const { employedOn } = require("../utils/attendance_eligibility");
const { matchesDimension } = require("../utils/telegram_group_mapping");
const {
  isReady,
  isTelegramMember,
  membershipStatus,
  telegramComplete,
} = require("../utils/telegram_membership");
const {
  MEMBERSHIP_STATUS,
  JOIN_LINK_TTL_MS,
  MEMBERSHIP_MESSAGES,
  ATTEMPT_STATUS,
  GROUP_READINESS,
  READINESS_REASON,
  VERIFIED_MEMBERSHIP,
} = require("../constants/telegram_membership");

/**
 * WHICH GROUPS AN EMPLOYEE MUST BE IN, AND WHETHER THEY ARE. Phase 3B.
 *
 * ================================== THE MATCHER IS PHASE 3A'S ==============
 *
 * Required groups are the deduplicated union of the Phase 3A mappings that
 * match this employee, decided by `utils/telegram_group_mapping.js` and the
 * shared dated `employedOn()` - the SAME code the Map screen counts with.
 * A second matcher here would eventually disagree with the screen that
 * configured it, and the disagreement would be invisible until somebody was
 * in a group the configuration says they should not be.
 *
 * A GROUP NAME, ITS CATEGORY, ITS `used_for` AND ITS REGISTRY OUTLET DECIDE
 * NOTHING. Only mapping rows map.
 *
 * ================================= WHAT THIS PHASE WILL NOT DO =============
 *
 * It verifies, it invites, and it approves a join that passes every check.
 * It NEVER removes anybody from a group, never reconciles a membership
 * against a changed rule, and never acts on a transfer or a resignation.
 * Those are Phase 3C, and there is no code path here that could do them -
 * `banChatMember` is not called, not imported, and not reachable.
 */

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

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

class EmployeeTelegramMembershipUsecase {
  /**
   * @param {object} deps
   * @param {object} deps.mappingRepo    repository/telegram_group_mapping
   * @param {object} deps.identityRepo   repository/employee_telegram
   * @param {object} deps.joinRepo       repository/employee_telegram_group_join
   * @param {object} deps.readiness      usecase/telegram_group_readiness
   * @param {object} deps.telegram       services/telegram
   * @param {() => Date} [deps.now]
   */
  constructor({ mappingRepo, identityRepo, joinRepo, readiness, telegram, verificationRepo, now } = {}) {
    this.mappingRepo = mappingRepo;
    this.identityRepo = identityRepo;
    this.joinRepo = joinRepo;
    this.readiness = readiness;
    this.telegram = telegram;
    // Optional: the dashboard's cache. This screen writes to it and never
    // reads it - it asks Telegram - so the screen works identically without.
    this.verificationRepo = verificationRepo || null;
    this.now = now || (() => new Date());
  }

  /**
   * Record a DEFINITIVE answer for the dashboard to read later.
   *
   * CALLED ONLY WHERE TELEGRAM ACTUALLY ANSWERED. A readiness of
   * TELEGRAM_UNAVAILABLE, or a membership check that threw, is not an answer
   * and must never overwrite a real one: a momentary network failure would
   * otherwise knock an employee off the Complete list for a reason that has
   * nothing to do with them. The repository refuses it too - belt and braces
   * on the one rule that makes the cache trustworthy.
   *
   * NEVER THROWS. Filling a cache is not worth failing the screen that
   * fetched the data.
   */
  async _recordVerification({ identity, group, readiness, joined }) {
    if (!this.verificationRepo || !identity) return;
    if (!readiness || readiness.status === GROUP_READINESS.TELEGRAM_UNAVAILABLE) return;
    try {
      await this.verificationRepo.record({
        employeeTelegramId: identity.employee_telegram_id,
        employeeId: identity.employee_id,
        telegramGroupId: group.telegram_group_id,
        membership: joined ? VERIFIED_MEMBERSHIP.JOINED : VERIFIED_MEMBERSHIP.NOT_JOINED,
        readinessStatus: readiness.status,
        verifiedAt: this.now(),
      });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.EMPLOYEE_TELEGRAM_MEMBERSHIP",
        code: "USECASE.EMPLOYEE_TELEGRAM_MEMBERSHIP.RECORD-VERIFICATION",
        description: `could not cache a verification: ${err.toString()}`,
        category: "",
        ref: { telegram_group_id: group.telegram_group_id },
      });
    }
  }

  businessDate() {
    return istDateOf(this.now());
  }

  /**
   * THE GROUPS THIS EMPLOYEE IS CURRENTLY REQUIRED TO BE IN.
   *
   * Deduplicated by group: an employee matched by an outlet rule AND a
   * designation rule belongs to that group once, and is asked to join once.
   *
   * EMPLOYMENT IS CHECKED ONCE, FOR THE WHOLE ANSWER. Somebody who has left
   * is required to be in nothing - which is not the same as being removed
   * from anything, and this phase does not remove.
   */
  async requiredGroups(employee) {
    if (!employee) return [];
    if (!employedOn(employee, this.businessDate())) return [];

    const mappings = await this.mappingRepo.getAllMappingsWithGroups();
    const byGroup = new Map();
    for (const mapping of mappings) {
      if (!matchesDimension(employee, mapping)) continue;
      if (!byGroup.has(mapping.telegram_group_id)) {
        byGroup.set(mapping.telegram_group_id, mapping.group);
      }
    }
    return [...byGroup.values()];
  }

  /** Is this group currently required for this employee? */
  async isGroupRequired(employee, telegramGroupId) {
    const required = await this.requiredGroups(employee);
    return required.some((group) => Number(group.telegram_group_id) === Number(telegramGroupId));
  }

  /**
   * THE EMPLOYEE'S TELEGRAM PICTURE: identity, required groups, where they
   * stand in each, and whether that adds up to complete.
   *
   * THE CALL BUDGET IS PER REQUIRED GROUP, AND THAT IS THE POINT OF SCOPING
   * IT TO ONE EMPLOYEE. Readiness is two Telegram calls per group and
   * membership is one more; for an employee with three required groups that
   * is nine calls on a screen somebody deliberately opened. The same work
   * across a company dashboard would be thousands, which is why no dashboard
   * path calls this.
   *
   * A DISCONNECTED EMPLOYEE COSTS NOTHING. Without an identity there is
   * nobody to ask Telegram about, so the groups are listed and not probed.
   */
  async getGroups(employeeId, employee) {
    const identity = await this.identityRepo.getActiveIdentityByEmployee(employeeId);
    const connected = Boolean(identity);
    const groups = await this.requiredGroups(employee);

    // Sweep anything that timed out before reading what is live, so a stale
    // PENDING is never shown as Join Pending.
    await this.joinRepo.expireOverdue(employeeId);
    // THE STORED `JOINED` IS NOT READ HERE. It used to be the fallback when
    // Telegram could not be reached, and that is precisely what made a
    // week-old record able to report Telegram Complete. This screen asks
    // Telegram or reports that it could not; the stored status remains the
    // history of what we did, and `getJoinedGroupIds` remains for a bounded
    // dashboard signal where a live check per employee is not affordable.
    const liveAttempts = await this.joinRepo.getLiveAttemptsForEmployee(employeeId);

    const readinessByGroup = connected
      ? await this.readiness.checkMany(groups)
      : new Map();

    const rows = [];
    for (const group of groups) {
      const readiness = readinessByGroup.get(group.telegram_group_id) || null;
      const liveAttempt = liveAttempts.get(group.telegram_group_id) || null;

      // TELEGRAM IS THE AUTHORITY ON MEMBERSHIP, and it is the ONLY
      // authority. Somebody may have been added by hand, or have left.
      //
      // AN UNVERIFIABLE MEMBERSHIP FAILS CLOSED. An earlier revision kept
      // the stored JOINED when the live check failed, which meant: employee
      // joins, later leaves the group by hand, today's `getChatMember`
      // happens to time out - and the screen reports Joined and Telegram
      // Complete from a record that is a week out of date. Completion is
      // defined as CURRENTLY VERIFIED membership, so a check we could not
      // make is not a membership, and the row says why rather than pretending
      // to know.
      //
      // The stored JOINED is therefore never read as truth. It stays in the
      // table as the history of what we did, which is what it is for.
      let joined = false;
      let rowReadiness = readiness;
      if (connected && isReady(readiness)) {
        const live = await this._isMember(group, identity);
        if (live === null) {
          // Not a verdict about the group - we simply could not ask. The
          // approved readiness vocabulary already has the word for that, and
          // using it keeps the row honest AND out of Telegram Complete.
          rowReadiness = {
            status: GROUP_READINESS.TELEGRAM_UNAVAILABLE,
            reason: READINESS_REASON.TELEGRAM_UNAVAILABLE,
          };
        } else {
          joined = live;
          await this._recordVerification({ identity, group, readiness, joined });
        }
      } else if (connected && readiness && readiness.status !== GROUP_READINESS.TELEGRAM_UNAVAILABLE) {
        // A group we definitively could not manage - inactive, a Basic
        // Group, the bot demoted. That is a real finding and the dashboard
        // should show the employee as PENDING rather than unverified: we DID
        // look, and the requirement is genuinely unmet.
        await this._recordVerification({ identity, group, readiness, joined: false });
      }

      rows.push({
        telegram_group_id: group.telegram_group_id,
        group_name: group.group_name,
        category: group.category,
        used_for: group.used_for,
        readiness_status: rowReadiness ? rowReadiness.status : null,
        readiness_reason: rowReadiness ? rowReadiness.reason : null,
        membership_status: connected
          ? membershipStatus({ readiness: rowReadiness, joined, liveAttempt })
          : MEMBERSHIP_STATUS.ACTION_REQUIRED,
        // The UI shows Join only when there is something a person can do.
        can_generate_join_link:
          connected && isReady(rowReadiness) && !joined && !liveAttempt,
        join_attempt_expires_at: liveAttempt ? liveAttempt.expires_at : null,
      });
    }

    return {
      connected,
      as_of_date: this.businessDate(),
      groups: rows,
      telegram_complete: telegramComplete({ connected, groups: rows }),
    };
  }

  /**
   * Is this employee in this group, according to Telegram? `null` when we
   * could not ask - which the caller must not read as "no".
   */
  async _isMember(group, identity) {
    if (!identity) return null;
    try {
      const member = await this.telegram.getChatMember(
        group.chat_id,
        identity.telegram_user_id
      );
      return isTelegramMember(member);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.WARN,
        component: "USECASE.EMPLOYEE_TELEGRAM_MEMBERSHIP",
        code: "USECASE.EMPLOYEE_TELEGRAM_MEMBERSHIP.MEMBER-CHECK",
        description: `membership check failed: ${err.toString()}`,
        category: "",
        ref: { telegram_group_id: group.telegram_group_id },
      });
      return null;
    }
  }

  /**
   * ISSUE A JOIN LINK for one employee and one group.
   *
   * EVERY PRECONDITION IS RE-CHECKED HERE, against current state, even
   * though the screen only offers the button when they hold. The screen is
   * not an authorization boundary and its data is seconds old: a mapping can
   * be deleted, an identity disconnected or an admin demoted between the
   * render and the click.
   *
   * ALREADY A MEMBER MEANS NO LINK. Asking somebody already in the group to
   * join it is nonsense, and issuing a link that Telegram would refuse makes
   * the flow look broken.
   *
   * THE URL IS RETURNED ONCE AND STORED AS A HASH. It is a working
   * credential; it appears in this response and in no log, no database
   * column and no later read.
   */
  async createJoinLink(employeeId, telegramGroupId, employee, { actorUserId = null } = {}) {
    const identity = await this.identityRepo.getActiveIdentityByEmployee(employeeId);
    if (!identity) throw validationError(MEMBERSHIP_MESSAGES.NOT_CONNECTED);

    const required = await this.requiredGroups(employee);
    const group = required.find(
      (g) => Number(g.telegram_group_id) === Number(telegramGroupId)
    );
    // NOT REQUIRED AND NOT FOUND ARE THE SAME ANSWER on purpose: a group the
    // employee has no business in should not be distinguishable from one
    // that does not exist.
    if (!group) throw validationError(MEMBERSHIP_MESSAGES.NOT_REQUIRED);

    const readiness = await this.readiness.check(group);
    if (!isReady(readiness)) {
      throw validationError(readiness.reason || MEMBERSHIP_MESSAGES.TELEGRAM_UNAVAILABLE);
    }

    const alreadyMember = await this._isMember(group, identity);
    if (alreadyMember === true) {
      return {
        code: 200,
        already_joined: true,
        membership_status: MEMBERSHIP_STATUS.JOINED,
        msg: MEMBERSHIP_MESSAGES.ALREADY_JOINED,
      };
    }

    const expiresAt = new Date(this.now().getTime() + JOIN_LINK_TTL_MS);
    let link;
    try {
      link = await this.telegram.createChatInviteLink(group.chat_id, {
        expireDate: expiresAt.getTime(),
        // A label visible only to group admins in Telegram's own UI. It
        // names the employee id, never the person and never a number.
        name: `DNDS emp ${employeeId}`,
      });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.EMPLOYEE_TELEGRAM_MEMBERSHIP",
        code: "USECASE.EMPLOYEE_TELEGRAM_MEMBERSHIP.INVITE",
        description: `invite link creation failed: ${err.toString()}`,
        category: "",
        ref: { telegram_group_id: group.telegram_group_id },
      });
      throw validationError(MEMBERSHIP_MESSAGES.TELEGRAM_UNAVAILABLE);
    }

    const inviteUrl = link && (link.invite_link || link.inviteLink);
    if (!inviteUrl) throw validationError(MEMBERSHIP_MESSAGES.TELEGRAM_UNAVAILABLE);

    await this.joinRepo.issueAttempt({
      employeeId,
      telegramGroupId: group.telegram_group_id,
      inviteLinkHash: sha256(inviteUrl),
      expiresAt,
      createdBy: actorUserId,
    });

    return {
      code: 200,
      already_joined: false,
      membership_status: MEMBERSHIP_STATUS.JOIN_PENDING,
      // ONCE. Never logged, never stored, never returned again.
      invite_link: inviteUrl,
      expires_at: expiresAt,
      expires_in_minutes: Math.round(JOIN_LINK_TTL_MS / 60000),
    };
  }
}

module.exports = (deps) => new EmployeeTelegramMembershipUsecase(deps);
module.exports.EmployeeTelegramMembershipUsecase = EmployeeTelegramMembershipUsecase;
module.exports.sha256 = sha256;
