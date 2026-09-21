const express = require("express");
const Joi = require("@hapi/joi");
const ExcelJS = require("exceljs");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const {
  effectiveStoreIds: narrowStoreIds,
  parseRequestedStores,
  scopeForClient,
} = require("../utils/dashboard_scope");

/**
 * THE SHIFT CHANGE ELIGIBILITY REPORT API.
 *
 * READ-ONLY, ENTIRELY. Two GETs and nothing else: the rows, and the same rows
 * as a spreadsheet. There is no POST, PUT, PATCH or DELETE on this router and
 * the usecase behind it has no write method to call. Opening or exporting the
 * report cannot raise a shift change request, approve or reject one, edit a
 * shift assignment, recalculate a date or touch a payroll lock.
 *
 * ======================================================== AUTHORIZATION ====
 *
 * Every route carries `requireDashboardAccess(...)` INDIVIDUALLY - the shared
 * Global Dashboard resolver, the same one the Attendance Dashboard and the
 * Missing Attendance Report use. It settles the two questions separately and
 * fails closed on both:
 *
 *   MAY THIS PERSON OPEN THIS REPORT?   `view_shift_change_eligibility_report`,
 *                                       its own key, granted to nobody by
 *                                       migration.
 *   WHICH BRANCHES MAY THEY SEE?        the dashboard STORE SCOPE -
 *                                       ALL_STORES or OWN_STORE - resolved
 *                                       from the server's own facts, never
 *                                       from the request.
 *
 * SO A NEW REPORT WIDENS NOBODY. A branch manager who is Own Store on the
 * Attendance Dashboard is Own Store here: the middleware refuses a request
 * naming another branch outright, and `narrowStoreIds` intersects whatever
 * survives with the scope before it reaches the usecase. NO OUTLET ID SENT BY
 * A BROWSER IS EVER TRUSTED - there is no code path on this router by which a
 * filter, a body, a header or a URL can widen a location.
 *
 * THE EXPORT REQUIRES A SECOND KEY. `export_shift_change_eligibility_report`
 * is checked ON TOP of the read key and the scope, exactly as Missing
 * Attendance splits its two, because a spreadsheet of every branch's long days
 * leaving the building is a different decision from reading the screen. The
 * export builds its rows from the SAME usecase call with the SAME narrowed
 * `store_ids` and the SAME filters, so it can never contain a row the screen
 * would not show.
 *
 * VIEWING IS NOT RAISING AND IS NOT APPROVING. Holding these keys grants this
 * table and nothing else. Raising a shift change is the employee's own route
 * behind `raise_shift_change_request`; deciding one is the approver's, behind
 * `approve_shift_change_request`. Neither is reachable from here.
 */

const DATE = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TRISTATE = Joi.string().valid("ALL", "YES", "NO").allow(null, "").optional();

/** The filters the report accepts. Unknown keys are refused by Joi. */
const FILTER_SCHEMA = {
  from_date: DATE.required(),
  to_date: DATE.required(),
  store_ids: Joi.string().regex(/^\d+(,\d+)*$/).allow(null, "").optional(),
  designation_id: Joi.number().integer().positive().allow(null, "").optional(),
  employee_id: Joi.number().integer().positive().allow(null, "").optional(),
  can_raise: TRISTATE,
  worked_longer: TRISTATE,
  request_status: Joi.string()
    .valid("ALL", "NOT_RAISED", "PENDING", "APPROVED", "REJECTED")
    .allow(null, "")
    .optional(),
  search: Joi.string().max(100).allow(null, "").optional(),
};

const asId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const yesNo = (value) => (value ? "Yes" : "No");

