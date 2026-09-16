const express = require("express");
const Joi = require("@hapi/joi");
const ExcelJS = require("exceljs");

const P = require("../constants/hr_permissions");
const { MAX_ROWS } = require("../usecase/employee_bulk_update");
const {
  EMPLOYEE_BRANCH_SCOPE,
  isEmployeeInScope,
} = require("../utils/employee_branch_scope");

const router = express.Router();

/**
 * EMPLOYEE MASTER BULK EXPORT / IMPORT — the HTTP surface, mounted at /hr.
 *
 *   GET  /hr/employees/bulk/fields    what may be exported, and the dropdowns
 *   POST /hr/employees/bulk/export    the .xlsx, streamed
 *   POST /hr/employees/bulk/preview   validate a file; writes NOTHING
 *   POST /hr/employees/bulk/confirm   apply it, after revalidating everything
 *
 * ================================ NO NEW PERMISSION, AND THAT IS ON PURPOSE ==
 *
 * The existing employee rights answer every question this feature asks, so it
 * uses them rather than adding a key:
 *
 *   export           `view_employees` - the same key as the HR directory. An
 *                    export is a read of employees the caller may already
 *                    read, in a different file format.
 *   preview/confirm  `view_employees` AND `employee_edit`, with `requireAll`
 *                    (AND; `require(a, b)` is OR and would weaken this to
 *                    either-of). `employee_edit` is the key
 *                    `POST /hr/employee/:id/edit` and
 *                    `POST /hr/employee/:id/joining-date` already carry, which
 *                    is exactly the authority a bulk edit of those same fields
 *                    needs - including the joining date, whose normal path
 *                    requires no more than this.
 *
 * A SEPARATE `employee_bulk_update` KEY WAS CONSIDERED AND REJECTED. It would
 * have to be granted to everyone who already edits employees to avoid removing
 * capability, at which point it says nothing; and if it were NOT granted to
 * them it would be a second, quieter answer to "who may change an employee's
 * branch", which is the kind of thing that ends up granted by accident. The
 * scale of a bulk operation is a UI and preview concern, not an authorization
 * one - and there is deliberately no bypass key either: a caller who cannot
 * edit one employee cannot edit eighty here.
 *
 * ============================================= BRANCH SCOPE IS NOT OPTIONAL ==
 *
 * The export population is scoped IN SQL through the same `accessScope` unit
 * the directory and Reports compose, from an actor resolved by
 * `employeeBranchScope.actorFor` - which fails closed. The import resolves the
 * caller's scope ONCE per request and applies it per row, both to the employee
 * being changed and to any branch they would be moved to, which is the same
 * pair of checks `routes/employee_master.js` makes on a single edit.
 *
 * ========================================== B3 APPLIES HERE TOO =============
 *
 * `filterResponse` and `guardWrite` are mounted on this router exactly as they
 * are on /employee and the master router. Nothing this feature touches is a
 * sensitive column - it handles six employment fields and no salary, bank,
 * PAN, Aadhaar, UAN, PF or ESI - so the guards change nothing in normal use.
 * They are here so that a column added to this feature later cannot quietly
 * escape them.
 */
class EmployeeBulkUpdateRoutes {
  constructor(bulkUsecase, permissions, sensitive, branchScope) {
    if (!branchScope) {
      throw new Error("routes/employee_bulk_update: the employee branch scope is required");
    }
    this.usecase = bulkUsecase;
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.branchScope = branchScope;
    this.setupRoutes();
  }

  _fail(res, err) {
    if (err && err.httpCode) {
      // The envelope-code convention every other HR route uses: a 200 carrying
      // `{ code, msg }`, which the frontend's API layer already reads.
      res.json({ code: err.httpCode, msg: err.message });
      return;
    }
    if (err && err.name === "ValidationError") {
      res.json({ code: 422, msg: err.toString() });
      return;
    }
    console.log(err);
    res.json({ code: 500, msg: "An error occurred !" });
  }

  /**
   * The caller's branch scope as two pure things the usecase can apply per
   * row, resolved ONCE rather than a database read per row of the file.
   *
   * `inScope` is the shared `isEmployeeInScope` predicate, not a local
   * re-reading of the rule. A scope of NONE yields a predicate that is false
   * for every branch - failing closed - and the route refuses before reaching
   * it anyway.
   */
  async _scope(req, res) {
    const scope = await this.branchScope.resolve(req);
    if (scope.kind === EMPLOYEE_BRANCH_SCOPE.NONE) {
      this.branchScope.refuse(res, scope);
      return null;
    }
    const allBranches = scope.kind === EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES;
    return {
      allBranches,
      inScope: (storeId) => (allBranches ? true : isEmployeeInScope(scope, storeId)),
    };
  }

