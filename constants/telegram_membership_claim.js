/**
 * Managed Telegram group membership - the vocabulary. Phase 3C.
 *
 * Phase 3B's `constants/telegram_membership.js` describes what a screen shows
 * about one employee in one group. This describes what the COMPANY HAS
 * CLAIMED to manage, which is a different fact with a different lifetime: a
 * claim outlives an outage, a screen does not.
 */

/** Where a claim came from. Both can exist for the same employee and group. */
const CLAIM_SOURCE = {
  /** Derived from `telegram_group_mapping` - maintained by reconciliation. */
  RULE: "RULE",
  /** Granted by a person under `manage_telegram_groups`. Survives transfers. */
  MANUAL: "MANUAL",
};

/**
 * ACTIVE           the business wants this membership
 * REMOVAL_PENDING  it does not, and Telegram cleanup is outstanding or failed
 * CLOSED           removal confirmed, or the person was confirmed absent
 */
const CLAIM_STATE = {
  ACTIVE: "ACTIVE",
  REMOVAL_PENDING: "REMOVAL_PENDING",
  CLOSED: "CLOSED",
};

/** Why a source stopped being wanted. Kept on the row after it closes. */
const INTENT_REASON = {
  RULE_NO_LONGER_MATCHES: "RULE_NO_LONGER_MATCHES",
  MANUAL_REVOKED: "MANUAL_REVOKED",
  EMPLOYMENT_ENDED: "EMPLOYMENT_ENDED",
  GROUP_RETIRED: "GROUP_RETIRED",
  /**
   * THE ONE THAT NEVER TOUCHES TELEGRAM. This source ended while ANOTHER
   * source still wants the person in the group, so the claim closes at once
   * and nobody is removed - a rule expiring must not eject somebody a human
   * deliberately put there by hand.
   */
  RETAINED_BY_OTHER_SOURCE: "RETAINED_BY_OTHER_SOURCE",
};

/** How a claim ended. */
const CLOSE_OUTCOME = {
  REMOVED: "REMOVED",
  ALREADY_ABSENT: "ALREADY_ABSENT",
  RETAINED_BY_OTHER_SOURCE: "RETAINED_BY_OTHER_SOURCE",
  GROUP_DELETED: "GROUP_DELETED",
};

/** Append-only audit vocabulary. Mirrors the migration's ENUM exactly. */
const MEMBERSHIP_EVENT = {
  CLAIM_OPENED: "CLAIM_OPENED",
  CLAIM_REOPENED: "CLAIM_REOPENED",
  CLAIM_REMOVAL_REQUESTED: "CLAIM_REMOVAL_REQUESTED",
  CLAIM_REMOVAL_CANCELLED: "CLAIM_REMOVAL_CANCELLED",
  CLAIM_CLOSED: "CLAIM_CLOSED",
  ADOPTED: "ADOPTED",
  REMOVE_ATTEMPTED: "REMOVE_ATTEMPTED",
  REMOVED: "REMOVED",
  ALREADY_ABSENT: "ALREADY_ABSENT",
  REMOVE_FAILED: "REMOVE_FAILED",
  SKIPPED_NOT_READY: "SKIPPED_NOT_READY",
  SKIPPED_NO_IDENTITY: "SKIPPED_NO_IDENTITY",
  IDENTITY_REUSED_BY_OTHER_EMPLOYEE: "IDENTITY_REUSED_BY_OTHER_EMPLOYEE",
};

/**
 * The ONLY values `detail_code` may take. A closed list is the point: this
 * column exists so nobody reaches for free text on a path that has a chat id
 * and an invite URL in scope.
 */
const DETAIL_CODE = {
  RULE_MATCHED: "RULE_MATCHED",
  RULE_UNMATCHED: "RULE_UNMATCHED",
  MANUAL_GRANT: "MANUAL_GRANT",
  MANUAL_REVOKE: "MANUAL_REVOKE",
  EMPLOYMENT_ENDED: "EMPLOYMENT_ENDED",
  ELIGIBILITY_RETURNED: "ELIGIBILITY_RETURNED",
  RETAINED_BY_OTHER_SOURCE: "RETAINED_BY_OTHER_SOURCE",
  ALREADY_IN_GROUP: "ALREADY_IN_GROUP",
  /** They were left banned by a half-finished removal; the ban is now lifted. */
  BAN_LIFTED: "BAN_LIFTED",
  NOT_IN_GROUP: "NOT_IN_GROUP",
  HISTORICAL_IDENTITY: "HISTORICAL_IDENTITY",
  REMOVAL_DISABLED: "REMOVAL_DISABLED",
  REMOVAL_CAP_REACHED: "REMOVAL_CAP_REACHED",
  REMOVAL_NOT_READY: "REMOVAL_NOT_READY",
  TELEGRAM_UNAVAILABLE: "TELEGRAM_UNAVAILABLE",
};

