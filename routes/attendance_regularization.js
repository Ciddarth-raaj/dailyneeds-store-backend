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
  constructor(attendanceRegularizationUsecase, permissions, sensitive, branchScope = null) {
    this.usecase = attendanceRegularizationUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    /**
     * `middlewares/employee_branch_scope.js`. It is what resolves WHICH
     * OUTLETS this caller may see requests from, from the server's own facts
     * and never from the query string. The approval usecase fails closed
     * without it, so a wiring that forgets it shows an empty queue rather
     * than the whole company.
     */
    this.branchScope = branchScope;
    this.router = express.Router();

    this.init();
  }

  /** The actor, with its outlet scope attached. Never from the client. */
  async _actor(req) {
    if (this.branchScope && typeof this.branchScope.actorFor === "function") {
      const actor = await this.branchScope.actorFor(req);
      return {
        ...actor,
        employee_id: Number(req.decoded.employee_id),
        user_type: req.decoded.user_type,
      };
    }
    return { employee_id: Number(req.decoded.employee_id), user_type: req.decoded.user_type };
  }

  /** A 403 that names the reason, for the authority check the chain performs. */
  static _respond(res, err) {
    if (err && err.name === "ForbiddenError") {
      res.status(403).json({ code: 403, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  /**
   * THE SHIFT KEYS ARE AN ADDITIONAL GATE, NEVER A REPLACEMENT.
   *
   * `view_attendance_approvals` and `approve_attendance_regularization` still
   * decide whether a caller may reach the approval API at all; these two
   * middlewares add `view_shift_change_requests` / `approve_shift_change_request`
   * ON TOP of them, and only for SHIFT_CHANGE. Attendance and OT pass through
   * both untouched, which is why the generic key is never re-checked here:
   * its own middleware has already run.
   *
   * `permissions.hasAll` is the repo's own finer-grained check, so the
   * administrator bypass (`user_type` 2 -> "allow all") continues to work
   * exactly as it does for every other key rather than being special-cased.
   *
   * THE AUTHORITY CHECK IS UNCHANGED AND STILL MANDATORY. Holding both keys
   * only gets the caller as far as `canApprove`, which decides whether they
   * may act on THIS stage of THIS request from their mapped role, their
   * outlet and whose request it is.
   */
  static _forbidden(res) {
    res.status(403).json({
      code: 403,
      msg: "You do not have permission to perform this action",
    });
  }

  /**
   * For the TYPED list endpoints, whose `request_type` is a required,
   * whitelisted query parameter. Nothing else is trusted: a value that is not
   * exactly `SHIFT_CHANGE` cannot reach a SHIFT_CHANGE row - `typesForTab`
   * maps REGULARIZATION to the two regularization types and every other tab
   * to itself - and anything unreadable is refused by the handler's own Joi
   * schema a moment later.
   */
  _requireShiftViewForTypedQuery() {
    return async (req, res, next) => {
      try {
        if (String(req.query.request_type) !== "SHIFT_CHANGE") return next();
        if (await this.permissions.hasAll(req, P.VIEW_SHIFT_CHANGE_REQUESTS)) return next();
        return AttendanceRegularizationRoutes._forbidden(res);
      } catch (err) {
        return AttendanceRegularizationRoutes._respond(res, err);
      }
    };
  }

  /**
   * For the endpoints addressed BY REQUEST ID, where the type is a property of
   * the stored record and never something the caller may assert. The request
   * is read server-side and its own `request_type` decides; a client cannot
   * reach a SHIFT_CHANGE without the Shift key by calling the detail or
   * decision route directly, and cannot pretend a SHIFT_CHANGE is an OT by
   * sending a type, because neither route reads one.
   *
   * A 404 for a request that does not exist is returned here rather than
   * inside the handler, so an unknown id looks the same to a caller with the
   * Shift key and one without it.
   */
  _requireShiftKeyForStoredRequest(key) {
    return async (req, res, next) => {
      try {
        const request = await this.usecase.getRequest(Number(req.params.request_id));
        if (!request) {
          res.status(404).json({ code: 404, msg: "No such request" });
          return;
        }
        // Handed on so the handler does not read the same row twice.
        req.storedApprovalRequest = request;
        if (String(request.request_type) !== "SHIFT_CHANGE") return next();
        if (await this.permissions.hasAll(req, key)) return next();
        return AttendanceRegularizationRoutes._forbidden(res);
      } catch (err) {
        return AttendanceRegularizationRoutes._respond(res, err);
      }
    };
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
     * MY ATTENDANCE: ask to work ANOTHER SHIFT on ONE date.
     *
     * A REQUEST, never a change. Nothing this endpoint writes makes any shift
     * effective - the row is PENDING, the resolver reads no pending request,
     * and only the final approval writes the one-date override. The next day
     * is not touched by it either, then or after approval: an override is one
     * date by construction.
     *
     * FOR YOURSELF ONLY, and by construction rather than by a check: the
     * employee is `req.decoded.employee_id` and the body has no field naming
     * anybody else, so Joi answers 400 to an attempt rather than obeying it.
     * `raise_shift_change_request` gates reaching it at all; it cannot widen
     * whose attendance it acts on.
     */
    this.router.post(
      "/attendance/me/shift-change",
      requireSelf,
      this.permissions.require(P.RAISE_SHIFT_CHANGE_REQUEST),
      async (req, res) => {
        try {
          const schema = {
            attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
            work_shift_id: Joi.number().integer().min(1).required(),
            reason: Joi.string().min(5).max(500).required(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.raiseShiftChangeRequest({
            actor: {
              employee_id: Number(req.decoded.employee_id),
              user_type: req.decoded.user_type,
            },
            attendance_date: req.body.attendance_date,
            work_shift_id: req.body.work_shift_id,
            reason: req.body.reason,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

    /**
     * The shifts you MAY ask for on a date: active, running that weekday, and
     * longer than your own.
     *
     * A CONVENIENCE FOR THE SCREEN AND NOT THE RULE. The submit endpoint
     * re-derives every one of those conditions server-side and refuses
     * anything that fails them, so a hand-made request cannot get past a
     * filtered dropdown.
     */
    this.router.get(
      "/attendance/me/shift-change/options",
      requireSelf,
      this.permissions.require(P.RAISE_SHIFT_CHANGE_REQUEST),
      async (req, res) => {
        try {
          const schema = {
            attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
          };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.shiftChangeOptions({
            actor: { employee_id: Number(req.decoded.employee_id) },
            attendance_date: req.query.attendance_date,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

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
            // Attendance correction only: the missing punch is required, and
            // there is no OT on this request (the finalized OT flow raises OT
            // separately, by the employee, after the corrected day exists).
            punch_time: Joi.string()
              .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/)
              .required(),
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
            punch_time: req.body.punch_time,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

    /**
     * MY ATTENDANCE: request the overtime the engine calculated on your OWN
     * date.
     *
     * The body is a date and a reason. There is no field for an employee id
     * and none for OT minutes - `candidate_ot_minutes`, `approved_ot_minutes`,
     * `employee_id` and `requested_for_employee_id` are all refused by the
     * schema (Joi rejects unknown keys) - and the usecase recalculates the
     * date on the server and stores THAT candidate. The chain, the one-claim-
     * per-date rule and the "complete FINAL day with OT" rule are the
     * usecase's, unchanged by anything the client sends.
     */
    this.router.post("/attendance/me/ot-request", requireSelf, async (req, res) => {
      try {
        const schema = {
          attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
          reason: Joi.string().min(5).max(500).required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const result = await this.usecase.raiseOtRequest({
          actor: { employee_id: Number(req.decoded.employee_id), user_type: req.decoded.user_type },
          attendance_date: req.body.attendance_date,
          reason: req.body.reason,
        });
        res.json({ code: 200, ...result });
      } catch (err) {
        AttendanceRegularizationRoutes._respond(res, err);
      }
    });

    /**
     * The approval screens. ONE request type per call, so Attendance Approval
     * (REGULARIZATION) and OT Approval (OT) never mix; PENDING is "pending
     * with me" and history is scoped to what the caller's role entitled them
     * to see. Same key as the existing pending queue.
     */
    this.router.get(
      "/attendance/approvals",
      this.permissions.require(P.VIEW_ATTENDANCE_APPROVALS),
      this._requireShiftViewForTypedQuery(),
      async (req, res) => {
        try {
          const schema = {
            request_type: Joi.string().valid("REGULARIZATION", "OT", "SHIFT_CHANGE").required(),
            status: Joi.string().valid("PENDING", "APPROVED", "REJECTED", "ALL").optional(),
            limit: Joi.number().integer().min(1).max(500).optional(),
            offset: Joi.number().integer().min(0).optional(),
            // The unified approval centre's filters. They NARROW what the
            // caller's outlet scope already allows and can never widen it:
            // an outlet the caller has no rights to simply matches nothing.
            outlet_ids: Joi.string().allow("").optional(),
            employee_id: Joi.number().integer().min(1).optional(),
            designation_id: Joi.number().integer().min(1).optional(),
          };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.listApprovals({
            actor: await this._actor(req),
            request_type: req.query.request_type,
            status: req.query.status || "PENDING",
            limit: req.query.limit ? Number(req.query.limit) : 200,
            offset: req.query.offset ? Number(req.query.offset) : 0,
            outlet_ids: AttendanceRegularizationRoutes._idList(req.query.outlet_ids),
            employee_id: req.query.employee_id ? Number(req.query.employee_id) : null,
            designation_id: req.query.designation_id ? Number(req.query.designation_id) : null,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

    /** "Pending with me", counted in SQL, per request type. */
    this.router.get(
      "/attendance/approvals/count",
      this.permissions.require(P.VIEW_ATTENDANCE_APPROVALS),
      this._requireShiftViewForTypedQuery(),
      async (req, res) => {
        try {
          const schema = {
            request_type: Joi.string().valid("REGULARIZATION", "OT", "SHIFT_CHANGE").required(),
            outlet_ids: Joi.string().allow("").optional(),
            employee_id: Joi.number().integer().min(1).optional(),
            designation_id: Joi.number().integer().min(1).optional(),
          };
          const isValid = Joi.validate(req.query, schema);
          if (isValid.error !== null) throw isValid.error;
          // Counted under the SAME filters the table is showing, so the
          // number over a filtered list is a count of that list.
          const result = await this.usecase.countPending({
            actor: await this._actor(req),
            request_type: req.query.request_type,
            outlet_ids: AttendanceRegularizationRoutes._idList(req.query.outlet_ids),
            employee_id: req.query.employee_id ? Number(req.query.employee_id) : null,
            designation_id: req.query.designation_id ? Number(req.query.designation_id) : null,
          });
          res.json({ code: 200, ...result });
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

    /**
     * The LEGACY queue: requests whose current stage this caller could decide.
     *
     * Attendance and OT only. It predates the unified approval centre, takes
     * no request-type filter and is reached with the generic view key alone,
     * so SHIFT_CHANGE is excluded in the repository query rather than shown
     * to somebody who does not hold `view_shift_change_requests`. The Shift
     * queue is `/attendance/approvals?request_type=SHIFT_CHANGE`.
     */
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
      this._requireShiftKeyForStoredRequest(P.VIEW_SHIFT_CHANGE_REQUESTS),
      async (req, res) => {
        try {
          // Already read, and already type-checked, by the middleware above.
          const request = req.storedApprovalRequest;
          res.json({ code: 200, request });
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

    /**
     * Decide the current stage.
     *
     * A final approval recalculates the date in the same transaction. For a
     * regularization that makes the proposed punch effective and nothing
     * more - any OT the corrected day earns becomes Available to request; for
     * an OT request it sets the approved OT, clamped to what the engine finds
     * eligible now. The endpoint takes no minutes: an approver cannot change
     * the figure. Both writes are idempotent, so a retry is safe.
     */
    this.router.post(
      "/attendance/regularization/:request_id/decision",
      this.permissions.require(P.APPROVE_ATTENDANCE_REGULARIZATION),
      this._requireShiftKeyForStoredRequest(P.APPROVE_SHIFT_CHANGE_REQUEST),
      async (req, res) => {
        try {
          const schema = {
            decision: Joi.string().valid("APPROVED", "REJECTED").required(),
            remarks: Joi.string().allow("").max(500).optional(),
          };
          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.decide({
            actor: await this._actor(req),
            request_id: Number(req.params.request_id),
            decision: req.body.decision,
            remarks: req.body.remarks || null,
            // The WEB app. The Telegram surface calls the same `decide` with
            // its own source, so the two act on one record and the step says
            // which of them did.
            source: "WEB",
          });
          res.status(result.code === 409 ? 409 : 200).json(result);
        } catch (err) {
          AttendanceRegularizationRoutes._respond(res, err);
        }
      }
    );

  }

  /** `"3,5"` or `"3"` -> `[3, 5]`; anything unreadable is simply not a filter. */
  static _idList(value) {
    if (value === undefined || value === null || value === "") return null;
    const ids = String(value)
      .split(",")
      .map((part) => Number(String(part).trim()))
      .filter((id) => Number.isInteger(id) && id > 0);
    return ids.length > 0 ? ids : null;
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (attendanceRegularizationUsecase, permissions, sensitive, branchScope) =>
  new AttendanceRegularizationRoutes(attendanceRegularizationUsecase, permissions, sensitive, branchScope);
module.exports.AttendanceRegularizationRoutes = AttendanceRegularizationRoutes;
