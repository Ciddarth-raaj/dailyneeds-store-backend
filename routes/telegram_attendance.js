const express = require("express");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

/**
 * THE TELEGRAM ATTENDANCE MINI APP API.
 *
 *   POST /telegram/attendance/session          exchange signed initData
 *   GET  /telegram/attendance/month            My Attendance, one month
 *   GET  /telegram/attendance/missing-dates    Corrections, this employee's
 *   GET  /telegram/attendance/date             one date, read-only
 *   POST /telegram/attendance/regularization   raise the normal request
 *   POST /telegram/attendance/ot-request       raise the normal OT request
 *
 * =============================== WHY THESE FIVE ARE "UNPROTECTED" ROUTES ===
 *
 * They are listed in `middlewares/auth.js#unProtectedRoutes` for one reason:
 * a Telegram Mini App has NO dnds.co.in session and cannot get one. Most
 * employees have no login at all. So the global `x-access-token` gate is
 * stepped past - and every one of these endpoints IMMEDIATELY applies its
 * own, stricter gate instead. `/user/login`, `/user/setup-password` and
 * `/user/forgot-password` are on that list for exactly the same reason: the
 * caller cannot present a session because proving who they are is the whole
 * point of the call.
 *
 * `/telegram/attendance/session` proves identity with Telegram's own
 * signature. The other four require `x-telegram-session`, the short-lived
 * scoped token that call returns, and refuse anything else - including a
 * perfectly valid dnds.co.in login token, which carries no `scope` claim
 * and is rejected by `telegram_attendance_session#authenticate`.
 *
 * THE PATHS ARE STATIC ON PURPOSE. `unProtectedRoutes` is an exact `req.path`
 * map, so a date is a QUERY PARAMETER rather than a path segment: a route
 * like `/telegram/attendance/date/:date` could not be expressed in that map
 * and would have silently fallen through to the global auth gate.
 *
 * ================================== WHAT THE BROWSER MAY NEVER SAY =========
 *
 * There is NO `employee_id` field anywhere on this router - not in a path,
 * not in a query schema, not in a body schema - and Joi refuses unknown keys,
 * so sending one is a 422 rather than an override. The employee is read from
 * `req.miniApp.employee_id`, which is set from the verified token's signed
 * claim and from nothing else. A `?date=` on the Mini App URL is a
 * NAVIGATION HINT the frontend may use to preselect a card; it reaches this
 * router only as the date argument of a read that is already pinned to the
 * authenticated employee.
 *
 * NO EMPLOYEE SELECTOR, NO BRANCH SELECTOR, NO APPROVAL ACTION. This is
 * employee self-service; approvals remain `routes/attendance_regularization.js`
 * behind `approve_attendance_regularization` and the existing chain.
 */
class TelegramAttendanceRoutes {
  constructor(sessionUsecase, miniAppUsecase) {
    this.session = sessionUsecase;
    this.miniApp = miniAppUsecase;
    this.router = express.Router();
    this.init();
  }

  /** 401 for an authentication refusal, the usual handling for everything else. */
  static _respond(res, err) {
    if (err && err.name === "TelegramAuthError") {
      res.status(err.status || 401).json({ code: 401, msg: err.message, error: err.code });
      return;
    }
    respondError(res, err);
  }

  /**
   * THE GATE. It sets `req.miniApp` and refuses everything it cannot verify.
   *
   * The token travels in `x-telegram-session`, NOT `x-access-token`. Keeping
   * the two headers apart means the Mini App token can never be picked up by
   * the ordinary auth middleware by accident, and the ordinary session token
   * can never be presented here by accident.
   */
  _requireSession() {
    return async (req, res, next) => {
      try {
        const header = req.headers["x-telegram-session"];
        req.miniApp = Object.freeze(await this.session.authenticate(header));
        next();
      } catch (err) {
        TelegramAttendanceRoutes._respond(res, err);
      }
    };
  }