/** The export's columns, in order. ONE list - the header and the rows share it. */
const EXPORT_COLUMNS = [
  { header: "Date", key: "attendance_date", width: 12 },
  { header: "Employee ID", key: "employee_id", width: 13 },
  { header: "Employee Name", key: "employee_name", width: 28 },
  { header: "Outlet", key: "outlet_name", width: 22 },
  { header: "Designation", key: "designation_name", width: 22 },
  { header: "Assigned Shift", key: "assigned_shift", width: 26 },
  { header: "Actual First Punch", key: "first_punch", width: 18 },
  { header: "Actual Last Punch", key: "last_punch", width: 18 },
  { header: "Worked Hours", key: "worked_hours", width: 14 },
  { header: "Extra Hours", key: "extra_hours", width: 13 },
  { header: "Can Raise Shift Change?", key: "can_raise", width: 22 },
  { header: "Worked Longer Than Assigned Shift?", key: "worked_longer", width: 32 },
  { header: "Eligibility Reason", key: "eligibility_reason", width: 52 },
  { header: "Request Status", key: "request_status", width: 16 },
  { header: "Request ID", key: "request_id", width: 12 },
];

/**
 * The Assigned Shift as one cell: the name, and the hours it runs.
 *
 * Shared by the screen and the spreadsheet through this module so the two
 * cannot describe the same shift differently.
 */
function assignedShiftLabel(row) {
  const name = row.assigned_shift_name || row.assigned_shift_code || null;
  const hhmm = (t) => (t ? String(t).slice(0, 5) : null);
  const span =
    row.assigned_shift_in_time && row.assigned_shift_out_time
      ? `${hhmm(row.assigned_shift_in_time)}-${hhmm(row.assigned_shift_out_time)}`
      : null;
  if (name && span) return `${name} ${span}`;
  return name || span || "";
}

/** One report row as the spreadsheet holds it. */
function exportRow(row) {
  return {
    attendance_date: row.attendance_date,
    employee_id: row.employee_id,
    employee_name: row.employee_name || "",
    outlet_name: row.outlet_name || "",
    designation_name: row.designation_name || "",
    assigned_shift: assignedShiftLabel(row),
    first_punch: row.first_punch || "",
    last_punch: row.last_punch || "",
    worked_hours: row.worked_hours,
    extra_hours: row.extra_hours,
    can_raise: yesNo(row.can_raise),
    worked_longer: yesNo(row.worked_longer),
    eligibility_reason: row.eligibility_reason || "",
    request_status: row.request_status,
    request_id: row.request_id === null ? "" : row.request_id,
  };
}

