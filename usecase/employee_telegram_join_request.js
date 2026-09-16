const crypto = require("crypto");
const logger = require("../utils/logger");
const { isReady, isTelegramMember, attemptIsLive } = require("../utils/telegram_membership");
const {
  ATTEMPT_STATUS,
  JOIN_REFUSAL,
  GROUP_READINESS,
  VERIFIED_MEMBERSHIP,
} = require("../constants/telegram_membership");

const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

/**
 * APPROVING A TELEGRAM JOIN REQUEST. Phase 3B. The security-critical file.
 *
 * ============ HOLDING OUR INVITE LINK IS NOT AUTHORISATION TO JOIN ========
 *
 * That is the single rule this file exists to enforce. An invite link is a
 * URL in a chat message: it can be forwarded, screenshotted, pasted into a
 * family group. If possession were enough, one employee sharing their link
 * would put a stranger inside a company group, and nothing would look wrong
 * at any point - the link WAS ours, the request DID arrive, the approval
 * WOULD succeed.
 *
 * So the link is only how we FIND the attempt. What authorises the approval
 * is that the Telegram account making the request is the account that
 * employee verified with their own phone number, checked against
 * `employee_telegram_identity` at the moment of approval. A forwarded link
 * therefore fails: the request arrives from somebody else's Telegram id, and
 * there is no attempt in the world that makes that id this employee.
 *
 * ========================== SEVEN CHECKS, ALL OF THEM, EVERY TIME =========
 *
 *   1  the chat is a registered group
 *   2  that group is still active and still readiness-eligible
 *   3  the request corresponds to one of our attempts
 *   4  that attempt is still live - not expired, superseded or concluded
 *   5  the employee still has a connected Telegram identity
 *   6  the requesting Telegram user IS that identity
 *   7  the group is STILL required by current Phase 3A mappings
 *
 * Checks 2 and 7 are re-evaluated NOW rather than trusted from issue time,
 * because the fifteen minutes between issuing a link and tapping it are
 * enough for a mapping to be deleted or an admin to be demoted, and joining
 * a group you are no longer required to be in is exactly the state Phase 3C
 * would then have to clean up.
 *
 * ========================= A FAILED CHECK DECLINES NOTHING ================
 *
 * A request we cannot approve is LEFT PENDING for a human, not declined.
 * Declining is an action taken against a real person on the strength of a
 * rule that might simply be misconfigured - and this phase does not act
 * against anybody. The bot also says nothing to the requester: "you are not
 * the employee this link was for" tells a stranger the link belongs to
 * somebody and that this company runs this flow.
 */
class EmployeeTelegramJoinRequestUsecase {
  constructor({ registryRepo, identityRepo, joinRepo, membership, readiness, telegram, mappingRepo, verificationRepo, now } = {}) {
    this.registryRepo = registryRepo;
    this.identityRepo = identityRepo;
    this.joinRepo = joinRepo;
    this.membership = membership;
    this.readiness = readiness;
    this.telegram = telegram;
    this.mappingRepo = mappingRepo;
    // Optional: the dashboard's cache. Written on a confirmed join, never read.
    this.verificationRepo = verificationRepo || null;
    this.now = now || (() => new Date());
  }

  /**
   * THE CLAIM PREDICATE - synchronous, and decided before any handler runs.
   *
   * It claims every `chat_join_request`, because this is the only feature
   * that handles them. It is deliberately NOT "claim if we can find an
   * attempt": that would be an asynchronous database read inside a
   * synchronous contract, and a request we end up refusing is still ours to
   * refuse rather than something another handler should try to interpret.
   */
  claims(update) {
    return Boolean(update && (update.chatJoinRequest || update.chat_join_request));
  }

  /** Telegram's payload, camelCased by the client. Either spelling is read. */
  static _request(update) {
    return (update && (update.chatJoinRequest || update.chat_join_request)) || null;
  }

  /**
   * Record why a request was not approved, without naming anybody.
   *
   * No Telegram user id, no employee name, no invite URL. The employee id is
   * referenced only where we actually resolved one, and it is an internal
   * key rather than a personal detail.
   */
  _refuse(reason, ref = {}) {
    logger.Log({
      level: logger.LEVEL.WARN,
      component: "USECASE.EMPLOYEE_TELEGRAM_JOIN_REQUEST",
      code: `USECASE.EMPLOYEE_TELEGRAM_JOIN_REQUEST.${reason}`,
      description: `join request not approved: ${reason}`,
      category: "",
      ref,
    });
    return { approved: false, reason };
  }