  setupRoutes() {
    router.use(this.sensitive.filterResponse);
    router.use(this.sensitive.guardWrite);

    /** The field catalogue and the current dropdown values. A read. */
    router.get(
      "/employees/bulk/fields",
      this.permissions.require(P.VIEW_EMPLOYEES),
      async (req, res) => {
        try {
          res.json(await this.usecase.describe());
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * THE EXPORT. Streamed as .xlsx.
     *
     * Every refusal - the permission, the branch scope, an unknown field - is
     * decided BEFORE a byte is written, because once headers are out the only
     * honest answer to a failure is to destroy the connection: a truncated
     * spreadsheet that opens cleanly is worse than a broken download, since
     * somebody will read it and believe it.
     */
    router.post(
      "/employees/bulk/export",
      this.permissions.require(P.VIEW_EMPLOYEES),
      (req, res) => this.exportXlsx(req, res)
    );

    /**
     * PREVIEW. Uploading a file must never change an employee, so this route
     * has no write path at all - the usecase it calls cannot reach one.
     */
    router.post(
      "/employees/bulk/preview",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, this.uploadSchema());
          if (isValid.error !== null) throw isValid.error;

          const scope = await this._scope(req, res);
          if (!scope) return;

          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.preview(req.body, scope, actor));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );

    /**
     * CONFIRM. It takes the rows AGAIN and checks them AGAIN - there is no
     * validation token and no server-side basket - and additionally checks
     * the `expected_before` the preview showed against the database as it is
     * now, so a row somebody else has touched in between is refused rather
     * than overwritten.
     */
    router.post(
      "/employees/bulk/confirm",
      this.permissions.requireAll(P.VIEW_EMPLOYEES, P.EMPLOYEE_EDIT),
      async (req, res) => {
        try {
          const isValid = Joi.validate(req.body, this.confirmSchema());
          if (isValid.error !== null) throw isValid.error;

          const scope = await this._scope(req, res);
          if (!scope) return;

          const actor = await this.permissions.actorFor(req);
          res.json(await this.usecase.confirm(req.body, scope, actor));
        } catch (err) {
          this._fail(res, err);
        }
        res.end();
      }
    );
  }

  /**
   * WHAT AN UPLOAD IS ALLOWED TO SAY: the header labels, the cells, and the
   * file's name for the audit. No field key, no column name, no employee
   * column and no id of anything the server would otherwise look up.
   *
   * `Joi.object().unknown(false)` on the envelope, and the ROWS are free-form
   * objects on purpose - they are spreadsheet cells, and which keys they carry
   * is exactly what `_readHeader` refuses or accepts. A key this feature does
   * not own never becomes part of a patch: the usecase reads cells by the
   * closed field catalogue, and `editEmployee` refuses anything outside
   * `EDITABLE_FIELDS` regardless.
   */
  uploadSchema() {
    return Joi.object()
      .keys({
        filename: Joi.string().trim().max(255).allow("").allow(null).optional(),
        headers: Joi.array().items(Joi.string().allow("")).min(1).max(64).required(),
        rows: Joi.array().items(Joi.object()).max(MAX_ROWS + 1).required(),
      })
      .unknown(false);
  }

  confirmSchema() {
    return Joi.object()
      .keys({
        filename: Joi.string().trim().max(255).allow("").allow(null).optional(),
        headers: Joi.array().items(Joi.string().allow("")).min(1).max(64).required(),
        rows: Joi.array().items(Joi.object()).max(MAX_ROWS + 1).required(),
        /**
         * What the PREVIEW showed, echoed back per row. Required: a confirm
         * that supplies none is refused row by row as a conflict, so the
         * staleness check cannot be opted out of by omission.
         */
        expected_before: Joi.array()
          .items(
            Joi.object().keys({
              row_number: Joi.number().integer().min(1).required(),
              expected_before: Joi.object().required(),
            })
          )
          .max(MAX_ROWS + 1)
          .required(),
      })
      .unknown(false);
  }

  /** See `routes/employee_report.js#_guardStream` - the same hazard, verbatim. */
  _guardStream(res) {
    res.on("error", (err) => {
      console.log(
        `EMPLOYEE.BULK.EXPORT.STREAM_ABORTED ${err && err.code ? err.code : "unknown"}`
      );
    });
  }

  async exportXlsx(req, res) {
    this._guardStream(res);
    try {
      const schema = Joi.object()
        .keys({
          fields: Joi.array().items(Joi.string()).min(0).max(16).required(),
          filters: Joi.object()
            .keys({
              status: Joi.number().valid(0, 1).allow(null).optional(),
              store_ids: Joi.array().items(Joi.number().integer()).optional(),
              department_ids: Joi.array().items(Joi.number().integer()).optional(),
              designation_ids: Joi.array().items(Joi.number().integer()).optional(),
            })
            .unknown(false)
            .optional(),
        })
        .unknown(false);
      const isValid = Joi.validate(req.body, schema);
      if (isValid.error !== null) throw isValid.error;

      const filters = req.body.filters || {};

      /*
       * AUTHORIZATION AND THE CALLER'S OWN FILTER ARE BOTH APPLIED, and they
       * are different things - the same pairing `GET /employee/employees`
       * makes. `listFilters` REFUSES a request that names a branch outside the
       * caller's scope rather than quietly narrowing it, so an export cannot
       * come back under a heading it does not match.
       */
      const scoped = await this.branchScope.listFilters(req, filters.store_ids);
      if (!scoped.ok) {
        this.branchScope.refuse(res, scoped);
        return;
      }

      // The actor carries the resolved scope into the WHERE clause, so the
      // population is restricted in SQL and not trimmed after the fact.
      const actor = await this.branchScope.actorFor(req);
      const sheet = await this.usecase.buildExport(
        req.body.fields,
        { ...filters, store_ids: scoped.store_ids === null ? undefined : scoped.store_ids },
        actor
      );

      const filename = `employee-bulk-${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      // A point-in-time answer about people; it must not sit in a cache.
      res.setHeader("Cache-Control", "no-store");

      await this.writeWorkbook(res, sheet);
      await this.usecase.recordExport(
        {
          filename,
          selected_fields: sheet.selected_fields,
          filters: {
            status: filters.status === undefined ? null : filters.status,
            store_ids: scoped.store_ids,
            department_ids: filters.department_ids || null,
            designation_ids: filters.designation_ids || null,
          },
          row_count: sheet.rows.length,
        },
        actor
      );
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      this._fail(res, err);
    }
  }

  /**
   * The workbook.
   *
   * DROPDOWNS WHERE THE VALUES ARE A LIST, so the person editing the file is
   * offered the right spellings instead of guessing at them. The list is
   * written into a hidden `Lists` sheet and referenced by range, which is what
   * keeps it working for long lists - Excel refuses an inline `formulae` list
   * over 255 characters, and the branch and designation lists exceed that.
   *
   * THE SPREADSHEET IS NOT THE SECURITY BOUNDARY, and the validation here is
   * not pretending to be one. It is a convenience for the person typing. Every
   * value is resolved and re-checked on the server at upload, and a file with
   * the validation stripped out is refused there exactly the same way.
   *
   * DATE OF JOINING IS A REAL DATE CELL formatted `dd/mm/yyyy`, so Excel sorts
   * and filters it as a date and the documented format is what is displayed.
   */
  async writeWorkbook(stream, sheet) {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Employees", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    const lists = workbook.addWorksheet("Lists");
    lists.state = "veryHidden";

    ws.columns = sheet.columns.map((c) => ({
      header: c.label,
      key: c.key,
      width: c.key === "employee_name" ? 28 : c.kind === "identity" ? 14 : 22,
    }));
    ws.getRow(1).font = { bold: true };

    for (const row of sheet.rows) {
      const values = {};
      for (const column of sheet.columns) {
        const value = row[column.key];
        if (column.kind === "date") {
          // Written as a DATE, not as text, so a genuine Excel date is what
          // comes back when the cell is untouched.
          const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || ""));
          values[column.key] = m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`) : "";
        } else {
          values[column.key] = value === null || value === undefined ? "" : value;
        }
      }
      const added = ws.addRow(values);
      for (const column of sheet.columns) {
        if (column.kind === "date") {
          added.getCell(column.key).numFmt = "dd/mm/yyyy";
        }
      }
    }

    // The identity columns are protected as a hint, not a guarantee: the
    // server ignores a changed name and refuses an unknown id whatever the
    // sheet allows.
    const lastRow = Math.max(sheet.rows.length + 1, 2);
    let listColumn = 0;
    for (const [i, column] of sheet.columns.entries()) {
      const options = sheet.validation[column.key];
      if (!options || options.length === 0) continue;

      listColumn += 1;
      const letter = ws.getColumn(i + 1).letter;
      const listLetter = lists.getColumn(listColumn).letter;
      lists.getColumn(listColumn).values = [column.label, ...options];

      for (let r = 2; r <= lastRow; r += 1) {
        ws.getCell(`${letter}${r}`).dataValidation = {
          type: "list",
          allowBlank: true, // BLANK IS LEGAL: it means "leave unchanged".
          formulae: [`Lists!$${listLetter}$2:$${listLetter}$${options.length + 1}`],
          showErrorMessage: true,
          errorTitle: column.label,
          error: `Choose a ${column.label} from the list, or leave the cell blank to keep the current value.`,
        };
      }
    }

    await workbook.xlsx.write(stream);
    stream.end();
  }

  getRouter() {
    return router;
  }
}

module.exports = (bulkUsecase, permissions, sensitive, branchScope) =>
  new EmployeeBulkUpdateRoutes(bulkUsecase, permissions, sensitive, branchScope);
module.exports.EmployeeBulkUpdateRoutes = EmployeeBulkUpdateRoutes;