class AttendanceShiftChangeReportRoutes {
  constructor(usecase, permissions, sensitive, dashboardScope) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.dashboards = dashboardScope;
    this.sensitive = sensitive;
    this.router = express.Router();
    this.init();
  }

  _scope(req) {
    return req.dashboardScope || { kind: "NONE", store_ids: [] };
  }

  /**
   * The filters as the usecase takes them, SCOPE ALREADY APPLIED.
   *
   * `store_ids` is the intersection of what the caller asked for with what
   * the server decided they may see. An Own Store caller gets their own
   * branch whatever they sent, and a request naming another branch never
   * reached this method - the middleware refused it.
   */
  _filters(req, query) {
    const scope = this._scope(req);
    return {
      from_date: query.from_date,
      to_date: query.to_date,
      store_ids: narrowStoreIds(scope, parseRequestedStores(query.store_ids)),
      designation_id: asId(query.designation_id),
      employee_id: asId(query.employee_id),
      can_raise: query.can_raise || "ALL",
      worked_longer: query.worked_longer || "ALL",
      request_status: query.request_status || "ALL",
      search: query.search ? String(query.search).trim() : null,
    };
  }

  /**
   * Make a mid-stream write failure survivable.
   *
   * Once headers are sent, a failure destroys the response rather than
   * appending an error to a half-written spreadsheet - but ExcelJS's archiver
   * keeps pushing, and a write to a destroyed socket emits an `error` EVENT
   * on the ServerResponse. An unhandled `error` event terminates the PROCESS,
   * so one failed download would take every other request in flight with it.
   * Transcribed from `routes/attendance_missing.js`, which took it from
   * `routes/employee_report.js`, which learned it the hard way.
   */
  _guardStream(res) {
    res.on("error", (err) => {
      console.log(
        `ATTENDANCE.SHIFT_CHANGE_ELIGIBILITY.EXPORT.STREAM_ABORTED ${
          err && err.code ? err.code : "unknown"
        }`
      );
    });
  }

  init() {
    if (this.sensitive) {
      this.router.use("/attendance/reports/shift-change-eligibility", this.sensitive.filterResponse);
      this.router.use("/attendance/reports/shift-change-eligibility", this.sensitive.guardWrite);
    }

    /** The rows. */
    this.router.get(
      "/attendance/reports/shift-change-eligibility",
      this.dashboards.requireDashboardAccess(P.VIEW_SHIFT_CHANGE_ELIGIBILITY_REPORT),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, FILTER_SCHEMA);
          if (isValid.error !== null) throw isValid.error;

          const scope = this._scope(req);
          const result = await this.usecase.getReport(this._filters(req, req.query));
          res.setHeader("Cache-Control", "no-store");
          res.json({
            code: 200,
            ...result,
            // Presentation input only - whether to offer an outlet picker and
            // which outlet an Own Store caller is pinned to. It carries no
            // permission key and nothing about anybody else's branches, and
            // every endpoint re-resolves the scope on the server regardless
            // of what the browser does with it.
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

    /**
     * The same rows, as a spreadsheet.
     *
     * TWO KEYS AND THE SAME SCOPE. The read key and the store scope are
     * settled by the middleware; the export key is checked after it, so a
     * caller holding only the export key cannot reach this and a caller
     * holding only the read key is refused the file.
     */
    this.router.get(
      "/attendance/reports/shift-change-eligibility/export.xlsx",
      this.dashboards.requireDashboardAccess(P.VIEW_SHIFT_CHANGE_ELIGIBILITY_REPORT),
      this.permissions.require(P.EXPORT_SHIFT_CHANGE_ELIGIBILITY_REPORT),
      async (req, res) => {
        this._guardStream(res);
        try {
          const isValid = Joi.validate(req.query, FILTER_SCHEMA);
          if (isValid.error !== null) throw isValid.error;

          // THE SAME CALL THE SCREEN MAKES, with the same narrowed
          // `store_ids` and the same view filters. The export cannot contain
          // a row the screen would not show, because it is not a second query.
          const { meta, data } = await this.usecase.getReport(this._filters(req, req.query));

          const filename = `shift-change-eligibility-${meta.from_date}-to-${meta.to_date}.xlsx`;
          res.setHeader("Cache-Control", "no-store");
          res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          );
          res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

          const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
          // The frozen header is declared as an OPTION and never assigned
          // afterwards: `WorksheetWriter.views` is a getter with no setter,
          // and assigning to it in strict mode throws AFTER the headers have
          // already gone out.
          const sheet = workbook.addWorksheet("Shift Change Eligibility", {
            views: [{ state: "frozen", ySplit: 1 }],
          });
          sheet.columns = EXPORT_COLUMNS;
          sheet.getRow(1).font = { bold: true };
          sheet.getRow(1).commit();

          data.forEach((row) => sheet.addRow(exportRow(row)).commit());
          sheet.commit();
          await workbook.commit();
        } catch (err) {
          if (res.headersSent) {
            // The client has already lost this response. The only thing left
            // to get right is not serving a truncated file as a whole one.
            res.destroy();
            return;
          }
          respondError(res, err);
        }
      }
    );
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions, sensitive, dashboardScope) =>
  new AttendanceShiftChangeReportRoutes(usecase, permissions, sensitive, dashboardScope);
module.exports.AttendanceShiftChangeReportRoutes = AttendanceShiftChangeReportRoutes;
module.exports.EXPORT_COLUMNS = EXPORT_COLUMNS;
module.exports.exportRow = exportRow;
module.exports.assignedShiftLabel = assignedShiftLabel;
