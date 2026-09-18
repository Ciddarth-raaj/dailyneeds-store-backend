const logger = require("../utils/logger");
const { PERIOD_STATUS } = require("../constants/payrun");
const {
  COMPONENTS,
  COMPONENT_KEYS,
  COMPONENT_BY_KEY,
  ADJUSTMENT_STATE,
  ADJUSTMENT_STATE_LABEL,
  CHANGE_SOURCE,
  MAX_IMPORT_ROWS,
  REMARKS_MAX_LENGTH,
} = require("../constants/payrun_adjustments");
const {
  parseAmount,
  amountError,
  computeContract,
  deriveState,
  summarizeStates,
  templateColumns,
  readHeader,
  cellOf,
  parseEmployeeId,
  parseRemarks,
  isEmptyRow,
} = require("../utils/payrun_adjustments");
const { normalizeMonth, validationError } = require("./payrun");

/**
 * Payrun Adjustments V1 - a STAGE of the payrun, not a module beside it.
 *
 * WHAT THE STAGE IS FOR. Initialization froze what each employee's month is
 * built from. This stage records the money that is added to or taken off that
 * month for reasons the salary structure does not know about - an incentive,
 * a bonus, arrears, an advance being recovered, a till shortage - and records,
 * for everybody else, that there is genuinely nothing.
 *
 * THE POPULATION IS THE MONTH'S INITIALIZED EMPLOYEES, READ FRESH, EVERY TIME.
 * Not a list captured when somebody exported a template, not a batch, not a
 * count stored on a row. This is the requirement that shapes the whole design:
 * 220 employees finished and 3 initialized afterwards is 223 initialized and 3
 * pending, from the next request onwards, with nothing re-opened and no job
 * run. It falls out of reading `payrun_employee` at request time and deriving
 * the state per employee; there is deliberately no table that could hold a
 * stale answer.
 *
 * A BLANK CELL IS NOT A CONFIRMATION, AND NEITHER IS A ZERO. Importing a
 * template with two hundred empty rows says nothing about two hundred people.
 * Confirmation is a separate, explicit act with its own endpoint, its own
 * actor and its own timestamp, and there is no path from this file's import
 * code into `confirmNoAdjustment`. That absence is the feature.
 *
 * IT CALCULATES NO PAYSLIP. `utils/payrun_adjustments.js#computeContract` says
 * what this stage CONTRIBUTES - the net pay delta, and zero for every
 * statutory base - and the later calculation stage applies it. Nothing here
 * touches a gross, an earned gross, a PF wage or an ESI wage.
 *
 * IT WRITES ONLY ITS OWN THREE TABLES. It reads `payrun_employee` to learn who
 * is in the month and `payrun_period` to learn whether the month is locked,
 * and has no statement that could change either.
 */

/* --------------------------------------------------------- row-level codes */

/** Stable strings; the screen groups and counts on them. */
const ROW_OUTCOME = {
  WITH_ADJUSTMENT: "WITH_ADJUSTMENT",
  NO_ADJUSTMENT_PENDING: "NO_ADJUSTMENT_PENDING",
  INVALID: "INVALID",
};

const CONFIRM_RESULT = {
  CONFIRMED: "CONFIRMED",
  ALREADY_CONFIRMED: "ALREADY_CONFIRMED",
  HAS_ADJUSTMENT: "HAS_ADJUSTMENT",
  NOT_INITIALIZED: "NOT_INITIALIZED",
};

class PayrunAdjustmentUsecase {
  /**
   * `payrunRepo` is the INITIALIZATION repository, and it is here for exactly
   * one read: the month's lock state. Reaching into it for anything else -
   * initializing somebody, changing a pay type - is not something this stage
   * is entitled to do, and it calls one method.
   */
  constructor(adjustmentRepo, payrunRepo) {
    this.repo = adjustmentRepo;
    this.payrun = payrunRepo;
  }

  _log(level, code, description, ref = {}) {
    logger.Log({
      level,
      component: "USECASE.PAYRUN_ADJUSTMENT",
      code: `USECASE.PAYRUN_ADJUSTMENT.${code}`,
      description,
      category: "",
      ref,
    });
  }

  /* ==================================================================== */
  /*  the catalogue                                                       */
  /* ==================================================================== */

