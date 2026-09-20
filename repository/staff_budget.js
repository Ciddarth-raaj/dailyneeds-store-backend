const logger = require("../utils/logger");
const { representativeWindow } = require("../utils/staffBudget");
const {
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

/**
 * The Staff Budget Master.
 *
 * `staff_budget`, `staff_budget_rate` and `staff_budget_history` only. The
 * four masters (`outlets`, `department`, `designation`, `work_shift`) are
 * READ for their names, their active flags and - for the work shift - its
 * weekly schedule, and are never written here.
 *
 * THE SHIFT MASTER IS `work_shift`, the one the attendance engine resolves
 * against. `shift_master` and `new_employee.shift_id` are the legacy pair and
 * appear in no query in this file. Neither does the legacy `budget` table of
 * the old /store-budget screen.
 *
 * A work shift's times live per weekday in `work_shift_weekly_schedule`, so
 * every read that needs a window fetches those rows and reduces them with
 * `representativeWindow` - one place, so the plan and the screen always agree
 * on what "the 2-10 shift" runs.
 *
 * NAMES COME OUT OF THE JOIN, IDS GO IN. The screen works in names, so every
 * read returns them; every write takes ids. No query matches a master row by
 * its display name.
 */

/**
 * One row per approved combination, with everything the screen displays.
 *
 * INNER JOINs on purpose, unlike the LEFT JOIN convention elsewhere in this
 * backend: a budget row whose master has gone is a row the screen cannot
 * label, and the foreign keys mean it cannot happen. `staff_budget_rate` is
 * the one LEFT JOIN - a missing rate is the normal case for every designation
 * except the two that are priced.
 */
const BUDGET_SELECT = `
  SELECT
    sb.staff_budget_id,
    sb.outlet_id,
    o.outlet_name,
    sb.department_id,
    d.department_name,
    sb.designation_id,
    dg.designation_name,
    sb.work_shift_id,
    ws.shift_name,
    ws.shift_code,
    ws.active AS shift_active,
    sb.approved_headcount,
    r.monthly_rate,
    sb.updated_at
  FROM staff_budget sb
  JOIN outlets o ON o.outlet_id = sb.outlet_id
  JOIN department d ON d.department_id = sb.department_id
  JOIN designation dg ON dg.designation_id = sb.designation_id
  JOIN work_shift ws ON ws.work_shift_id = sb.work_shift_id
  LEFT JOIN staff_budget_rate r
    ON r.designation_id = sb.designation_id
   AND r.work_shift_id = sb.work_shift_id
   AND r.status = 1
  WHERE sb.status = 1
`;

class StaffBudgetRepository {
  constructor(db) {
    this.db = db;
  }

  log(code, err) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.STAFF_BUDGET",
      code: `REPOSITORY.STAFF_BUDGET.${code}`,
      description: err.toString(),
      category: "",
      ref: {},
    });
  }

  /**
   * The working-day window of every work shift named in `workShiftIds`.
   *
   * One query for the whole screen rather than one per shift, reduced through
   * `representativeWindow` so that a shift running different hours on
   * different working days is reported as its usual window plus the fact that
   * it varies - never averaged, never silently picked from a Sunday.
   */
  async getShiftWindows(workShiftIds) {
    if (!workShiftIds || workShiftIds.length === 0) return new Map();
    try {
      const rows = await queryAsync(
        this.db,
        `SELECT work_shift_id, day_of_week, is_working_day, in_time, out_time
           FROM work_shift_weekly_schedule
          WHERE work_shift_id IN (?)
          ORDER BY work_shift_id, day_of_week`,
        [workShiftIds]
      );

      const byShift = new Map();
      for (const row of rows) {
        if (!byShift.has(row.work_shift_id)) byShift.set(row.work_shift_id, []);
        byShift.get(row.work_shift_id).push(row);
      }

      const windows = new Map();
      for (const [work_shift_id, schedule] of byShift) {
        windows.set(work_shift_id, representativeWindow(schedule));
      }
      return windows;
    } catch (err) {
      this.log("GET-SHIFT-WINDOWS", err);
      throw err;
    }
  }

  /**
   * Every active budget row, optionally narrowed to one location, each with
   * its work shift's window attached.
   *
   * The window is a second query rather than a join: `work_shift` keeps seven
   * rows per shift, so joining them here would multiply every budget row by
   * seven and leave the caller to collapse it. Two queries and a Map is the
   * cheaper and the clearer of the two.
   *
   * Ordering is done again in utils/staffBudget.js when the tree is built; it
   * is here too so that a caller reading the flat rows (an export, a test)
   * gets them in the same order the screen shows.
   */
  async getBudgetRows({ outlet_id } = {}) {
    try {
      const where = outlet_id === undefined || outlet_id === null ? "" : " AND sb.outlet_id = ?";
      const params = where ? [outlet_id] : [];
      const rows = await queryAsync(
        this.db,
        `${BUDGET_SELECT}${where}
         ORDER BY o.outlet_name, d.department_name, dg.designation_name, ws.shift_name`,
        params
      );

      const windows = await this.getShiftWindows([
        ...new Set(rows.map((row) => row.work_shift_id)),
      ]);

      return rows.map((row) => {
        const window = windows.get(row.work_shift_id) || {
          in_time: null,
          out_time: null,
          varies: false,
        };
        return {
          ...row,
          in_time: window.in_time,
          out_time: window.out_time,
          schedule_varies: window.varies,
        };
      });
    } catch (err) {
      this.log("GET-BUDGET-ROWS", err);
      throw err;
    }
  }

  /**
   * The four masters, active rows only, for the pickers on the screen.
   *
   * The shift master is `work_shift`, whose `active` flag is an explicit
   * TINYINT(1) defaulting to 1 - unlike the legacy `shift_master.status`,
   * which defaults to 0 and is not read anywhere in this feature. Each work
   * shift comes back with its working-day window so the picker can show
   * "2 PM - 10 PM" beside the name.
   */
  async getMasters() {
    try {
      const [outlets, departments, designations, shifts] = await Promise.all([
        queryAsync(
          this.db,
          `SELECT outlet_id, outlet_name, outlet_nickname, is_active
             FROM outlets WHERE is_active = 1 ORDER BY outlet_name`,
          []
        ),
        queryAsync(
          this.db,
          `SELECT department_id, department_name, status
             FROM department WHERE status = 1 ORDER BY department_name`,
          []
        ),
        queryAsync(
          this.db,
          `SELECT designation_id, designation_name, status
             FROM designation WHERE status = 1 ORDER BY designation_name`,
          []
        ),
        queryAsync(
          this.db,
          `SELECT work_shift_id, shift_code, shift_name, active
             FROM work_shift WHERE active = 1 ORDER BY shift_name`,
          []
        ),
      ]);

      const windows = await this.getShiftWindows(
        shifts.map((shift) => shift.work_shift_id)
      );

      return {
        outlets,
        departments,
        designations,
        shifts: shifts.map((shift) => {
          const window = windows.get(shift.work_shift_id) || {
            in_time: null,
            out_time: null,
            varies: false,
          };
          return {
            ...shift,
            in_time: window.in_time,
            out_time: window.out_time,
            schedule_varies: window.varies,
          };
        }),
      };
    } catch (err) {
      this.log("GET-MASTERS", err);
      throw err;
    }
  }

  /**
   * Which of the four ids actually exist and are active.
   *
   * Answers all four in one round trip and reports each separately, so the
   * caller can tell the user WHICH master is wrong instead of "invalid
   * selection".
   */
  async checkMasters({ outlet_id, department_id, designation_id, work_shift_id }) {
    try {
      const [outlet, department, designation, shift] = await Promise.all([
        queryAsync(this.db, "SELECT outlet_id, is_active FROM outlets WHERE outlet_id = ?", [outlet_id]),
        queryAsync(this.db, "SELECT department_id, status FROM department WHERE department_id = ?", [department_id]),
        queryAsync(this.db, "SELECT designation_id, status FROM designation WHERE designation_id = ?", [designation_id]),
        queryAsync(
          this.db,
          "SELECT work_shift_id, active FROM work_shift WHERE work_shift_id = ?",
          [work_shift_id]
        ),
      ]);

      return {
        outlet: { found: outlet.length > 0, active: outlet.length > 0 && Number(outlet[0].is_active) === 1 },
        department: { found: department.length > 0, active: department.length > 0 && Number(department[0].status) === 1 },
        designation: { found: designation.length > 0, active: designation.length > 0 && Number(designation[0].status) === 1 },
        shift: {
          found: shift.length > 0,
          active: shift.length > 0 && Number(shift[0].active) === 1,
        },
      };
    } catch (err) {
      this.log("CHECK-MASTERS", err);
      throw err;
    }
  }

  /**
   * Create or update the approved headcount for one combination, and record
   * the change.
   *
   * ONE ROW PER COMBINATION IS THE DATABASE'S RULE, not this method's: the
   * unique key decides, and this reads the existing row inside the
   * transaction so that two people saving the same combination at once end
   * with one row and two history entries rather than a duplicate.
   *
   * A combination that was removed from the plan (`status` 0) is REVIVED
   * rather than duplicated, keeping its history attached.
   *
   * History is appended only when the number actually moved. Re-saving the
   * same figure is not a change and does not deserve a history row.
   */
  async upsertBudget({ outlet_id, department_id, designation_id, work_shift_id, approved_headcount }, actorId) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      const existing = await queryAsync(
        connection,
        `SELECT staff_budget_id, approved_headcount, status
           FROM staff_budget
          WHERE outlet_id = ? AND department_id = ? AND designation_id = ? AND work_shift_id = ?
          FOR UPDATE`,
        [outlet_id, department_id, designation_id, work_shift_id]
      );

      let staff_budget_id;
      let old_headcount = null;
      let created = false;

      if (existing.length === 0) {
        const result = await queryAsync(
          connection,
          `INSERT INTO staff_budget
             (outlet_id, department_id, designation_id, work_shift_id, approved_headcount, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [outlet_id, department_id, designation_id, work_shift_id, approved_headcount, actorId, actorId]
        );
        staff_budget_id = result.insertId;
        created = true;
      } else {
        staff_budget_id = existing[0].staff_budget_id;
        // A revived row's previous figure is still the previous figure: the
        // history says what the number was, and "it was switched off in
        // between" is not a different number.
        old_headcount = Number(existing[0].approved_headcount);
        created = Number(existing[0].status) !== 1;

        await queryAsync(
          connection,
          `UPDATE staff_budget
              SET approved_headcount = ?, status = 1, updated_by = ?
            WHERE staff_budget_id = ?`,
          [approved_headcount, actorId, staff_budget_id]
        );
      }

      if (old_headcount === null || old_headcount !== Number(approved_headcount)) {
        await queryAsync(
          connection,
          `INSERT INTO staff_budget_history
             (staff_budget_id, old_headcount, new_headcount, changed_by)
           VALUES (?, ?, ?, ?)`,
          [staff_budget_id, old_headcount, approved_headcount, actorId]
        );
      }

      await commitAsync(connection);
      return { staff_budget_id, created };
    } catch (err) {
      await rollbackAsync(connection);
      this.log("UPSERT-BUDGET", err);
      throw err;
    } finally {
      connection.release();
    }
  }

  /** The combination a budget row stands for, or null. */
  async getBudgetById(staff_budget_id) {
    try {
      const rows = await queryAsync(
        this.db,
        `SELECT staff_budget_id, outlet_id, department_id, designation_id, work_shift_id,
                approved_headcount, status
           FROM staff_budget WHERE staff_budget_id = ?`,
        [staff_budget_id]
      );
      return rows.length === 0 ? null : rows[0];
    } catch (err) {
      this.log("GET-BUDGET-BY-ID", err);
      throw err;
    }
  }

  /**
   * Take a combination out of the plan.
   *
   * `status = 0`, never a DELETE: the history of what was approved, and by
   * whom, survives the combination being retired, and re-adding it later
   * reuses the same row.
   */
  async deactivateBudget(staff_budget_id, actorId) {
    try {
      const result = await queryAsync(
        this.db,
        "UPDATE staff_budget SET status = 0, updated_by = ? WHERE staff_budget_id = ? AND status = 1",
        [actorId, staff_budget_id]
      );
      return result.affectedRows > 0;
    } catch (err) {
      this.log("DEACTIVATE-BUDGET", err);
      throw err;
    }
  }

  /** What an approved headcount used to be, newest first. */
  async getHistory(staff_budget_id) {
    try {
      return await queryAsync(
        this.db,
        `SELECT h.staff_budget_history_id, h.staff_budget_id, h.old_headcount,
                h.new_headcount, h.changed_by, e.employee_name AS changed_by_name,
                h.changed_at
           FROM staff_budget_history h
           LEFT JOIN new_employee e ON e.employee_id = h.changed_by
          WHERE h.staff_budget_id = ?
          ORDER BY h.changed_at DESC, h.staff_budget_history_id DESC`,
        [staff_budget_id]
      );
    } catch (err) {
      this.log("GET-HISTORY", err);
      throw err;
    }
  }

  /** Every configured monthly rate, with the names and windows the screen
   *  shows. */
  async getRates() {
    try {
      const rows = await queryAsync(
        this.db,
        `SELECT r.staff_budget_rate_id, r.designation_id, dg.designation_name,
                r.work_shift_id, ws.shift_name, ws.shift_code,
                r.monthly_rate, r.status, r.updated_at
           FROM staff_budget_rate r
           JOIN designation dg ON dg.designation_id = r.designation_id
           JOIN work_shift ws ON ws.work_shift_id = r.work_shift_id
          WHERE r.status = 1
          ORDER BY dg.designation_name, ws.shift_name`,
        []
      );
      const windows = await this.getShiftWindows([
        ...new Set(rows.map((row) => row.work_shift_id)),
      ]);

      return rows.map((row) => {
        const window = windows.get(row.work_shift_id) || {
          in_time: null,
          out_time: null,
          varies: false,
        };
        return {
          ...row,
          in_time: window.in_time,
          out_time: window.out_time,
          schedule_varies: window.varies,
        };
      });
    } catch (err) {
      this.log("GET-RATES", err);
      throw err;
    }
  }

  /**
   * Write monthly rates, keyed by the ids the caller resolved.
   *
   * One transaction for the whole set: a half-applied rate table would price
   * some shifts of a designation and not others, and a location total built
   * from that would look complete while being wrong.
   */
  async upsertRates(rates, actorId) {
    const connection = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(connection);

      let created = 0;
      let updated = 0;
      for (const rate of rates) {
        const result = await queryAsync(
          connection,
          `INSERT INTO staff_budget_rate
             (designation_id, work_shift_id, monthly_rate, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             monthly_rate = VALUES(monthly_rate),
             status = 1,
             updated_by = VALUES(updated_by)`,
          [rate.designation_id, rate.work_shift_id, rate.monthly_rate, actorId, actorId]
        );
        // mysql reports 1 for an insert and 2 for an update that changed a
        // row; 0 means the row was already exactly this.
        if (result.affectedRows === 1) created += 1;
        else if (result.affectedRows >= 2) updated += 1;
      }

      await commitAsync(connection);
      return { created, updated, unchanged: rates.length - created - updated };
    } catch (err) {
      await rollbackAsync(connection);
      this.log("UPSERT-RATES", err);
      throw err;
    } finally {
      connection.release();
    }
  }
}

module.exports = (db) => {
  return new StaffBudgetRepository(db);
};
