const engine = require("../utils/salary_engine");
const periodLock = require("../services/salary_period_lock");
const { STATUS } = require("../repository/employee_salary");
const { SOURCE } = require("./employee_salary");

/**
 * M5 — Bulk Salary Upload.
 *
 * ONE SCREEN FOR BOTH THINGS, AND THE SYSTEM DECIDES WHICH EACH ROW IS. A file
 * of employee ids and grosses may contain opening salaries for people who have
 * never had one and revisions for people who have. The uploader does not
 * choose: the classification is read off the employee's own salary lifecycle,
 * by exactly the rule `usecase/employee_salary.js` uses on the single-employee
 * path - `hasLiveSalary`, which does not count rejected rows - so the same
 * employee is classified the same way whichever door the proposal came in by.
 *
 * THIS MODULE HOLDS NO SALARY RULES OF ITS OWN, AND THAT IS THE DESIGN.
 * It does not calculate a breakup, a contribution or a CTC; it does not decide
 * an opening date; it does not write a row. Every one of those is
 * `usecase/employee_salary.js` and `utils/salary_engine.js`, called per row.
 * A second implementation of any of them would be a second answer, and the two
 * would disagree the first time a statutory rate moved. What this module adds
 * is the batch: read a file's worth of rows, tell somebody which ones will be
 * refused and why BEFORE anything is written, and then write the rest.
 *
 * THREE COLUMNS COME IN, AND ONLY THREE. Employee ID, Monthly Gross Salary and
 * Effective From. No name (looked up), no component (calculated), no status
 * (always Pending), no source (always IMPORT), no reason (automatic). Anything
 * else on the row is not "ignored" - the shape check refuses it, because a
 * column somebody filled in and the system silently dropped is worse than a
 * column that was never offered.
 *
 * EFFECTIVE FROM IS STILL REQUIRED FOR AN OPENING SALARY, AND IS STILL NOT THE
 * UPLOADER'S TO CHOOSE. The opening rule - the later of the opening floor and
 * the date of joining - is the server's, so the file's date is CHECKED against
 * it rather than used. A row whose date disagrees is refused by name
 * (`Opening salary Effective From must be YYYY-MM-DD`). It is deliberately not
 * corrected silently: a file that says one date and a record that says another
 * is how somebody discovers, on a payslip, that a hundred rows meant something
 * they did not read.
 *
 * NOTHING IS EVER AUTO-APPROVED. Every row this creates lands PENDING and is
 * decided on Salary Approval, exactly like a proposal typed by hand - including
 * one uploaded by an administrator. Bulk is a faster way to PROPOSE, never a
 * way round the approval.
 *
 * VALIDATE AND SUBMIT ARE TWO REQUESTS AND THE SECOND TRUSTS NOTHING FROM THE
 * FIRST. There is no token, no staging table and no server-side basket: submit
 * re-runs the whole validation against the database as it is at that moment,
 * because a proposal can be raised for one of these employees in the minutes
 * between a preview and a click. A row that has since become invalid comes back
 * as a per-row failure rather than being written on the strength of a check
 * that has expired.
 */

/**
 * The revision reason every bulk-created REVISION carries.
 *
 * WHY IT IS AUTOMATIC. `usecase/employee_salary.js` requires a revision reason
 * whenever a proposal CHANGES pay somebody is already on, and the approved M5
 * template has exactly three columns and no reason among them. The two are
 * reconciled here, in the one place a bulk row is created, by stating the only
 * thing that is actually true of all of them: this one came from a bulk upload.
 *
 * IT IS NOT `override_reason` AND IT IS NOT `rejection_reason`. Those answer
 * different questions asked of different people - why the breakup departs from
 * the automatic one, and why an approver refused - and overloading either to
 * carry this would make both unreadable.
 *
 * The origin is ALSO on the row as `source = IMPORT`, so the history says both
 * what happened and where it came from.
 */
const BULK_REVISION_REASON = "Bulk salary upload";

/**
 * The most rows one upload may carry.
 *
 * A guard rather than a page size: each row is several indexed reads and an
 * engine calculation, and the company has hundreds of employees rather than
 * hundreds of thousands. A file larger than this is a mistake - a whole
 * export pasted in, or the same sheet twice - and refusing it whole is a better
 * answer than half an hour of work followed by a timeout.
 */
