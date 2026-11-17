const respondError = require("../utils/http");

/**
 * Warehouse Daily Reports (/wh-daily-reports): the five RetailPilot exports
 * the team uploads every morning - Picking, Packing, Verification, Loading,
 * Unloading - and their analysis.
 *
 *   GET    /status?from&to                     what was uploaded each day        upload_wh_daily_reports (Daily Uploads),
 *                                                                                    view_wh_daily_reports (Analysis) or
 *                                                                                    view_pick_pack_verifications (its calendar)
 *   GET    /analysis?from&to&store             write-offs, funnel, boxes, trucks  view_wh_daily_reports
 *   GET    /rows?from&to&report_type&only&store  rows for downloads              view_wh_daily_reports
 *   POST   /upload                             one file as one report for a day   upload_wh_daily_reports
 *          { report_type, report_date, file_name, headers: [...], rows: [[...], ...], allow_date_mismatch }
 *   DELETE /uploads/:upload_id                 remove an upload and its rows      upload_wh_daily_reports
 */
class WhDailyReportsRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = require("express").Router();
    this.init();
  }

  init() {
    const deny = (req, res) => res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });
    // Any of the keys.
    const need = (...keys) => (this.permissions ? this.permissions.require(...keys) : deny);
    const send = (res, result) => {
      if (result.code === 200) return res.json(result);
      return res.status([403, 404, 409, 422].includes(result.code) ? result.code : 400).json(result);
    };
    const q = (req, k) => (req.query[k] == null ? null : String(req.query[k]).trim() || null);

    // The Pick & Pack Verification calendar reads it to mark days uploaded with no write-off.
    this.router.get("/status", need("upload_wh_daily_reports", "view_wh_daily_reports", "view_pick_pack_verifications"), async (req, res) => {
      try {
        send(res, await this.usecase.status({ from: q(req, "from"), to: q(req, "to") }));
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.get("/analysis", need("view_wh_daily_reports"), async (req, res) => {
      try {
        send(res, await this.usecase.analysis({ from: q(req, "from"), to: q(req, "to"), store: q(req, "store") }));
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.get("/rows", need("view_wh_daily_reports"), async (req, res) => {
      try {
        send(
          res,
          await this.usecase.rows({
            from: q(req, "from"),
            to: q(req, "to"),
            report_type: q(req, "report_type"),
            only: q(req, "only") || "all",
            store: q(req, "store"),
          })
        );
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.post("/upload", need("upload_wh_daily_reports"), async (req, res) => {
      try {
        const b = req.body || {};
        if (!Array.isArray(b.headers) || !Array.isArray(b.rows)) return res.status(422).json({ code: 422, msg: "The file could not be read" });
        send(
          res,
          await this.usecase.upload({
            report_type: b.report_type,
            report_date: b.report_date,
            file_name: b.file_name == null ? null : String(b.file_name),
            headers: b.headers,
            rows: b.rows,
            allow_date_mismatch: b.allow_date_mismatch === true,
            employee_id: (req.decoded && req.decoded.employee_id) || null,
          })
        );
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.delete("/uploads/:upload_id", need("upload_wh_daily_reports"), async (req, res) => {
      try {
        send(res, await this.usecase.deleteUpload({ upload_id: req.params.upload_id }));
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new WhDailyReportsRoutes(usecase, permissions);
