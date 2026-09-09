// routes/employee_report.js
const express = require("express");
const Joi = require("@hapi/joi");
const ExcelJS = require("exceljs");

const P = require("../constants/hr_permissions");
const reportConfig = require("../config/reports");
const { DATASET } = require("../constants/report_datasets");

/**
 * Reports — the Employee Master HTTP surface.
 *
 * ======================================= WHAT A REQUEST IS ALLOWED TO SAY ==
 *
 * Semantic field KEYS, filter VALUES, a template id, a page number. Nothing
 * else. There is no field on any schema below that carries a table name, a
 * column name, a SELECT expression, a JOIN, a WHERE fragment, an ORDER BY, an
 * operator, or raw SQL - and Joi runs without `allowUnknown`, so a body that
 * invents one is refused rather than ignored. The SQL is assembled entirely
 * from catalogue text in `usecase/employee_report.js`.
 *
 * ============================================ TWO PERMISSIONS, TWO VERBS ==
 *
 * `view_reports` guards discovery, templates and preview. `export_reports`
 * guards the two export routes, and is checked AGAIN inside the service - the
 * middleware protects the route, the service protects the operation, and the
 * export path is the one place where being wrong means data leaves the
 * building. Neither key confers field access: sensitive columns still need
 * `view_employee_sensitive`, so a report cannot become a way around B3.
 *
 * ================================================== STREAMING AND ERRORS ==
 *
 * Both exports stream. That means the status code and headers are committed
 * before the first row is read, so EVERY refusal - permissions, the widened
 * -filter gate, the row cap - is decided in `prepareExport` BEFORE anything is
 * written. Once bytes are flowing the only honest response to a failure is to
 * destroy the connection: a truncated file that downloads cleanly is worse
 * than a broken download, because somebody will open it and believe it.
 *
 * NOTHING HERE LOGS A ROW. Not a name, not a mobile number, not a PAN, not an
 * account number, not the search text. The audit row records the shape of an
 * export - which field keys, which filters, how many rows - and never its
 * contents.
 */

/** Filter VALUES. No operators: this is a form, not a query language. */
const filterSchema = Joi.object({
  status: Joi.string().valid(["active", "inactive", "all"]).optional(),
  outlet_ids: Joi.array().items(Joi.number().integer().positive()).max(200).optional(),
  department_ids: Joi.array().items(Joi.number().integer().positive()).max(200).optional(),
  designation_ids: Joi.array().items(Joi.number().integer().positive()).max(200).optional(),
  search: Joi.string().max(100).allow("").optional(),
});

const fieldKeys = Joi.array()
  .items(Joi.string().max(60))
  .max(reportConfig.MAX_FIELDS)
  .optional();

const runSchema = {
  template_id: Joi.number().integer().positive().optional(),
  field_keys: fieldKeys,
  filters: filterSchema.optional(),
  page: Joi.number().integer().min(1).optional(),
  page_size: Joi.number().integer().min(1).max(reportConfig.MAX_PAGE_SIZE).optional(),
};

const exportSchema = {
  template_id: Joi.number().integer().positive().optional(),
  field_keys: fieldKeys,
  filters: filterSchema.optional(),
  // The explicit "yes, I meant to export the wider set". Absent means no.
  acknowledge_widened_filters: Joi.boolean().optional(),
};

const templateSchema = {
  template_name: Joi.string().min(1).max(120).required(),
  dataset_key: Joi.string().valid([DATASET.EMPLOYEE_MASTER]).optional(),
  field_keys: Joi.array()
    .items(Joi.string().max(60))
    .min(1)
    .max(reportConfig.MAX_FIELDS)
    .required(),
  filters: filterSchema.optional(),
  is_shared: Joi.boolean().optional(),
};

const copySchema = {
  template_name: Joi.string().max(120).allow("").optional(),
};

class EmployeeReportRoutes {
  constructor(reportService, permissions) {
    this.service = reportService;
    this.permissions = permissions;
    // A router per instance rather than a module-level one, so that
    // constructing the routes twice - which the tests do - does not stack two
    // sets of handlers on one shared router.
    this.router = express.Router();
    this.init();
  }

  getRouter() {
    return this.router;
  }

  validate(payload, schema) {
    const isValid = Joi.validate(payload === undefined ? {} : payload, schema);
    if (isValid.error !== null) throw isValid.error;
    return isValid.value;
  }

