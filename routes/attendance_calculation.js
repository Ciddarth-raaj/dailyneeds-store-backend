const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

/**
 * Attendance v2 - the calculated attendance and monthly payroll API.
 *
 * READ AND RECALCULATE ONLY. Nothing on this router creates, edits or deletes
 * a punch; the only writes it can cause are to `attendance_day_calculation`
 * and `attendance_monthly_payroll`, both of which are derived tables that can
 * be dropped and recomputed. `biomax_punch` is not reachable from here.
 *
 * NO NEW SCREEN IS ASSUMED. These are stable backend outputs for a frontend
 * that has not been designed yet: the response shape is the contract the v2
 * handoff names, field for field, and it deliberately does not decide how any
 * of it should be displayed.
 *
 * PERMISSIONS. Reading calculated attendance is `view_calculated_attendance`;
 * re-running the engine is `recalculate_attendance`, a separate key because
 * re-running it rewrites what payroll will read. The monthly roll-up has its
 * own key again - somebody who may look at worked minutes is not thereby
 * entitled to see what those minutes are worth.
 *
 * B3 APPLIES HERE TOO. `filterResponse` and `guardWrite` are mounted exactly
 * as they are on /hr, so this router cannot become a way around
 * `view_employee_sensitive`. Nothing here selects a sensitive column in the
 * first place; the middleware is the guarantee rather than the mechanism.
 */
/**
 * The self-only guard for `/attendance/me`.
 *
 * NO PERMISSION KEY, and deliberately so: reading your own attendance is not
 * "view everybody's calculated attendance", and a designation that holds
 * neither key must still be able to see its own month. What it needs instead
 * is an EMPLOYEE identity - `req.decoded.employee_id`, set by the auth
 * middleware from the token and never from the request. A system account has
 * no employee and is refused; an unauthenticated call is refused by the auth
 * middleware before this runs, and refused again here in case it is mounted
 * without it.
 *
 * The handlers behind it never read an employee id from the query, body or
 * path, and their schemas REJECT one (Joi refuses unknown keys), so there is
 * no parameter an employee could manipulate to see somebody else.
 */
function requireSelf(req, res, next) {
  if (!req.decoded) {
    res.status(401).json({ code: 401, msg: "Unauthorized" });
    return;
  }
  const employeeId = Number(req.decoded.employee_id);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    res.status(403).json({ code: 403, msg: "This account is not linked to an employee" });
    return;
  }
  next();
}
requireSelf.__guard = { mode: "self", keys: [] };

class AttendanceCalculationRoutes {
  constructor(attendanceCalculationUsecase, permissions, sensitive) {
    this.usecase = attendanceCalculationUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.router = express.Router();

    this.init();
  }