  /**
   * WHAT V1 IS, ANSWERED BY THE SERVER.
   *
   * The screen draws its columns and its labels from this rather than from a
   * list of its own, so "Advance Recovery" is spelled once. It also carries
   * `kind`, `pf` and `esi` per component, so the screen can say what a
   * component does without deciding it.
   */
  describe() {
    return {
      code: 200,
      components: COMPONENTS.map((c) => ({ ...c })),
      columns: templateColumns(),
      states: Object.values(ADJUSTMENT_STATE).map((key) => ({
        key,
        label: ADJUSTMENT_STATE_LABEL[key],
      })),
      max_rows: MAX_IMPORT_ROWS,
      remarks_max_length: REMARKS_MAX_LENGTH,
    };
  }

  /* ==================================================================== */
  /*  the month                                                           */
  /* ==================================================================== */

  /**
   * THE MONTH'S ADJUSTMENT STAGE: who is initialized, what each of them has,
   * and where the stage stands.
   *
   * THREE BATCHED READS FOR THE WHOLE POPULATION - the initialized rows, the
   * stored amounts, the states - plus the month's lock. Never a query per
   * employee; see `repository/payrun.js` on why.
   *
   * THE SUMMARY COUNTS THE WHOLE MONTH, NEVER THE FILTERED VIEW. A state
   * filter is a way of LOOKING at the month, not a different month, and a
   * "pending: 0" that only means "none matching this filter" is the single
   * most dangerous number this screen could show.
   */
  async getMonth({ year, month, store_ids = null, state = null, search = null }) {
    const period = normalizeMonth(year, month);

    const [population, periodRow] = await Promise.all([
      this.repo.listInitialized({ year: period.year, month: period.month, store_ids }),
      this.payrun.getPeriod(period.year, period.month),
    ]);

    const employeeIds = population.map((e) => e.employee_id);
    const [amounts, states] = await Promise.all([
      this.repo.listAmounts({ year: period.year, month: period.month, employee_ids: employeeIds }),
      this.repo.listStates({ year: period.year, month: period.month, employee_ids: employeeIds }),
    ]);

    const amountsOf = new Map();
    amounts.forEach((row) => {
      if (!amountsOf.has(row.employee_id)) amountsOf.set(row.employee_id, {});
      amountsOf.get(row.employee_id)[row.component] = Number(row.amount);
    });
    const stateOf = new Map(states.map((row) => [row.employee_id, row]));

    const rows = population.map((employee) =>
      this._presentRow(employee, amountsOf.get(employee.employee_id) || {}, stateOf.get(employee.employee_id) || null)
    );

    const wantedState =
      state && Object.values(ADJUSTMENT_STATE).includes(String(state).toUpperCase())
        ? String(state).toUpperCase()
        : null;
    const needle = search ? String(search).trim().toLowerCase() : "";

    const filtered = rows.filter((row) => {
      if (wantedState && row.adjustment_state !== wantedState) return false;
      if (needle) {
        const haystack = `${row.employee_id} ${row.employee_name || ""} ${row.location || ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    const monthLocked = Boolean(periodRow && periodRow.status === PERIOD_STATUS.LOCKED);

    return {
      period_year: period.year,
      period_month: period.month,
      period_status: monthLocked ? PERIOD_STATUS.LOCKED : PERIOD_STATUS.OPEN,
      /**
       * THE FINALIZED / LOCKED GATE, WIRED TO THE ONE STATE THAT EXISTS.
       * `payrun_period.status` is declared by the initialization migration and
       * nothing writes it yet, because finalization is not built. This stage
       * ENFORCES it anyway - every write below refuses a LOCKED month - so the
       * day finalization sets that column, adjustments stop being editable
       * without a line changing here.
       */
      month_locked: monthLocked,
      summary: summarizeStates(rows),
      rows: filtered,
    };
  }

  /** One employee's row, as the screen and the export both read it. */
  _presentRow(employee, amounts, state) {
    const contract = computeContract(amounts);
    const confirmed = Boolean(state && Number(state.confirmed_no_adjustment) === 1);
    const adjustmentState = deriveState({ amounts, confirmed_no_adjustment: confirmed });

    return {
      employee_id: employee.employee_id,
      payrun_employee_id: employee.payrun_employee_id,
      employee_name: employee.employee_name,
      location: employee.store_name,
      store_id: employee.store_id,
      designation_name: employee.designation_name,
      amounts: contract.by_component,
      remarks: state ? state.remarks : null,
      adjustment_state: adjustmentState,
      adjustment_state_label: ADJUSTMENT_STATE_LABEL[adjustmentState],
      /*
       * THE CONTRACT TRAVELS WITH THE ROW, so the screen shows the same net
       * effect the calculation stage will apply rather than adding the
       * columns up itself in a browser. `balance_advance` is in `amounts` and
       * in `informational`, and in neither total - which is the whole of what
       * "informational" means.
       */
      additions: contract.additions,
      deductions: contract.deductions,
      informational: contract.informational,
      net_pay_delta: contract.net_pay_delta,
      pf_wage_delta: contract.pf_wage_delta,
      esi_wage_delta: contract.esi_wage_delta,
      confirmed_no_adjustment: confirmed,
      confirmed_by: confirmed ? state.confirmed_by : null,
      confirmed_at: confirmed ? state.confirmed_at : null,
    };
  }

  /* ==================================================================== */
  /*  the export template                                                 */
  /* ==================================================================== */

  /**
   * THE TEMPLATE FOR THE SELECTED MONTH.
   *
   * IT CONTAINS ONLY EMPLOYEES CURRENTLY INITIALIZED FOR THAT MONTH, and it is
   * pre-filled with whatever they already have - so it doubles as an export of
   * the stage's current state, which is what somebody reviewing a month
   * actually wants. Re-importing an untouched export is a no-op, by
   * construction rather than by special-casing.
   *
   * IT IS NOT A SNAPSHOT OF THE POPULATION. Downloading it does not freeze who
   * takes part; the month's completion is recomputed from the CURRENT
   * initialized employees on every request, so somebody initialized after this
   * download is pending whether or not they are in this file.
   */
  async buildExport({ year, month, store_ids = null }) {
    const view = await this.getMonth({ year, month, store_ids });
    return {
      period_year: view.period_year,
      period_month: view.period_month,
      columns: templateColumns(),
      rows: view.rows.map((row) => ({
        employee_id: row.employee_id,
        employee_name: row.employee_name || "",
        location: row.location || "",
        ...COMPONENT_KEYS.reduce((cells, key) => {
          // A ZERO IS WRITTEN AS AN EMPTY CELL, because zero means "no value"
          // on the way in and a template that said 0.00 in six columns would
          // be teaching people to type a number that means nothing.
          cells[key] = row.amounts[key] ? row.amounts[key] : "";
          return cells;
        }, {}),
        remarks: row.remarks || "",
      })),
      summary: view.summary,
      month_locked: view.month_locked,
    };
  }

  /* ==================================================================== */
  /*  the import                                                          */
  /* ==================================================================== */

  /**
   * PREVIEW - VALIDATE A FILE AND WRITE ABSOLUTELY NOTHING.
   *
   * THERE IS NO WRITE PATH OUT OF THIS METHOD. It calls `_validate`, which is
   * pure apart from the reads it is handed, and never reaches the repository's
   * write methods. A test asserts the absence, because "preview does not
   * write" is the kind of guarantee that is true until somebody adds a
   * convenience.
   *
   * WHAT THE PREVIEW COUNTS, AND WHY THOSE FOUR NUMBERS. Somebody about to
   * commit a payroll file needs to know: how many people this file gives money
   * to or takes it from; how many it says nothing about and who therefore
   * still need confirming; how many rows are broken; and - the number that
   * makes the other three mean something - how many employees are initialized
   * for the month at all. Two hundred rows uploaded against two hundred and
   * twenty three initialized employees is a file that is missing twenty three
   * people, and no amount of row-level validation would say so.
   */
  async preview({ year, month, headers, rows, filename }, { store_ids = null } = {}) {
    const validated = await this._validate({ year, month, headers, rows, store_ids });
    return {
      code: 200,
      source_filename: filename || null,
      ...validated.summary,
      /**
       * The gate the screen honours and the server enforces AGAIN at confirm:
       * while any row is invalid, nothing may be saved. A file with no
       * adjustments at all is also refused a save - it has nothing to apply,
       * and saving it must never be mistaken for confirming anybody.
       */
      can_confirm: validated.summary.invalid_rows === 0 && validated.summary.with_adjustments > 0,
      month_locked: validated.month_locked,
      rows: validated.results,
    };
  }

  /**
   * CONFIRM - SAVE THE ADJUSTMENTS IN THE FILE.
   *
   * THE FILE IS VALIDATED AGAIN, FROM SCRATCH, AGAINST THE DATABASE AS IT IS
   * NOW. There is no token, no server-side basket and no trust in what the
   * preview said: an employee may have been un-initialized, the month may have
   * been locked, and the preview the browser is echoing may be twenty minutes
   * old. This is the convention `usecase/employee_bulk_update.js` established
   * and the reason it exists.
   *
   * IF ANY ROW IS INVALID, NOTHING IS SAVED. Not the valid rows, not partially
   * - the whole file is refused with the refreshed preview attached. A payroll
   * file that half-applied is one nobody can reason about afterwards.
   *
   * ONLY ROWS THAT CARRY A VALUE ARE WRITTEN. A row of blanks is reported as
   * NO_ADJUSTMENT_PENDING and reaches no write at all: it is not saved as six
   * zeroes, and it emphatically does not confirm anybody. That is the single
   * most important line in this file.
   */
  async confirm({ year, month, headers, rows, filename }, { store_ids = null, actor = {} } = {}) {
    const validated = await this._validate({ year, month, headers, rows, store_ids });

    if (validated.month_locked) {
      throw validationError(
        `Payroll month ${validated.period.year}-${String(validated.period.month).padStart(2, "0")} is locked; adjustments cannot be saved`
      );
    }

    if (validated.summary.invalid_rows > 0) {
      return {
        code: 409,
        applied: false,
        msg:
          "The file no longer validates cleanly against the current payroll month, so nothing has " +
          "been saved. Review the refreshed preview and import again.",
        source_filename: filename || null,
        ...validated.summary,
        can_confirm: false,
        rows: validated.results,
      };
    }

    const entries = validated.results
      .filter((row) => row.outcome === ROW_OUTCOME.WITH_ADJUSTMENT || row.remarks_given)
      .map((row) => ({
        employee_id: row.employee_id,
        payrun_employee_id: row.payrun_employee_id,
        /*
         * A COMPONENT COLUMN THAT WAS IN THE FILE AND LEFT BLANK IS A CLEAR,
         * not an omission. Somebody who deletes the 2,000 out of the Incentive
         * cell and re-imports means to remove it; treating a blank as "leave
         * it" would make an adjustment impossible to take back through the
         * file it was entered by. A component column NOT IN THE FILE is absent
         * from this map entirely and is left exactly as it is.
         */
        amounts: row.amounts,
        ...(row.remarks_given ? { remarks: row.remarks } : {}),
      }));

    const counts = await this.repo.saveAdjustments({
      year: validated.period.year,
      month: validated.period.month,
      entries,
      actor_id: actor && actor.employeeId !== undefined ? actor.employeeId : null,
      source: CHANGE_SOURCE.IMPORT,
      filename: filename || null,
    });

    this._log(
      logger.LEVEL.INFO,
      "IMPORT_APPLIED",
      `${validated.period.year}-${validated.period.month}: ${counts.employees_written} employees written from ${filename || "an upload"}`
    );

    /*
     * THE SUMMARY IS RE-READ AFTER THE WRITE, from the current initialized
     * population, so the screen's completion counts are the post-save truth
     * rather than the pre-save arithmetic plus a guess.
     */
    const after = await this.getMonth({ year, month, store_ids });

    return {
      code: 200,
      applied: true,
      source_filename: filename || null,
      ...validated.summary,
      ...counts,
      /*
       * SAID PLAINLY, BECAUSE IT IS THE THING PEOPLE GET WRONG. Importing a
       * file never confirms anybody as having no adjustment; the employees
       * whose rows were blank are still pending and still need the explicit
       * confirmation step.
       */
      pending_confirmation_after_save: after.summary.pending_adjustment_confirmation_count,
      summary: after.summary,
      rows: validated.results,
    };
  }

  /**
   * ONE FILE, VALIDATED - the shared engine behind preview and confirm.
   *
   * SHARED ON PURPOSE. Two implementations of "is this file acceptable" is how
   * a preview comes back clean and a confirm writes something different.
   */
  async _validate({ year, month, headers, rows, store_ids }) {
    const period = normalizeMonth(year, month);

    const header = readHeader(headers || []);

    /*
     * AN UNKNOWN COLUMN REFUSES THE WHOLE FILE, and this is the rule the
     * specification states most firmly: an unsupported column must never
     * silently create a payroll component. Ignoring it would mean somebody
     * typing two hundred Loan Recovery figures, reading "200 rows imported",
     * and discovering in a month that none of it existed.
     */
    if (header.unknown.length > 0) {
      throw validationError(
        `This file has columns the Adjustments stage does not recognise: ${header.unknown.join(", ")}. ` +
          `V1 supports exactly ${COMPONENTS.map((c) => c.label).join(", ")}. ` +
          `Export the template for this month and fill that in.`
      );
    }
    if (header.duplicated.length > 0) {
      throw validationError(
        `This file repeats the column(s) ${header.duplicated.join(", ")}. Each column may appear once.`
      );
    }
    if (!header.hasEmployeeId) {
      throw validationError("This file has no 'Employee ID' column, so its rows cannot be matched to anybody.");
    }

    const list = Array.isArray(rows) ? rows : [];
    if (list.length > MAX_IMPORT_ROWS) {
      throw validationError(
        `The uploaded file has ${list.length} rows; the most that can be processed at once is ${MAX_IMPORT_ROWS}.`
      );
    }

    /*
     * THE MONTH'S CURRENT INITIALIZED POPULATION, INSIDE THE CALLER'S BRANCH
     * SCOPE. This one read answers three of the required validations at once:
     * whether the employee exists in this month at all, whether they are
     * initialized, and whether the caller may touch them - and it answers all
     * three with ONE refusal, because telling a caller which of the three it
     * was would confirm the existence of an employee they may not see.
     */
    const [population, periodRow] = await Promise.all([
      this.repo.listInitialized({ year: period.year, month: period.month, store_ids }),
      this.payrun.getPeriod(period.year, period.month),
    ]);
    const initializedOf = new Map(population.map((e) => [Number(e.employee_id), e]));

    const seen = new Map();
    const results = [];

    list.forEach((raw, index) => {
      // +2: the header is row 1 and spreadsheets are 1-based, so this is the
      // number the person sees in Excel's gutter.
      const rowNumber = index + 2;
      if (isEmptyRow(raw, header)) return;

      const result = this._validateRow({ raw, rowNumber, header, initializedOf, seen });
      if (result.employee_id !== null && result.outcome !== ROW_OUTCOME.INVALID) {
        seen.set(result.employee_id, rowNumber);
      }
      results.push(result);
    });

    const withAdjustments = results.filter((r) => r.outcome === ROW_OUTCOME.WITH_ADJUSTMENT);
    const pending = results.filter((r) => r.outcome === ROW_OUTCOME.NO_ADJUSTMENT_PENDING);
    const invalid = results.filter((r) => r.outcome === ROW_OUTCOME.INVALID);

    return {
      period,
      month_locked: Boolean(periodRow && periodRow.status === PERIOD_STATUS.LOCKED),
      results,
      summary: {
        rows_uploaded: results.length,
        with_adjustments: withAdjustments.length,
        no_adjustment_pending_confirmation: pending.length,
        invalid_rows: invalid.length,
        /**
         * THE POPULATION THE FILE IS BEING JUDGED AGAINST - current, not
         * exported. A file of 200 rows against 223 initialized employees is
         * missing 23 people, and this is the only number that says so.
         */
        initialized_count: population.length,
        employees_not_in_file: Math.max(
          population.length - results.filter((r) => r.outcome !== ROW_OUTCOME.INVALID).length,
          0
        ),
        net_pay_delta_total: Number(
          withAdjustments.reduce((total, row) => total + Number(row.net_pay_delta || 0), 0).toFixed(2)
        ),
      },
    };
  }

  /**
   * ONE ROW OF THE FILE.
   *
   * THE ORDER IS THE ORDER SOMEBODY CAN ACT ON. Identity first - an unreadable
   * Employee ID makes every other complaint about the row noise - then whether
   * this employee's month may be touched at all, then the cells.
   *
   * ALL CELL ERRORS ARE COLLECTED, not just the first. Six components and a
   * remarks column, fixed one upload at a time, is six uploads.
   */
  _validateRow({ raw, rowNumber, header, initializedOf, seen }) {
    const errors = [];
    const warnings = [];

    const idCell = cellOf(raw, "Employee ID");
    const employeeId = parseEmployeeId(idCell);

    if (employeeId === null) {
      return this._invalidRow(rowNumber, null, [
        idCell === undefined || String(idCell === null ? "" : idCell).trim() === ""
          ? "Employee ID is required."
          : `Employee ID '${String(idCell).trim()}' is not a whole number.`,
      ]);
    }

    if (seen.has(employeeId)) {
      return this._invalidRow(rowNumber, employeeId, [
        `Employee ${employeeId} already appears on row ${seen.get(employeeId)}. ` +
          `One row per employee - the amounts are columns, not rows.`,
      ]);
    }

    const employee = initializedOf.get(employeeId);
    if (!employee) {
      /*
       * ONE REFUSAL FOR THREE DIFFERENT FACTS - the employee does not exist,
       * they exist but are not initialized for this month, or they are outside
       * the caller's branch scope. Distinguishing them in the message would
       * confirm the existence of employees the caller may not see; the
       * remedies are the same in all three cases.
       */
      return this._invalidRow(rowNumber, employeeId, [
        `Employee ${employeeId} is not initialized for this payroll month, or is outside your branch scope. ` +
          `Initialize the employee first, then export a fresh template.`,
      ]);
    }

    /*
     * THE NAME AND LOCATION CELLS ARE REFERENCE ONLY AND ARE NEVER WRITTEN.
     * A mismatch is a WARNING and not a refusal, because the overwhelmingly
     * common cause is a renamed or transferred employee since the export - but
     * it is shown prominently, because the second most common cause is rows
     * pasted out of line, which puts one person's incentive on another
     * person's row.
     */
    const nameCell = cellOf(raw, "Employee Name");
    if (nameCell !== undefined && String(nameCell).trim() !== "") {
      const given = String(nameCell).trim().toLowerCase();
      const actual = String(employee.employee_name || "").trim().toLowerCase();
      if (actual && given !== actual) {
        warnings.push(
          `The name in the file ('${String(nameCell).trim()}') is not this employee's current name ` +
            `('${employee.employee_name}'). The name in the file is never saved - check the rows are not out of line.`
        );
      }
    }

    const amounts = {};
    let hasValue = false;

    header.componentColumns.forEach((column) => {
      const cell = cellOf(raw, column.header);
      const parsed = parseAmount(cell);

      if (parsed.status === "EMPTY") {
        /*
         * BLANK OR ZERO. `null` means CLEAR: the column was in the file, so
         * the person is saying this component has no value. It is NOT a
         * confirmation of anything about the employee.
         */
        amounts[column.key] = null;
        return;
      }
      if (parsed.status !== "OK") {
        errors.push(amountError(column.label, parsed.status, cell));
        return;
      }

      amounts[column.key] = parsed.amount;
      hasValue = true;
    });

    const remarksGiven = header.hasRemarks;
    let remarks = null;
    if (remarksGiven) {
      const parsed = parseRemarks(cellOf(raw, "Remarks"));
      if (parsed.status !== "OK") {
        errors.push(`Remarks are longer than ${REMARKS_MAX_LENGTH} characters.`);
      } else {
        remarks = parsed.value;
      }
    }

    if (errors.length > 0) return this._invalidRow(rowNumber, employeeId, errors, employee);

    const contract = computeContract(
      Object.keys(amounts).reduce((map, key) => {
        map[key] = amounts[key] === null ? 0 : amounts[key];
        return map;
      }, {})
    );

    return {
      row_number: rowNumber,
      employee_id: employeeId,
      payrun_employee_id: employee.payrun_employee_id,
      employee_name: employee.employee_name,
      location: employee.store_name,
      amounts,
      remarks,
      remarks_given: remarksGiven,
      valid: true,
      errors: [],
      warnings,
      additions: contract.additions,
      deductions: contract.deductions,
      informational: contract.informational,
      net_pay_delta: contract.net_pay_delta,
      /*
       * A ROW WITH NO VALUES IS "PENDING", NEVER "CONFIRMED". It is a valid
       * row that says nothing, and the employee it names still needs the
       * explicit confirmation step.
       */
      outcome: hasValue ? ROW_OUTCOME.WITH_ADJUSTMENT : ROW_OUTCOME.NO_ADJUSTMENT_PENDING,
    };
  }

