const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

/**
 * The Attendance Dashboard API.
 *
 * READ-ONLY, ENTIRELY. Every route here is a GET, there is no POST, PUT,
 * PATCH or DELETE on this router, and the usecase behind it has no write
 * method to call. Opening the dashboard cannot approve a request, create an
 * OT claim, edit a punch time, regularize a date or trigger a recalculation -
 * not as an intended action and not as a side effect of a read.
 *
 * EVERY ENDPOINT REQUIRES AUTHENTICATION AND THE PERMISSION KEY, INDIVIDUALLY.
 * `permissions.require(P.VIEW_ATTENDANCE_DASHBOARD)` is attached to each
 * route rather than relying on the page being hidden: the web app hiding a
 * screen is presentation, and the only thing that actually stops a request is
 * this check. A logged-out call is refused 401 by the auth middleware before
 * anything here runs; a revoked or expired token likewise; a signed-in caller
 * without the key is refused 403 on the aggregate, on the drilldown, on the
 * trend, on the punch feed AND on the filter options - there is no endpoint
 * on this router that answers without it, so none of them can be used to
 * count employees, enumerate outlets or read device metadata sideways.
 *
 * VIEWING IS NOT APPROVING. Holding this key grants the six counts and their
 * drilldowns and nothing else. Every action the screen links out to -
 * regularization, OT approval, editing a date's shift, voiding a punch - is
 * performed by its own existing route, behind its own existing key, and is
 * re-checked there. This router cannot be used to reach any of them.
 *
 * THE BROWSER'S FILTERS ARE FILTERS, NEVER AUTHORIZATION. `store_ids`,
 * `designation_id`, `work_shift_id` and `search` narrow a result set that the
 * server has already scoped; they cannot widen one. The scope itself is
 * decided by `resolveLocationScope` below, on the server, from the caller's
 * own identity - never from a parameter.
 *
 * NOTHING SENSITIVE IS SELECTED OR RETURNED. The repository names every
 * column it reads and no salary, bank, PAN, PF/ESI or Aadhaar field is among
 * them. `filterResponse` and `guardWrite` are mounted as well, exactly as
 * they are on /hr and on /attendance/calculated, so this router cannot become
 * a way around `view_employee_sensitive` - the middleware is the guarantee,
 * the column list is the mechanism.
 */

/**
 * THE SERVER-SIDE LOCATION SCOPE - and the honest state of it today.
 *
 * The approved task requires that the caller's PERMITTED LOCATION SCOPE be
 * enforced on the server for every count, chart label, employee search and
 * piece of device metadata, and that a branch filter arriving from the browser
 * never be treated as authorization. The second half is implemented and
 * enforced here. The first half has a DEPENDENCY that this task cannot settle
 * on its own, and pretending otherwise would be worse than saying so:
 *
 *   THIS BACKEND HAS NO MULTI-LOCATION AUTHORIZATION MODEL. Authorization is
 *   permission keys by designation (`middlewares/permissions.js`) plus the
 *   administrator bypass, and separately an IP rule per branch
 *   (`middlewares/ip_restriction.js`). `req.decoded.store_id` is the user's
 *   OWN store and is used in a handful of routes as a DEFAULT VALUE for a
 *   submitted outlet - never as a boundary. There is no "stores this user may
 *   read" list anywhere in the schema or the token, and every existing
 *   attendance read - `/attendance/calculated`, `/attendance/list`, the
 *   approval queues - is company-wide once the key is held.
 *
 * So this function returns the caller's permitted scope, and TODAY that is
 * `null`, meaning "every outlet", which is exactly the scope the existing
 * attendance screens already grant to the same designations. That is a
 * deliberate choice between two wrong alternatives:
 *
 *   - Inventing a rule here - say, confining every caller to
 *     `decoded.store_id` - would be a business-rule invention with real
 *     consequences. Roles that are MEANT to work across branches would
 *     silently lose data (the outlet-directory work records exactly this
 *     breakage for Accounts Executive), and this overview would show LESS
 *     than the per-employee screen beside it, which is incoherent.
 *   - Widening anything is not on the table either: this returns a scope, and
 *     the caller below INTERSECTS the browser's filter with it. When a real
 *     scope model arrives, it is implemented in this one function and every
 *     count, label, search and device row on the dashboard narrows with it,
 *     because they all pass through here.
 *
 * The dependency is reported with this task rather than resolved inside it:
 * building a location-authorization model is an authorization change affecting
 * every HR screen, not a dashboard feature, and it is not in the approved
 * scope.
 *
 * @returns {number[]|null} the outlet ids the caller may read, or null for all
 */
function resolveLocationScope(/* req */) {
  return null;
}

/**
 * The browser's outlet filter, INTERSECTED with the caller's scope.
 *
 * The intersection is the whole point: a request naming an outlet outside the
 * caller's scope gets the intersection (nothing from that outlet), never the
 * outlet. When the scope is null the filter stands alone as an ordinary
 * filter, which is what it is.
 */
function effectiveStoreIds(requested, scope) {
  const asked =
    requested === null || requested === undefined || requested === ""
      ? null
      : String(requested)
          .split(",")
          .map((v) => Number(String(v).trim()))
          .filter((n) => Number.isInteger(n) && n > 0);

  if (scope === null) return asked && asked.length ? asked : null;
  if (!asked || asked.length === 0) return scope;
  const allowed = new Set(scope.map(Number));
  return asked.filter((id) => allowed.has(id));
}

