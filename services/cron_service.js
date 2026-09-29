const cron = require("node-cron");

/** All in-process cron jobs use India Standard Time (matches server crontab). */
const CRON_TIMEZONE = "Asia/Kolkata";

/**
 * Five fields, or six when the first one is seconds. Nothing else.
 *
 * THIS EXISTS BECAUSE `cron.validate` DOES NOT CHECK IT. Handed the seven
 * fields of `"*\/3 * * * * * *"` it answers true, and node-cron then schedules
 * SOMETHING - it fired every three seconds on a two-second offset when this
 * was measured against the pinned 3.0.3 - rather than rejecting the typo.
 * That was harmless while every schedule here had five fields and an extra
 * one was obvious on sight. The Telegram poller now legitimately uses six,
 * so six-and-seven is a one-character slip that validate would wave through
 * and that nothing downstream would ever complain about: the job runs, on the
 * wrong cadence, silently.
 *
 * Fail it here instead, where the job's name can be printed beside it.
 */
function isFieldCountValid(schedule) {
  const fields = String(schedule || "").trim().split(/\s+/).filter(Boolean);
  return fields.length === 5 || fields.length === 6;
}

/** Register jobs with register(), then start(). */
class CronService {
  constructor() {
    this.jobs = [];
    this.tasks = [];
    /** Names of preventOverlap jobs whose previous run has not settled yet. */
    this.running = new Set();
  }

  /**
   * @param {string} name @param {string} schedule @param {() => void | Promise<void>} task
   * @param {{ preventOverlap?: boolean }} [options]
   *   preventOverlap: node-cron fires on schedule whether or not the previous
   *   run finished. With this set, a tick that arrives while the job is still
   *   running is skipped (and logged). The guard is per process: it holds
   *   because the API runs as ONE PM2 fork instance. Cluster mode or a second
   *   instance would each get their own guard.
   */
  register(name, schedule, task, options = {}) {
    this.jobs.push({ name, schedule, task, preventOverlap: !!options.preventOverlap });
  }

  /**
   * Run one registered job the way a schedule tick does. Resolves when it has
   * settled; never rejects (errors are logged, as for a scheduled run).
   * @returns {Promise<"ran" | "failed" | "skipped_overlap">}
   */
  async runJob(job) {
    const { name, task, preventOverlap } = job;
    if (preventOverlap) {
      if (this.running.has(name)) {
        console.warn(`[CRON] "${name}" skipped - previous run still active`);
        return "skipped_overlap";
      }
      this.running.add(name);
    }
    try {
      await task();
      return "ran";
    } catch (err) {
      console.error(`[CRON] ${name}`, err);
      return "failed";
    } finally {
      if (preventOverlap) this.running.delete(name);
    }
  }

  start() {
    // Stage 0A staging: a rehearsal instance must never run the production
    // jobs (Digisme sync, Telegram poller, GST refresh, purchase acks). With
    // CRON_DISABLED=true every job is registered and listed but none is
    // scheduled. Production never sets this.
    if (process.env.CRON_DISABLED === "true") {
      console.log(`[CRON] CRON_DISABLED=true — ${this.jobs.length} job(s) registered, none scheduled: ${this.jobs.map((j) => j.name).join(", ")}`);
      return;
    }
    this.jobs.forEach((job) => {
      const { name, schedule } = job;
      if (!isFieldCountValid(schedule)) {
        console.error(
          `[CRON] invalid schedule for "${name}": ${schedule} — expected 5 fields (minute hour day month weekday) or 6 (second first)`
        );
        return;
      }
      if (!cron.validate(schedule)) {
        console.error(`[CRON] invalid schedule for "${name}": ${schedule}`);
        return;
      }
      const t = cron.schedule(
        schedule,
        () => {
          this.runJob(job);
        },
        { timezone: CRON_TIMEZONE }
      );
      this.tasks.push(t);
      console.log(`[CRON] "${name}" -> ${schedule} (${CRON_TIMEZONE})`);
    });
  }

  stopAll() {
    this.tasks.forEach((t) => {
      try {
        t.stop();
      } catch (_) {
        /* ignore */
      }
    });
    this.tasks = [];
  }
}

module.exports = CronService;
module.exports.CRON_TIMEZONE = CRON_TIMEZONE;
