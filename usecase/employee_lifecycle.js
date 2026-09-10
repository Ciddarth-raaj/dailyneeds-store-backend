const logger = require("../utils/logger");

/**
 * Stage 0C / C1c — the employment-lifecycle reconciler.
 *
 * Digisme is still the source of truth for who is employed. This does not
 * change that: it reads `new_employee` as the sync leaves it and brings
 * `employee_employment_period` into agreement, so that
 *
 *     join -> resign -> rejoin -> resign -> rejoin
 *
 * becomes periods 1, 2, 3 under one permanent `employee_id`, and no earlier
 * period is ever edited to make room for a later one.
 *
 * RECONCILIATION, NOT EVENT HANDLING. The decision is taken from the current
 * master row and the newest period, never from "what this particular sync
 * payload said changed". That is what makes it idempotent - a second run
 * finds the two already in agreement and does nothing - and what makes an
 * interrupted run repairable by simply running it again.
 *
 * WHAT IT WILL NOT DO. It never invents a date. `today`, `created_at`,
 * `updated_at` and the previous resignation date are not joining dates, and
 * none of them is read here. Where a date is unknown the column stays NULL
 * and `needs_review` is set, exactly as C1b left the 518 rows it flagged.
 */

/** ENUM values from the C1a schema. There is no 'rejoin' type; the reason lives in detail_json. */
const EVENT = {
  OPENED: "period_opened",
  CLOSED: "period_closed",
  CORRECTED: "period_corrected",
};

/** Why a period was opened. Distinguishes a first join from a rejoin. */
const REASON = {
  INITIAL_JOIN: "initial_join",
  REJOIN: "rejoin",
  RESIGNATION: "resignation",
  DATE_LEARNED: "date_learned",
};

