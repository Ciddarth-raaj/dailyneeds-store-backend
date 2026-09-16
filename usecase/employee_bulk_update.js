const logger = require("../utils/logger");
const {
  IDENTITY_FIELDS,
  UPDATE_FIELDS,
  DATE_DISPLAY_FORMAT,
  fieldForLabel,
  resolveSelectedFields,
  buildMasterIndex,
  parseDateCell,
  displayDate,
  toIsoDate,
  isBlankCell,
} = require("../utils/employee_bulk_fields");

/**
 * EMPLOYEE MASTER BULK EXPORT / IMPORT.
 *
 * Export the employment fields for a scoped set of employees, let HR edit the
 * spreadsheet, upload it, show exactly what would change, and only then apply
 * it.
 *
 * ================== THIS MODULE HOLDS NO EMPLOYEE BUSINESS RULE OF ITS OWN ==
 *
 * It does not write an employee column. It does not decide whether a store
 * change revokes a session, what a joining date does to an employment period,
 * or which employees a caller may reach. Every one of those already exists and
 * is CALLED, per row:
 *
 *   `employeeMasterUsecase.editEmployee`      Location, Department,
 *                                             Designation, Employment Type,
 *                                             Grade. Same transaction, same
 *                                             `EDITABLE_FIELDS` allowlist,
 *                                             same `SECURITY_RELEVANT_FIELDS`
 *                                             session revocation on a store or
 *                                             designation change.
 *   `employeeMasterUsecase.correctJoiningDate` Date of Joining. NEVER a column
 *                                             write: it moves the current
 *                                             employment period with the date
 *                                             and records C1c's
 *                                             `period_corrected` event.
 *                                             `editEmployee` refuses the field
 *                                             by name, which is what makes
 *                                             that unbypassable.
 *   `branchScope` (per row)                   which employees may be touched,
 *                                             and which branch they may be
 *                                             moved to.
 *
 * What this module adds is the BATCH: read a file, resolve human-readable
 * cells against the masters safely, say what would change before anything is
 * written, and then apply the rows that survive a second, full revalidation.
 * A second implementation of any rule above would be a second answer, and the
 * two would disagree the first time one of them moved.
 *
 * ===================================== PREVIEW AND CONFIRM ARE TWO REQUESTS ==
 *
 * And the second trusts nothing from the first. There is no token, no staging
 * table and no server-side basket: confirm is handed the same rows and runs
 * the WHOLE validation again - permissions, branch scope, the masters, the
 * dates - against the database as it is at that moment.
 *
 * ON TOP OF THAT IT DETECTS STALE DATA. Preview returns, per row, the CURRENT
 * value of every field it proposes to change. Confirm sends those back as
 * `expected_before`, and a row whose current value no longer matches is
 * REFUSED as a conflict rather than overwritten - because between a preview
 * drawn at 10:00 and a click at 10:20, somebody may have moved that employee
 * to another branch by hand, and a bulk file must not silently undo them.
 * A confirm that omits `expected_before` is not trusted either: the row is
 * refused, so a hand-rolled client cannot opt out of the check.
 *
 * ======================================= BLANK MEANS LEAVE ALONE, ALWAYS ====
 *
 * An empty update cell is "no instruction", never "clear this field". There
 * is no way to clear a field through this import in this version. That is a
 * deliberate omission and not an oversight: a blank cell is what a file
 * arrives with when somebody deleted a column, filtered a sheet or pasted a
 * short range, and reading those as an instruction to erase six hundred
 * employees' grades is the single most expensive mistake this feature could
 * make. Clearing a field remains the single-employee edit screen's job.
 *
 * =========================================== ROW-LEVEL, NOT ALL-OR-NOTHING ==
 *
 * Each applied row is its own transaction, because `editEmployee` and
 * `correctJoiningDate` each own one and wrapping them in an outer transaction
 * would mean reimplementing both. The approved instruction is explicit that
 * business correctness comes before one transaction, so this reports the
 * outcome of every row instead of pretending to atomicity it does not have.
 * The cost is bounded by the preview: NOTHING is applied until the whole file
 * validates clean, so a partial application is the result of a genuine
 * mid-flight conflict, not of a typo on row 400.
 */

/**
 * The most rows one upload may carry.
 *
 * A guard, not a page size: the company has hundreds of employees, and a file
 * larger than this is a mistake - a whole export pasted twice - which is
 * better refused whole than half-applied twenty minutes later. Matches the
 * bulk salary upload's cap so the two behave alike.
 */
const MAX_ROWS = 1000;