const MAX_ROWS = 1000;

/** What a row IS, as opposed to what gets stamped on it (`source = IMPORT`). */
const ROW_TYPE = {
  OPENING_SALARY: "OPENING_SALARY",
  REVISION: "REVISION",
};

/** The three columns, in the approved order. Exported so the API can say so. */
const TEMPLATE_COLUMNS = ["Employee ID", "Monthly Gross Salary", "Effective From"];

/** Shaped so `utils/http.js#respondError` answers 400 with the detail. */
function validationError(message, extra = {}) {
  const err = new Error(message);
  err.name = "ValidationError";
  Object.assign(err, extra);
  return err;
}

/** Today, as a date-only string. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Blank, in every way a cell can be blank. */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

/** The cell exactly as it arrived, for echoing back beside its error. */
function asText(value) {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * A whole positive employee id, or null.
 *
 * Deliberately strict about the SHAPE rather than clever about it: `"42 "` is a
 * spreadsheet's whitespace and is accepted, `"42.5"` and `"E42"` are not an
 * employee id at all and are refused by name rather than coerced to 42.
 */
function toEmployeeId(value) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * A monthly gross as a number, or null when the cell is not one.
 *
 * Commas are stripped because every spreadsheet in the building writes
 * `1,25,000`; a currency symbol is not, because a column of mixed units is a
 * file somebody should look at again rather than one this should guess at.
 */
function toAmount(value) {
  if (isBlank(value)) return null;
  const text = String(value).replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** `YYYY-MM-DD` and nothing else, and it must be a real calendar date. */
function toDateOnly(value) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return engine.toDateOnly(text);
}

class SalaryBulkUploadUsecase {
  /**
   * @param salaryRepo     `repository/employee_salary.js` — the same repository
   *                       the single-employee lifecycle uses
   * @param salaryUsecase  `usecase/employee_salary.js` — the lifecycle itself.
   *                       Every calculation and every write goes through it.
   * @param options.now    the clock, for tests. Not a caller input.
   */
  constructor(salaryRepo, salaryUsecase, options = {}) {
    this.salaryRepo = salaryRepo;
    this.salaryUsecase = salaryUsecase;
    this._now = typeof options.now === "function" ? options.now : today;
  }

  _today() {
    return engine.toDateOnly(this._now());
  }

  /* ------------------------------------------------------------- the file */

  /**
   * The rows as they arrived, checked for shape only.
   *
   * NOTHING HERE TOUCHES THE DATABASE. Shape errors are the ones that are true
   * of the file on its own - a missing id, a gross that is not a number, a date
   * that is not a date - and answering them before any read means a file of
   * six hundred typos costs six hundred string checks rather than eighteen
   * hundred queries.
   */
  _normalize(rows) {
    if (!Array.isArray(rows)) {
      throw validationError("The upload must be a list of rows");
    }
    if (rows.length === 0) {
      throw validationError("The file has no rows to validate");
    }
    if (rows.length > MAX_ROWS) {
      throw validationError(
        `An upload may carry at most ${MAX_ROWS} rows; this one has ${rows.length}`
      );
    }

    return rows.map((raw, index) => {
      const row = raw && typeof raw === "object" ? raw : {};
      return {
        // 1-based and counted over DATA rows, so it matches what somebody sees
        // in a spreadsheet once the header line is discounted.
        row_number: index + 1,
        employee_id: asText(row.employee_id),
        monthly_gross: asText(row.monthly_gross),
        effective_from: asText(row.effective_from),
        parsed: {
          employee_id: toEmployeeId(row.employee_id),
          monthly_gross: toAmount(row.monthly_gross),
          effective_from: toDateOnly(row.effective_from),
        },
      };
    });
  }

  /** The shape complaint for a row, or null when the three cells are readable. */
  _shapeError(entry) {
    const p = entry.parsed;
    if (p.employee_id === null) {
      return isBlank(entry.employee_id)
        ? "Employee ID is required"
        : "Employee ID must be a whole number";
    }
    if (p.monthly_gross === null) {
      return isBlank(entry.monthly_gross)
        ? "Monthly Gross Salary is required"
        : "Monthly Gross Salary must be a number";
    }
    if (p.monthly_gross <= 0) {
      // A gross of nothing is not a salary. The engine would price it quite
      // happily - it is a non-negative number - and produce a whole structure
      // of zeroes that reads as if somebody meant it.
      return "Monthly Gross Salary must be more than zero";
    }
    if (p.effective_from === null) {
      return isBlank(entry.effective_from)
        ? "Effective From is required"
        : "Effective From must be a date in YYYY-MM-DD form";
    }
    return null;
  }

  /**
   * Every employee id that appears on more than one row of this file.
   *
   * ALL of their rows are refused, not all but the first. An employee may hold
   * one salary proposal at a time, so two rows for one person is a file whose
   * author meant something the system cannot represent - and picking one of
   * them to honour would be this module deciding which of two pay figures
   * somebody meant.
   */
  _duplicateIds(entries) {
    const seen = new Map();
    for (const entry of entries) {
      const id = entry.parsed.employee_id;
      if (id === null) continue;
      seen.set(id, (seen.get(id) || 0) + 1);
    }
    const duplicates = new Set();
    for (const [id, count] of seen) {
      if (count > 1) duplicates.add(id);
    }
    return duplicates;
  }

  /* -------------------------------------------------------------- one row */

  /**
   * Validate ONE row against the database as it is right now.
   *
   * The order is the order `createInitialSalary` refuses things in, so that the
   * reason a row is refused here is the reason it would be refused there. The
   * only rule this adds is the opening-date CHECK, which exists because the
   * file carries a date the server is going to ignore.
   */
  async _validateRow(entry, duplicates) {
    const shape = this._shapeError(entry);
    if (shape) return { valid: false, error_reason: shape };

    const { employee_id: employeeId, monthly_gross: gross, effective_from: uploaded } = entry.parsed;

    if (duplicates.has(employeeId)) {
      return { valid: false, error_reason: "Duplicate Employee ID in upload" };
    }

    const employee = await this.salaryRepo.getStatutoryContext(employeeId);
    if (!employee) {
      return { valid: false, error_reason: `Employee ${employeeId} was not found` };
    }

    /*
     * ONE PENDING PROPOSAL PER EMPLOYEE — the strongest rule in the lifecycle,
     * and the one a bulk upload is most likely to walk into: a file assembled
     * last week does not know that somebody raised a revision for two of these
     * people yesterday. Checked FIRST of the record rules, because the answer
     * is the same whatever the gross or the date, and it names the salary that
     * is in the way.
     */
    const pending = await this.salaryRepo.getPendingForEmployee(employeeId);
    if (pending) {
      return {
        valid: false,
        employee_name: employee.employee_name || null,
        error_reason:
          "A salary proposal is already pending for this employee; amend, approve or reject it " +
          "before uploading another",
      };
    }

    // The classification, by the lifecycle's own rule: a rejected-only history
    // is no salary at all, so the next proposal is still this person's first.
    const hasLive = await this.salaryRepo.hasLiveSalary(employeeId);
    const type = hasLive ? ROW_TYPE.REVISION : ROW_TYPE.OPENING_SALARY;

    let effectiveFrom = uploaded;
    if (type === ROW_TYPE.OPENING_SALARY) {
      const required = engine.resolveOpeningEffectiveFrom(employee.date_of_joining);
      if (uploaded !== required) {
        return {
          valid: false,
          employee_name: employee.employee_name || null,
          type,
          error_reason: `Opening salary Effective From must be ${required}`,
        };
      }
      effectiveFrom = required;
    }

    const lock = periodLock.checkLock(effectiveFrom);
    if (lock.locked) {
      return {
        valid: false,
        employee_name: employee.employee_name || null,
        type,
        error_reason: periodLock.blockedReason(effectiveFrom),
      };
    }

    const clash = await this.salaryRepo.getActiveRevisionAt(employeeId, effectiveFrom);
    if (clash) {
      return {
        valid: false,
        employee_name: employee.employee_name || null,
        type,
        error_reason: `A ${String(clash.status).toLowerCase()} salary revision already exists for ${effectiveFrom}`,
      };
    }

    /*
     * TWO FUTURE-DATED REVISIONS AT ONCE ARE REFUSED, exactly as M2 refuses
     * them: an employee with an undecided or agreed pay change still ahead of
     * them cannot have a second one queued behind it.
     */
    const todayDate = this._today();
    if (effectiveFrom > todayDate) {
      const futures = (await this.salaryRepo.getFutureRevisions(employeeId, todayDate)) || [];
      const blocking = futures.filter((f) => engine.toDateOnly(f.effective_from) !== effectiveFrom);
      if (blocking.length > 0) {
        const detail = blocking
          .map((f) => `${String(f.status).toLowerCase()} revision effective ${engine.toDateOnly(f.effective_from)}`)
          .join(", ");
        return {
          valid: false,
          employee_name: employee.employee_name || null,
          type,
          error_reason:
            `This employee already has a future-dated salary revision (${detail}); ` +
            "decide that one before uploading another future revision",
        };
      }
    }

    /*
     * THE SERVER PRICES IT, and the same function that will fill the record
     * does. Nothing in the file influences a component, a contribution or the
     * CTC - only the gross and (for a revision) the date reach this call.
     */
    let calculated;
    try {
      calculated = await this.salaryUsecase.calculateForEmployee(employeeId, {
        monthly_gross: gross,
        effective_from: effectiveFrom,
      });
    } catch (err) {
      return {
        valid: false,
        employee_name: employee.employee_name || null,
        type,
        error_reason: err && err.message ? err.message : "The salary could not be calculated",
      };
    }

    return {
      valid: true,
      employee_name: employee.employee_name || null,
      type,
      resolved_effective_from: effectiveFrom,
      // Opening salaries change nothing, so they say nothing. Revisions carry
      // the one automatic sentence, and it is stored as `revision_reason`.
      revision_reason: type === ROW_TYPE.REVISION ? BULK_REVISION_REASON : null,
      calculated,
    };
  }

  /** A validated row as the API returns it: the three columns, plus the verdict. */
  _present(entry, outcome) {
    return {
      row_number: entry.row_number,
      // The ORIGINAL three cells, echoed exactly. The rejected-row export is
      // built from these, so a file somebody fixes and re-uploads still says
      // what they typed rather than what this module made of it.
      employee_id: entry.employee_id,
      monthly_gross: entry.monthly_gross,
      effective_from: entry.effective_from,

      valid: outcome.valid === true,
      error_reason: outcome.valid === true ? null : outcome.error_reason || "Invalid row",

      employee_name: outcome.employee_name || null,
      type: outcome.type || null,
      resolved_effective_from: outcome.resolved_effective_from || null,
      revision_reason: outcome.revision_reason || null,
      // PENDING, always, and stated so the preview cannot imply otherwise.
      status_to_be_created: outcome.valid === true ? STATUS.PENDING : null,
      source: outcome.valid === true ? SOURCE.IMPORT : null,
      calculated: outcome.calculated || null,
    };
  }

  /* ------------------------------------------------------------- validate */

  /**
   * Validate the WHOLE file and report on every row.
   *
   * NOTHING IS WRITTEN. This is the preview somebody reads before they commit:
   * how many rows are good, how many are not, what each of the good ones will
   * create, and - for each of the bad ones - the one sentence saying why.
   *
   * EVERY ROW IS VALIDATED, INCLUDING ONES AFTER A FAILURE. A batch that
   * stopped at the first bad row would make fixing a file an exercise in
   * uploading it once per mistake.
   */
  async validate(rows) {
    const entries = this._normalize(rows);
    const duplicates = this._duplicateIds(entries);

    const results = [];
    for (const entry of entries) {
      /* eslint-disable no-await-in-loop */
      const outcome = await this._validateRow(entry, duplicates);
      results.push(this._present(entry, outcome));
    }

    const valid = results.filter((r) => r.valid).length;
    return {
      total_rows: results.length,
      valid_rows: valid,
      invalid_rows: results.length - valid,
      rows: results,
    };
  }

  /* --------------------------------------------------------------- submit */

  /**
   * Create the valid rows, and only the valid rows.
   *
   * IT REVALIDATES EVERYTHING FIRST, against the database as it is now rather
   * than as it was when the preview was drawn. There is no token to trust and
   * no staging table to read back: the file is sent again and checked again,
   * which is the simplest thing that cannot write a row on the strength of an
   * expired check.
   *
   * PARTIAL SUCCESS IS THE CORRECT OUTCOME, not a failure to be rolled back.
   * These are proposals for unrelated employees; refusing to create ninety-six
   * good ones because four were wrong would mean the whole file waiting on the
   * four, and nothing about one employee's pay depends on another's.
   *
   * A ROW THAT FAILS ON THE WAY IN IS REPORTED, NOT THROWN. The unique pending
   * key is the final backstop against two requests racing for one employee, and
   * it fires as a duplicate-key error on the insert - which is a per-row answer
   * ("somebody got there first"), not a reason to abandon the other ninety-nine.
   */
  async submit(rows, actor = {}) {
    const entries = this._normalize(rows);
    const duplicates = this._duplicateIds(entries);

    const results = [];
    for (const entry of entries) {
      /* eslint-disable no-await-in-loop */
      const outcome = await this._validateRow(entry, duplicates);
      const presented = this._present(entry, outcome);

      if (!presented.valid) {
        results.push({ ...presented, created: false, salary_id: null });
        continue;
      }

      try {
        const created = await this.salaryUsecase.createInitialSalary(
          entry.parsed.employee_id,
          {
            monthly_gross: entry.parsed.monthly_gross,
            // Ignored by the lifecycle for an opening salary, which dates
            // itself. Sent for a revision, which is the uploader's date.
            effective_from: outcome.resolved_effective_from,
            revision_reason: outcome.revision_reason,
          },
          actor,
          // THE ONE THING THIS MODULE STAMPS: where the row came from. The
          // classification, the date, the breakup and the reason requirement
          // are all still the lifecycle's.
          { source: SOURCE.IMPORT }
        );
        results.push({
          ...presented,
          created: true,
          salary_id: created.salary_id,
          status: created.status,
        });
      } catch (err) {
        // The row did not become anything, so it no longer claims it will:
        // `status_to_be_created` and `source` describe a record that exists,
        // and leaving them on a failed row would put PENDING beside a proposal
        // nobody holds.
        results.push({
          ...presented,
          valid: false,
          created: false,
          salary_id: null,
          status_to_be_created: null,
          source: null,
          error_reason: this._failureReason(err),
        });
      }
    }

    const created = results.filter((r) => r.created).length;
    return {
      total_rows: results.length,
      created_rows: created,
      failed_rows: results.length - created,
      rows: results,
    };
  }

  /**
   * A create failure as one sentence somebody can act on.
   *
   * THE DUPLICATE-KEY CASE IS THE POINT OF THIS. `uq_salary_pending_proposal`
   * is what actually guarantees one pending proposal per employee, and when two
   * requests race for the same employee the loser gets a driver error naming an
   * index. That is true and unreadable; what the person needs to know is that a
   * proposal now exists for that employee and this row did not create it.
   */
  _failureReason(err) {
    const code = err && err.code;
    const message = (err && err.message) || "";
    if (code === "ER_DUP_ENTRY" || /uq_salary_pending_proposal|Duplicate entry/i.test(message)) {
      return (
        "A salary proposal is already pending for this employee; amend, approve or reject it " +
        "before uploading another"
      );
    }
    return message || "The salary proposal could not be created";
  }
}

module.exports = (salaryRepo, salaryUsecase, options) =>
  new SalaryBulkUploadUsecase(salaryRepo, salaryUsecase, options);
module.exports.SalaryBulkUploadUsecase = SalaryBulkUploadUsecase;
module.exports.BULK_REVISION_REASON = BULK_REVISION_REASON;
module.exports.MAX_ROWS = MAX_ROWS;
module.exports.ROW_TYPE = ROW_TYPE;
module.exports.TEMPLATE_COLUMNS = TEMPLATE_COLUMNS;
