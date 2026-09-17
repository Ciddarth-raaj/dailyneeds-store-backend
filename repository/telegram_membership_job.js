const logger = require("../utils/logger");
const {
  JOB_STATUS,
  JOB_SCOPE,
  RETRY_BACKOFF_MINUTES,
  MAX_FAILURES,
} = require("../constants/telegram_membership_claim");

const TABLE = "telegram_membership_job";

/**
 * THE RECONCILIATION QUEUE - SQL only. Phase 3C.
 *
 * ================================= THE THREE STATEMENTS THAT MATTER ========
 *
 * ENQUEUE is an upsert onto the live-job marker. If a live job already
 * exists for the scope - PENDING or RUNNING - the insert collides and
 * becomes "mark it dirty" instead of creating a second job. It never resets
 * `failure_count`, and it can never revive a DEAD job, whose marker is NULL.
 *
 * CLAIM clears the dirty flag in the SAME statement that takes the job, so
 * anything arriving after that instant sets the flag again and cannot be
 * lost.
 *
 * COMPLETE reads the dirty flag and concludes in one statement: dirty sends
 * the job back to PENDING, clean marks it SUCCEEDED.
 *
 * ================ WHY COMPLETE DOES NOT CLEAR THE FLAG =====================
 *
 * It would be natural to write `status = IF(rerun_requested = 1, ...), ... ,
 * rerun_requested = 0` - and it would WORK, but only because MySQL evaluates
 * SET assignments left to right and the status expression happens to be
 * listed first. Reorder the clauses, or let a formatter do it, and every
 * completion silently reads a zero and the dirty mark is lost. Nothing in
 * the statement would look wrong.
 *
 * So the flag is cleared by CLAIM, never by COMPLETE, and this statement's
 * result does not depend on the order of its own assignments.
 * A `1` left on a concluded row is harmless: its marker is NULL, so the next
 * change opens a new job rather than colliding with it.
 */
class TelegramMembershipJobRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.TELEGRAM_MEMBERSHIP_JOB",
      code: `REPOSITORY.TELEGRAM_MEMBERSHIP_JOB.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  _query(code, sql, params, tx) {
    if (tx) return tx.query(sql, params);
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          return reject(err);
        }
        resolve(rows);
      });
    });
  }

  static _row(row) {
    if (!row) return null;
    return {
      telegram_membership_job_id: Number(row.telegram_membership_job_id),
      scope_type: row.scope_type,
      scope_id: Number(row.scope_id),
      reason: row.reason,
      status: row.status,
      rerun_requested: Boolean(row.rerun_requested),
      failure_count: Number(row.failure_count),
      next_attempt_at: row.next_attempt_at,
      last_error_code: row.last_error_code || null,
      claimed_at: row.claimed_at || null,
      finished_at: row.finished_at || null,
    };
  }

  /**
   * ENQUEUE, and mark an in-flight job dirty if there is one.
   *
   * `tx` IS THE POINT. Handed the transaction of the HR change that caused
   * it, the queue row and the business change commit together: a resignation
   * that committed always has its cleanup queued, and a resignation that
   * rolled back never queued anything. Telegram is not touched here.
   */
  async enqueue({ scopeType, scopeId, reason, enqueuedBy = null }, { tx } = {}) {
    const res = await this._query(
      "ENQUEUE",
      `INSERT INTO ${TABLE}
         (scope_type, scope_id, reason, status, next_attempt_at, enqueued_by)
       VALUES (?, ?, ?, '${JOB_STATUS.PENDING}', NOW(), ?)
       ON DUPLICATE KEY UPDATE
         rerun_requested = 1,
         next_attempt_at = LEAST(next_attempt_at, NOW())`,
      [scopeType, Number(scopeId), reason, enqueuedBy],
      tx
    );
    // 1 = a new job, 2 = an existing live job was marked dirty.
    return {
      created: Boolean(res && res.affectedRows === 1),
      markedDirty: Boolean(res && res.affectedRows === 2),
    };
  }

  /** Convenience wrappers, so callers never spell the scope wrong. */
  enqueueEmployee(employeeId, reason, options = {}, txOptions = {}) {
    return this.enqueue(
      { scopeType: JOB_SCOPE.EMPLOYEE, scopeId: employeeId, reason, ...options },
      txOptions
    );
  }

  enqueueGroup(telegramGroupId, reason, options = {}, txOptions = {}) {
    return this.enqueue(
      { scopeType: JOB_SCOPE.GROUP, scopeId: telegramGroupId, reason, ...options },
      txOptions
    );
  }

  /** Jobs whose time has come, oldest first. */
  async dueJobs(limit) {
    const rows = await this._query(
      "DUE",
      `SELECT * FROM ${TABLE}
        WHERE status = '${JOB_STATUS.PENDING}' AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at ASC, telegram_membership_job_id ASC
        LIMIT ?`,
      [Number(limit)]
    );
    return (rows || []).map(TelegramMembershipJobRepository._row);
  }

  /**
   * TAKE THE JOB, AND CLEAR THE DIRTY FLAG WITH IT. Zero rows means another
   * tick got there first, or it is no longer due.
   */
  async claim(jobId) {
    const res = await this._query(
      "CLAIM",
      `UPDATE ${TABLE}
          SET status = '${JOB_STATUS.RUNNING}', claimed_at = NOW(), rerun_requested = 0,
              finished_at = NULL
        WHERE telegram_membership_job_id = ? AND status = '${JOB_STATUS.PENDING}'
          AND next_attempt_at <= NOW()`,
      [Number(jobId)]
    );
    return { claimed: Boolean(res && res.affectedRows) };
  }

  /**
   * CONCLUDE. Dirty -> PENDING (immediately due), clean -> SUCCEEDED.
   *
   * `requestRerun` lets the worker itself ask for another pass - what a job
   * stopped by the per-tick removal cap does, so a capped job is never
   * reported as finished work.
   */
  async complete(jobId, { requestRerun = false } = {}) {
    const dirty = requestRerun ? "1" : "rerun_requested";
    const res = await this._query(
      "COMPLETE",
      `UPDATE ${TABLE}
          SET status = IF(${dirty} = 1, '${JOB_STATUS.PENDING}', '${JOB_STATUS.SUCCEEDED}'),
              finished_at = IF(${dirty} = 1, NULL, NOW()),
              next_attempt_at = NOW()
        WHERE telegram_membership_job_id = ? AND status = '${JOB_STATUS.RUNNING}'`,
      [Number(jobId)]
    );
    return { changed: Boolean(res && res.affectedRows) };
  }

  /**
   * A RETRYABLE FAILURE. Back to PENDING with the next backoff, or DEAD once
   * the ladder runs out. The dirty flag is left exactly as it is - the retry
   * will re-read truth anyway, and the next claim clears it.
   */
  async fail(jobId, { errorCode = null, errorDetail = null } = {}) {
    const rows = await this._query(
      "READ-FOR-FAIL",
      `SELECT failure_count FROM ${TABLE} WHERE telegram_membership_job_id = ?`,
      [Number(jobId)]
    );
    const failures = rows && rows[0] ? Number(rows[0].failure_count) + 1 : 1;
    const exhausted = failures > MAX_FAILURES;
    const minutes = RETRY_BACKOFF_MINUTES[Math.min(failures, MAX_FAILURES) - 1];
    // ±20% jitter, so a mass event does not retry in one synchronised wave.
    const jittered = Math.max(1, Math.round(minutes * (0.8 + Math.random() * 0.4)));

    const res = await this._query(
      "FAIL",
      `UPDATE ${TABLE}
          SET status = ?, failure_count = ?,
              next_attempt_at = DATE_ADD(NOW(), INTERVAL ? MINUTE),
              last_error_code = ?, last_error_detail = ?,
              finished_at = IF(? = 1, NOW(), NULL)
        WHERE telegram_membership_job_id = ? AND status = '${JOB_STATUS.RUNNING}'`,
      [
        exhausted ? JOB_STATUS.DEAD : JOB_STATUS.PENDING,
        failures,
        exhausted ? 0 : jittered,
        errorCode,
        TelegramMembershipJobRepository._safeDetail(errorDetail),
        exhausted ? 1 : 0,
        Number(jobId),
      ]
    );
    return { changed: Boolean(res && res.affectedRows), dead: exhausted, failures };
  }

  /**
   * RATE LIMITED, WHICH IS NOT A FAILED ATTEMPT. `failure_count` is
   * deliberately untouched: spending a retry on work Telegram never let us
   * try would kill jobs that were never wrong.
   */
  async delay(jobId, seconds, { errorCode = "TELEGRAM_RATE_LIMITED" } = {}) {
    const res = await this._query(
      "DELAY",
      `UPDATE ${TABLE}
          SET status = '${JOB_STATUS.PENDING}',
              next_attempt_at = DATE_ADD(NOW(), INTERVAL ? SECOND),
              last_error_code = ?
        WHERE telegram_membership_job_id = ? AND status = '${JOB_STATUS.RUNNING}'`,
      [Math.max(1, Number(seconds) || 1), errorCode, Number(jobId)]
    );
    return { changed: Boolean(res && res.affectedRows) };
  }

  /** Straight to DEAD - a refusal no retry can fix. */
  async kill(jobId, { errorCode = null, errorDetail = null } = {}) {
    const res = await this._query(
      "KILL",
      `UPDATE ${TABLE}
          SET status = '${JOB_STATUS.DEAD}', finished_at = NOW(),
              last_error_code = ?, last_error_detail = ?
        WHERE telegram_membership_job_id = ? AND status = '${JOB_STATUS.RUNNING}'`,
      [errorCode, TelegramMembershipJobRepository._safeDetail(errorDetail), Number(jobId)]
    );
    return { changed: Boolean(res && res.affectedRows) };
  }

  /**
   * A RUNNING job whose worker died. Back to PENDING without spending a
   * retry - nothing was established about whether the work was wrong.
   */
  async reclaimAbandoned(olderThanMs) {
    const res = await this._query(
      "RECLAIM-ABANDONED",
      `UPDATE ${TABLE}
          SET status = '${JOB_STATUS.PENDING}', next_attempt_at = NOW(), claimed_at = NULL
        WHERE status = '${JOB_STATUS.RUNNING}'
          AND claimed_at < DATE_SUB(NOW(), INTERVAL ? SECOND)`,
      [Math.round(Number(olderThanMs) / 1000)]
    );
    return { reclaimed: res && res.affectedRows ? Number(res.affectedRows) : 0 };
  }

  /** Admin re-queue of a DEAD job: a fresh job, not a revived corpse. */
  async requeueDead(jobId, { enqueuedBy = null, reason } = {}) {
    const rows = await this._query(
      "READ-DEAD",
      `SELECT scope_type, scope_id FROM ${TABLE}
        WHERE telegram_membership_job_id = ? AND status = '${JOB_STATUS.DEAD}'`,
      [Number(jobId)]
    );
    if (!rows || !rows[0]) return { requeued: false };
    await this.enqueue({
      scopeType: rows[0].scope_type,
      scopeId: Number(rows[0].scope_id),
      reason,
      enqueuedBy,
    });
    return { requeued: true };
  }

  /** Queue health for the admin screen. */
  async counts() {
    const rows = await this._query(
      "COUNTS",
      `SELECT status, COUNT(*) AS n, MIN(next_attempt_at) AS oldest
         FROM ${TABLE} GROUP BY status`,
      []
    );
    const out = { PENDING: 0, RUNNING: 0, SUCCEEDED: 0, DEAD: 0, oldest_pending: null };
    for (const row of rows || []) {
      out[row.status] = Number(row.n);
      if (row.status === JOB_STATUS.PENDING) out.oldest_pending = row.oldest;
    }
    return out;
  }

  async listByStatus(status, { limit = 50 } = {}) {
    const rows = await this._query(
      "LIST-BY-STATUS",
      `SELECT * FROM ${TABLE} WHERE status = ?
        ORDER BY telegram_membership_job_id DESC LIMIT ?`,
      [status, Number(limit)]
    );
    return (rows || []).map(TelegramMembershipJobRepository._row);
  }

  /** How many removals have run in the last hour - the hourly ceiling. */
  async removalsSince(since, countQuery) {
    return countQuery ? countQuery(since) : 0;
  }

  /**
   * BOUNDED AND SANITISED. An error detail is for a person reading the admin
   * screen, and it is written on paths that have a chat id and an invite URL
   * in scope. Anything long is cut, and anything that looks like a URL or a
   * long digit run - an invite link, a chat id, a mobile - is dropped rather
   * than stored.
   */
  static _safeDetail(detail) {
    if (detail === null || detail === undefined) return null;
    const text = String(detail).replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (/https?:\/\//i.test(text) || /t\.me\//i.test(text)) return null;
    return text.replace(/-?\d{6,}/g, "#").slice(0, 200);
  }
}

module.exports = (db) => new TelegramMembershipJobRepository(db);
module.exports.TelegramMembershipJobRepository = TelegramMembershipJobRepository;
