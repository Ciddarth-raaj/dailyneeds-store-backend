const express = require("express");
const Joi = require("@hapi/joi");
const ExcelJS = require("exceljs");

const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");
const {
  COMPONENT_KEYS,
  ADJUSTMENT_STATE,
  MAX_IMPORT_ROWS,
  REMARKS_MAX_LENGTH,
} = require("../constants/payrun_adjustments");

/**
 * Payrun Adjustments V1 - the API. A STAGE of /payrun, mounted under it.
 *
 * THE SURFACE:
 *
 *   GET  /payrun/adjustments/components   what V1 is: the six, their labels
 *   GET  /payrun/adjustments/month        the stage: population, states, counts
 *   POST /payrun/adjustments/export       the .xlsx template, streamed
 *   POST /payrun/adjustments/preview      validate a file; writes NOTHING
 *   POST /payrun/adjustments/confirm      save the file's adjustments
 *   POST /payrun/adjustments/employee     add / edit / clear one employee
 *   POST /payrun/adjustments/no-adjustment  EXPLICIT confirmation, 1 or many
 *   GET  /payrun/adjustments/history      who changed what, when, from where
 *
 * ========================================= NO NEW PERMISSION, AND THAT IS ==
 * ========================================= A DECISION, NOT AN OMISSION    ==
 *
 *   read    `view_employees` AND `view_payroll` AND `view_salary` - the same
 *           conjunction `GET /payrun/month` uses. The third is not decoration:
 *           this screen shows per-employee amounts of money across the whole
 *           company, which is exactly the disclosure `view_salary` governs,
 *           and it must not become reachable through a payroll key somebody
 *           was granted to look at headcounts.
 *
 *   write   `view_employees` AND `process_payroll`. M2 declared
 *           `process_payroll` as "run a payroll period"; the initialization
 *           stage claimed it for Initialize, and putting figures into that
 *           same month is the same person doing the same job one stage later.
 *
 * AN `adjust_payrun` KEY WAS CONSIDERED AND REJECTED. It would have to be
 * granted on day one to everybody who already holds `process_payroll`, or the
 * people who run payroll could no longer finish a month - at which point it
 * says nothing. Not granting it would make it a second, quieter answer to "who
 * may put money into a payroll month", which is the kind of right that gets
 * granted by accident. `change_payrun_pay_type` is separate because it is a
 * different decision - HOW the money travels. An adjustment is HOW MUCH.
 *
 * NOTHING A CLIENT SENDS IS TRUSTED AS A VALUE. The schemas below accept a
 * month, employee ids, amounts and free text. They accept no employee name, no
 * location, no state, no `confirmed_by` and no timestamp: who confirmed
 * something is the SERVER'S identity, taken from `permissions.actorFor(req)`
 * and never from a body. Joi runs without `allowUnknown`, so a body that so
 * much as names `confirmed_by` is refused before the usecase is reached.
 *
 * THE BRANCH SCOPE IS APPLIED TO EVERY ENDPOINT, READS AND WRITES ALIKE, with
 * the shared resolver every other employee route uses. It fails closed, and an
 * employee id in a body can only ever be refused by it - never widen it.
 *
 * B3 APPLIES HERE TOO: the sensitive response filter and write guard are
 * mounted on this router exactly as they are on /payrun and /hr.
 */
class PayrunAdjustmentRoutes {
  constructor(adjustmentUsecase, permissions, sensitive, branchScope) {
    this.usecase = adjustmentUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.branchScope = branchScope;
    this.router = express.Router();
    this.init();
  }

  /** `NotFoundError` as a 404 rather than the 500 the shared helper would give it. */
  _fail(res, err) {
    if (err && err.name === "NotFoundError") {
      res.status(404).json({ code: 404, msg: err.message });
      return;
    }
    respondError(res, err);
  }

