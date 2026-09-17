const logger = require("../utils/logger");
const { retryAfterOf } = require("../utils/telegram_membership_errors");
const {
  JOB_SCOPE,
  JOB_REASON,
  ABANDONED_RUNNING_MS,
} = require("../constants/telegram_membership_claim");

/**
 * THE RECONCILIATION WORKER. Phase 3C.
 *
 * ================================ IT SHARES A BOT TOKEN WITH THE POLLER ====
 *
 * The three-second `getUpdates` poller is INTERACTIVE - somebody is watching
 * a screen waiting for their Telegram link to go green - and this is not.
 * They share one rate-limited token, so every protection here exists to keep
 * this one out of the other's way:
 *
 *   a re-entrancy guard, so a slow tick makes the next one a no-op rather
 *     than stacking a second worker onto the same queue;
 *   a hard budget of jobs AND Bot API calls per tick, so one mapping change
 *     across four hundred employees cannot monopolise the token;
 *   a removal cap per tick and per hour, so a mis-configured mapping empties
 *     nobody's group while somebody is asleep;
 *   a 429 that DELAYS this worker and never the poller.
 *
 * NOTHING HERE IS ON BY DEFAULT. Without `TELEGRAM_MEMBERSHIP_WORKER=on` the
 * tick returns immediately, and without `TELEGRAM_MEMBERSHIP_REMOVALS=on` the
 * worker maintains claims and adopts but removes nobody - which is the
 * dry-run the rollout runs on before anything is kicked out of anything.
 */
class TelegramMembershipWorkerUsecase {
  constructor({ jobRepo, claimRepo, identityRepo, reconcile, config = {}, now } = {}) {
    this.jobRepo = jobRepo;
    this.claimRepo = claimRepo;
    this.identityRepo = identityRepo;
    this.reconcile = reconcile;
    this.config = config;
    this.now = typeof now === "function" ? now : () => new Date();
    this.running = false;
    this._removalWindow = { startedAt: 0, count: 0 };
  }

  _log(level, code, description, ref = {}) {
    logger.Log({
      level,
      component: "USECASE.TELEGRAM_MEMBERSHIP_WORKER",
      code: `USECASE.TELEGRAM_MEMBERSHIP_WORKER.${code}`,
      description,
      category: "",
      ref,
    });
  }

  enabled() {
    return this.config.workerEnabled === true;
  }

  /** How many removals are still allowed in the current rolling hour. */
  _hourlyRemovalsLeft() {
    const now = this.now().getTime();
    if (now - this._removalWindow.startedAt >= 60 * 60 * 1000) {
      this._removalWindow = { startedAt: now, count: 0 };
    }
    return Math.max(0, (this.config.removalCapPerHour || 0) - this._removalWindow.count);
  }

  /**
   * A TICK'S BUDGET, handed down to the reconciler so the accounting is done
   * where the calls are made rather than guessed here.
   */
  _budget() {
    const self = this;
    let calls = this.config.apiCallsPerTick || 20;
    let removals = Math.min(this.config.removalCapPerTick || 5, this._hourlyRemovalsLeft());
    return {
      get callsLeft() {
        return calls;
      },
      get removalsLeft() {
        return removals;
      },
      /**
       * SPENDING IS A REQUEST, NOT A STATEMENT. It answers whether the whole
       * amount was available and deducts only then, so a caller that ignores
       * the answer cannot overspend and the balance can never go negative -
       * which is what "at most twenty calls a tick" has to mean if the
       * poller is to keep its share of the token.
       */
      spend(n = 1) {
        if (n <= 0) return true;
        if (calls < n) return false;
        calls -= n;
        return true;
      },
      /**
       * A REMOVAL IS TAKEN, NOT SUBTRACTED. The cap is the reason a
       * mis-configured mapping cannot empty a group overnight, so it is a
       * checked withdrawal: refused when nothing is left, and counted
       * against the rolling hour in the same breath.
       */
      takeRemoval() {
        if (removals <= 0) return false;
        removals -= 1;
        self._removalWindow.count += 1;
        return true;
      },
      exhausted() {
        return calls <= 0;
      },
    };
  }

  /**
   * ONE TICK. Returns a summary rather than throwing: a cron job that throws
   * is a log line nobody reads, and the next tick would run anyway.
   */
  async tick() {
    if (!this.enabled()) return { skipped: "disabled" };
    if (this.running) return { skipped: "in_progress" };
    this.running = true;
    const summary = { jobs: 0, succeeded: 0, failed: 0, dead: 0, delayed: 0 };
    try {
      const budget = this._budget();
      const jobs = await this.jobRepo.dueJobs(this.config.jobsPerTick || 5);
      for (const job of jobs) {
        if (budget.exhausted()) break;
        const claimed = await this.jobRepo.claim(job.telegram_membership_job_id);
        if (!claimed.claimed) continue; // somebody else took it
        summary.jobs += 1;
        const outcome = await this._runJob(job, budget);
        summary[outcome] = (summary[outcome] || 0) + 1;
      }
    } catch (err) {
      this._log(logger.LEVEL.ERROR, "TICK", err.toString());
    } finally {
      this.running = false;
    }
    return summary;
  }

