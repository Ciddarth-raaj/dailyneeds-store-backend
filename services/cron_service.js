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
  }

  /** @param {string} name @param {string} schedule @param {() => void | Promise<void>} task */
  register(name, schedule, task) {
    this.jobs.push({ name, schedule, task });
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
    this.jobs.forEach(({ name, schedule, task }) => {
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
          Promise.resolve(task()).catch((err) =>
            console.error(`[CRON] ${name}`, err)
          );
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
