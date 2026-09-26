const cron = require("node-cron");
const { runInLane } = require("../utils/db_admission");

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

/**
 * Register jobs with register(), then start().
 *
 * EVERY TICK, three rules (docs/api-db-backpressure.md):
 *
 *   BACKGROUND LANE  the task runs in the `background` DB lane
 *                    (utils/db_admission.js): it may hold at most
 *                    DB_BACKGROUND_MAX_ACTIVE (4) connections, so no cron can
 *                    take the pool away from HTTP traffic.
 *   NO OVERLAP       a tick that arrives while the same job's previous tick
 *                    is still running is SKIPPED, not stacked. Several jobs
 *                    (e.g. the 5-minute GoFrugal purchase acknowledgement
 *                    sync) had no guard of their own, so a stuck database
 *                    made each period add another pending run.
 *   DB GATE          while a database the job NEEDS is known to be
 *                    unavailable (that pool's circuit is open - see
 *                    setDbUnavailableProbe), the tick is SKIPPED rather than
 *                    queued against it. The job runs again on its next
 *                    scheduled tick. Which pools a job needs is declared at
 *                    register() (`requires`, default ["main"]: every job in
 *                    this API touches the main database; the GoFrugal sync
 *                    and the Purchase Ref warm-up also need "gofrugal").
 *                    The gate is checked BEFORE the task starts, so a job
 *                    that calls an external service first (Telegram
 *                    getUpdates, DigiSME) never fetches data it could not
 *                    store: skipped updates stay queued at the source.
 *
 * Skips are counted (stats()) and logged once per job per outage, not per
 * tick.
 */
class CronService {
  constructor() {
    this.jobs = [];
    this.tasks = [];
    this.running = new Set();
    this.skips = {}; // name -> {overlap, db_unavailable}
    this.skipLogged = new Set();
    this.dbUnavailable = () => false;
  }

  /** `fn(poolName)` true while that pool is failing fast (circuit open). */
  setDbUnavailableProbe(fn) {
    if (typeof fn === "function") this.dbUnavailable = fn;
  }

  stats() {
    return { running: Array.from(this.running), skips: { ...this.skips } };
  }

  _skip(name, why) {
    const s = this.skips[name] || (this.skips[name] = { overlap: 0, db_unavailable: 0 });
    s[why] += 1;
    const key = `${name}:${why}`;
    if (!this.skipLogged.has(key)) {
      this.skipLogged.add(key);
      console.log(`[CRON] ${name} tick skipped (${why === "overlap" ? "previous tick still running" : "database unavailable"}); further skips for this reason are counted, not logged`);
    }
  }

  /** The body of one tick; exposed for tests. */
  _tick(name, task, requires = ["main"]) {
    if (this.running.has(name)) return this._skip(name, "overlap");
    let unavailable = false;
    try {
      unavailable = requires.some((pool) => this.dbUnavailable(pool) === true);
    } catch (e) {
      unavailable = false;
    }
    if (unavailable) return this._skip(name, "db_unavailable");
    this.skipLogged.delete(`${name}:overlap`);
    this.skipLogged.delete(`${name}:db_unavailable`);
    this.running.add(name);
    return runInLane("background", () => Promise.resolve().then(task))
      .catch((err) => console.error(`[CRON] ${name}`, err))
      .then(() => {
        this.running.delete(name);
      });
  }

  /**
   * @param {string} name @param {string} schedule @param {() => void | Promise<void>} task
   * @param {{requires?: string[]}} [options] pools the job needs (default ["main"])
   */
  register(name, schedule, task, options = {}) {
    const requires = Array.isArray(options.requires) ? options.requires : ["main"];
    this.jobs.push({ name, schedule, task, requires });
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
    this.jobs.forEach(({ name, schedule, task, requires }) => {
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
          this._tick(name, task, requires);
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