  init() {
    const r = this.router;
    const guard = this._requireSession();

    /**
     * Exchange Telegram's signed `initData` for a scoped session.
     *
     * The body carries ONE field. `employee_id`, `telegram_user_id` and a
     * username are all unknown keys and are refused by the schema - the only
     * thing that decides who this is, is the signature.
     */
    r.post("/telegram/attendance/session", async (req, res) => {
      try {
        const schema = { init_data: Joi.string().min(1).max(8192).required() };
        const isValid = Joi.validate(req.body || {}, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(await this.session.exchange({ initData: req.body.init_data }));
      } catch (err) {
        TelegramAttendanceRoutes._respond(res, err);
      }
    });

    /**
     * This employee's actionable Missing Attendance dates - ALL of them
     * inside the regularisation window, not only the one the message named.
     * The population is the shared Missing Attendance rule; nothing is
     * recalculated here.
     */
    r.get("/telegram/attendance/missing-dates", guard, async (req, res) => {
      try {
        const isValid = Joi.validate(req.query || {}, Joi.object().keys({}).unknown(false));
        if (isValid.error !== null) throw isValid.error;

        res.json(await this.miniApp.listMissingDates(req.miniApp.employee_id));
      } catch (err) {
        TelegramAttendanceRoutes._respond(res, err);
      }
    });

    /**
     * MY ATTENDANCE: one month of the authenticated employee's own days.
     *
     * READ-ONLY, and the month is the ONLY parameter. The employee comes from
     * `req.miniApp.employee_id`; there is no field for an employee, an
     * outlet, a store, a designation or an approval role, and Joi refuses
     * unknown keys, so none of them can be supplied. The days are whatever
     * `attendance_calculation#readRange` returns - the same read
     * `/attendance/me` serves - and no attendance state is decided here.
     */
    r.get("/telegram/attendance/month", guard, async (req, res) => {
      try {
        const schema = { month: Joi.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).required() };
        const isValid = Joi.validate(req.query || {}, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(await this.miniApp.getMonth(req.miniApp.employee_id, req.query.month));
      } catch (err) {
        TelegramAttendanceRoutes._respond(res, err);
      }
    });

    /** One date: shift, existing punches (read-only) and current state. */
    r.get("/telegram/attendance/date", guard, async (req, res) => {
      try {
        const schema = {
          attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
        };
        const isValid = Joi.validate(req.query || {}, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.miniApp.getDateDetail(req.miniApp.employee_id, req.query.attendance_date)
        );
      } catch (err) {
        TelegramAttendanceRoutes._respond(res, err);
      }
    });

    /**
     * Raise the NORMAL Daily Needs regularisation request.
     *
     * Three fields, the same three `POST /attendance/me/regularization`
     * takes, straight into `attendanceRegularizationUsecase.raiseRequest`
     * with actor and requested-for both set to the authenticated employee.
     * There is no second regularisation engine and no Telegram approval path:
     * what this creates walks the existing manager/HR chain.
     */
    r.post("/telegram/attendance/regularization", guard, async (req, res) => {
      try {
        const schema = {
          attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
          punch_time: Joi.string()
            .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/)
            .required(),
          reason: Joi.string().min(5).max(500).required(),
        };
        const isValid = Joi.validate(req.body || {}, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.miniApp.submitRegularization(
            req.miniApp.employee_id,
            {
              attendance_date: req.body.attendance_date,
              punch_time: req.body.punch_time,
              reason: req.body.reason,
            },
            { session_id: req.miniApp.session_id, telegram_user_id: req.miniApp.telegram_user_id }
          )
        );
      } catch (err) {
        TelegramAttendanceRoutes._respond(res, err);
      }
    });

    /**
     * Raise the NORMAL Daily Needs OT request.
     *
     * A THIN AUTHENTICATED DELEGATION AND NOTHING ELSE. The route exists
     * only because a Mini App cannot present the dnds.co.in session that
     * `POST /attendance/me/ot-request` requires - that endpoint takes its
     * employee from `req.decoded`, which a Telegram caller has no way to
     * populate. So this one resolves the employee from the verified Telegram
     * session instead and hands the SAME two fields to the SAME usecase:
     * `attendanceRegularizationUsecase#raiseOtRequest`, through
     * `miniApp.submitOtRequest`. There is no second OT engine, no second set
     * of eligibility rules and no Telegram approval path.
     *
     * TWO FIELDS, AND NEITHER IS A DURATION. `candidate_ot_minutes`,
     * `approved_ot_minutes`, `ot_minutes`, `employee_id` and
     * `requested_for_employee_id` are all unknown keys here, and Joi refuses
     * unknown keys - so each is a 422, never a value that is ignored today
     * and read tomorrow. The minutes are recalculated on the server at
     * submission, and the client has no field with which to disagree.
     */
    r.post("/telegram/attendance/ot-request", guard, async (req, res) => {
      try {
        const schema = {
          attendance_date: Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/).required(),
          reason: Joi.string().min(5).max(500).required(),
        };
        const isValid = Joi.validate(req.body || {}, schema);
        if (isValid.error !== null) throw isValid.error;

        res.json(
          await this.miniApp.submitOtRequest(
            req.miniApp.employee_id,
            { attendance_date: req.body.attendance_date, reason: req.body.reason },
            { session_id: req.miniApp.session_id, telegram_user_id: req.miniApp.telegram_user_id }
          )
        );
      } catch (err) {
        TelegramAttendanceRoutes._respond(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (sessionUsecase, miniAppUsecase) =>
  new TelegramAttendanceRoutes(sessionUsecase, miniAppUsecase);
module.exports.TelegramAttendanceRoutes = TelegramAttendanceRoutes;