const DATE = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The filters every dashboard read accepts. Unknown keys are refused by Joi. */
const FILTER_SCHEMA = {
  attendance_date: DATE.required(),
  store_ids: Joi.string().regex(/^\d+(,\d+)*$/).allow(null, "").optional(),
  designation_id: Joi.number().integer().positive().allow(null, "").optional(),
  work_shift_id: Joi.number().integer().positive().allow(null, "").optional(),
  search: Joi.string().max(100).allow(null, "").optional(),
};

const asId = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

class AttendanceDashboardRoutes {
  constructor(attendanceDashboardUsecase, permissions, sensitive) {
    this.usecase = attendanceDashboardUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.router = express.Router();
    this.init();
  }

  /** The filters as the usecase takes them, scope already applied. */
  _filters(req, query) {
    return {
      attendance_date: query.attendance_date,
      store_ids: effectiveStoreIds(query.store_ids, resolveLocationScope(req)),
      designation_id: asId(query.designation_id),
      work_shift_id: asId(query.work_shift_id),
      search: query.search ? String(query.search).trim() : null,
    };
  }

  init() {
    if (this.sensitive) {
      this.router.use("/attendance/dashboard", this.sensitive.filterResponse);
      this.router.use("/attendance/dashboard", this.sensitive.guardWrite);
    }

    /**
     * The filter selectors' options: the REAL outlets, designations and
     * Shift Management shifts, plus today's date in IST.
     *
     * BEHIND THE SAME KEY as the aggregates. A selector is a read of master
     * data, and an endpoint that listed every outlet and every designation to
     * anybody signed in would be a way of enumerating the company through the
     * dashboard's own door.
     */
    this.router.get(
      "/attendance/dashboard/filters",
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const filters = await this.usecase.getFilters();
          const scope = resolveLocationScope(req);
          // The selector offers only outlets inside the caller's scope, so
          // the control cannot suggest a branch the counts would refuse.
          const outlets =
            scope === null
              ? filters.outlets
              : filters.outlets.filter((o) => scope.map(Number).includes(Number(o.store_id)));
          res.json({ code: 200, ...filters, outlets });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /** The six cards and the panels for one attendance date. */
    this.router.get(
      "/attendance/dashboard/overview",
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, FILTER_SCHEMA);
          if (isValid.error !== null) throw isValid.error;
          const result = await this.usecase.getOverview(this._filters(req, req.query));
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * The employee list behind one card, slice or issue. Paginated.
     *
     * Re-derived from the same population on the server, so a drilldown can
     * never list somebody the card did not count.
     */
    this.router.get(
      "/attendance/dashboard/drilldown",
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...FILTER_SCHEMA,
            bucket: Joi.string()
              .valid(
                "TOTAL",
                "CHECKED_IN",
                "NOT_YET_CHECKED_IN",
                "SHIFT_NOT_STARTED",
                "ABSENT",
                "UNRESOLVED",
                "NEED_ACTION",
                "OT_PENDING",
                "MISSING_PUNCH",
                "REGULARIZATION_PENDING",
                "NO_SHIFT",
                "SHIFT_SETUP"
              )
              .required(),
            limit: Joi.number().integer().min(1).max(200).optional(),
            offset: Joi.number().integer().min(0).optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.getDrilldown({
            ...this._filters(req, req.query),
            bucket: req.query.bucket,
            limit: req.query.limit,
            offset: req.query.offset,
          });
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /** The trend over COMPLETED attendance days. Never the open one. */
    this.router.get(
      "/attendance/dashboard/trend",
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...FILTER_SCHEMA,
            search: Joi.any().forbidden(),
            days: Joi.number().integer().min(1).max(35).optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const filters = this._filters(req, req.query);
          const result = await this.usecase.getTrend({
            attendance_date: filters.attendance_date,
            store_ids: filters.store_ids,
            designation_id: filters.designation_id,
            work_shift_id: filters.work_shift_id,
            days: req.query.days,
          });
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * The bounded tail of received punches, and the terminals' own freshness.
     *
     * BEHIND THE SAME KEY, which matters here specifically: device labels,
     * dev ids and sync times are infrastructure metadata, and this endpoint
     * must not become a way to read the terminal registry without the
     * dashboard permission.
     */
    this.router.get(
      "/attendance/dashboard/recent-punches",
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            store_ids: Joi.string().regex(/^\d+(,\d+)*$/).allow(null, "").optional(),
            limit: Joi.number().integer().min(1).max(100).optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const result = await this.usecase.getRecentPunches({
            limit: req.query.limit || 25,
            store_ids: effectiveStoreIds(req.query.store_ids, resolveLocationScope(req)),
          });
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
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

module.exports = (attendanceDashboardUsecase, permissions, sensitive) =>
  new AttendanceDashboardRoutes(attendanceDashboardUsecase, permissions, sensitive);
module.exports.AttendanceDashboardRoutes = AttendanceDashboardRoutes;
module.exports.resolveLocationScope = resolveLocationScope;
module.exports.effectiveStoreIds = effectiveStoreIds;