  /**
   * Turn a thrown error into a response.
   *
   * `ReportError` and `ReportValidationError` both carry their own status, so
   * a caller learns which of the several refusals happened - a widened filter
   * (409) is a different conversation from too many rows (422).
   */
  fail(res, err) {
    if (res.headersSent) {
      // Already streaming. See the header note above: destroy rather than
      // append an error to a half-written spreadsheet.
      res.destroy();
      return;
    }
    if (err && (err.name === "ReportError" || err.name === "ValidationError") && err.httpCode) {
      res.status(err.httpCode).json({
        code: err.httpCode,
        error: err.code,
        msg: err.message,
        ...(err.detail || {}),
      });
    } else if (err && err.name === "ValidationError") {
      res.status(400).json({ code: 422, msg: err.toString() });
    } else if (err && (err.name === "SystemAccountError" || err.name === "UnauthenticatedError")) {
      res.status(err.status).json({ code: err.status, error: err.code, msg: err.message });
    } else {
      console.log(err);
      res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
  }

  init() {
    const { require: needs } = this.permissions;
    const canView = needs(P.VIEW_REPORTS);
    const canExport = needs(P.EXPORT_REPORTS);

    const actor = (req) => this.permissions.actorFor(req);
    const router = this.router;

    /* ------------------------------------------------------- discovery */

    // The field catalogue, as this caller may see it. Fields they cannot use
    // are absent rather than disabled: an unusable field in the picker tells
    // them what exists, which is itself a small disclosure.
    router.get("/fields", canView, async (req, res) => {
      try {
        res.json(this.service.describe(await actor(req)));
      } catch (err) {
        this.fail(res, err);
      }
    });

    /* ------------------------------------------------------- templates */

    router.get("/templates", canView, async (req, res) => {
      try {
        res.json({ templates: await this.service.listTemplates(await actor(req)) });
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.post("/templates", canView, async (req, res) => {
      try {
        const body = this.validate(req.body, templateSchema);
        const template = await this.service.createTemplate(body, await actor(req));
        res.status(201).json({ template });
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.put("/templates/:templateId", canView, async (req, res) => {
      try {
        const body = this.validate(req.body, templateSchema);
        const template = await this.service.updateTemplate(
          Number(req.params.templateId),
          body,
          await actor(req)
        );
        res.json({ template });
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.delete("/templates/:templateId", canView, async (req, res) => {
      try {
        await this.service.deleteTemplate(Number(req.params.templateId), await actor(req));
        res.json({ code: 200, msg: "Report deleted" });
      } catch (err) {
        this.fail(res, err);
      }
    });

    // Save a Copy. The route every user has for a template they may run but
    // not edit - which is what makes the system templates read-only without
    // making them useless.
    router.post("/templates/:templateId/copy", canView, async (req, res) => {
      try {
        const body = this.validate(req.body, copySchema);
        const template = await this.service.copyTemplate(
          Number(req.params.templateId),
          body.template_name,
          await actor(req)
        );
        res.status(201).json({ template });
      } catch (err) {
        this.fail(res, err);
      }
    });

    /* --------------------------------------------------------- preview */

    // POST rather than GET: the body carries an ordered field list and several
    // id arrays, which do not survive a query string honestly, and a preview
    // of somebody's PAN column does not belong in an access log URL.
    router.post("/preview", canView, async (req, res) => {
      try {
        const body = this.validate(req.body, runSchema);
        res.json(await this.service.preview(body, await actor(req)));
      } catch (err) {
        this.fail(res, err);
      }
    });

    /* ---------------------------------------------------------- export */

    router.post("/export/xlsx", canExport, (req, res) => this.exportXlsx(req, res));
    router.post("/export/csv", canExport, (req, res) => this.exportCsv(req, res));
  }

  /**
   * Every decision that can refuse an export, made before a byte is written.
   * Returns `null` if the response has already been failed.
   */
  async _prepare(req, res, format) {
    const body = this.validate(req.body, exportSchema);
    const actor = await this.permissions.actorFor(req);
    const prepared = await this.service.prepareExport(body, actor, format);
    return { prepared, actor };
  }

  _sendHeaders(res, prepared, contentType) {
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${prepared.filename}"`
    );
    // A report is a point-in-time answer about people; it must not sit in an
    // intermediary or a browser cache.
    res.setHeader("Cache-Control", "no-store");
  }

  /**
   * XLSX, streamed.
   *
   * `WorkbookWriter` writes each row through to the response as it is
   * committed rather than building the workbook in memory, which is what keeps
   * a 5,000-row export bounded on a small box.
   */
  async exportXlsx(req, res) {
    let timer = null;
    try {
      const { prepared, actor } = await this._prepare(req, res, "xlsx");

      this._sendHeaders(
        res,
        prepared,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      // A streamed export holds a cursor; without a deadline a stuck client
      // holds it open. The connection is destroyed rather than completed, so
      // nobody receives a short file that looks whole.
      timer = setTimeout(() => res.destroy(), reportConfig.EXPORT_TIMEOUT_MS);

      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
      const sheet = workbook.addWorksheet("Report");

      sheet.addRow(prepared.fields.map((f) => f.label)).font = { bold: true };
      sheet.views = [{ state: "frozen", ySplit: 1 }];

      const written = await this.service.streamRows(prepared, (rows) => {
        for (const row of rows) {
          // Values are written as text as the catalogue produced them. No
          // formula, no leading `=`, nothing evaluated - a cell that begins
          // with `=` in a spreadsheet is code, and an employee's name is not.
          sheet
            .addRow(
              prepared.fields.map((f) => {
                const v = row[f.key];
                return v === null || v === undefined ? "" : String(v);
              })
            )
            .commit();
        }
      });

      sheet.commit();
      await workbook.commit();
      clearTimeout(timer);

      // Audited after the fact, so an export that failed mid-stream is not
      // recorded as one that happened. Shape only - never a value.
      await this.service.recordExport({ ...prepared, row_count: written }, actor);
    } catch (err) {
      if (timer) clearTimeout(timer);
      this.fail(res, err);
    }
  }

  /**
   * CSV, streamed natively.
   *
   * No library: RFC 4180 quoting is six lines, and a dependency that formats
   * text is a dependency that can decide to interpret it.
   */
  async exportCsv(req, res) {
    let timer = null;
    try {
      const { prepared, actor } = await this._prepare(req, res, "csv");

      this._sendHeaders(res, prepared, "text/csv; charset=utf-8");
      timer = setTimeout(() => res.destroy(), reportConfig.EXPORT_TIMEOUT_MS);

      // A BOM, so Excel opens a UTF-8 CSV as UTF-8 rather than as the local
      // code page - otherwise every non-ASCII name arrives mangled.
      res.write("﻿");
      res.write(`${prepared.fields.map((f) => csvCell(f.label)).join(",")}\r\n`);

      const written = await this.service.streamRows(prepared, (rows) => {
        const chunk = rows
          .map((row) => prepared.fields.map((f) => csvCell(row[f.key])).join(","))
          .join("\r\n");
        // Respect backpressure: without this a fast query outruns a slow
        // client and the rows queue in memory, which is the thing streaming
        // was meant to avoid.
        return new Promise((resolve, reject) => {
          res.write(`${chunk}\r\n`, (err) => (err ? reject(err) : resolve()));
        });
      });

      clearTimeout(timer);
      res.end();

      await this.service.recordExport({ ...prepared, row_count: written }, actor);
    } catch (err) {
      if (timer) clearTimeout(timer);
      this.fail(res, err);
    }
  }
}

/**
 * One CSV cell.
 *
 * Two separate jobs, and they are not the same job:
 *
 *   RFC 4180 quoting, so a comma or a newline in an address does not become a
 *   new column or a new row.
 *
 *   FORMULA NEUTRALISATION. A cell beginning `=`, `+`, `-`, `@`, or a control
 *   character is executed by Excel when the file is opened - so a name stored
 *   as `=HYPERLINK(...)` runs on the machine of whoever opens the export. The
 *   value is prefixed with a single quote, which Excel shows as text and
 *   never evaluates. The stored data is not altered; only what the spreadsheet
 *   is told to do with it.
 */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

module.exports = (reportService, permissions) =>
  new EmployeeReportRoutes(reportService, permissions);
module.exports.EmployeeReportRoutes = EmployeeReportRoutes;
module.exports.csvCell = csvCell;