const OUTCOME = Object.freeze({
  APPLIED: "APPLIED",
  NO_CHANGE: "NO_CHANGE",
  ERROR: "ERROR",
  CONFLICT: "CONFLICT",
  FAILED: "FAILED",
});

function validationError(message, extra = {}) {
  const err = new Error(message);
  err.name = "ValidationError";
  err.httpCode = 422;
  Object.assign(err, extra);
  return err;
}

const asText = (value) => (value === null || value === undefined ? "" : String(value));

class EmployeeBulkUpdateUsecase {
  /**
   * `employeeMasterUsecase` is C2 - the ONLY thing in this feature that writes
   * an employee.
   *
   * The caller's BRANCH SCOPE is deliberately not held here. It belongs to a
   * request, not to a server-lifetime object, so it is resolved once by the
   * route and passed in per call as two pure functions. A scope cached on this
   * instance would be one request's authorization answering another's.
   */
  constructor(bulkRepo, employeeMasterUsecase) {
    this.repo = bulkRepo;
    this.master = employeeMasterUsecase;
  }

  _log(level, code, description, ref = {}) {
    logger.Log({
      level,
      component: "USECASE.EMPLOYEE_BULK_UPDATE",
      code: `USECASE.EMPLOYEE_BULK_UPDATE.${code}`,
      description,
      category: "",
      ref,
    });
  }

  /* ==================================================================== */
  /*  the catalogue the screen is built from                              */
  /* ==================================================================== */

  /**
   * Which fields may be exported/imported, and - for the four that are
   * chosen from a list - what the list currently holds.
   *
   * The dropdown values the spreadsheet offers come from HERE, so the sheet
   * and the server cannot drift. The sheet is still not the security
   * boundary: every one of these is resolved and re-checked on upload.
   */
  async describe() {
    const masters = await this.repo.getMasters();
    const index = {
      outlet: buildMasterIndex(masters.outlet),
      department: buildMasterIndex(masters.department),
      designation: buildMasterIndex(masters.designation),
    };
    return {
      code: 200,
      identity_fields: IDENTITY_FIELDS.map((f) => ({ key: f.key, label: f.label, role: f.role })),
      update_fields: UPDATE_FIELDS.map((f) => ({
        key: f.key,
        label: f.label,
        kind: f.kind,
        lifecycle: f.lifecycle === true,
        options: f.kind === "master" ? index[f.master].activeLabels() : f.choices || null,
        format: f.kind === "date" ? DATE_DISPLAY_FORMAT : null,
      })),
      max_rows: MAX_ROWS,
      date_format: DATE_DISPLAY_FORMAT,
    };
  }

  /* ==================================================================== */
  /*  export                                                              */
  /* ==================================================================== */