  /** An invalid row. It carries no amounts, so nothing about it can be saved. */
  _invalidRow(rowNumber, employeeId, errors, employee = null) {
    return {
      row_number: rowNumber,
      employee_id: employeeId,
      payrun_employee_id: employee ? employee.payrun_employee_id : null,
      employee_name: employee ? employee.employee_name : null,
      location: employee ? employee.store_name : null,
      amounts: {},
      remarks: null,
      remarks_given: false,
      valid: false,
      errors,
      warnings: [],
      additions: 0,
      deductions: 0,
      informational: 0,
      net_pay_delta: 0,
      outcome: ROW_OUTCOME.INVALID,
    };
  }

  /* ==================================================================== */
  /*  manual editing                                                      */
  /* ==================================================================== */

  /**
   * ADD, EDIT OR CLEAR ONE EMPLOYEE'S ADJUSTMENTS BY HAND.
   *
   * THE SAME VALIDATION AS THE IMPORT, LITERALLY. `parseAmount` is the one
   * place an amount is read, so a negative Advance Recovery typed into the
   * screen is refused in the same words as one in a spreadsheet, and a zero
   * means "no value" in both. A second, gentler validator for the manual path
   * is how a rule ends up with an exception nobody documented.
   *
   * CLEARING IS `null`, AND IT IS WHAT MAKES AN ADJUSTMENT REVERSIBLE before
   * the month is locked. Sending `{ INCENTIVE: null }` removes the row; a
   * component the caller does not name is untouched.
   *
   * A LOCKED MONTH REFUSES, and so does an employee who is not initialized for
   * it or is outside the caller's branch scope - checked here, on the server,
   * from the server's own read, because an employee id in a body is a claim.
   */
  async saveEmployee({ year, month, employee_id, amounts = {}, remarks, store_ids = null, actor = {} }) {
    const period = normalizeMonth(year, month);
    const employeeId = parseEmployeeId(employee_id);
    if (employeeId === null) throw validationError("employee_id must be a positive integer");

    const periodRow = await this.payrun.getPeriod(period.year, period.month);
    if (periodRow && periodRow.status === PERIOD_STATUS.LOCKED) {
      throw validationError(
        `Payroll month ${period.year}-${String(period.month).padStart(2, "0")} is locked; adjustments cannot be changed`
      );
    }

    const population = await this.repo.listInitialized({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids: [employeeId],
    });
    const employee = population[0];
    if (!employee) {
      const err = new Error(
        "This employee is not initialized for the selected payroll month, or is outside your branch scope"
      );
      err.name = "NotFoundError";
      throw err;
    }

    const parsedAmounts = {};
    const errors = [];
    Object.keys(amounts || {}).forEach((key) => {
      const component = COMPONENT_BY_KEY[String(key).toUpperCase()];
      if (!component) {
        // THE SAME RULE THE IMPORT APPLIES: an unknown component never
        // silently becomes a payroll line. Here it is a refusal outright,
        // since a screen that sent one is a screen that is out of date.
        errors.push(`'${key}' is not a component this payroll stage supports.`);
        return;
      }
      const parsed = parseAmount(amounts[key]);
      if (parsed.status === "EMPTY") {
        parsedAmounts[component.key] = null;
        return;
      }
      if (parsed.status !== "OK") {
        errors.push(amountError(component.label, parsed.status, amounts[key]));
        return;
      }
      parsedAmounts[component.key] = parsed.amount;
    });

    let remarksEntry = {};
    if (remarks !== undefined) {
      const parsed = parseRemarks(remarks);
      if (parsed.status !== "OK") errors.push(`Remarks are longer than ${REMARKS_MAX_LENGTH} characters.`);
      else remarksEntry = { remarks: parsed.value };
    }

    if (errors.length > 0) throw validationError(errors.join(" "));

    const counts = await this.repo.saveAdjustments({
      year: period.year,
      month: period.month,
      entries: [
        {
          employee_id: employeeId,
          payrun_employee_id: employee.payrun_employee_id,
          amounts: parsedAmounts,
          ...remarksEntry,
        },
      ],
      actor_id: actor && actor.employeeId !== undefined ? actor.employeeId : null,
      source: CHANGE_SOURCE.MANUAL,
    });

    const view = await this.getMonth({
      year: period.year,
      month: period.month,
      store_ids,
    });
    const row = view.rows.find((r) => r.employee_id === employeeId) || null;

    return {
      period_year: period.year,
      period_month: period.month,
      employee_id: employeeId,
      ...counts,
      row,
      summary: view.summary,
    };
  }