/** A DATE column, as YYYY-MM-DD, so two dates can be compared as text. */
function toDateOnly(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const text = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

const isActive = (employee) => Number(employee.status) === 1;

/**
 * Is `candidate` credible as the start of a NEW period that follows `prev`?
 *
 * `new_employee.date_of_joining` is one column holding one date, and Digisme
 * does not update it on a rejoin - the sync mapper does not even carry the
 * field. So on a rejoin the value found there is usually the ORIGINAL joining
 * date, and writing it onto period 2 would claim the second spell began
 * before the first one ended. A date that does not postdate the previous
 * period is therefore treated as stale history, not as a rejoin date, and
 * the period opens with joined_on NULL for review.
 *
 * When the previous period has no known dates at all, nothing distinguishes
 * a stale value from a fresh one, so the same conservative answer applies.
 * The raw text is recorded on the event either way, so a human can resolve it
 * without going back to Digisme.
 */
function credibleRejoinDate(candidate, prev) {
  if (candidate === null) return false;
  const prevEnded = toDateOnly(prev.ended_on);
  const prevJoined = toDateOnly(prev.joined_on);
  if (prevEnded !== null) return candidate > prevEnded;
  if (prevJoined !== null) return candidate > prevJoined;
  return false;
}

/**
 * May the joining date read from the master be written into THIS period's
 * empty `joined_on`?
 *
 * For period 1 the answer is yes whenever the ordering holds: there is no
 * earlier spell for the value to belong to instead.
 *
 * For period 2 and beyond it is the same question `credibleRejoinDate` asks
 * when the period is created, and it has to be asked again here - otherwise
 * a rejoin that correctly opened with joined_on NULL would have the stale
 * original date filled into it by the very next sync, defeating the guard one
 * day later. It must postdate the previous spell's end, and where that end is
 * unknown there is nothing to judge against, so the date stays NULL for a
 * human to resolve.
 */
function joinableInto(period, candidate) {
  if (candidate === null) return false;
  const ended = toDateOnly(period.ended_on);
  // A closed period cannot take a joining date later than its own end.
  if (ended !== null && candidate > ended) return false;
  if (Number(period.period_no) <= 1) return true;
  const prevEnded = toDateOnly(period.prev_ended_on);
  return prevEnded !== null && candidate > prevEnded;
}

/** A period needs review while a date it ought to have is still unknown. */
const reviewNeeded = (period_state, joined_on, ended_on) =>
  joined_on === null || (period_state === "closed" && ended_on === null);

/**
 * The whole decision, as a pure function of the two rows. No I/O, no clock,
 * no randomness - which is what lets every transition below be tested
 * exhaustively without a database.
 *
 * `employee` : { status, resignation_date, parsed_joined_on, raw_date_of_joining }
 * `latest`   : the newest period row, or null when there is none.
 */
function decide(employee, latest) {
  const joinDate = toDateOnly(employee.parsed_joined_on);
  const endDate = toDateOnly(employee.resignation_date);
  const active = isActive(employee);

  /* ---- Case A: no period at all. An employee who arrived after C1b. ---- */
  if (!latest) {
    if (active) {
      return {
        action: "open_initial",
        period: {
          period_no: 1,
          period_state: "open",
          joined_on: joinDate,
          ended_on: null,
          end_reason_type: null,
          needs_review: reviewNeeded("open", joinDate, null),
        },
        event: {
          event_type: EVENT.OPENED,
          detail: { reason: REASON.INITIAL_JOIN, period_no: 1, opened_state: "open" },
        },
        revokeSessions: false,
      };
    }

    // Already inactive when first seen: the period is created closed. Only
    // one event is written - the opening - because the closure was never
    // observed here, and inventing a period_closed event for it would be
    // manufacturing history this system did not witness.
    const closeDate = endDate !== null && (joinDate === null || endDate >= joinDate) ? endDate : null;
    return {
      action: "open_initial",
      period: {
        period_no: 1,
        period_state: "closed",
        joined_on: joinDate,
        ended_on: closeDate,
        end_reason_type: closeDate === null ? "unknown" : "resignation",
        needs_review: reviewNeeded("closed", joinDate, closeDate),
      },
      event: {
        event_type: EVENT.OPENED,
        detail: {
          reason: REASON.INITIAL_JOIN,
          period_no: 1,
          opened_state: "closed",
          // Recorded when a resignation date exists but contradicts the
          // joining date; the period keeps NULL rather than a bad date.
          ...(endDate !== null && closeDate === null ? { rejected_end_date: endDate } : {}),
        },
      },
      revokeSessions: false,
    };
  }

  const open = String(latest.period_state) === "open";
  const latestJoined = toDateOnly(latest.joined_on);
  const latestEnded = toDateOnly(latest.ended_on);

  /* ---- Case C: open + inactive. The employee has left. ---- */
  if (open && !active) {
    const closeDate = endDate !== null && (latestJoined === null || endDate >= latestJoined) ? endDate : null;
    return {
      action: "close",
      period_id: latest.period_id,
      ended_on: closeDate,
      end_reason_type: closeDate === null ? "unknown" : "resignation",
      needs_review: reviewNeeded("closed", latestJoined, closeDate),
      event: {
        event_type: EVENT.CLOSED,
        detail: {
          reason: REASON.RESIGNATION,
          period_no: latest.period_no,
          ended_on: closeDate,
          ...(endDate !== null && closeDate === null ? { rejected_end_date: endDate } : {}),
        },
      },
      // An employee who has left keeps no live session. `employeeActive` in
      // the auth middleware already refuses them; bumping token_valid_from
      // makes the refusal independent of that one check.
      revokeSessions: true,
    };
  }

  /* ---- Case E: closed + active. A REJOIN. ---- */
  if (!open && active) {
    const credible = credibleRejoinDate(joinDate, latest);
    return {
      action: "open_rejoin",
      period: {
        period_no: Number(latest.period_no) + 1,
        period_state: "open",
        joined_on: credible ? joinDate : null,
        ended_on: null,
        end_reason_type: null,
        needs_review: reviewNeeded("open", credible ? joinDate : null, null),
      },
      event: {
        event_type: EVENT.OPENED,
        detail: {
          reason: REASON.REJOIN,
          period_no: Number(latest.period_no) + 1,
          previous_period_id: latest.period_id,
          previous_ended_on: latestEnded,
          joined_on: credible ? joinDate : null,
          // What the master actually held, so the unresolved case is
          // reviewable without a second system.
          ...(credible
            ? {}
            : {
                rejoin_date_unknown: true,
                master_date_of_joining: employee.raw_date_of_joining || null,
              }),
        },
      },
      // MANDATORY. status returning to 1 would otherwise make a token issued
      // before the resignation valid again, because the only thing that had
      // been refusing it was the employee-active check.
      revokeSessions: true,
    };
  }

  /* ---- Cases B and D: the period already agrees. Fill NULLs only. ---- */
  const fills = [];

  if (latestJoined === null && joinDate !== null && joinableInto(latest, joinDate)) {
    fills.push({ column: "joined_on", value: joinDate });
  }

  if (!open && latestEnded === null && endDate !== null) {
    const effectiveJoined =
      latestJoined !== null
        ? latestJoined
        : (fills.find((f) => f.column === "joined_on") || {}).value || null;
    if (effectiveJoined === null || endDate >= effectiveJoined) {
      fills.push({ column: "ended_on", value: endDate });
    }
  }

  if (fills.length === 0) return { action: "none" };

  const nextJoined = (fills.find((f) => f.column === "joined_on") || {}).value || latestJoined;
  const nextEnded = (fills.find((f) => f.column === "ended_on") || {}).value || latestEnded;

  return {
    action: "fill",
    period_id: latest.period_id,
    fills,
    needs_review: reviewNeeded(latest.period_state, nextJoined, nextEnded),
    event: {
      event_type: EVENT.CORRECTED,
      detail: {
        reason: REASON.DATE_LEARNED,
        period_no: latest.period_no,
        filled: fills.map((f) => f.column),
        joined_on: nextJoined,
        ended_on: nextEnded,
      },
    },
    revokeSessions: false,
  };
}

class EmployeeLifecycleUsecase {
  /**
   * `userRepo` is optional and used for one thing: revoking sessions through
   * the Stage 0A `token_valid_from` mechanism. C1c deliberately adds no
   * second authentication system.
   */
  constructor(lifecycleRepo, userRepo) {
    this.lifecycleRepo = lifecycleRepo;
    this.userRepo = userRepo || null;
  }

  _log(level, code, description, ref = {}) {
    logger.Log({
      level,
      component: "USECASE.EMPLOYEE_LIFECYCLE",
      code: `USECASE.EMPLOYEE_LIFECYCLE.${code}`,
      description,
      category: "",
      ref,
    });
  }

  /**
   * Brings one employee's periods into agreement with the master. Runs in a
   * single transaction that starts by locking the employee's master row, so
   * two concurrent reconciliations of the same employee serialise rather than
   * both deciding "rejoin".
   *
   * Returns the action taken: "none", "open_initial", "open_rejoin", "close"
   * or "fill".
   */
  async reconcileEmployee(employeeId, options = {}) {
    const actor = options.actorEmployeeId === undefined ? null : options.actorEmployeeId;

    /**
     * C2. A caller that has already changed `new_employee` inside its own
     * transaction passes that transaction in, so the master change and the
     * period it implies commit or roll back together. Without this the two
     * would be separate transactions and a failure between them would leave
     * an employee marked inactive with their period still open.
     *
     * `withTransaction` is used only when nobody supplied one, so the
     * standalone path - the Digisme sync, reconcileAll - is unchanged.
     */
    const run = (fn) =>
      options.tx ? fn(options.tx) : this.lifecycleRepo.withTransaction(fn);

    const outcome = await run(async (tx) => {
      await this.lifecycleRepo.assertDateLocale(tx);

      const employee = await this.lifecycleRepo.lockAndReadEmployee(tx, employeeId);
      if (!employee) return { action: "skipped", reason: "employee_not_found" };

      const latest = await this.lifecycleRepo.getLatestPeriod(tx, employeeId);
      const plan = decide(employee, latest);

      if (plan.action === "none") return { action: "none" };

      if (plan.action === "open_initial" || plan.action === "open_rejoin") {
        const periodId = await this.lifecycleRepo.insertPeriod(tx, {
          employee_id: employeeId,
          actor_employee_id: actor,
          ...plan.period,
        });
        await this.lifecycleRepo.insertEvent(tx, {
          employee_id: employeeId,
          period_id: periodId,
          actor_employee_id: actor,
          event_type: plan.event.event_type,
          detail: plan.event.detail,
        });
        return { action: plan.action, period_id: periodId, revokeSessions: plan.revokeSessions };
      }

      if (plan.action === "close") {
        const affected = await this.lifecycleRepo.closePeriod(tx, plan.period_id, {
          ended_on: plan.ended_on,
          end_reason_type: plan.end_reason_type,
          needs_review: plan.needs_review,
          actor_employee_id: actor,
        });
        // Zero means another transaction closed it first. The event belongs
        // to whichever transaction did the closing, so this one writes none -
        // that is what keeps a repeated sync from stacking resignations.
        if (affected === 0) return { action: "none", reason: "already_closed" };
        await this.lifecycleRepo.insertEvent(tx, {
          employee_id: employeeId,
          period_id: plan.period_id,
          actor_employee_id: actor,
          event_type: plan.event.event_type,
          detail: plan.event.detail,
        });
        return { action: "close", period_id: plan.period_id, revokeSessions: plan.revokeSessions };
      }

      // fill
      let filled = 0;
      for (const f of plan.fills) {
        filled += await this.lifecycleRepo.fillNullDate(tx, plan.period_id, f.column, f.value, {
          needs_review: plan.needs_review,
          actor_employee_id: actor,
        });
      }
      if (filled === 0) return { action: "none", reason: "already_filled" };
      await this.lifecycleRepo.insertEvent(tx, {
        employee_id: employeeId,
        period_id: plan.period_id,
        actor_employee_id: actor,
        event_type: plan.event.event_type,
        detail: plan.event.detail,
      });
      return { action: "fill", period_id: plan.period_id, revokeSessions: false };
    });

    // Standalone, this runs outside the transaction on purpose: revoking a
    // session is a `user` table write, and holding the employee lock across
    // it would widen the lock for no benefit, while a failure here must not
    // undo a correct period.
    //
    // C2 is the opposite case. When the caller owns the transaction the
    // revocation belongs inside it, so that a resignation which later rolls
    // back does not leave the employee logged out of a job they still have.
    // It is therefore performed by the caller in that case, and reported
    // here so the caller knows it is owed.
    if (options.tx) return { ...outcome, revocationOwedFor: outcome.revokeSessions ? employeeId : null };

    if (outcome.revokeSessions && this.userRepo && this.userRepo.bumpTokenValidFromByEmployeeId) {
      try {
        await this.userRepo.bumpTokenValidFromByEmployeeId(employeeId);
      } catch (err) {
        this._log(
          logger.LEVEL.ERROR,
          "SESSION-REVOKE-FAILED",
          `period changed for employee ${employeeId} but token_valid_from could not be bumped: ${err.message}`,
          { employeeId }
        );
      }
    }

    return outcome;
  }

  /**
   * Reconciles every employee whose master row and newest period disagree.
   *
   * One employee's failure is logged and the run continues: a single bad row
   * must not stop the other 629 from being brought up to date, and because
   * the whole thing is reconciliation rather than event handling, the failed
   * one is simply picked up again by the next run.
   */
  async reconcileAll(options = {}) {
    const limit = options.limit || 5000;
    const summary = {
      candidates: 0,
      none: 0,
      open_initial: 0,
      open_rejoin: 0,
      close: 0,
      fill: 0,
      skipped: 0,
      failed: 0,
      failures: [],
    };

    let ids;
    try {
      ids = await this.lifecycleRepo.listEmployeesNeedingReconciliation(limit);
    } catch (err) {
      this._log(logger.LEVEL.ERROR, "CANDIDATE-QUERY-FAILED", err.toString());
      throw err;
    }

    summary.candidates = ids.length;
    if (ids.length === 0) return summary;

    for (const id of ids) {
      try {
        const res = await this.reconcileEmployee(id, options);
        const key = res.action === "skipped" ? "skipped" : res.action;
        if (summary[key] !== undefined) summary[key] += 1;
      } catch (err) {
        summary.failed += 1;
        if (summary.failures.length < 20) {
          summary.failures.push({ employee_id: id, error: err.message });
        }
        this._log(
          logger.LEVEL.ERROR,
          "RECONCILE-FAILED",
          `employee ${id}: ${err.message}`,
          { employeeId: id }
        );
      }
    }

    this._log(
      summary.failed > 0 ? logger.LEVEL.ERROR : logger.LEVEL.INFO,
      "RECONCILE-ALL",
      `candidates ${summary.candidates}: opened ${summary.open_initial}, rejoined ${summary.open_rejoin}, ` +
        `closed ${summary.close}, filled ${summary.fill}, no-op ${summary.none}, ` +
        `skipped ${summary.skipped}, failed ${summary.failed}`,
      { summary: { ...summary, failures: undefined } }
    );

    return summary;
  }
}

module.exports = (lifecycleRepo, userRepo) =>
  new EmployeeLifecycleUsecase(lifecycleRepo, userRepo);
module.exports.EmployeeLifecycleUsecase = EmployeeLifecycleUsecase;
module.exports.decide = decide;
module.exports.toDateOnly = toDateOnly;
module.exports.credibleRejoinDate = credibleRejoinDate;
module.exports.EVENT = EVENT;
module.exports.REASON = REASON;
