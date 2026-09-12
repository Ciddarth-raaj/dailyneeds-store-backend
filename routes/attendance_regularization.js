const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const { requireSelf } = require("./attendance_calculation");

/**
 * Attendance v2 / A3 - the regularization and OT approval API.
 *
 * NO FRONTEND IS BUILT FOR THIS YET, and none is assumed. These endpoints are
 * the backend a future pending-approval screen will consume; the response
 * shapes are the stable contract and nothing here decides how a queue should
 * look.
 *
 * THE PERMISSION IS NOT THE AUTHORITY. `approve_attendance_regularization`
 * says a caller may reach the decision endpoint at all; whether they may
 * decide THIS stage of THIS request is decided by
 * `utils/attendance_approval_chain.js#canApprove` from their mapped approval
 * role, their outlet, and whose request it is. A holder of the key who is not
 * the right approver gets 403 with the reason, which is why the two are
 * separate and why neither alone is enough.
 *
 * NOBODY APPROVES THEIR OWN REQUEST, administrators included. A Store
 * Manager's own request follows the Manager chain by construction, so the
 * first approver is somebody else rather than themselves-with-a-check.
 */
class AttendanceRegularizationRoutes {
  constructor(attendanceRegularizationUsecase, permissions, sensitive) {
    this.usecase = attendanceRegularizationUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.router = express.Router();

    this.init();
  }

  /** A 403 that names the reason, for the authority check the chain performs. */
  static _respond(res, err) {
    if (err && err.name === "ForbiddenError") {
      res.status(403).json({ code: 403, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  init() {
    if (this.sensitive) {
      this.router.use("/attendance/regularization", this.sensitive.filterResponse);
      this.router.use("/attendance/regularization", this.sensitive.guardWrite);
      this.router.use("/attendance/me", this.sensitive.filterResponse);
      this.router.use("/attendance/me", this.sensitive.guardWrite);
    }

    /**
     * MY ATTENDANCE: regularize a missing punch on your OWN attendance.
     *
     * The employee it is for is the caller - `req.decoded.employee_id`, from
     * the token - and the body has no field to name anybody else; Joi refuses
     * unknown keys, so `requested_for_employee_id` here is a 400, not an
     * override. No permission key: filing for yourself is self-service, and
     * `raise_attendance_regularization_for_others` remains the only way to
     * file for somebody else, on the HR route above.
     *
     * Everything else is the usecase's business, unchanged: the date must
     * actually have an odd punch count, the proposed time must land on that
     * date under the historical cutoff, the reason is required, an open
     * request already on the date is refused, and any OT the corrected day
     * creates rides the SAME request. Existing Biomax punches cannot be named
     * on this path at all, so they cannot be edited or deleted.
     */
    this.router.post("/attendance/me/regularization", requireSelf, async (req, res) => {
      try {
        const schema = {
          attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
          reason: Joi.string().min(5).max(500).required(),
          punch_time: Joi.string()
            .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/)
            .required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const employeeId = Number(req.decoded.employee_id);
        const result = await this.usecase.raiseRequest({
          actor: { employee_id: employeeId, user_type: req.decoded.user_type },
          requested_for_employee_id: employeeId,
          attendance_date: req.body.attendance_date,
          reason: req.body.reason,
          punch_time: req.body.punch_time,
        });
        res.json({ code: 200, ...result });
      } catch (err) {
        AttendanceRegularizationRoutes._respond(res, err);
      }
    });

    /**
     * Raise a request for one date.
     *
     * Raising one for SOMEBODY ELSE takes a second key: a manager filing on
     * behalf of a team member is a different act from an employee filing their
     * own, and the audit trail records both ids either way.
     */
    this.router.post(
      "/attendance/regularization",
      this.permissions.require(P.RAISE_ATTENDANCE_REGULARIZATION),
      async (req, res) => {
        try {
          const schema = {
            requested_for_employee_id: Joi.number().integer().positive().optional(),
            attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
            reason: Joi.string().min(5).max(500).required(),
            punch_time: Joi.string()
              .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/)
              .optional(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) throw isValid.error;

          const actorId = Number(req.decoded.employee_id);
          const forId = req.body.requested_for_employee_id
            ? Number(req.body.requested_for_employee_id)
            : actorId;

          if (
            forId !== actorId &&
            !(await this.permissions.has(req, P.RAISE_ATTENDANCE_REGULARIZATION_FOR_OTHERS))
          ) {
            res.status(403).json({
              code: 403,
              msg: "Raising a request for somebody else needs raise_attendance_regularization_for_others",
            });
            return;
          }

          const result = await this.usecase.raiseRequest({
            actor: { employee_id: actorId, user_type: req.decoded.user_type },
            requested_for_employee_id: forId,
            attendance_date: req.body.attendance_date,
            reason: req.body.reason,
            punch_time: req.body.punch_time || null,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

    /** The queue: requests whose current stage this caller could decide. */
    this.router.get(
      "/attendance/regularization/pending",
      this.permissions.require(P.VIEW_ATTENDANCE_APPROVALS),
      async (req, res) => {
        try {
          const schema = { limit: Joi.number().integer().min(1).max(500).optional() };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.listPending({
            actor: {
              employee_id: Number(req.decoded.employee_id),
              user_type: req.decoded.user_type,
            },
            limit: req.query.limit ? Number(req.query.limit) : 200,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

    /** One request with its whole chain and every decision taken on it. */
    this.router.get(
      "/attendance/regularization/:request_id",
      this.permissions.require(P.VIEW_ATTENDANCE_APPROVALS),
      async (req, res) => {
        try {
          const request = await this.usecase.getRequest(Number(req.params.request_id));
          if (!request) {
            res.status(404).json({ code: 404, msg: "No such request" });
            return;
          }
          res.json({ code: 200, request });
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

    /**
     * Decide the current stage.
     *
     * A final approval recalculates the date in the same request, which is
     * what turns the regularized punch into worked minutes and the candidate
     * OT into payable OT. Both writes are idempotent, so a retry is safe.
     */
    this.router.post(
      "/attendance/regularization/:request_id/decision",
      this.permissions.require(P.APPROVE_ATTENDANCE_REGULARIZATION),
      async (req, res) => {
        try {
          const schema = {
            decision: Joi.string().valid("APPROVED", "REJECTED").required(),
            remarks: Joi.string().allow("").max(500).optional(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.decide({
            actor: {
              employee_id: Number(req.decoded.employee_id),
              user_type: req.decoded.user_type,
            },
            request_id: Number(req.params.request_id),
            decision: req.body.decision,
            remarks: req.body.remarks || null,
          });
          res.status(result.code === 409 ? 409 : 200).json(result);
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

  }

  getRouter() {
    return this.router;
  }
}

module.exports = (attendanceRegularizationUsecase, permissions, sensitive) =>
  new AttendanceRegularizationRoutes(attendanceRegularizationUsecase, permissions, sensitive);
module.exports.AttendanceRegularizationRoutes = AttendanceRegularizationRoutes;
