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
    }

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