  /**
   * Teach the dashboard's cache what Telegram just confirmed.
   *
   * SAME RULES AS THE DETAIL SCREEN'S RECORDER: only a definitive answer is
   * written, TELEGRAM_UNAVAILABLE never is, and a failure to cache never
   * changes the outcome of a join that has already happened. The repository
   * refuses a non-answer as well, so this is the second of three layers
   * rather than the only one.
   *
   * OPTIONAL. Without a verification repository wired the approval works
   * exactly as before; the dashboard simply learns later.
   */
  async _recordVerification({ identity, group, joined, readiness }) {
    if (!this.verificationRepo || !identity || !group) return;
    if (!readiness || readiness.status === GROUP_READINESS.TELEGRAM_UNAVAILABLE) return;
    try {
      await this.verificationRepo.record({
        employeeTelegramId: identity.employee_telegram_id,
        employeeId: Number(identity.employee_id),
        telegramGroupId: group.telegram_group_id,
        membership: joined ? VERIFIED_MEMBERSHIP.JOINED : VERIFIED_MEMBERSHIP.NOT_JOINED,
        readinessStatus: readiness.status,
        verifiedAt: this.now(),
      });
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.EMPLOYEE_TELEGRAM_JOIN_REQUEST",
        code: "USECASE.EMPLOYEE_TELEGRAM_JOIN_REQUEST.RECORD-VERIFICATION",
        description: `could not cache a verification: ${err.toString()}`,
        category: "",
        ref: { telegram_group_id: group.telegram_group_id },
      });
    }
  }

  async handle(update) {
    const request = EmployeeTelegramJoinRequestUsecase._request(update);
    if (!request) return { approved: false, reason: JOIN_REFUSAL.NO_MATCHING_ATTEMPT };

    const chatId = request.chat && (request.chat.id ?? request.chat.chatId);
    const fromId = request.from && (request.from.id ?? request.from.userId);
    if (chatId === undefined || chatId === null || fromId === undefined || fromId === null) {
      return this._refuse(JOIN_REFUSAL.NO_MATCHING_ATTEMPT);
    }

    /* 1 - a registered group */
    const group = await this.registryRepo.getByChatId(String(chatId));
    if (!group) return this._refuse(JOIN_REFUSAL.UNREGISTERED_GROUP);
    const full = await this.registryRepo.getById(group.telegram_group_id);
    if (!full) return this._refuse(JOIN_REFUSAL.UNREGISTERED_GROUP);

    /* 2 - still active and still manageable, asked NOW */
    const readiness = await this.readiness.check(full);
    if (!isReady(readiness)) {
      return this._refuse(JOIN_REFUSAL.GROUP_NOT_READY, {
        telegram_group_id: full.telegram_group_id,
      });
    }

    /* 5 + 6 - WHOSE TELEGRAM ACCOUNT IS THIS, and is it connected?
     *
     * Resolved from the REQUESTING USER rather than from the attempt. That
     * direction is what makes a forwarded link useless: we do not ask
     * "is this the employee's link" and then trust it, we ask "which
     * employee is this Telegram account" and require the answer to match. */
    const identity = await this.identityRepo.getActiveIdentityByTelegramUser(Number(fromId));
    if (!identity) {
      return this._refuse(JOIN_REFUSAL.IDENTITY_DISCONNECTED, {
        telegram_group_id: full.telegram_group_id,
      });
    }
    const employeeId = Number(identity.employee_id);

    /* 3 - an attempt of ours.
     *
     * Matched by the invite link's hash when Telegram gives us one - it is
     * optional in the payload. When it is absent the attempt is found by the
     * employee this account resolves to, which is a match on the SAME
     * verified identity the approval turns on rather than a weaker one. */
    const inviteUrl =
      request.inviteLink && (request.inviteLink.inviteLink || request.inviteLink.invite_link);
    const attempt = inviteUrl
      ? await this.joinRepo.findAttemptByInviteHash(full.telegram_group_id, sha256(inviteUrl))
      : await this.joinRepo.findLiveAttempt(employeeId, full.telegram_group_id);

    if (!attempt) {
      return this._refuse(JOIN_REFUSAL.NO_MATCHING_ATTEMPT, {
        telegram_group_id: full.telegram_group_id,
        employee_id: employeeId,
      });
    }

    /* 6 again, explicitly - THE ATTEMPT MUST BELONG TO THIS EMPLOYEE.
     *
     * This is the forwarded-link case. The link was ours and the attempt is
     * real, but it was issued to somebody else, and the person tapping it is
     * not them. */
    if (Number(attempt.employee_id) !== employeeId) {
      return this._refuse(JOIN_REFUSAL.IDENTITY_MISMATCH, {
        telegram_group_id: full.telegram_group_id,
      });
    }

    /* 4 - still live */
    if (attempt.status !== ATTEMPT_STATUS.PENDING) {
      return this._refuse(JOIN_REFUSAL.ATTEMPT_NOT_LIVE, {
        telegram_group_id: full.telegram_group_id,
        employee_id: employeeId,
      });
    }
    if (!attemptIsLive(attempt, this.now())) {
      // Conclude it, so the next read does not show a live-looking row.
      await this.joinRepo.advanceStatus(
        attempt.employee_telegram_group_join_attempt_id,
        ATTEMPT_STATUS.PENDING,
        ATTEMPT_STATUS.EXPIRED
      );
      return this._refuse(JOIN_REFUSAL.ATTEMPT_EXPIRED, {
        telegram_group_id: full.telegram_group_id,
        employee_id: employeeId,
      });
    }

    /* 7 - STILL required, by current mappings */
    const employee = await this.mappingRepo.getEmployeeForMatching(employeeId);
    const stillRequired = await this.membership.isGroupRequired(
      employee,
      full.telegram_group_id
    );
    if (!stillRequired) {
      return this._refuse(JOIN_REFUSAL.GROUP_NO_LONGER_REQUIRED, {
        telegram_group_id: full.telegram_group_id,
        employee_id: employeeId,
      });
    }

    /* ---------------------------------------------------- approve ----- */

    // CLAIM THE ATTEMPT FIRST. Telegram can deliver the same request twice,
    // and this conditional update is what makes the second delivery a no-op:
    // it matches no row, so only one delivery ever reaches the approval call.
    const claimed = await this.joinRepo.advanceStatus(
      attempt.employee_telegram_group_join_attempt_id,
      ATTEMPT_STATUS.PENDING,
      ATTEMPT_STATUS.JOIN_REQUEST_RECEIVED
    );
    if (!claimed.changed) {
      return { approved: false, reason: JOIN_REFUSAL.ATTEMPT_NOT_LIVE, duplicate: true };
    }

    try {
      await this.telegram.approveChatJoinRequest(String(chatId), Number(fromId));
    } catch (err) {
      // ALREADY A MEMBER IS A SUCCESS, NOT A FAILURE. Telegram refuses to
      // approve somebody already in the chat, which happens when a request
      // is delivered twice or an admin let them in by hand while this ran.
      const description = String((err && err.telegramDescription) || err.message || "");
      if (/USER_ALREADY_PARTICIPANT|already a participant|HIDE_REQUESTER_MISSING/i.test(description)) {
        await this.joinRepo.advanceStatus(
          attempt.employee_telegram_group_join_attempt_id,
          ATTEMPT_STATUS.JOIN_REQUEST_RECEIVED,
          ATTEMPT_STATUS.JOINED,
          { completed: true }
        );
        return { approved: true, alreadyMember: true };
      }
      await this.joinRepo.advanceStatus(
        attempt.employee_telegram_group_join_attempt_id,
        ATTEMPT_STATUS.JOIN_REQUEST_RECEIVED,
        ATTEMPT_STATUS.FAILED
      );
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.EMPLOYEE_TELEGRAM_JOIN_REQUEST",
        code: "USECASE.EMPLOYEE_TELEGRAM_JOIN_REQUEST.APPROVE",
        description: `approve failed: ${err.toString()}`,
        category: "",
        ref: { telegram_group_id: full.telegram_group_id, employee_id: employeeId },
      });
      return this._refuse(JOIN_REFUSAL.APPROVAL_FAILED, {
        telegram_group_id: full.telegram_group_id,
        employee_id: employeeId,
      });
    }

    await this.joinRepo.advanceStatus(
      attempt.employee_telegram_group_join_attempt_id,
      ATTEMPT_STATUS.JOIN_REQUEST_RECEIVED,
      ATTEMPT_STATUS.APPROVED
    );

    // VERIFY, rather than assume the approval took. A failure to confirm
    // leaves the attempt APPROVED - honest about what we know - instead of
    // claiming a membership nothing has checked.
    try {
      const member = await this.telegram.getChatMember(full.chat_id, Number(fromId));
      if (isTelegramMember(member)) {
        await this.joinRepo.advanceStatus(
          attempt.employee_telegram_group_join_attempt_id,
          ATTEMPT_STATUS.APPROVED,
          ATTEMPT_STATUS.JOINED,
          { completed: true }
        );
        // THE DASHBOARD LEARNS IT NOW, not whenever somebody next opens the
        // employee. This is the moment a join actually completes, and it
        // completes asynchronously - nobody is looking at a screen. Without
        // this the employee would sit in the queue as VERIFICATION_PENDING
        // after the join that finished them, which is the queue reporting
        // work that is already done.
        //
        // Readiness was re-confirmed as READY earlier in this same handler,
        // and Telegram has just confirmed the membership, so this is a
        // definitive answer by both halves.
        await this._recordVerification({ identity, group: full, joined: true, readiness });
        return { approved: true, joined: true };
      }
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.WARN,
        component: "USECASE.EMPLOYEE_TELEGRAM_JOIN_REQUEST",
        code: "USECASE.EMPLOYEE_TELEGRAM_JOIN_REQUEST.VERIFY",
        description: `post-approval verification failed: ${err.toString()}`,
        category: "",
        ref: { telegram_group_id: full.telegram_group_id, employee_id: employeeId },
      });
    }
    return { approved: true, joined: false };
  }
}

module.exports = (deps) => new EmployeeTelegramJoinRequestUsecase(deps);
module.exports.EmployeeTelegramJoinRequestUsecase = EmployeeTelegramJoinRequestUsecase;