  /* ==================================================================== */
  /*  the explicit no-adjustment confirmation                             */
  /* ==================================================================== */

  /**
   * "THESE PEOPLE GENUINELY HAVE NOTHING THIS MONTH."
   *
   * THE ONLY WAY AN EMPLOYEE BECOMES `NO_ADJUSTMENT_CONFIRMED`, and it is
   * reached from nowhere else in this file. There is no call to it from
   * `confirm` (the import), none from `saveEmployee`, and none from any read.
   * A blank row, an empty file and an untouched employee all leave somebody
   * pending, which is the point of the stage.
   *
   * INDIVIDUAL AND BULK ARE THE SAME CALL. One employee is a list of one, so
   * the two cannot apply different rules.
   *
   * AN EMPLOYEE WITH AN ADJUSTMENT IS REFUSED, per row, from the database as
   * it is inside the transaction - not from what the screen was showing. They
   * come back as HAS_ADJUSTMENT and the rest of the batch still goes through.
   *
   * NOBODY OUTSIDE THE MONTH OR THE CALLER'S SCOPE IS CONFIRMED. Ids are
   * matched against the month's initialized population first; the rest are
   * reported as NOT_INITIALIZED and never reach a write.
   */
  async confirmNoAdjustment({ year, month, employee_ids, store_ids = null, actor = {} }) {
    const period = normalizeMonth(year, month);

    const ids = [];
    (Array.isArray(employee_ids) ? employee_ids : [employee_ids]).forEach((raw) => {
      const id = parseEmployeeId(raw);
      if (id === null) throw validationError("employee_ids must be positive integers");
      if (!ids.includes(id)) ids.push(id);
    });
    if (ids.length === 0) throw validationError("employee_ids must not be empty");

    const periodRow = await this.payrun.getPeriod(period.year, period.month);
    if (periodRow && periodRow.status === PERIOD_STATUS.LOCKED) {
      throw validationError(
        `Payroll month ${period.year}-${String(period.month).padStart(2, "0")} is locked; adjustments cannot be confirmed`
      );
    }

    const population = await this.repo.listInitialized({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids: ids,
    });
    const initializedOf = new Map(population.map((e) => [Number(e.employee_id), e]));

    const eligible = ids
      .filter((id) => initializedOf.has(id))
      .map((id) => ({ employee_id: id, payrun_employee_id: initializedOf.get(id).payrun_employee_id }));

    const written = await this.repo.confirmNoAdjustment({
      year: period.year,
      month: period.month,
      employees: eligible,
      actor_id: actor && actor.employeeId !== undefined ? actor.employeeId : null,
    });
    const writtenOf = new Map(written.map((r) => [r.employee_id, r.result]));

    const results = ids.map((id) => ({
      employee_id: id,
      result: writtenOf.get(id) || CONFIRM_RESULT.NOT_INITIALIZED,
      message:
        writtenOf.get(id) === CONFIRM_RESULT.HAS_ADJUSTMENT
          ? "This employee has an adjustment for this month, so they cannot be confirmed as having none."
          : writtenOf.get(id)
          ? undefined
          : "This employee is not initialized for the selected payroll month, or is outside your branch scope.",
    }));

    const view = await this.getMonth({ year: period.year, month: period.month, store_ids });
    const counted = (code) => results.filter((r) => r.result === code).length;

    return {
      period_year: period.year,
      period_month: period.month,
      confirmed_count: counted(CONFIRM_RESULT.CONFIRMED),
      already_confirmed_count: counted(CONFIRM_RESULT.ALREADY_CONFIRMED),
      has_adjustment_count: counted(CONFIRM_RESULT.HAS_ADJUSTMENT),
      not_initialized_count: counted(CONFIRM_RESULT.NOT_INITIALIZED),
      results,
      summary: view.summary,
    };
  }

