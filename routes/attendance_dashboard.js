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
 * THE PERMISSION THAT MEANS "EVERY BRANCH".
 *
 * `all_stores` ("Access All Stores") is this system's own, already-declared
 * statement of company-wide access - seeded by
 * `20251128052422-all-stores-up.sql` and listed on the designation rights
 * screen. It is used here rather than invented: the dashboard needs a
 * company-wide authorization and the system already has exactly one.
 */
const ACCESS_ALL_STORES = "all_stores";

/** Every state a caller's location authorization can be in. Never a null. */
const SCOPE = Object.freeze({
  ALL: "ALL",
  LIST: "LIST",
  NONE: "NONE",
});

/**
 * THE SERVER-SIDE LOCATION SCOPE.
 *
 * WHAT WAS WRONG BEFORE. This function returned `null`, meaning "every
 * outlet", for every caller who held the dashboard permission. Intersecting a
 * browser filter with an unrestricted scope is not location authorization at
 * all - it is a filter with extra steps - and it made the permission key the
 * only thing standing between any holder and the whole company's attendance.
 *
 * THE THREE STATES ARE THREE DIFFERENT ANSWERS, and keeping them distinct all
 * the way down is the point:
 *
 *   ALL   the caller is explicitly authorized company-wide. Two things
 *         establish it and nothing else does: `user_type` 2, the
 *         administrator the permission middleware already bypasses the whole
 *         table for; and the existing `all_stores` grant, verified on the
 *         SERVER through that same middleware.
 *   LIST  a specific set of authorized outlets.
 *   NONE  no authorized locations, or an authorization that cannot be
 *         resolved. This FAILS CLOSED - the endpoint refuses - rather than
 *         degrading to company-wide, which is how the previous version's
 *         "unresolved" case behaved.
 *
 * NEITHER ATTENDANCE KEY ESTABLISHES ALL. Holding
 * `view_attendance_dashboard`, or `view_calculated_attendance`, says the
 * caller may READ CALCULATED ATTENDANCE; it does not say for whom. Treating
 * either as company-wide is exactly the conflation this replaces.
 *
 * `decoded.store_id` IS DELIBERATELY NOT USED AS A BOUNDARY. It identifies the
 * user's own store, which is not the same statement as "these are the stores
 * this person may read" - it is a default value that a handful of routes use
 * to prefill a submitted outlet. Promoting it to an authorization rule would
 * invent a per-store attendance policy that nobody has approved, and it would
 * silently confine roles that are meant to work across branches (the outlet
 * directory work records that exact breakage for Accounts Executive).
 *
 * SO: WHAT THIS MEANS TODAY, stated plainly rather than papered over. The
 * system has no per-user list of permitted locations - there is no column,
 * table or claim that carries one. Until one exists, only an administrator or
 * an `all_stores` holder can resolve to a scope at all, and every other caller
 * gets NONE and is refused. That is the fail-closed direction the review asked
 * for, and it means THE DASHBOARD IS NOT YET USABLE BY A BRANCH MANAGER. That
 * remaining dependency is reported with the task rather than closed here,
 * because defining who may see which branch is an authorization decision for
 * the owner and a change that would reach every HR screen - not a dashboard
 * feature.
 *
 * `LIST` is implemented and enforced throughout even though nothing produces
 * one yet: it is the shape a real model will return, and the intersection,
 * the empty-set handling and the tests around it all exercise it.
 *
 * @returns {Promise<{kind: string, store_ids: number[]|null, reason: string}>}
 */
async function resolveLocationScope(req, permissions) {
  if (!req || !req.decoded) {
    return { kind: SCOPE.NONE, store_ids: [], reason: "UNAUTHENTICATED" };
  }
  // The admin user type comes from the permission middleware instance rather
  // than a second copy of the number here: it is exported on what
  // `middlewares/permissions.js` RETURNS, not on the module, so requiring it
  // at the top of this file would silently be `undefined` and every
  // administrator would fall through to NONE.
  const adminUserType = permissions && permissions.ADMIN_USER_TYPE;
  if (adminUserType !== undefined && Number(req.decoded.user_type) === Number(adminUserType)) {
    return { kind: SCOPE.ALL, store_ids: null, reason: "ADMINISTRATOR" };
  }
  if (permissions && (await permissions.has(req, ACCESS_ALL_STORES))) {
    return { kind: SCOPE.ALL, store_ids: null, reason: "ALL_STORES_PERMISSION" };
  }
  return { kind: SCOPE.NONE, store_ids: [], reason: "NO_LOCATION_SCOPE" };
}

/** The refusal a NONE scope produces. Same shape as any other 403. */
const SCOPE_DENIED = {
  code: 403,
  msg:
    "You are not authorized for any branch on the Attendance Dashboard. " +
    "Company-wide access requires the Access All Stores permission or an administrator account.",
};