  /** The caller's branch scope, or a refusal already sent. See `routes/payrun.js`. */
  async _scope(req, res, requested) {
    if (!this.branchScope) return { store_ids: null };
    const scoped = await this.branchScope.listFilters(req, requested);
    if (!scoped.ok) {
      this.branchScope.refuse(res, scoped);
      return undefined;
    }
    return scoped;
  }

  _month() {
    return {
      year: Joi.number().integer().min(2000).max(2100).required(),
      month: Joi.number().integer().min(1).max(12).required(),
    };
  }

  /**
   * WHAT AN UPLOAD IS ALLOWED TO SAY: the month, the header labels, the cells
   * and the file's name. No employee id column mapping, no component key, no
   * resolved anything - the server reads the cells by its own closed catalogue
   * and refuses a header it does not own.
   */
  _uploadSchema() {
    return Joi.object()
      .keys({
        ...this._month(),
        filename: Joi.string().trim().max(255).allow("").allow(null).optional(),
        headers: Joi.array().items(Joi.string().allow("")).min(1).max(64).required(),
        rows: Joi.array().items(Joi.object()).max(MAX_IMPORT_ROWS + 1).required(),
      })
      .unknown(false);
  }

  init() {
    if (this.sensitive) {
      this.router.use("/payrun/adjustments", this.sensitive.filterResponse);
      this.router.use("/payrun/adjustments", this.sensitive.guardWrite);
    }

    const READ = [P.VIEW_EMPLOYEES, P.VIEW_PAYROLL, P.VIEW_SALARY];
    const WRITE = [P.VIEW_EMPLOYEES, P.PROCESS_PAYROLL];

    /**
     * WHAT V1 IS - the six components, their labels, their kinds and their
     * PF/ESI flags, plus the template's columns in order.
     *
     * THE SCREEN DRAWS ITSELF FROM THIS. A browser holding its own list of
     * components is a second declaration of V1, and the day a seventh is added
     * it renders six columns and drops a payroll figure on the floor.
     */
    this.router.get(
      "/payrun/adjustments/components",
      this.permissions.requireAll(...READ),
      async (req, res) => {
        try {
          res.json(this.usecase.describe());
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * THE STAGE, FOR ONE MONTH.
     *
     * READS STATE AND CHANGES NONE. Opening the Adjustments screen must never
     * confirm anybody, never create a state row and never initialize an
     * employee; the capability to do any of the three is simply absent from
     * this handler.
     */
    this.router.get(
      "/payrun/adjustments/month",
      this.permissions.requireAll(...READ),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...this._month(),
            store_ids: Joi.any().optional(),
            state: Joi.string().valid(...Object.values(ADJUSTMENT_STATE)).optional(),
            search: Joi.string().trim().max(120).allow("").optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, req.query.store_ids);
          if (!scoped) return;

          res.json({
            code: 200,
            ...(await this.usecase.getMonth({
              year: Number(req.query.year),
              month: Number(req.query.month),
              store_ids: scoped.store_ids,
              state: req.query.state,
              search: req.query.search,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * THE EXPORT TEMPLATE. Streamed as .xlsx.
     *
     * Every refusal - the permission, the branch scope, an impossible month -
     * is decided BEFORE a byte is written, for the reason
     * `routes/employee_bulk_update.js` records: once headers are out, the only
     * honest answer to a failure is to destroy the connection, because a
     * truncated spreadsheet that opens cleanly is worse than a broken download.
     * Somebody will read it and believe it.
     */
    this.router.post(
      "/payrun/adjustments/export",
      this.permissions.requireAll(...READ),
      (req, res) => this.exportXlsx(req, res)
    );

    /**
     * PREVIEW. Uploading a file must never change a payroll month, so this
     * route reaches only `usecase.preview`, which has no write path.
     */
    this.router.post(
      "/payrun/adjustments/preview",
      this.permissions.requireAll(...WRITE),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, this._uploadSchema());
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          res.json(
            await this.usecase.preview(
              {
                year: Number(req.body.year),
                month: Number(req.body.month),
                headers: req.body.headers,
                rows: req.body.rows,
                filename: req.body.filename,
              },
              { store_ids: scoped.store_ids }
            )
          );
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * CONFIRM - save the adjustments the file carries.
     *
     * IT TAKES THE ROWS AGAIN AND VALIDATES THEM AGAIN. There is no token and
     * no server-side basket: an employee may have been un-initialized and the
     * month may have been locked since the preview, and the file has to answer
     * to the month as it is now.
     *
     * IT CANNOT CONFIRM ANYBODY AS HAVING NO ADJUSTMENT. That is the endpoint
     * below, reached by an explicit act, and there is no path from here to it.
     */
    this.router.post(
      "/payrun/adjustments/confirm",
      this.permissions.requireAll(...WRITE),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, this._uploadSchema());
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json(
            await this.usecase.confirm(
              {
                year: Number(req.body.year),
                month: Number(req.body.month),
                headers: req.body.headers,
                rows: req.body.rows,
                filename: req.body.filename,
              },
              { store_ids: scoped.store_ids, actor }
            )
          );
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * ONE EMPLOYEE, BY HAND - add, edit or clear.
     *
     * THE AMOUNT SCHEMA IS DELIBERATELY PERMISSIVE AND THE USECASE IS NOT.
     * `Joi.any()` here, because the ONE place an amount is read is
     * `utils/payrun_adjustments.js#parseAmount` - the same function the
     * importer uses - and a second, subtly different numeric rule in a Joi
     * schema is how the screen and the spreadsheet start accepting different
     * things. What Joi DOES enforce is the closed set of component keys, so a
     * component V1 does not have cannot even be named.
     *
     * `null` CLEARS a component. A component not named is left alone.
     */
    this.router.post(
      "/payrun/adjustments/employee",
      this.permissions.requireAll(...WRITE),
      async (req, res) => {
        try {
          const amounts = {};
          COMPONENT_KEYS.forEach((key) => {
            amounts[key] = Joi.any().optional();
          });
          const isValid = Joi.validate(req.body, {
            ...this._month(),
            employee_id: Joi.number().integer().positive().required(),
            amounts: Joi.object().keys(amounts).unknown(false).optional(),
            remarks: Joi.string().trim().max(REMARKS_MAX_LENGTH).allow("").allow(null).optional(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.saveEmployee({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_id: Number(req.body.employee_id),
              amounts: req.body.amounts || {},
              remarks: req.body.remarks,
              store_ids: scoped.store_ids,
              actor,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /**
     * THE EXPLICIT NO-ADJUSTMENT CONFIRMATION - one employee or a selection.
     *
     * THE ONLY ENDPOINT THAT CAN PRODUCE `NO_ADJUSTMENT_CONFIRMED`, and it
     * exists precisely so that nothing else can. Importing blanks does not
     * reach it, saving an empty employee does not reach it, and opening the
     * screen does not reach it.
     *
     * INDIVIDUAL AND BULK ARE ONE ENDPOINT. Confirming one employee posts a
     * list of one; two endpoints doing the same thing is how one of them ends
     * up missing the has-an-adjustment check.
     *
     * THE BODY CANNOT SAY WHO CONFIRMED. There is no `confirmed_by` in this
     * schema and Joi refuses unknown keys, so the actor is the server's
     * authenticated identity and nothing else.
     */
    this.router.post(
      "/payrun/adjustments/no-adjustment",
      this.permissions.requireAll(...WRITE),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, {
            ...this._month(),
            employee_ids: Joi.array()
              .items(Joi.number().integer().positive())
              .min(1)
              .max(1000)
              .required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          const actor = await this.permissions.actorFor(req);
          res.json({
            code: 200,
            ...(await this.usecase.confirmNoAdjustment({
              year: Number(req.body.year),
              month: Number(req.body.month),
              employee_ids: req.body.employee_ids,
              store_ids: scoped.store_ids,
              actor,
            })),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );

    /** One employee's adjustment history for the month. */
    this.router.get(
      "/payrun/adjustments/history",
      this.permissions.requireAll(...READ),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.query, {
            ...this._month(),
            employee_id: Joi.number().integer().positive().required(),
          });
          if (isValid.error !== null) throw isValid.error;

          const scoped = await this._scope(req, res, null);
          if (!scoped) return;

          res.json({
            code: 200,
            history: await this.usecase.getHistory({
              year: Number(req.query.year),
              month: Number(req.query.month),
              employee_id: Number(req.query.employee_id),
              store_ids: scoped.store_ids,
            }),
          });
        } catch (err) {
          this._fail(res, err);
        }
      }
    );
  }

  /** See `routes/employee_bulk_update.js#_guardStream` - the same hazard. */
  _guardStream(res) {
    res.on("error", (err) => {
      console.log(
        `PAYRUN.ADJUSTMENTS.EXPORT.STREAM_ABORTED ${err && err.code ? err.code : "unknown"}`
      );
    });
  }

  async exportXlsx(req, res) {
    this._guardStream(res);
    try {
      const isValid = Joi.validate(
        req.body,
        Joi.object()
          .keys({
            ...this._month(),
            store_ids: Joi.any().optional(),
          })
          .unknown(false)
      );
      if (isValid.error !== null) throw isValid.error;

      const scoped = await this._scope(req, res, req.body.store_ids);
      if (!scoped) return;

      const sheet = await this.usecase.buildExport({
        year: Number(req.body.year),
        month: Number(req.body.month),
        store_ids: scoped.store_ids,
      });

      const filename = `payrun-adjustments-${sheet.period_year}-${String(sheet.period_month).padStart(2, "0")}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      // A point-in-time answer about people's pay; it must not sit in a cache.
      res.setHeader("Cache-Control", "no-store");

      await this.writeWorkbook(res, sheet);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      this._fail(res, err);
    }
  }

  /**
   * THE TEMPLATE WORKBOOK.
   *
   * THE AMOUNT COLUMNS ARE REAL NUMBER CELLS formatted `#,##0.00`, so Excel
   * totals and sorts them as money and a pasted-in value is a number rather
   * than text that happens to look like one.
   *
   * THE IDENTITY COLUMNS ARE LEFT EDITABLE AND THE SERVER IGNORES THEM. A
   * locked column in a spreadsheet is a hint, not a guarantee - the file can
   * be edited anywhere - so the guarantee is where it belongs: the importer
   * keys on Employee ID, never writes a name or a location, and warns when the
   * name in the file does not match.
   *
   * BALANCE ADVANCE CARRIES ITS OWN NOTE IN THE HEADER COMMENT, because it is
   * the one column whose value does nothing to the pay, and a person filling
   * six amount columns has no way to know that from the heading alone.
   */
  async writeWorkbook(stream, sheet) {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Adjustments", {
      views: [{ state: "frozen", ySplit: 1, xSplit: 1 }],
    });

    ws.columns = sheet.columns.map((c) => ({
      header: c.label,
      key: c.key,
      width: c.key === "employee_name" ? 28 : c.key === "remarks" ? 32 : c.kind === "amount" ? 18 : 16,
    }));

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true };
    sheet.columns.forEach((column, index) => {
      if (!column.help) return;
      headerRow.getCell(index + 1).note = column.help;
    });

    sheet.rows.forEach((row) => {
      const added = ws.addRow(row);
      sheet.columns.forEach((column) => {
        if (column.kind !== "amount") return;
        const cell = added.getCell(column.key);
        cell.numFmt = "#,##0.00";
      });
    });

    await workbook.xlsx.write(stream);
    stream.end();
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (adjustmentUsecase, permissions, sensitive, branchScope) =>
  new PayrunAdjustmentRoutes(adjustmentUsecase, permissions, sensitive, branchScope);
module.exports.PayrunAdjustmentRoutes = PayrunAdjustmentRoutes;
