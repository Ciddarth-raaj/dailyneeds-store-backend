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
 * THE MISSING ATTENDANCE REPORT API.
 *
 * READ-ONLY, ENTIRELY. Two GETs and nothing else: the rows, and the same rows
 * as a spreadsheet. There is no POST, PUT, PATCH or DELETE on this router and
 * the usecase behind it has no write method to call. Opening or exporting the
 * report cannot regularize a date, approve anything, edit a punch or
 * recalculate attendance.
 *
 * ======================================================== AUTHORIZATION ====
 *
 * Every route carries `requireDashboardAccess(...)` INDIVIDUALLY - the shared
 * Global Dashboard resolver, the same one the Attendance Dashboard uses. It
 * settles the two questions separately and fails closed on both:
 *
 *   MAY THIS PERSON OPEN THIS REPORT?   `view_missing_attendance_report`, its
 *                                       own key, granted to nobody by
 *                                       migration.
 *   WHICH BRANCHES MAY THEY SEE?        the dashboard STORE SCOPE -
 *                                       ALL_STORES or OWN_STORE - resolved
 *                                       from the server's own facts, never
 *                                       from the request.
 *
 * SO A NEW REPORT WIDENS NOBODY. A branch manager who is Own Store on the
 * Attendance Dashboard is Own Store here: the middleware refuses a request
 * naming another branch outright, and `narrowStoreIds` intersects whatever
 * survives with the scope before it reaches the usecase. There is no code
 * path on this router by which a filter, a body, a header or a URL can widen
 * a location.
 *
 * THE EXPORT REQUIRES A SECOND KEY. `export_missing_attendance_report` is
 * checked ON TOP of the read key and the scope, because a spreadsheet of
 * every branch's attendance gaps leaving the building is a different decision
 * from reading the screen - the same split `view_raw_attendance` /
 * `export_raw_attendance` already makes on the Attendance List. The export
 * builds its rows from the SAME usecase call with the SAME narrowed
 * `store_ids`, so it can never contain a row the screen would not show.
 */

const DATE = Joi.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The filters the report accepts. Unknown keys are refused by Joi. */
const FILTER_SCHEMA = {
  from_date: DATE.required(),
  to_date: DATE.required(),
  store_ids: Joi.string().regex(/^\d+(,\d+)*$/).allow(null, "").optional(),
  department_id: Joi.number().integer().positive().allow(null, "").optional(),
  employee_id: Joi.number().integer().positive().allow(null, "").optional(),
  work_shift_id: Joi.number().integer().positive().allow(null, "").optional(),
  search: Joi.string().max(100).allow(null, "").optional(),
};

const asId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** The export's columns, in order. ONE list - the header and the rows share it. */
const EXPORT_COLUMNS = [
  { header: "Date", key: "attendance_date", width: 12 },
  { header: "Employee ID", key: "employee_id", width: 13 },
  { header: "Employee Name", key: "employee_name", width: 28 },
  { header: "Outlet", key: "outlet_name", width: 22 },
  { header: "Department", key: "department_name", width: 20 },
  { header: "Designation", key: "designation_name", width: 22 },
  { header: "Shift", key: "shift_name", width: 18 },
  { header: "Punch Count", key: "punch_count", width: 13 },
  { header: "Punch Times", key: "punch_times", width: 34 },
  { header: "Status", key: "status", width: 20 },
  { header: "Correction Requested", key: "correction_requested", width: 20 },
];

/** One report row as the spreadsheet holds it. */
function exportRow(row) {
  return {
    attendance_date: row.attendance_date,
    employee_id: row.employee_id,
    employee_name: row.employee_name || "",
    outlet_name: row.outlet_name || "",
    department_name: row.department_name || "",
    designation_name: row.designation_name || "",
    shift_name: row.shift_name || "",
    punch_count: row.punch_count,
    punch_times: (row.punch_times || []).join(", "),
    status: row.status,
    correction_requested: row.has_correction_request
      ? row.correction_request_pending
        ? "Pending"
        : "Raised"
      : "No",
  };
}

class AttendanceMissingRoutes {
  constructor(attendanceMissingUsecase, permissions, sensitive, dashboardScope) {
    this.usecase = attendanceMissingUsecase;
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
      department_id: asId(query.department_id),
      employee_id: asId(query.employee_id),
      work_shift_id: asId(query.work_shift_id),
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
   * This listener turns that back into what it should be: this download
   * fails, and nothing else notices. Transcribed from
   * `routes/employee_report.js`, which learned it the hard way.
   */
  _guardStream(res) {
    res.on("error", (err) => {
      console.log(
        `ATTENDANCE.MISSING.EXPORT.STREAM_ABORTED ${err && err.code ? err.code : "unknown"}`
      );
    });
  }

  init() {
    if (this.sensitive) {
      this.router.use("/attendance/reports/missing", this.sensitive.filterResponse);
      this.router.use("/attendance/reports/missing", this.sensitive.guardWrite);
    }

    /** The rows. */
    this.router.get(
      "/attendance/reports/missing",
      this.dashboards.requireDashboardAccess(P.VIEW_MISSING_ATTENDANCE_REPORT),
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
      "/attendance/reports/missing/export.xlsx",
      this.dashboards.requireDashboardAccess(P.VIEW_MISSING_ATTENDANCE_REPORT),
      this.permissions.require(P.EXPORT_MISSING_ATTENDANCE_REPORT),
      async (req, res) => {
        this._guardStream(res);
        try {
          const isValid = Joi.validate(req.query, FILTER_SCHEMA);
          if (isValid.error !== null) throw isValid.error;

          // THE SAME CALL THE SCREEN MAKES, with the same narrowed
          // `store_ids`. The export cannot contain a row the screen would not
          // show, because it is not a second query.
          const { meta, data } = await this.usecase.getReport(this._filters(req, req.query));

          const filename = `missing-attendance-${meta.effective_from_date || meta.from_date}-to-${
            meta.effective_to_date || meta.to_date
          }.xlsx`;
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
          const sheet = workbook.addWorksheet("Missing Attendance", {
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

module.exports = (attendanceMissingUsecase, permissions, sensitive, dashboardScope) =>
  new AttendanceMissingRoutes(attendanceMissingUsecase, permissions, sensitive, dashboardScope);
module.exports.AttendanceMissingRoutes = AttendanceMissingRoutes;
module.exports.EXPORT_COLUMNS = EXPORT_COLUMNS;
module.exports.exportRow = exportRow;
