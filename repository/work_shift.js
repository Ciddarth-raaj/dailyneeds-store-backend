const logger = require("../utils/logger");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { buildConfigVersion, configVersionHash } = require("../utils/shift_config_version");
const { istToday } = require("../utils/istDate");

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
/**
 * Append the shift's CONFIGURATION VERSION, if it actually changed (review
 * fix #2).
 *
 * Runs on the caller's connection, inside the caller's transaction, right
 * after the live tables have been written - so the version that is stored is
 * exactly what was saved, and a save that rolls back leaves no version behind.
 *
 * NOTHING IS OVERWRITTEN. A change appends a row; an unchanged save appends
 * nothing, which is what keeps a typo fix in a shift name from filling the
 * table. Two saves on the SAME day that both change something append two rows
 * with the same `effective_from`, and the resolver breaks that tie on id -
 * newest wins - exactly as the A0 assignment history does.
 *
 * WHY TODAY AND NOT BACKDATED. A Work Shift edit made today describes the
 * shift from today. Applying it to yesterday is what this whole fix exists to
 * prevent: a settled September date must keep reading September's version.
 */
function hashOfStoredDocument(row) {
  if (!row || row.config_document === null || row.config_document === undefined) return null;
  try {
    const doc =
      typeof row.config_document === "string"
        ? JSON.parse(row.config_document)
        : row.config_document;
    if (!doc) return null;
    return configVersionHash(buildConfigVersion(doc.config, doc.schedule));
  } catch (err) {
    // An unreadable stored document is not a reason to refuse a save: it just
    // means this save cannot prove nothing changed, so it appends a version.
    return null;
  }
}

async function appendConfigVersionOnConnection(connection, work_shift_id, options = {}) {
  const [config] = await queryAsync(
    connection,
    `SELECT work_shift_id, shift_code,
            overtime_allowed, overtime_minimum_minutes,
            overtime_rounding_method, overtime_rounding_interval_minutes,
            overtime_minimum_threshold_only, maximum_ot_minutes_per_day,
            pre_shift_overtime_allowed, pre_shift_overtime_minimum_minutes,
            pre_shift_overtime_rounding_method,
            pre_shift_overtime_rounding_interval_minutes,
            late_offset_against_overtime, early_exit_offset_against_overtime
       FROM work_shift
      WHERE work_shift_id = ?`,
    [work_shift_id]
  );
  if (!config) return { appended: false, reason: "NO_SHIFT" };

  const schedule = await queryAsync(
    connection,
    `SELECT day_of_week, is_working_day,
            TIME_FORMAT(in_time, '%H:%i:%s')               AS in_time,
            TIME_FORMAT(out_time, '%H:%i:%s')              AS out_time,
            TIME_FORMAT(attendance_day_cutoff, '%H:%i:%s') AS attendance_day_cutoff,
            break_minutes, ot_rate
       FROM work_shift_weekly_schedule
      WHERE work_shift_id = ?
      ORDER BY day_of_week ASC`,
    [work_shift_id]
  );

  const document = buildConfigVersion(config, schedule || []);
  const hash = configVersionHash(document);

  const [latest] = await queryAsync(
    connection,
    `SELECT work_shift_config_version_id, config_hash, config_document
       FROM work_shift_config_version
      WHERE work_shift_id = ?
      ORDER BY effective_from DESC, work_shift_config_version_id DESC
      LIMIT 1`,
    [work_shift_id]
  );

  // Compared by RECOMPUTING the stored document's hash rather than by trusting
  // the stored `config_hash` column. The migration seeds the first version
  // straight from the live tables in SQL and leaves that column NULL, and a
  // JSON document written by MySQL does not have to serialize in the same byte
  // order as one written by Node; recomputing walks a fixed field list and is
  // therefore immune to both. It is also what stops a seeded shift nobody has
  // edited from growing a spurious second version on its next save.
  if (latest && hashOfStoredDocument(latest) === hash) {
    return { appended: false, reason: "UNCHANGED", hash };
  }

  const inserted = await queryAsync(
    connection,
    `INSERT INTO work_shift_config_version
       (work_shift_id, effective_from, config_hash, config_document, source, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      work_shift_id,
      istToday(options.effective_from),
      hash,
      JSON.stringify(document),
      options.source || "WORK_SHIFT_SAVE",
      options.created_by === undefined ? null : options.created_by,
    ]
  );

  return {
    appended: true,
    hash,
    work_shift_config_version_id: inserted ? inserted.insertId : null,
  };
}

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
  async createWorkShiftWithSchedule(config, weeklySchedule, options = {}) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const result = await queryAsync(connection, "INSERT INTO work_shift SET ?", [config]);
      const work_shift_id = result.insertId;

      await this.replaceWeeklySchedule(connection, work_shift_id, weeklySchedule);

      // The first configuration version, in the same transaction as the shift
      // it describes, so a shift can never exist without one.
      const version = await appendConfigVersionOnConnection(connection, work_shift_id, options);

      await commitAsync(connection);
      return { code: 200, work_shift_id, config_version: version };
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
  async updateWorkShiftWithSchedule(work_shift_id, config, weeklySchedule, options = {}) {
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

      // Behind the scenes, and ONLY if the content actually changed: the
      // screen, the endpoint and the response are exactly as they were.
      const version = await appendConfigVersionOnConnection(connection, work_shift_id, options);

      await commitAsync(connection);
      return { code: 200, work_shift_id, config_version: version };
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
