const cron = require("node-cron");

/** All in-process cron jobs use India Standard Time (matches server crontab). */
const CRON_TIMEZONE = "Asia/Kolkata";

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
    this.jobs.forEach(({ name, schedule, task }) => {
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