/** Queue vocabulary. Four statuses; retry is PENDING again, not a state. */
const JOB_STATUS = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  DEAD: "DEAD",
};

const JOB_SCOPE = { EMPLOYEE: "EMPLOYEE", GROUP: "GROUP" };

/** Why a job exists. Mirrors the migration's ENUM exactly. */
const JOB_REASON = {
  EMPLOYEE_CREATED: "EMPLOYEE_CREATED",
  EMPLOYEE_EDITED: "EMPLOYEE_EDITED",
  JOINING_DATE_CORRECTED: "JOINING_DATE_CORRECTED",
  RESIGNED: "RESIGNED",
  REJOINED: "REJOINED",
  TELEGRAM_CONNECTED: "TELEGRAM_CONNECTED",
  TELEGRAM_RECONNECTED: "TELEGRAM_RECONNECTED",
  TELEGRAM_DISCONNECTED: "TELEGRAM_DISCONNECTED",
  MAPPING_ADDED: "MAPPING_ADDED",
  MAPPING_REMOVED: "MAPPING_REMOVED",
  MANUAL_GRANTED: "MANUAL_GRANTED",
  MANUAL_REVOKED: "MANUAL_REVOKED",
  SWEEP: "SWEEP",
  ADMIN_REQUEUE: "ADMIN_REQUEUE",
};

/**
 * Backoff between attempts, in minutes. The sixth failure has nowhere left to
 * go and the job is DEAD.
 */
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60, 240];
const MAX_FAILURES = RETRY_BACKOFF_MINUTES.length;

/** A RUNNING job older than this lost its worker; the sweep reclaims it. */
const ABANDONED_RUNNING_MS = 10 * 60 * 1000;

/** Fields whose change can alter which groups a rule matches. */
const MAPPING_RELEVANT_FIELDS = ["store_id", "department_id", "designation_id"];

/**
 * WHAT ONE GROUP'S CLEANUP ACHIEVED. The worker turns these into a job
 * outcome, which is why they are a closed list rather than loose booleans:
 * a cleanup that did not happen must never be able to look like one that did.
 */
const REMOVAL_OUTCOME = {
  /** They were in the group and are not now. */
  REMOVED: "REMOVED",
  /** They were already out. The desired end state, so a success. */
  ALREADY_ABSENT: "ALREADY_ABSENT",
  /** Removals are switched off. Deliberate, so it burns no retry - but the
   *  work is NOT done and the job must not report that it is. */
  DEFERRED: "DEFERRED",
  /** A per-tick or hourly cap stopped it. Resume next tick. */
  CAPPED: "CAPPED",
  /** Telegram would not answer, or refused. Retry, and eventually DEAD. */
  RETRYABLE: "RETRYABLE",
};

/** Why a removal could not be performed. Never a reason to close a claim. */
const REMOVAL_REFUSAL = {
  REMOVAL_DISABLED: "REMOVAL_DISABLED",
  NOT_READY: "NOT_READY",
  NO_IDENTITY: "NO_IDENTITY",
  TELEGRAM_UNAVAILABLE: "TELEGRAM_UNAVAILABLE",
  CAP_REACHED: "CAP_REACHED",
  IDENTITY_REUSED: "IDENTITY_REUSED",
};

module.exports = {
  REMOVAL_OUTCOME,
  CLAIM_SOURCE,
  CLAIM_STATE,
  INTENT_REASON,
  CLOSE_OUTCOME,
  MEMBERSHIP_EVENT,
  DETAIL_CODE,
  JOB_STATUS,
  JOB_SCOPE,
  JOB_REASON,
  RETRY_BACKOFF_MINUTES,
  MAX_FAILURES,
  ABANDONED_RUNNING_MS,
  MAPPING_RELEVANT_FIELDS,
  REMOVAL_REFUSAL,
};
