const cron = require("node-cron");

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
      const t = cron.schedule(schedule, () => {
        Promise.resolve(task()).catch((err) => console.error(`[CRON] ${name}`, err));
      });
      this.tasks.push(t);
      console.log(`[CRON] "${name}" -> ${schedule}`);
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
