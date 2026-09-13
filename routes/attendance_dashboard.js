const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const {
  DASHBOARD_SCOPE,
  effectiveStoreIds: narrowStoreIds,
  parseRequestedStores,
  scopeForClient,
} = require("../utils/dashboard_scope");

/**
 * The Attendance Dashboard API.
 *
 * READ-ONLY, ENTIRELY. Every route here is a GET, there is no POST, PUT,
 * PATCH or DELETE on this router, and the usecase behind it has no write
 * method to call. Opening the dashboard cannot approve a request, create an
 * OT claim, edit a punch time, regularize a date or trigger a recalculation -
 * not as an intended action and not as a side effect of a read.
 *
 * EVERY ENDPOINT REQUIRES AUTHENTICATION, THE PERMISSION KEY AND A RESOLVED
 * STORE SCOPE, INDIVIDUALLY. `requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD)`
 * is attached to each route rather than relying on the page being hidden: the web app hiding a
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
 * decided by the SHARED Global Dashboard resolver, on the server, from the
 * caller's own identity - never from a parameter.
 *
 * NOTHING SENSITIVE IS SELECTED OR RETURNED. The repository names every
 * column it reads and no salary, bank, PAN, PF/ESI or Aadhaar field is among
 * them. `filterResponse` and `guardWrite` are mounted as well, exactly as
 * they are on /hr and on /attendance/calculated, so this router cannot become
 * a way around `view_employee_sensitive` - the middleware is the guarantee,
 * the column list is the mechanism.
 */

/**
 * LOCATION AUTHORIZATION IS NOT THIS ROUTER'S JOB ANY MORE.
 *
 * It used to be: this file carried its own `resolveLocationScope`, its own
 * three-state SCOPE vocabulary and its own intersection helper, and the only
 * non-administrator it could resolve was a holder of the application-wide
 * `all_stores` permission. That was an Attendance-specific answer to a question
 * every dashboard has, and the HR and Sales dashboards would each have grown
 * their own copy of it.
 *
 * It now consumes the SHARED Global Dashboard resolver -
 * `middlewares/dashboard_scope.js` over `utils/dashboard_scope.js` - exactly as
 * a future dashboard will:
 *
 *   requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD)   on every route
 *   req.dashboardScope                                    ALL_STORES | OWN_STORE
 *   req.dashboardStoreIds                                 null | [id]
 *
 * The middleware refuses - before any handler runs - a caller without the
 * feature key, without a store scope, with both scope keys, whose branch cannot
 * be resolved, or whose request names a branch outside their scope. So every
 * handler below starts from a caller who may be here and a `store_ids` that has
 * already been narrowed and can only be narrowed further.
 *
 * `store_unassigned` and the other filters are still filters, and still cannot
 * widen anything: they are applied on top of a `store_ids` the server decided.
 */

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

/** A paging number, where ZERO is a legitimate value and `asId` would drop it. */
const asCount = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

class AttendanceDashboardRoutes {
  constructor(
    attendanceDashboardUsecase,
    permissions,
    sensitive,
    attendanceStaffingUsecase,
    dashboardScope
  ) {
    this.usecase = attendanceDashboardUsecase;
    this.staffing = attendanceStaffingUsecase;
    this.permissions = permissions;
    // The shared Global Dashboard resolver. Every route below is gated by it.
    this.dashboards = dashboardScope;
    this.sensitive = sensitive;
    this.router = express.Router();
    this.init();
  }

  /**
   * The scope the shared middleware already resolved for this request.
   *
   * It cannot be NONE here - `requireDashboardAccess` refused that before the
   * handler ran - so this is a read, not a second authorization check. It is
   * kept as a method so a handler that needs the kind (the filters endpoint,
   * which tells the browser whether to offer an outlet picker) has one place to
   * get it from.
   */
  _scope(req) {
    return req.dashboardScope || { kind: DASHBOARD_SCOPE.NONE, store_ids: [] };
  }