  /**
   * The sheet: a header row, one row per employee in scope, and the dropdown
   * lists the writer attaches as data validation.
   *
   * VALUES ARE HUMAN-READABLE. `Muthialpet`, not `4`; `15/06/2024`, not a
   * serial. The only number in the sheet is the Employee ID, which is the
   * identity and is meant to be one.
   */
  async buildExport(selectedKeys, filters, actor) {
    const selection = resolveSelectedFields(selectedKeys);
    if (!selection.ok) {
      throw validationError(`not an exportable field: ${selection.unknown.join(", ")}`);
    }

    const masters = await this.repo.getMasters();
    const index = {
      outlet: buildMasterIndex(masters.outlet),
      department: buildMasterIndex(masters.department),
      designation: buildMasterIndex(masters.designation),
    };

    const employees = await this.repo.getEmployeesForExport(actor, filters);

    const columns = [
      ...IDENTITY_FIELDS.map((f) => ({ key: f.key, label: f.label, kind: "identity" })),
      ...selection.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, field: f })),
    ];

    const rows = employees.map((employee) => {
      const row = {
        employee_id: Number(employee.employee_id),
        employee_name: asText(employee.employee_name),
      };
      for (const field of selection.fields) {
        row[field.key] = this._exportValue(field, employee, index);
      }
      return row;
    });

    return {
      columns,
      rows,
      /** The data-validation lists, by column key. ACTIVE master rows only. */
      validation: Object.fromEntries(
        selection.fields
          .filter((f) => f.kind === "master" || f.kind === "choice")
          .map((f) => [
            f.key,
            f.kind === "master" ? index[f.master].activeLabels() : [...f.choices],
          ])
      ),
      selected_fields: selection.fields.map((f) => f.key),
      date_format: DATE_DISPLAY_FORMAT,
    };
  }

  /** One exported cell, as text a person reads and this module can read back. */
  _exportValue(field, employee, index) {
    if (field.kind === "master") {
      return index[field.master].labelForId(employee[field.column]);
    }
    if (field.kind === "date") {
      const iso = toIsoDate(employee[field.column]);
      return iso ? displayDate(iso) : "";
    }
    return asText(employee[field.column]);
  }

  /* ==================================================================== */
  /*  reading an uploaded file                                            */
  /* ==================================================================== */

  /**
   * THE SHAPE CHECK, and it runs before a single row is looked at.
   *
   * A file whose structure this cannot understand is refused WHOLE rather than
   * interpreted generously. That covers: no header at all, no `Employee ID`
   * column, and - importantly - a column headed something this feature does
   * not own. A sheet carrying a `salary` or a `status` column is not silently
   * ignored: it is refused by name, because a column somebody filled in and
   * the system dropped is how people come to believe a change was saved.
   *
   * IT IS ALSO THE BACKSTOP AGAINST A CRAFTED SPREADSHEET. Even if this check
   * were bypassed, the patch built below is assembled from the closed field
   * catalogue by key and handed to `editEmployee`, which refuses anything
   * outside `EDITABLE_FIELDS`. This is the first of two answers, not the only
   * one.
   */
  _readHeader(headers) {
    const raw = Array.isArray(headers) ? headers.map((h) => asText(h).trim()) : [];
    const present = raw.filter((h) => h !== "");
    if (present.length === 0) {
      throw validationError(
        "The uploaded file has no header row. Export a template from Employee Master, edit it and upload that file."
      );
    }

    const mapped = [];
    const unknown = [];
    const seen = new Set();
    const duplicated = [];
    for (const label of present) {
      const field = fieldForLabel(label);
      if (!field) {
        unknown.push(label);
        continue;
      }
      if (seen.has(field.key)) duplicated.push(label);
      seen.add(field.key);
      mapped.push({ label, field });
    }

    if (unknown.length > 0) {
      throw validationError(
        `The uploaded file has ${unknown.length === 1 ? "a column" : "columns"} this bulk update ` +
          `does not handle: ${unknown.join(", ")}. Only the Employee Master bulk template's columns ` +
          `are accepted, so that nothing you typed is silently discarded.`
      );
    }
    if (duplicated.length > 0) {
      throw validationError(
        `The uploaded file repeats ${duplicated.join(", ")}. Each column may appear once.`
      );
    }
    if (!seen.has("employee_id")) {
      throw validationError("The uploaded file has no 'Employee ID' column, so no employee can be identified.");
    }

    const updateFields = mapped.map((m) => m.field).filter((f) => f.column);
    if (updateFields.length === 0) {
      throw validationError(
        "The uploaded file has no updatable column. Include at least one of: " +
          UPDATE_FIELDS.map((f) => f.label).join(", ") + "."
      );
    }

    return {
      /** ONLY the fields the FILE carries may be considered for update. */
      updateFields,
      hasName: seen.has("employee_name"),
    };
  }

  /**
   * The rows as they arrived, keyed by the column labels, turned into entries
   * keyed by field. `row_number` is 1-based over DATA rows, so it matches what
   * somebody counting in a spreadsheet sees once the header is discounted.
   */
  _normalize(rows, header) {
    return (rows || []).map((row, i) => {
      const source = row && typeof row === "object" ? row : {};
      const cells = {};
      // Read by LABEL, tolerantly of case and spacing, exactly as the header
      // check matched them - a parser that trims one and not the other would
      // report every cell blank, which reads as "no changes" and is the
      // quietest possible failure.
      for (const [key, value] of Object.entries(source)) {
        const field = fieldForLabel(key);
        if (field) cells[field.key] = value;
      }
      return {
        row_number: i + 1,
        raw: {
          employee_id: asText(cells.employee_id),
          employee_name: asText(cells.employee_name),
          ...Object.fromEntries(header.updateFields.map((f) => [f.key, asText(cells[f.key])])),
        },
        cells,
      };
    });
  }

  /** A whole positive employee id, or null. */
  _employeeId(value) {
    if (isBlankCell(value)) return null;
    const text = String(value).trim();
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }

  /** Every employee id appearing on more than one row. ALL their rows fail. */
  _duplicateIds(entries) {
    const count = new Map();
    for (const entry of entries) {
      const id = this._employeeId(entry.cells.employee_id);
      if (id !== null) count.set(id, (count.get(id) || 0) + 1);
    }
    return new Set([...count].filter(([, n]) => n > 1).map(([id]) => id));
  }

  /* ==================================================================== */
  /*  validating one row                                                  */
  /* ==================================================================== */

  /**
   * ONE CELL -> the value that would be written, or a refusal.
   *
   * Returns `{ skip: true }` for a blank cell, which is this feature's whole
   * treatment of blank: no instruction, no change, no error.
   */
  _resolveCell(field, value, context) {
    if (isBlankCell(value)) return { skip: true };

    if (field.kind === "master") {
      const index = context.index[field.master];
      const outcome = index.resolve(value);
      if (outcome.status === "UNKNOWN") {
        return { error: `${field.label} '${asText(value).trim()}' is not in the ${field.label} master` };
      }
      if (outcome.status === "AMBIGUOUS") {
        // Names are not unique in these masters, so this is a real case and
        // not a theoretical one. Picking the first would move an employee to a
        // branch nobody chose; the fix is to name the id, and the message says
        // which ids are available.
        return {
          error:
            `${field.label} '${asText(value).trim()}' matches more than one record ` +
            `(${outcome.rows.map((r) => index.labelForId(r.id)).join(", ")}). ` +
            `Use the 'Name [ID]' form to say which one.`,
        };
      }
      if (outcome.status === "NAME_MISMATCH") {
        /*
         * THE ID IS NOT TRUSTED ALONE. The cell points at a real master row,
         * but the name beside it is not that row's name - the master has been
         * renamed since the export, or somebody edited the label and left the
         * id behind. Either way the file and the database disagree about what
         * this id MEANS, and assigning it would be honouring a pointer whose
         * label the author was reading instead.
         */
        return {
          error:
            `${field.label} '${asText(value).trim()}' does not match the current master: ` +
            `${index.labelForId(outcome.row.id)}. Re-export and try again.`,
        };
      }
      if (!outcome.row.active) {
        return { error: `${field.label} '${outcome.row.name}' is inactive and cannot be assigned` };
      }
      return { value: outcome.row.id, display: index.labelForId(outcome.row.id) };
    }

    if (field.kind === "choice") {
      // Matched case-insensitively HERE so a spreadsheet's autocapitalisation
      // is not a refusal, then handed on in the master's EXACT spelling -
      // `utils/employment_classification.js` refuses a near miss, and that
      // strictness is right at the column and wrong at the keyboard.
      const text = asText(value).trim();
      const match = field.choices.find((c) => c.toLowerCase() === text.toLowerCase());
      if (!match) {
        return { error: `${field.label} must be one of ${field.choices.join(", ")}; received '${text}'` };
      }
      return { value: match, display: match };
    }

    if (field.kind === "date") {
      const parsed = parseDateCell(value);
      if (parsed.status !== "OK") {
        return {
          error:
            `${field.label} '${asText(value).trim()}' is not a date this can read. ` +
            `Use a real Excel date or ${DATE_DISPLAY_FORMAT}.`,
        };
      }
      if (parsed.date > context.today) {
        // The same refusal `usecase/employee_master.js#rejectFutureDate`
        // makes, made here so it lands on the preview with a row number
        // rather than as the hundredth row's failure at confirm time.
        return {
          error: `${field.label} '${displayDate(parsed.date)}' is in the future`,
        };
      }
      return { value: parsed.date, display: displayDate(parsed.date) };
    }

    /* istanbul ignore next - the catalogue is closed; no other kind exists. */
    return { error: `${field.label} cannot be set by bulk update` };
  }

  /** The current value of a field, as the comparable/displayable pair. */
  _currentValue(field, employee, index) {
    if (field.kind === "master") {
      const id = employee[field.column] === null || employee[field.column] === undefined
        ? null
        : Number(employee[field.column]);
      return { value: Number.isInteger(id) ? id : null, display: index[field.master].labelForId(id) };
    }
    if (field.kind === "date") {
      const iso = toIsoDate(employee[field.column]);
      return { value: iso, display: iso ? displayDate(iso) : "" };
    }
    const raw = employee[field.column];
    return { value: raw === null || raw === undefined || raw === "" ? null : String(raw), display: asText(raw) };
  }

  /**
   * ONE ROW, against the database as it is right now.
   *
   * Order matters and is the order somebody can act on: the identity first
   * (an unreadable id makes every other complaint about that row noise), then
   * whether they may touch this employee at all, then the cells.
   */
  async _validateRow(entry, context) {
    const errors = [];
    const warnings = [];

    const employeeId = this._employeeId(entry.cells.employee_id);
    if (employeeId === null) {
      return this._present(entry, {
        errors: [
          isBlankCell(entry.cells.employee_id)
            ? "Employee ID is required"
            : "Employee ID must be a whole number",
        ],
      });
    }

    if (context.duplicates.has(employeeId)) {
      // ALL of the duplicate's rows are refused, not all but the first:
      // two rows for one person is a file whose author meant something this
      // cannot represent, and honouring one of them would be this module
      // choosing which of two branches they meant.
      return this._present(entry, {
        employee_id: employeeId,
        errors: [`Employee ID ${employeeId} appears on more than one row`],
      });
    }

    const employee = context.employees.get(employeeId);
    /*
     * OUT OF SCOPE AND NON-EXISTENT GET THE SAME ANSWER FOR A BRANCH-SCOPED
     * CALLER, exactly as `branchScope.checkEmployee` does on every other
     * employee route. Distinguishing them would let a branch manager
     * enumerate another branch's employee ids by watching which sentence came
     * back - through a spreadsheet, which is a particularly comfortable place
     * to do it a thousand ids at a time.
     */
    if (!employee || !context.inScope(employee.store_id)) {
      return this._present(entry, {
        employee_id: employeeId,
        errors: [
          context.allBranches && !employee
            ? `Employee ${employeeId} was not found`
            : `Employee ${employeeId} is not an employee you are authorized for`,
        ],
      });
    }

    // NAME IS A WARNING, NEVER AN IDENTITY AND NEVER AN UPDATE. It is shown
    // because a mismatch usually means the file's rows were sorted or pasted
    // out of line, and that is worth seeing before eighty employees move.
    if (context.hasName && !isBlankCell(entry.cells.employee_name)) {
      const supplied = asText(entry.cells.employee_name).trim();
      const actual = asText(employee.employee_name).trim();
      if (supplied.toLowerCase() !== actual.toLowerCase()) {
        warnings.push(
          `The file says '${supplied}' but employee ${employeeId} is '${actual}'. ` +
            `The name in the file is ignored and will NOT be changed; check the row is the one you meant.`
        );
      }
    }

    const changes = [];
    for (const field of context.header.updateFields) {
      const resolved = this._resolveCell(field, entry.cells[field.key], context);
      if (resolved.skip) continue; // blank = leave the current value alone
      if (resolved.error) {
        errors.push(resolved.error);
        continue;
      }

      const current = this._currentValue(field, employee, context.index);
      // UNCHANGED IS NOT A CHANGE. A file re-uploaded untouched produces an
      // empty change set and performs no write at all - not an idempotent
      // write, no write - so it cannot revoke a session or move an employment
      // period as a side effect of somebody re-checking their work.
      if (String(current.value ?? "") === String(resolved.value ?? "")) continue;

      if (field.key === "store_id") {
        // BRANCH-TRANSFER PROTECTION, the same rule the edit route applies:
        // a branch-scoped caller may not move an employee to a branch they
        // are not authorized for, in or out.
        if (!context.inScope(resolved.value)) {
          errors.push(`You are not authorized to move an employee to ${resolved.display}`);
          continue;
        }
      }

      changes.push({
        field: field.key,
        label: field.label,
        from: current.value,
        to: resolved.value,
        from_display: current.display,
        to_display: resolved.display,
      });
    }

    return this._present(entry, {
      employee_id: employeeId,
      employee_name: asText(employee.employee_name),
      errors,
      warnings,
      changes,
    });
  }

  /** A validated row in the shape the preview and the result both use. */
  _present(entry, outcome) {
    const errors = outcome.errors || [];
    const warnings = outcome.warnings || [];
    const changes = outcome.changes || [];
    return {
      row_number: entry.row_number,
      // The ORIGINAL cells, echoed exactly, so a file somebody fixes still
      // says what they typed rather than what this module made of it.
      raw: entry.raw,
      employee_id: outcome.employee_id === undefined ? null : outcome.employee_id,
      employee_name: outcome.employee_name || null,
      valid: errors.length === 0,
      errors,
      warnings,
      changes,
      has_changes: errors.length === 0 && changes.length > 0,
      /**
       * WHAT THE SERVER BELIEVES IS TRUE RIGHT NOW for every field this row
       * would change. The browser sends it back at confirm time and the
       * server checks it against the database again - see `confirm`.
       */
      expected_before: Object.fromEntries(changes.map((c) => [c.field, c.from])),
    };
  }

  /**
   * Everything a row's validation needs, read ONCE for the whole file: the
   * masters, the caller's branch scope, and the current state of exactly the
   * employees named in it.
   */
  async _context(entries, header, scope) {
    const masters = await this.repo.getMasters();
    const index = {
      outlet: buildMasterIndex(masters.outlet),
      department: buildMasterIndex(masters.department),
      designation: buildMasterIndex(masters.designation),
    };

    const ids = entries.map((e) => this._employeeId(e.cells.employee_id)).filter((n) => n !== null);
    const rows = await this.repo.getCurrentValues(ids);
    const employees = new Map(rows.map((r) => [Number(r.employee_id), r]));

    return {
      index,
      employees,
      header,
      duplicates: this._duplicateIds(entries),
      hasName: header.hasName,
      inScope: scope.inScope,
      allBranches: scope.allBranches,
      today: new Date().toISOString().slice(0, 10),
    };
  }

  /* ==================================================================== */
  /*  preview                                                             */
  /* ==================================================================== */

  /**
   * Validate the WHOLE file and report on every row. NOTHING IS WRITTEN.
   *
   * EVERY row is validated, including ones after a failure: a batch that
   * stopped at the first bad row would make fixing a file an exercise in
   * uploading it once per mistake.
   */
  async preview({ headers, rows, filename }, scope, actor) {
    const header = this._readHeader(headers);
    const entries = this._guardSize(rows, header);

    const context = await this._context(entries, header, scope);
    const results = [];
    for (const entry of entries) {
      /* eslint-disable-next-line no-await-in-loop */
      results.push(await this._validateRow(entry, context));
    }

    const summary = this._summarise(results, header);
    await this._audit("PREVIEW", { filename, header, summary, results, actor, outcome: "PREVIEWED" });

    return {
      code: 200,
      source_filename: filename || null,
      fields_in_file: header.updateFields.map((f) => ({ key: f.key, label: f.label })),
      ...summary,
      /**
       * The gate the UI honours and the server enforces again at confirm:
       * while ANY row has a blocking error, nothing may be applied. Warnings
       * (a name mismatch) never block - they are for a human to read.
       */
      can_confirm: summary.error_rows === 0 && summary.rows_with_changes > 0,
      rows: results,
    };
  }

  _guardSize(rows, header) {
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
      throw validationError("The uploaded file has no data rows.");
    }
    if (list.length > MAX_ROWS) {
      throw validationError(
        `The uploaded file has ${list.length} rows; the most that can be processed at once is ${MAX_ROWS}.`
      );
    }
    return this._normalize(list, header);
  }

  _summarise(results, header) {
    return {
      rows_uploaded: results.length,
      valid_rows: results.filter((r) => r.valid).length,
      error_rows: results.filter((r) => !r.valid).length,
      warning_rows: results.filter((r) => r.warnings.length > 0).length,
      rows_with_changes: results.filter((r) => r.has_changes).length,
      rows_without_changes: results.filter((r) => r.valid && !r.has_changes).length,
      selected_fields: header.updateFields.map((f) => f.key),
    };
  }

  /* ==================================================================== */
  /*  confirm                                                             */
  /* ==================================================================== */

  /**
   * Apply the file. The FULL validation runs again first, against the
   * database as it is now, and then each changed row is written through C2.
   *
   * THE WHOLE FILE MUST STILL BE CLEAN. If revalidation now finds a blocking
   * error - a branch deactivated since the preview, an employee moved out of
   * the caller's scope - NOTHING is applied and the refreshed preview comes
   * back for a human to look at again. That is the difference between this
   * and a per-row best effort: the user approved a specific set of changes,
   * and a file that no longer means what it meant has not been approved.
   */
  async confirm({ headers, rows, filename, expected_before: expectedByRow }, scope, actor) {
    const header = this._readHeader(headers);
    const entries = this._guardSize(rows, header);

    const context = await this._context(entries, header, scope);
    const results = [];
    for (const entry of entries) {
      /* eslint-disable-next-line no-await-in-loop */
      results.push(await this._validateRow(entry, context));
    }

    const summary = this._summarise(results, header);
    if (summary.error_rows > 0) {
      await this._audit("CONFIRM", {
        filename, header, summary, results, actor, outcome: "REFUSED_REVALIDATION",
      });
      return {
        code: 409,
        applied: false,
        msg:
          "The file no longer validates cleanly against the current employee data, so nothing has " +
          "been changed. Review the refreshed preview and upload again.",
        source_filename: filename || null,
        ...summary,
        can_confirm: false,
        rows: results,
      };
    }

    const expected = this._expectedIndex(expectedByRow);
    const applied = [];
    for (const row of results) {
      /* eslint-disable-next-line no-await-in-loop */
      applied.push(await this._applyRow(row, expected, actor));
    }

    const counts = {
      rows_applied: applied.filter((r) => r.outcome === OUTCOME.APPLIED).length,
      rows_unchanged: applied.filter((r) => r.outcome === OUTCOME.NO_CHANGE).length,
      rows_conflicted: applied.filter((r) => r.outcome === OUTCOME.CONFLICT).length,
      rows_failed: applied.filter((r) => r.outcome === OUTCOME.FAILED).length,
    };

    await this._audit("CONFIRM", {
      filename,
      header,
      summary,
      results: applied,
      actor,
      counts,
      outcome:
        counts.rows_conflicted + counts.rows_failed === 0
          ? "APPLIED"
          : counts.rows_applied > 0
          ? "APPLIED_PARTIAL"
          : "FAILED",
    });

    return {
      code: 200,
      applied: true,
      source_filename: filename || null,
      ...summary,
      ...counts,
      rows: applied,
    };
  }

  /**
   * The `expected_before` the browser sent back, by row number.
   *
   * A row the client did not send one for is NOT treated as "no expectation":
   * `_applyRow` refuses it. Otherwise a client could skip the staleness check
   * simply by omitting the field, which would make the check advisory - and an
   * advisory safety check protects nobody.
   */
  _expectedIndex(expectedByRow) {
    const map = new Map();
    for (const item of Array.isArray(expectedByRow) ? expectedByRow : []) {
      if (!item || typeof item !== "object") continue;
      const n = Number(item.row_number);
      if (Number.isInteger(n)) map.set(n, item.expected_before || {});
    }
    return map;
  }

  /**
   * ONE ROW, WRITTEN THROUGH C2.
   *
   * The ordinary fields go in ONE `editEmployee` call, so Location,
   * Department, Designation, Employment Type and Grade for one employee are
   * one transaction and one session revocation rather than five. Date of
   * Joining is its OWN call to `correctJoiningDate`, because it is not an
   * ordinary field: it moves the employment period with it.
   */
  async _applyRow(row, expected, actor) {
    if (!row.has_changes) {
      return { ...row, outcome: OUTCOME.NO_CHANGE, applied_fields: [], failure_reason: null };
    }

    const stale = this._staleFields(row, expected);
    if (stale.length > 0) {
      /*
       * STALE DATA. The value this row proposes to change is no longer the
       * value the person approving it was shown, so somebody else has touched
       * this employee in between. The row is REFUSED and named - never
       * applied over the other change, and never silently skipped.
       */
      return {
        ...row,
        outcome: OUTCOME.CONFLICT,
        applied_fields: [],
        failure_reason:
          `Employee ${row.employee_id} was changed by someone else after the preview ` +
          `(${stale.join("; ")}). Nothing was changed for this row; re-export and try again.`,
      };
    }

    const patch = {};
    let joiningDate = null;
    for (const change of row.changes) {
      if (change.field === "date_of_joining") joiningDate = change.to;
      else patch[change.field] = change.to;
    }

    const appliedFields = [];
    try {
      if (Object.keys(patch).length > 0) {
        const result = await this.master.editEmployee(row.employee_id, patch, {
          actorEmployeeId: actor ? actor.employeeId : null,
        });
        appliedFields.push(...Object.keys(patch));
        row = { ...row, sessions_revoked: result.sessions_revoked === true };
      }
      if (joiningDate !== null) {
        await this.master.correctJoiningDate(
          row.employee_id,
          { date_of_joining: joiningDate },
          { actorEmployeeId: actor ? actor.employeeId : null }
        );
        appliedFields.push("date_of_joining");
      }
    } catch (err) {
      /*
       * A ROW THAT FAILS ON THE WAY IN IS REPORTED, NOT THROWN. It is one
       * employee: abandoning the other ninety-nine because C2 refused this one
       * would be a worse answer than saying which one it refused and why. What
       * HAS been written for this row is named too, because with two calls a
       * row can be half applied and pretending otherwise would be a lie.
       */
      this._log(
        logger.LEVEL.ERROR,
        "ROW-FAILED",
        `employee ${row.employee_id}: ${err && err.message}`,
        { employeeId: row.employee_id }
      );
      return {
        ...row,
        outcome: OUTCOME.FAILED,
        applied_fields: appliedFields,
        failure_reason: (err && err.message) || "The employee could not be updated",
      };
    }

    return { ...row, outcome: OUTCOME.APPLIED, applied_fields: appliedFields, failure_reason: null };
  }

  /**
   * Which of this row's fields no longer hold the value the preview showed.
   *
   * The comparison is against `row.changes[].from`, which revalidation has
   * JUST re-read from the database, versus the `expected_before` the browser
   * is echoing back from the preview it displayed. A missing expectation is a
   * mismatch, not a pass.
   */
  _staleFields(row, expected) {
    const sent = expected.get(row.row_number);
    if (!sent) {
      return [
        "the preview this confirmation refers to was not supplied, so the values you saw cannot be checked",
      ];
    }
    const stale = [];
    for (const change of row.changes) {
      const was = Object.prototype.hasOwnProperty.call(sent, change.field) ? sent[change.field] : undefined;
      if (was === undefined) {
        stale.push(`${change.label} was not part of the preview`);
        continue;
      }
      if (String(was ?? "") !== String(change.from ?? "")) {
        stale.push(`${change.label} is now '${change.from_display}'`);
      }
    }
    return stale;
  }

  /* ==================================================================== */
  /*  audit                                                               */
  /* ==================================================================== */

  /**
   * The bulk-operation row. NEVER the thing that makes a change auditable -
   * `editEmployee` and `correctJoiningDate` already write the per-employee
   * history and the lifecycle event, exactly as a hand edit does. This adds
   * the batch: who, when, which file, which fields, and what came of it.
   *
   * A FAILURE TO AUDIT NEVER FAILS THE OPERATION IT RECORDS - for a confirm
   * the employees have already been changed, and throwing here would report a
   * write that happened as one that did not. It is logged loudly instead.
   */
  async _audit(operation, { filename, header, summary, results, actor, counts = {}, outcome }) {
    try {
      await this.repo.recordBulkUpdate({
        operation,
        user_id: actor ? actor.userId : null,
        employee_id: actor ? actor.employeeId : null,
        source_filename: filename || null,
        selected_fields: header.updateFields.map((f) => f.key),
        filters: {},
        rows_uploaded: summary.rows_uploaded,
        rows_valid: summary.valid_rows,
        rows_error: summary.error_rows,
        rows_warning: summary.warning_rows,
        rows_changed: summary.rows_with_changes,
        rows_applied: counts.rows_applied || 0,
        rows_failed: (counts.rows_conflicted || 0) + (counts.rows_failed || 0),
        outcome,
        // Per row: who, which fields, and what happened. The VALUES are the
        // field keys and the resolved ids - which are the change - and no
        // other employee column is recorded.
        detail: results
          .filter((r) => r.has_changes || !r.valid)
          .map((r) => ({
            row_number: r.row_number,
            employee_id: r.employee_id,
            fields: r.changes.map((c) => c.field),
            changes: r.changes.map((c) => ({ field: c.field, from: c.from, to: c.to })),
            outcome: r.outcome || (r.valid ? null : OUTCOME.ERROR),
            errors: r.valid ? undefined : r.errors,
          })),
      });
    } catch (err) {
      this._log(
        logger.LEVEL.ERROR,
        "AUDIT-FAILED",
        `the ${operation} audit row could not be written: ${err && err.message}`,
        {}
      );
    }
  }

  /**
   * The audit row for an EXPORT. Shape only - how many employees, which
   * fields, which filters - and never a value, exactly as
   * `report_export_log` records the Reports export.
   */
  async recordExport({ filename, selected_fields, filters, row_count }, actor) {
    try {
      await this.repo.recordBulkUpdate({
        operation: "EXPORT",
        user_id: actor ? actor.userId : null,
        employee_id: actor ? actor.employeeId : null,
        source_filename: filename || null,
        selected_fields: selected_fields || [],
        filters: filters || {},
        rows_uploaded: Number(row_count) || 0,
        rows_valid: Number(row_count) || 0,
        rows_error: 0,
        rows_warning: 0,
        rows_changed: 0,
        rows_applied: 0,
        rows_failed: 0,
        outcome: "EXPORTED",
        detail: [],
      });
    } catch (err) {
      this._log(logger.LEVEL.ERROR, "AUDIT-FAILED", `the EXPORT audit row could not be written: ${err && err.message}`, {});
    }
  }
}

module.exports = (bulkRepo, employeeMasterUsecase) =>
  new EmployeeBulkUpdateUsecase(bulkRepo, employeeMasterUsecase);
module.exports.EmployeeBulkUpdateUsecase = EmployeeBulkUpdateUsecase;
module.exports.MAX_ROWS = MAX_ROWS;
module.exports.OUTCOME = OUTCOME;
