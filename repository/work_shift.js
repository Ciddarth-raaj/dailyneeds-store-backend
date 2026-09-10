const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

const WEEKLY_SCHEDULE_COLUMNS = [
  "work_shift_id",
  "day_of_week",
  "is_working_day",
  "in_time",
  "out_time",
  "attendance_day_cutoff",
  "break_minutes",
  "normal_work_minutes",
  "ot_rate",
];

/** MySQL gives TINYINT(1) back as 0/1 and DECIMAL as a string. */
function presentScheduleRow(row) {
  return {
    ...row,
    is_working_day: Boolean(row.is_working_day),
    ot_rate: Number(row.ot_rate),
  };
}

/**
 * The new payroll/attendance shift master.
 *
 * `work_shift` and `work_shift_weekly_schedule` only. The legacy
 * `shift_master` table is owned by repository/shift.js and is never read or
 * written from here.
 */
class WorkShiftRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * Every work shift, without the weekly schedule.
   *
   * `active` narrows to active (true) or inactive (false) shifts. Omitting it
   * returns everything, exactly as this method always has - the Work Shift
   * Master list needs both kinds, and the switch in its Status column is the
   * only way to bring an inactive one back. The filter exists for the
   * dropdowns that must offer ACTIVE shifts only, so they do not have to
   * fetch the inactive ones and remember to hide them.
   */
  get({ active } = {}) {
    const where = active === undefined || active === null ? "" : "WHERE active = ?";
    const params = where === "" ? [] : [active ? 1 : 0];

    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM work_shift ${where} ORDER BY shift_code ASC`,
        params,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.WORK_SHIFT",
              code: "REPOSITORY.WORK_SHIFT.GET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }

  getWorkShiftById(work_shift_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM work_shift WHERE work_shift_id = ?",
        [work_shift_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.WORK_SHIFT",
              code: "REPOSITORY.WORK_SHIFT.GET-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }

  /** The weekly schedule rows for one work shift, Sunday first. */
  getWeeklySchedule(work_shift_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT work_shift_weekly_schedule_id, work_shift_id, day_of_week, is_working_day,
                in_time, out_time, attendance_day_cutoff, break_minutes,
                normal_work_minutes, ot_rate, created_at, updated_at
           FROM work_shift_weekly_schedule
          WHERE work_shift_id = ?
          ORDER BY day_of_week ASC`,
        [work_shift_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.WORK_SHIFT",
              code: "REPOSITORY.WORK_SHIFT.GET-WEEKLY-SCHEDULE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve((rows || []).map(presentScheduleRow));
        }
      );
    });
  }

  /** A work shift's configuration together with its weekly schedule, or null. */
  async getWorkShiftWithSchedule(work_shift_id) {
    const rows = await this.getWorkShiftById(work_shift_id);
    const workShift = rows && rows[0];
    if (!workShift) return null;

    const weekly_schedule = await this.getWeeklySchedule(work_shift_id);
    return { ...workShift, weekly_schedule };
  }

  /**
   * Write the supplied rows as the shift's complete weekly schedule.
   *
   * Validation upstream guarantees all seven days are present, so this is an
   * upsert on the (work_shift_id, day_of_week) unique key with no delete pass:
   * a day that already exists keeps its id, and no day can be left behind.
   * Runs on a caller-supplied connection so it shares the caller's
   * transaction.
   */
  async replaceWeeklySchedule(connection, work_shift_id, rows) {
    const values = rows.map((row) => [
      work_shift_id,
      row.day_of_week,
      row.is_working_day,
      row.in_time,
      row.out_time,
      row.attendance_day_cutoff,
      row.break_minutes,
      row.normal_work_minutes,
      row.ot_rate,
    ]);

    const updates = WEEKLY_SCHEDULE_COLUMNS.filter(
      (column) => column !== "work_shift_id" && column !== "day_of_week"
    )
      .map((column) => `${column} = VALUES(${column})`)
      .join(", ");

    await queryAsync(
      connection,
      `INSERT INTO work_shift_weekly_schedule (${WEEKLY_SCHEDULE_COLUMNS.join(", ")})
       VALUES ?
       ON DUPLICATE KEY UPDATE ${updates}`,
      [values]
    );
  }

  /**
   * Create a work shift and its complete weekly schedule in one transaction,
   * so a shift can never land without the seven days that define it.
   *
   * @param {object} config normalized work_shift fields
   * @param {object[]} weeklySchedule normalized rows, all seven days
   */
  async createWorkShiftWithSchedule(config, weeklySchedule) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const result = await queryAsync(connection, "INSERT INTO work_shift SET ?", [config]);
      const work_shift_id = result.insertId;

      await this.replaceWeeklySchedule(connection, work_shift_id, weeklySchedule);

      await commitAsync(connection);
      return { code: 200, work_shift_id };
    } catch (err) {
      await rollbackAsync(connection);
      if (err.code === "ER_DUP_ENTRY") {
        return { code: 101, msg: "A work shift with that shift_code already exists" };
      }
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.WORK_SHIFT",
        code: "REPOSITORY.WORK_SHIFT.CREATE-WITH-SCHEDULE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    } finally {
      connection.release();
    }
  }

  /**
   * Update a work shift's configuration and/or its weekly schedule atomically.
   *
   * `config` may be empty (schedule-only save) and `weeklySchedule` may be
   * null (configuration-only save, schedule left exactly as it was).
   */
  async updateWorkShiftWithSchedule(work_shift_id, config, weeklySchedule) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const existing = await queryAsync(
        connection,
        "SELECT work_shift_id FROM work_shift WHERE work_shift_id = ?",
        [work_shift_id]
      );
      if (!existing || existing.length === 0) {
        await rollbackAsync(connection);
        return { code: 404, msg: "Work shift not found" };
      }

      if (config && Object.keys(config).length > 0) {
        await queryAsync(connection, "UPDATE work_shift SET ? WHERE work_shift_id = ?", [
          config,
          work_shift_id,
        ]);
      }

      if (weeklySchedule) {
        await this.replaceWeeklySchedule(connection, work_shift_id, weeklySchedule);
      }

      await commitAsync(connection);
      return { code: 200, work_shift_id };
    } catch (err) {
      await rollbackAsync(connection);
      if (err.code === "ER_DUP_ENTRY") {
        return { code: 101, msg: "A work shift with that shift_code already exists" };
      }
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "REPOSITORY.WORK_SHIFT",
        code: "REPOSITORY.WORK_SHIFT.UPDATE-WITH-SCHEDULE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    } finally {
      connection.release();
    }
  }

  updateStatus(work_shift_id, active) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE work_shift SET active = ? WHERE work_shift_id = ?",
        [active, work_shift_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.WORK_SHIFT",
              code: "REPOSITORY.WORK_SHIFT.UPDATE-STATUS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          if (!res || res.affectedRows === 0) {
            resolve({ code: 404, msg: "Work shift not found" });
            return;
          }
          resolve({ code: 200 });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new WorkShiftRepository(db);
};