  init() {
    if (this.sensitive) {
      this.router.use("/attendance/calculated", this.sensitive.filterResponse);
      this.router.use("/attendance/calculated", this.sensitive.guardWrite);
      this.router.use("/attendance/payroll", this.sensitive.filterResponse);
      this.router.use("/attendance/payroll", this.sensitive.guardWrite);
      this.router.use("/attendance/me", this.sensitive.filterResponse);
      this.router.use("/attendance/me", this.sensitive.guardWrite);
    }

    /**
     * MY ATTENDANCE: the caller's own calculated attendance, read-only.
     *
     * `employee_id` comes from `req.decoded` and from nowhere else. The query
     * schema has no such field, and Joi refuses unknown keys, so a request
     * that tries to pass one is rejected rather than ignored. This is the same
     * preview path as `/attendance/calculated`: it calculates and returns, it
     * stores nothing, and it queues nothing - the OT auto-queue runs only
     * after a STORED recalculation, which this is not.
     */
    this.router.get("/attendance/me", requireSelf, async (req, res) => {
      try {
        const schema = {
          from_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
          to_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
        };
        const isValid = Joi.validate(req.query, schema);
        if (isValid.error !== null) throw isValid.error;

        const employee_id = Number(req.decoded.employee_id);
        const days = await this.usecase.calculateRange({
          employee_id,
          from_date: req.query.from_date,
          to_date: req.query.to_date,
        });
        res.json({ code: 200, employee_id, days });
      } catch (err) {
        respondError(res, err);
      }
    });

    /**
     * Calculate a date range WITHOUT storing anything.
     *
     * The preview a reviewer is shown and the rows that get stored come from
     * one code path, so what was approved is what lands.
     */
    this.router.get(
      "/attendance/calculated",
      this.permissions.require(P.VIEW_CALCULATED_ATTENDANCE),
      async (req, res) => {
        try {
          const schema = {
            employee_id: Joi.number().integer().positive().required(),
            from_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
            to_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
          };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) throw isValid.error;

          const days = await this.usecase.calculateRange({
            employee_id: Number(req.query.employee_id),
            from_date: req.query.from_date,
            to_date: req.query.to_date,
          });
          res.json({ code: 200, days });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * Recalculate a range and store the result.
     *
     * Idempotent: the unique key on (employee_id, attendance_date) makes a
     * re-run an update of the same rows, so a retried request can never
     * produce a second calculation for a date.
     */
    this.router.post(
      "/attendance/calculated/recalculate",
      this.permissions.require(P.RECALCULATE_ATTENDANCE),
      async (req, res) => {
        try {
          const schema = {
            employee_id: Joi.number().integer().positive().required(),
            from_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
            to_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.recalculateRange({
            employee_id: Number(req.body.employee_id),
            from_date: req.body.from_date,
            to_date: req.body.to_date,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * The A4 monthly roll-up for one employee.
     *
     * `persist=true` stores the month as well as returning it, and needs the
     * recalculate key on top of the read key - storing is what payroll will
     * later read, and that is a different decision from looking.
     */
    this.router.get(
      "/attendance/payroll/monthly",
      this.permissions.require(P.VIEW_ATTENDANCE_PAYROLL),
      async (req, res) => {
        try {
          const schema = {
            employee_id: Joi.number().integer().positive().required(),
            year: Joi.number().integer().min(2000).max(2100).required(),
            month: Joi.number().integer().min(1).max(12).required(),
            persist: Joi.string().valid("true", "false").optional(),
          };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) throw isValid.error;

          const persist = req.query.persist === "true";
          if (persist && !(await this.permissions.has(req, P.RECALCULATE_ATTENDANCE))) {
            res.status(403).json({
              code: 403,
              msg: "Storing a month needs recalculate_attendance as well",
            });
            return;
          }

          const result = await this.usecase.calculateMonth({
            employee_id: Number(req.query.employee_id),
            year: Number(req.query.year),
            month: Number(req.query.month),
            persist,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );


    /**
     * The SINGLE-DATE shift edit.
     *
     * `edit_attendance_date_shift`, granted by migration to nobody. Body is
     * exactly the finalized UX: which employee, which date, which shift. There
     * is no effective-from, no effective-to, no range and no reason field -
     * the audit line is the override row itself (employee, date, shift before,
     * shift after, who, when). The usecase changes that one date, recalculates
     * it in the same transaction, and leaves the employee's current shift and
     * the neighbouring dates alone.
     *
     * This is NOT the `/hr/work-shift-assignments/correction` path, whose
     * effective-from semantics would move every later date as well.
     */
    this.router.post(
      "/attendance/calculated/date-shift",
      this.permissions.require(P.EDIT_ATTENDANCE_DATE_SHIFT),
      async (req, res) => {
        try {
          const schema = {
            employee_id: Joi.number().integer().positive().required(),
            attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
            work_shift_id: Joi.number().integer().positive().required(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.setDateShift({
            employee_id: Number(req.body.employee_id),
            attendance_date: req.body.attendance_date,
            work_shift_id: Number(req.body.work_shift_id),
            actor_employee_id:
              req.decoded && req.decoded.employee_id !== undefined ? req.decoded.employee_id : null,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          if (err && err.name === "NotFoundError") {
            res.status(404).json({ code: 404, msg: err.message });
            return;
          }
          respondError(res, err);
        }
      }
    );

    /** The active shifts the Edit Shift dropdown offers. Same key as the edit. */
    this.router.get(
      "/attendance/calculated/date-shift/options",
      this.permissions.require(P.EDIT_ATTENDANCE_DATE_SHIFT),
      async (req, res) => {
        try {
          res.json({ code: 200, options: await this.usecase.listDateShiftOptions() });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * The employee's Special Break Duration Override.
     *
     * ONE CURRENT VALUE AND NO EFFECTIVE DATE (review fix #7), because that is
     * what the approved v2 product contract describes: one field on Employee
     * Master, nullable. There is deliberately no `effective_from` on this
     * path, no history endpoint and no dated semantics to introduce later by
     * accident.
     *
     * `manage_employee_break_override` is granted by migration to nobody:
     * changing somebody's allowed break changes their NRM and therefore their
     * pay, so an administrator grants it deliberately.
     */
    this.router.get(
      "/attendance/calculated/break-override/:employee_id",
      this.permissions.require(P.VIEW_CALCULATED_ATTENDANCE),
      async (req, res) => {
        try {
          res.json({ code: 200, ...(await this.usecase.getBreakOverride(req.params.employee_id)) });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    this.router.post(
      "/attendance/calculated/break-override",
      this.permissions.require(P.MANAGE_EMPLOYEE_BREAK_OVERRIDE),
      async (req, res) => {
        try {
          const schema = {
            employee_id: Joi.number().integer().positive().required(),
            // null CLEARS the override. It is not the same as 0, which is the
            // real setting "charge this employee no break at all".
            minutes: Joi.number().integer().min(0).max(1439).allow(null).required(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) throw isValid.error;

          res.json({
            code: 200,
            ...(await this.usecase.setBreakOverride({
              employee_id: Number(req.body.employee_id),
              minutes: req.body.minutes,
            })),
          });
        } catch (err) {
          respondError(res, err);
        }
      }
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (attendanceCalculationUsecase, permissions, sensitive) =>
  new AttendanceCalculationRoutes(attendanceCalculationUsecase, permissions, sensitive);
module.exports.AttendanceCalculationRoutes = AttendanceCalculationRoutes;
module.exports.requireSelf = requireSelf;