/**
 * The browser's outlet filter, INTERSECTED with the caller's scope.
 *
 * The intersection is the whole point: a request naming an outlet outside the
 * caller's scope gets the intersection - nothing from that outlet - never the
 * outlet. The three scope states map to three different return values, and
 * the EMPTY ARRAY is a real answer meaning "no locations", which callers must
 * honour rather than treat as "no filter":
 *
 *   ALL  + no filter  -> null   (no restriction)
 *   ALL  + [2]        -> [2]
 *   LIST + no filter  -> the scope
 *   LIST + [9]        -> []     when 9 is outside it: NO data, not all data
 *   NONE + anything   -> []
 *
 * The `[]`-means-nothing contract is enforced again in the repository
 * (`locationPredicate`) and short-circuited in the usecase, so a caller that
 * forgets to check still cannot leak.
 */
function effectiveStoreIds(requested, scope) {
  const asked =
    requested === null || requested === undefined || requested === ""
      ? null
      : String(requested)
          .split(",")
          .map((v) => Number(String(v).trim()))
          .filter((n) => Number.isInteger(n) && n > 0);

  if (!scope || scope.kind === SCOPE.NONE) return [];
  if (scope.kind === SCOPE.ALL) return asked && asked.length ? asked : null;

  const allowed = new Set((scope.store_ids || []).map(Number));
  if (!asked || asked.length === 0) return [...allowed];
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
  constructor(attendanceDashboardUsecase, permissions, sensitive, attendanceStaffingUsecase) {
    this.usecase = attendanceDashboardUsecase;
    this.staffing = attendanceStaffingUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.router = express.Router();
    this.init();
  }

  /**
   * Resolve the caller's scope and refuse the request when it is NONE.
   *
   * Every handler goes through this before touching the usecase, so there is
   * one place that decides and one place that refuses. Returns null when the
   * request has already been answered.
   */
  async _scopeOrDeny(req, res) {
    const scope = await resolveLocationScope(req, this.permissions);
    if (scope.kind === SCOPE.NONE) {
      res.status(403).json(SCOPE_DENIED);
      return null;
    }
    return scope;
  }

  /** The filters as the usecase takes them, scope already applied. */
  _filters(req, query, scope) {
    return {
      attendance_date: query.attendance_date,
      store_ids: effectiveStoreIds(query.store_ids, scope),
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
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const scope = await this._scopeOrDeny(req, res);
          if (!scope) return;
          const filters = await this.usecase.getFilters({
            store_ids: effectiveStoreIds(null, scope),
          });
          res.json({ code: 200, ...filters, scope: scope.kind });
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
          const scope = await this._scopeOrDeny(req, res);
          if (!scope) return;
          const { store_unassigned, ...filters } = this._filters(req, req.query, scope);
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

          const scope = await this._scopeOrDeny(req, res);
          if (!scope) return;
          const result = await this.usecase.getDrilldown({
            ...this._filters(req, req.query, scope),
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
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...FILTER_SCHEMA,
            days: Joi.number().integer().min(1).max(35).optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scope = await this._scopeOrDeny(req, res);
          if (!scope) return;
          const { store_unassigned, ...filters } = this._filters(req, req.query, scope);
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
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            store_ids: Joi.string().regex(/^\d+(,\d+)*$/).allow(null, "").optional(),
            designation_id: Joi.number().integer().positive().allow(null, "").optional(),
            work_shift_id: Joi.number().integer().positive().allow(null, "").optional(),
            search: Joi.string().max(100).allow(null, "").optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scope = await this._scopeOrDeny(req, res);
          if (!scope) return;

          const result = await this.staffing.getSnapshot({
            store_ids: effectiveStoreIds(req.query.store_ids, scope),
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
     * E. Recurring coverage gaps - repeated shortfalls against the SCHEDULE.
     *
     * A secondary, evidence-showing panel: every row carries the dates and
     * counts behind it, and days whose punch retrieval was unfinished or
     * failed are excluded rather than averaged in.
     */
    this.router.get(
      "/attendance/dashboard/recurring-gaps",
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            store_ids: Joi.string().regex(/^\d+(,\d+)*$/).allow(null, "").optional(),
            designation_id: Joi.number().integer().positive().allow(null, "").optional(),
            search: Joi.string().max(100).allow(null, "").optional(),
            comparable_days: Joi.number().integer().min(2).max(8).optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scope = await this._scopeOrDeny(req, res);
          if (!scope) return;

          const result = await this.staffing.getRecurringGaps({
            store_ids: effectiveStoreIds(req.query.store_ids, scope),
            designation_id: asId(req.query.designation_id),
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
      this.permissions.require(P.VIEW_ATTENDANCE_DASHBOARD),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...FILTER_SCHEMA,
            limit: Joi.number().integer().min(1).max(100).optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scope = await this._scopeOrDeny(req, res);
          if (!scope) return;
          const { store_unassigned, ...filters } = this._filters(req, req.query, scope);
          const result = await this.usecase.getRecentPunches({
            ...filters,
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

module.exports = (attendanceDashboardUsecase, permissions, sensitive, attendanceStaffingUsecase) =>
  new AttendanceDashboardRoutes(
    attendanceDashboardUsecase,
    permissions,
    sensitive,
    attendanceStaffingUsecase
  );
module.exports.AttendanceDashboardRoutes = AttendanceDashboardRoutes;
module.exports.resolveLocationScope = resolveLocationScope;
module.exports.effectiveStoreIds = effectiveStoreIds;
module.exports.SCOPE = SCOPE;
module.exports.ACCESS_ALL_STORES = ACCESS_ALL_STORES;
