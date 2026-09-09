const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { withLegacyColumns } = require("../utils/shiftSchedule");

const WEEKLY_SCHEDULE_COLUMNS = [
  "shift_id",
  "day_of_week",
  "is_working_day",
  "in_time",
  "out_time",
  "attendance_day_cutoff",
  "break_minutes",
  "normal_work_minutes",
  "ot_rate",
];

class ShiftRepository {
    constructor(db) {
        this.db = db;
    }

    get() {
        return new Promise((resolve, reject) => {
            this.db.query(
                "SELECT * FROM shift_master",
                [],
                (err, docs) => {
                    if (err) {
                        logger.Log({
                            level: logger.LEVEL.ERROR,
                            component: "REPOSITORY.SHIFT",
                            code: "REPOSITORY.SHIFT.GET",
                            description: err.toString(),
                            category: "",
                            ref: {},
                        });
                        reject(err);
                        return;
                    }
                    resolve(docs)
                }
            );
        });
    }
    updateStatus(file) {
      return new Promise((resolve, reject) => {
        this.db.query(
          "UPDATE shift_master SET status = ?, active = ? WHERE shift_id = ?",
          [file.status, Number(file.status) === 0 ? 0 : 1, file.shift_id],
          (err, docs) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.SHIFT",
                code: "REPOSITORY.SHIFT.UPDATE-STATUS",
                description: err.toString(),
                category: "",
                ref: {},
              });
              reject(err);
              return;
            }
            resolve(docs);
          });
      });
    }
    updateShiftDetails(data, shift_id) {
      return new Promise((resolve, reject) => {
        this.db.query(
          `UPDATE shift_master SET ? WHERE shift_id = ?`,
          [withLegacyColumns(data), shift_id],
          (err, res) => {
            if (err) {
                if (err.code === "ER_DUP_ENTRY") {
                  resolve({ code: 101, msg: "A shift with that shift_code already exists" });
                  return;
                }
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.SHIFT",
                  code: "REPOSITORY.SHIFT.UPDATE-SHIFT-DETAILS",
                  description: err.toString(),
                  category: "",
                  ref: {},
                });
              reject(err);
              return;
            }
            resolve({ code: 200 });
          }
        );
      });
    }
    getShiftById(shift_id) {
      return new Promise((resolve, reject) => {
        this.db.query("SELECT * FROM shift_master where shift_id = ?",
        [shift_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SHIFT",
              code: "REPOSITORY.SHIFT.GET-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
      });
    }
    /** The weekly schedule rows for one shift, Sunday first. */
    getWeeklySchedule(shift_id) {
      return new Promise((resolve, reject) => {
        this.db.query(
          `SELECT shift_weekly_schedule_id, shift_id, day_of_week, is_working_day,
                  in_time, out_time, attendance_day_cutoff, break_minutes,
                  normal_work_minutes, ot_rate, created_at, updated_at
             FROM shift_weekly_schedule
            WHERE shift_id = ?
            ORDER BY day_of_week ASC`,
          [shift_id],
          (err, rows) => {
            if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.SHIFT",
                code: "REPOSITORY.SHIFT.GET-WEEKLY-SCHEDULE",
                description: err.toString(),
                category: "",
                ref: {},
              });
              reject(err);
              return;
            }
            resolve((rows || []).map((row) => ({
              ...row,
              is_working_day: Boolean(row.is_working_day),
              ot_rate: Number(row.ot_rate),
            })));
          }
        );
      });
    }

    /** A shift's configuration together with its weekly schedule, or null. */
    async getShiftWithSchedule(shift_id) {
      const rows = await this.getShiftById(shift_id);
      const shift = rows && rows[0];
      if (!shift) return null;

      const weekly_schedule = await this.getWeeklySchedule(shift_id);
      return { ...shift, weekly_schedule };
    }

    /**
     * Write the supplied rows as the shift's complete weekly schedule.
     *
     * Days present are upserted on the (shift_id, day_of_week) unique key, so
     * a day that already exists keeps its id; days absent from `rows` are
     * removed. Runs on a caller-supplied connection so it can share the
     * caller's transaction.
     */
    async replaceWeeklySchedule(connection, shift_id, rows) {
      const keptDays = rows.map((row) => row.day_of_week);

      if (keptDays.length === 0) {
        await queryAsync(connection, "DELETE FROM shift_weekly_schedule WHERE shift_id = ?", [
          shift_id,
        ]);
        return;
      }

      await queryAsync(
        connection,
        "DELETE FROM shift_weekly_schedule WHERE shift_id = ? AND day_of_week NOT IN (?)",
        [shift_id, keptDays]
      );

      const values = rows.map((row) => [
        shift_id,
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
        (column) => column !== "shift_id" && column !== "day_of_week"
      )
        .map((column) => `${column} = VALUES(${column})`)
        .join(", ");

      await queryAsync(
        connection,
        `INSERT INTO shift_weekly_schedule (${WEEKLY_SCHEDULE_COLUMNS.join(", ")})
         VALUES ?
         ON DUPLICATE KEY UPDATE ${updates}`,
        [values]
      );
    }

    /**
     * Create a shift and its weekly schedule in one transaction, so a shift
     * never lands without the schedule that was saved with it.
     *
     * @param {object} config normalized shift_master fields
     * @param {object[]|null} weeklySchedule normalized rows, or null to skip
     */
    async createShiftWithSchedule(config, weeklySchedule) {
      const connection = await getConnectionAsync(this.db);
      try {
        await beginTransactionAsync(connection);

        const result = await queryAsync(
          connection,
          "INSERT INTO shift_master SET ?",
          [withLegacyColumns(config)]
        );
        const shift_id = result.insertId;

        if (weeklySchedule) {
          await this.replaceWeeklySchedule(connection, shift_id, weeklySchedule);
        }

        await commitAsync(connection);
        return { code: 200, shift_id, id: shift_id };
      } catch (err) {
        await rollbackAsync(connection);
        if (err.code === "ER_DUP_ENTRY") {
          return { code: 101, msg: "A shift with that shift_code already exists" };
        }
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.SHIFT",
          code: "REPOSITORY.SHIFT.CREATE-WITH-SCHEDULE",
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
     * Update a shift's configuration and/or its weekly schedule atomically.
     *
     * `config` may be empty (schedule-only save) and `weeklySchedule` may be
     * null (configuration-only save, schedule left alone).
     */
    async updateShiftWithSchedule(shift_id, config, weeklySchedule) {
      const connection = await getConnectionAsync(this.db);
      try {
        await beginTransactionAsync(connection);

        const existing = await queryAsync(
          connection,
          "SELECT shift_id FROM shift_master WHERE shift_id = ?",
          [shift_id]
        );
        if (!existing || existing.length === 0) {
          await rollbackAsync(connection);
          return { code: 404, msg: "Shift not found" };
        }

        if (config && Object.keys(config).length > 0) {
          await queryAsync(connection, "UPDATE shift_master SET ? WHERE shift_id = ?", [
            withLegacyColumns(config),
            shift_id,
          ]);
        }

        if (weeklySchedule) {
          await this.replaceWeeklySchedule(connection, shift_id, weeklySchedule);
        }

        await commitAsync(connection);
        return { code: 200, shift_id };
      } catch (err) {
        await rollbackAsync(connection);
        if (err.code === "ER_DUP_ENTRY") {
          return { code: 101, msg: "A shift with that shift_code already exists" };
        }
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.SHIFT",
          code: "REPOSITORY.SHIFT.UPDATE-WITH-SCHEDULE",
          description: err.toString(),
          category: "",
          ref: {},
        });
        throw err;
      } finally {
        connection.release();
      }
    }
}

module.exports = (db) => {
    return new ShiftRepository(db);
};