  async _runJob(job, budget) {
    const jobId = job.telegram_membership_job_id;
    try {
      const result =
        job.scope_type === JOB_SCOPE.EMPLOYEE
          ? await this.reconcile.reconcileEmployee(job.scope_id, { jobId, budget })
          : await this.reconcile.reconcileGroup(job.scope_id, { jobId, budget });

      // DEFERRED IS NOT DONE, AND IS NOT A FAILURE EITHER. Removals switched
      // off, or nobody with a Telegram account to remove: retrying in a
      // minute achieves nothing and spending a retry on it would eventually
      // kill a job that was never wrong. So the job waits - visibly PENDING,
      // with its claims still REMOVAL_PENDING - rather than being reported as
      // cleanup that happened.
      if (result && result.deferred) {
        await this.jobRepo.delay(jobId, this.config.deferSeconds || 900, {
          errorCode: "REMOVAL_DEFERRED",
        });
        return "deferred";
      }

      // A JOB STOPPED BY A CAP IS NOT A FINISHED JOB. Asking for a rerun is
      // what stops the queue reporting work that was never done.
      const requestRerun = Boolean(result && (result.capReached || budget.exhausted()));
      await this.jobRepo.complete(jobId, { requestRerun });
      return "succeeded";
    } catch (err) {
      const retryAfter = TelegramMembershipWorkerUsecase._retryAfter(err);
      if (retryAfter) {
        // RATE LIMITED IS NOT A FAILED ATTEMPT - `failure_count` is untouched,
        // so a busy hour cannot kill jobs that were never wrong.
        await this.jobRepo.delay(jobId, retryAfter);
        return "delayed";
      }
      const res = await this.jobRepo.fail(jobId, {
        errorCode: (err && err.code) || "RECONCILE_FAILED",
        errorDetail: err && err.message,
      });
      this._log(logger.LEVEL.ERROR, "JOB", `job ${jobId} failed: ${err.toString()}`, {
        scope_type: job.scope_type,
        scope_id: job.scope_id,
      });
      return res.dead ? "dead" : "failed";
    }
  }

  /**
   * Telegram's own `retry_after`, in seconds, or null if this is not a 429.
   * Shared with the reconciler, so a rate limit raised from inside a removal
   * reaches the delay path exactly as one raised here would.
   */
  static _retryAfter(err) {
    return retryAfterOf(err);
  }

  /**
   * THE HOURLY SAFETY NET, and deliberately not a cursor.
   *
   * Employment can change without passing a hooked path - the Digisme sync
   * reconciles lifecycle in bulk - so something has to notice. A durable
   * "changed since" cursor would be a second source of truth to keep
   * correct, and a wrong one silently stops reconciling. Instead this
   * re-enqueues the bounded population that could possibly need it: anybody
   * with a Telegram identity, and anybody with a live claim. Enqueue
   * collapses onto one live job per scope, so re-enqueuing somebody who is
   * already queued costs a row update and nothing else.
   */
  async sweep() {
    if (!this.enabled()) return { skipped: "disabled" };
    const summary = { reclaimed: 0, enqueued: 0 };
    try {
      const reclaimed = await this.jobRepo.reclaimAbandoned(ABANDONED_RUNNING_MS);
      summary.reclaimed = reclaimed.reclaimed;

      const ids = new Set();
      for (const id of await this.identityRepo.getEmployeeIdsWithAnyIdentity()) ids.add(Number(id));
      for (const id of await this.claimRepo.getEmployeeIdsWithLiveClaims()) ids.add(Number(id));
      for (const id of await this.claimRepo.getEmployeeIdsAwaitingRemoval()) ids.add(Number(id));

      for (const employeeId of ids) {
        await this.jobRepo.enqueueEmployee(employeeId, JOB_REASON.SWEEP);
        summary.enqueued += 1;
      }
    } catch (err) {
      this._log(logger.LEVEL.ERROR, "SWEEP", err.toString());
    }
    return summary;
  }
}

module.exports = (deps) => new TelegramMembershipWorkerUsecase(deps);
module.exports.TelegramMembershipWorkerUsecase = TelegramMembershipWorkerUsecase;