  /* ==================================================================== */
  /*  the history                                                         */
  /* ==================================================================== */

  /** One employee's adjustment history for the month - who, what, when, whence. */
  async getHistory({ year, month, employee_id, store_ids = null }) {
    const period = normalizeMonth(year, month);
    const employeeId = parseEmployeeId(employee_id);
    if (employeeId === null) throw validationError("employee_id must be a positive integer");

    /*
     * THE BRANCH SCOPE IS APPLIED TO THE HISTORY TOO. A change log is a read
     * of somebody's pay, and a scope that guarded the amounts but not the log
     * of the amounts would be no scope at all.
     */
    const population = await this.repo.listInitialized({
      year: period.year,
      month: period.month,
      store_ids,
      employee_ids: [employeeId],
    });
    if (population.length === 0) {
      const err = new Error(
        "This employee is not initialized for the selected payroll month, or is outside your branch scope"
      );
      err.name = "NotFoundError";
      throw err;
    }

    return this.repo.listAudit({ year: period.year, month: period.month, employee_id: employeeId });
  }
}

module.exports = (adjustmentRepo, payrunRepo) =>
  new PayrunAdjustmentUsecase(adjustmentRepo, payrunRepo);
module.exports.PayrunAdjustmentUsecase = PayrunAdjustmentUsecase;
module.exports.ROW_OUTCOME = ROW_OUTCOME;
module.exports.CONFIRM_RESULT = CONFIRM_RESULT;
