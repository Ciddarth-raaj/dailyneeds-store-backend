const express = require("express");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const { csvCell } = require("./employee_report");

/**
 * Attendance - Part 1, the raw Biomax punch flow. Mounted at /attendance.
 *
 * Two views, two permissions, two exports (R14, D5, D7):
 *
 *   GET  /raw                    Attendance List      view_raw_attendance
 *   GET  /raw/export.csv         its CSV              export_raw_attendance
 *   GET  /raw/summary            banner counts        view_raw_attendance
 *   GET  /raw/punches            Punch Audit          view_attendance_punch_audit
 *   GET  /raw/punches/export.csv its CSV              view_attendance_punch_audit
 *
 * The Attendance List has NO device or punch-location parameter and answers
 * 400 if one is sent, so a client cannot believe it filtered by them: a row
 * is an employee's whole attendance day across every terminal. Device and
 * location filters live on the Punch Audit, which lists punches, not days.
 *
 * Nothing here calculates attendance. The rows are raw punches grouped by
 * employee and attendance date; a day with one punch and a day with nine
 * are both just rows.
 *
 * Exports stream CSV natively and refuse before the first byte, guard the
 * response stream, neutralise formulas with `csvCell`, and are audited in
 * report_export_log by shape only - exactly as routes/employee_report.js.
 */
class AttendanceRawRoutes {
  constructor(attendanceRawUsecase, permissions) {
    this.usecase = attendanceRawUsecase;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  init() {
    const r = this.router;
    const P_ = this.permissions;

    r.get("/raw", P_.require(P.VIEW_RAW_ATTENDANCE), async (req, res) => {
      try {
        const result = await this.usecase.list(req.query);
        res.json({ code: 200, ...result });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.get("/raw/summary", P_.require(P.VIEW_RAW_ATTENDANCE), async (req, res) => {
      try {
        const data = await this.usecase.summary(req.query);
        res.json({ code: 200, data });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.get("/raw/export.csv", P_.require(P.EXPORT_RAW_ATTENDANCE), (req, res) =>
      this.streamCsv(req, res, () => this.usecase.listCsv(req.query))
    );

    r.get("/raw/punches", P_.require(P.VIEW_ATTENDANCE_PUNCH_AUDIT), async (req, res) => {
      try {
        const result = await this.usecase.audit(req.query);
        res.json({ code: 200, ...result });
      } catch (err) {
        this.fail(res, err);
      }
    });

    r.get("/raw/punches/export.csv", P_.require(P.VIEW_ATTENDANCE_PUNCH_AUDIT), (req, res) =>
      this.streamCsv(req, res, () => this.usecase.auditCsv(req.query))
    );
  }

  /**
   * Stream a CSV. Every refusal (validation, permission already checked)
   * happens in `build()` before any header is sent; once bytes flow a
   * failure destroys the response rather than appending an error to a
   * half-written file. `res.on("error")` is the guard that keeps a dead
   * socket from taking the process down (see routes/employee_report.js).
   */
  async streamCsv(req, res, build) {
    res.on("error", (err) => {
      console.log(`ATTENDANCE.EXPORT.STREAM_ABORTED ${err && err.code ? err.code : "unknown"}`);
    });
    let timer = null;
    try {
      const prepared = await build();
      const actor = await this.permissions.actorFor(req);

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${prepared.filename}"`);
      res.setHeader("Cache-Control", "no-store");
      timer = setTimeout(() => res.destroy(), 60000);

      res.write("﻿");
      res.write(`${prepared.header.map(csvCell).join(",")}\r\n`);
      for (let i = 0; i < prepared.rows.length; i += 500) {
        const chunk = prepared.rows
          .slice(i, i + 500)
          .map((row) => row.map(csvCell).join(","))
          .join("\r\n");
        // Respect backpressure so a fast query never outruns a slow client.
        await new Promise((resolve, reject) => {
          res.write(`${chunk}\r\n`, (err) => (err ? reject(err) : resolve()));
        });
      }
      clearTimeout(timer);
      res.end();

      await this.usecase.recordExport(
        {
          dataset_key: prepared.dataset_key,
          header: prepared.header,
          filters: prepared.meta,
          row_count: prepared.rows.length,
        },
        actor
      );
    } catch (err) {
      if (timer) clearTimeout(timer);
      this.fail(res, err);
    }
  }

  fail(res, err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (err && err.httpCode) {
      res.status(err.httpCode).json({ code: err.httpCode, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (attendanceRawUsecase, permissions) =>
  new AttendanceRawRoutes(attendanceRawUsecase, permissions);
module.exports.AttendanceRawRoutes = AttendanceRawRoutes;