  /** The filters as the usecase takes them, scope already applied. */
  _filters(req, query) {
    const scope = this._scope(req);
    return {
      attendance_date: query.attendance_date,
      // Narrowed against the server's scope. An Own Store caller gets their own
      // branch whatever they asked for, and a request naming another branch
      // never reaches a handler at all.
      store_ids: narrowStoreIds(scope, parseRequestedStores(query.store_ids)),
      store_unassigned: query.store_unassigned === "true" || query.store_unassigned === true,
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
     * BEHIND THE SAME KEY as the aggregates AND scoped the same way. A
     * selector is a read of master data, and an unscoped one would enumerate
     * every branch in the company to somebody authorized for two of them.
     */
    this.router.get(
      "/attendance/dashboard/filters",
      this.dashboards.requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const scope = this._scope(req);
          const filters = await this.usecase.getFilters({
            store_ids: narrowStoreIds(scope, null),
          });
          // THE SCOPE THE BROWSER IS TOLD ABOUT is deliberately small: the kind,
          // the one outlet an Own Store caller is pinned to, and whether an
          // outlet picker should be offered at all. It carries no permission
          // key, no reason code and nothing about anybody else's branches - the
          // screen does not need those and a payload that has them is one more
          // place they can leak. It is presentation input, never authorization:
          // every endpoint re-resolves the scope on the server regardless of
          // what the browser does with this.
          res.json({
            code: 200,
            ...filters,
            scope: scope.kind,
            dashboard_scope: {
              ...scopeForClient(scope),
              outlet_name: scope.outlet_name || null,
            },
          });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /** The six cards and the panels for one attendance date. */
    this.router.get(
      "/attendance/dashboard/overview",
      this.dashboards.requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, FILTER_SCHEMA);
          if (isValid.error !== null) throw isValid.error;
          const { store_unassigned, ...filters } = this._filters(req, req.query);
          const result = await this.usecase.getOverview(filters);
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * The employee list behind one card, slice, issue or panel row.
     *
     * `store_unassigned` selects the "no outlet on record" group explicitly -
     * an employee with no `store_id` cannot be named by a store filter, and
     * omitting the filter would return everybody.
     */
    this.router.get(
      "/attendance/dashboard/drilldown",
      this.dashboards.requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD),
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
                "UNCONFIRMED_ABSENCE",
                "NEED_ACTION",
                "OT_PENDING",
                "MISSING_PUNCH",
                "REGULARIZATION_PENDING",
                "NO_SHIFT",
                "SHIFT_SETUP"
              )
              .required(),
            store_unassigned: Joi.boolean().optional(),
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

    /**
     * The trend over COMPLETED attendance days. Never the open one.
     *
     * IT TAKES THE SAME FILTERS AS EVERYTHING ELSE, EMPLOYEE SEARCH INCLUDED.
     * The first version forbade `search` here and deleted it in the frontend
     * helper, so the chart quietly described a different population from the
     * cards above it. It is applied server-side, per date, against each date's
     * own applicable population.
     */
    this.router.get(
      "/attendance/dashboard/trend",
      this.dashboards.requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...FILTER_SCHEMA,
            days: Joi.number().integer().min(1).max(35).optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const { store_unassigned, ...filters } = this._filters(req, req.query);
          const result = await this.usecase.getTrend({
            ...filters,
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
     * THE OPERATIONAL SNAPSHOT: Expected Now / Recorded IN / Gap.
     *
     * NO `attendance_date`, DELIBERATELY. This endpoint answers "right now",
     * and the server decides what "now" is - one `as_of` in the business
     * timezone, returned with the response. A caller-supplied date would
     * invite a past day's figures under a "Now" heading, which is the one
     * thing this view must never show.
     *
     * Same key, same scope resolution, same fail-closed behaviour as every
     * other endpoint on this router. Read-only: it computes in memory and
     * stores nothing.
     */
    this.router.get(
      "/attendance/dashboard/staffing",
      this.dashboards.requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            store_ids: Joi.string().regex(/^\d+(,\d+)*$/).allow(null, "").optional(),
            designation_id: Joi.number().integer().positive().allow(null, "").optional(),
            work_shift_id: Joi.number().integer().positive().allow(null, "").optional(),
            search: Joi.string().max(100).allow(null, "").optional(),
          });
          if (isValid.error !== null) throw isValid.error;


          const scope = this._scope(req);
          const result = await this.staffing.getSnapshot({
            store_ids: narrowStoreIds(scope, parseRequestedStores(req.query.store_ids)),
            // An Own Store viewer learns THAT an employee is recorded elsewhere,
            // never WHERE - that branch is outside their scope.
            disclose_other_locations: scope.kind === DASHBOARD_SCOPE.ALL_STORES,
            designation_id: asId(req.query.designation_id),
            work_shift_id: asId(req.query.work_shift_id),
            search: req.query.search ? String(req.query.search).trim() : null,
          });
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * THE STAFFING DRILLDOWN - one named bucket of the CURRENT snapshot, paged.
     *
     * WHY THIS EXISTS. The snapshot used to carry a 200-row array that the
     * screen opened as though it were the whole population, so a clickable list
     * could silently disagree with the headline count above it. The snapshot now
     * sends previews and this endpoint serves the real lists: the bucket names
     * the subset, `limit`/`offset` page it, and `total` is the same number the
     * card shows because both come from one classification.
     *
     * NO `attendance_date` HERE EITHER. Like the snapshot it answers "now", and
     * it recomputes with its OWN server-issued `as_of`, which it returns: a
     * drilldown opened a minute after the card is a new observation and says so
     * rather than pretending to be a replay.
     *
     * A REQUESTED LOCATION CANNOT WIDEN THE READ. `store_id` is intersected
     * with the caller's resolved scope in the usecase; an id outside it yields
     * nothing, exactly as an empty scope does.
     */
    this.router.get(
      "/attendance/dashboard/staffing/drilldown",
      this.dashboards.requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            bucket: Joi.string().max(60).required(),
            store_ids: Joi.string().regex(/^\d+(,\d+)*$/).allow(null, "").optional(),
            store_id: Joi.number().integer().positive().allow(null, "").optional(),
            designation_id: Joi.number().integer().positive().allow(null, "").optional(),
            work_shift_id: Joi.number().integer().positive().allow(null, "").optional(),
            search: Joi.string().max(100).allow(null, "").optional(),
            gap_class: Joi.string().max(40).allow(null, "").optional(),
            limit: Joi.number().integer().min(1).max(200).optional(),
            offset: Joi.number().integer().min(0).optional(),
          });
          if (isValid.error !== null) throw isValid.error;


          const scope = this._scope(req);
          const result = await this.staffing.getStaffingDrilldown({
            bucket: req.query.bucket,
            store_ids: narrowStoreIds(scope, parseRequestedStores(req.query.store_ids)),
            disclose_other_locations: scope.kind === DASHBOARD_SCOPE.ALL_STORES,
            store_id: asId(req.query.store_id),
            designation_id: asId(req.query.designation_id),
            work_shift_id: asId(req.query.work_shift_id),
            search: req.query.search ? String(req.query.search).trim() : null,
            gap_class: req.query.gap_class ? String(req.query.gap_class).trim() : null,
            limit: asCount(req.query.limit, undefined),
            offset: asCount(req.query.offset, 0),
          });
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * E. Recurring coverage gaps - repeated shortfalls against the SCHEDULE.
     *
     * A secondary, evidence-showing panel: every row carries the dates and
     * counts behind it, days whose punch retrieval was unfinished or failed are
     * excluded rather than averaged in, and retrieval status that cannot be read
     * at all makes the panel unavailable rather than optimistic.
     *
     * IT TAKES THE SAME FILTERS AS THE SNAPSHOT, the effective shift included:
     * a pattern panel narrowed differently from the cards above it is a
     * different question wearing the same heading.
     */
    this.router.get(
      "/attendance/dashboard/recurring-gaps",
      this.dashboards.requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            store_ids: Joi.string().regex(/^\d+(,\d+)*$/).allow(null, "").optional(),
            designation_id: Joi.number().integer().positive().allow(null, "").optional(),
            work_shift_id: Joi.number().integer().positive().allow(null, "").optional(),
            search: Joi.string().max(100).allow(null, "").optional(),
            comparable_days: Joi.number().integer().min(2).max(8).optional(),
          });
          if (isValid.error !== null) throw isValid.error;


          const result = await this.staffing.getRecurringGaps({
            store_ids: narrowStoreIds(this._scope(req), parseRequestedStores(req.query.store_ids)),
            designation_id: asId(req.query.designation_id),
            work_shift_id: asId(req.query.work_shift_id),
            search: req.query.search ? String(req.query.search).trim() : null,
            comparable_days: req.query.comparable_days,
          });
          res.setHeader("Cache-Control", "no-store");
          res.json({ code: 200, ...result });
        } catch (err) {
          respondError(res, err);
        }
      }
    );

    /**
     * The punches the engine dated to the SELECTED attendance day, for the
     * selected filters, and the terminals' own freshness.
     *
     * The date and the filters are required here for the same reason they are
     * everywhere else: a feed showing this morning under cards describing last
     * Tuesday is not evidence about anything.
     */
    this.router.get(
      "/attendance/dashboard/recent-punches",
      this.dashboards.requireDashboardAccess(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...FILTER_SCHEMA,
            limit: Joi.number().integer().min(1).max(100).optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const { store_unassigned, ...filters } = this._filters(req, req.query);
          const result = await this.usecase.getRecentPunches({
            ...filters,
            disclose_other_locations: this._scope(req).kind === DASHBOARD_SCOPE.ALL_STORES,
            limit: req.query.limit || 25,
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

module.exports = (
  attendanceDashboardUsecase,
  permissions,
  sensitive,
  attendanceStaffingUsecase,
  dashboardScope
) =>
  new AttendanceDashboardRoutes(
    attendanceDashboardUsecase,
    permissions,
    sensitive,
    attendanceStaffingUsecase,
    dashboardScope
  );
module.exports.AttendanceDashboardRoutes = AttendanceDashboardRoutes;

// THE SCOPE VOCABULARY IS NO LONGER THIS FILE'S. `resolveLocationScope`,
// `SCOPE`, `ACCESS_ALL_STORES` and the local intersection helper are gone; the
// shared Global Dashboard layer owns all four, and anything that used to import
// them from here imports them from `utils/dashboard_scope.js` instead. Nothing
// is re-exported as an alias: a second name for one rule is how the two copies
// start to drift.
