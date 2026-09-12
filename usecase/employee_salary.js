const engine = require("../utils/salary_engine");
const periodLock = require("../services/salary_period_lock");
const { STATUS } = require("../repository/employee_salary");

/**
 * M2 — the salary lifecycle.
 *
 * The rules that decide whether a salary may be created, amended, approved or
 * rejected live here rather than in the route, so they can be tested without a
 * database and without Express — the same reason `usecase/employee_work_shift.js`
 * holds the assignment rules rather than its route.
 *
 * THE SERVER CALCULATES EVERYTHING. A caller supplies a gross, an effective
 * date, and — for an override — four component amounts. Every other number on
 * a salary record is produced by `utils/salary_engine.js` here, on the way in.
 * A client-supplied `basic`, `employee_pf` or `monthly_ctc` is not merely
 * ignored, it never reaches the row: the insert is built from the engine's
 * output, key by key, and a test asserts that a body full of invented
 * statutory amounts changes nothing.
 *
 * APPROVED HISTORY IS IMMUTABLE. There is no path here that edits an approved
 * record and no path that deletes any record. A correction to an approved
 * salary is a NEW revision, which is a thing somebody has to approve.
 *
 * TWO RULES THAT ARE REFUSALS AND NOT WARNINGS, and are enforced HERE rather
 * than in a route or a screen, because this is the layer every path shares:
 *
 *   a person may not approve a salary revision they created themselves,
 *   administrators (`user_type = 2`) excepted — see `_refuseSelfApproval`
 *
 *   an employee may not be given a second future-dated live revision while one
 *   is already outstanding — see `createInitialSalary`
 *
 * M4 ADDS A THIRD, AND IT IS THE STRONGEST OF THE THREE:
 *
 *   an employee may have AT MOST ONE PENDING salary proposal at any time,
 *   whatever its effective date — see `_refuseSecondPendingProposal`
 */

/** Shaped so `utils/http.js#respondError` answers 400 with the detail. */
function validationError(message, extra = {}) {
  const err = new Error(message);
  err.name = "ValidationError";
  Object.assign(err, extra);
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.name = "NotFoundError";
  return err;
}

/**
 * `user_type = 2` is an administrator and holds every permission.
 *
 * The same constant `middlewares/permissions.js` uses, restated here rather
 * than imported because that module is a factory that has to be built with the
 * designation usecase, and this layer deliberately has no Express or database
 * dependency at all. `actorFor` already reports the same fact as `isAdmin`;
 * both are honoured so that an actor assembled either way is read correctly.
 */
const ADMIN_USER_TYPE = 2;

/** True only for an administrator, by either of the two things an actor carries. */
function isAdminActor(actor = {}) {
  return actor.isAdmin === true || Number(actor.userType) === ADMIN_USER_TYPE;
}

/** `YYYY-MM-DD`, or null. Salary dates are date-only; a time would be noise. */
function normalizeDate(value, field) {
  const d = engine.toDateOnly(value);
  if (!d) throw validationError(`${field} must be a date in YYYY-MM-DD form`);
  return d;
}

/** Today, as a date-only string, in the one place it is taken from the clock. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

const SOURCE = {
  OPENING_SALARY: "OPENING_SALARY",
  REVISION: "REVISION",
  CORRECTION: "CORRECTION",
  IMPORT: "IMPORT",
};

/**
 * M4 — the sources that must say WHY.
 *
 * A REVISION and a CORRECTION both CHANGE something an employee is already on,
 * and an approver's first question about a change is what it is for. An
 * OPENING_SALARY changes nothing: it is the first structure the person is put
 * on at all, so there is no prior figure for a reason to be a reason about,
 * and demanding one would only produce six hundred rows reading "opening
 * salary".
 *
 * IMPORT is not listed. Nothing creates one today; when a bulk load does, what
 * it carries per row is that module's decision and not a rule inherited here.
 */
const SOURCES_REQUIRING_REASON = [SOURCE.REVISION, SOURCE.CORRECTION];

/** A reason as it is stored: trimmed, or null when nobody wrote one. */
function normalizeReason(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * The revision reason for a proposal of this source, or a refusal.
 *
 * ENFORCED HERE, in the layer every write path shares, for the same reason the
 * self-approval rule is: a required-field rule that lives in a Joi schema is
 * one new endpoint away from not existing, and the database column is
 * deliberately nullable because opening salaries legitimately have no reason.
 *
 * `revision_reason` IS ITS OWN FIELD AND IS NEVER SATISFIED BY ANOTHER ONE.
 * `override_reason` is why the BREAKUP departs from the automatic one, and
 * `rejection_reason` is why an approver REFUSED. Three questions, three people,
 * three columns - a proposal carrying a manual override still has to say why
 * the pay is changing.
 */
function resolveRevisionReason(source, value) {
  const reason = normalizeReason(value);
  if (!SOURCES_REQUIRING_REASON.includes(source)) return reason;
  if (reason === null) {
    throw validationError(
      "A revision reason is required: say why this salary is changing"
    );
  }
  return reason;
}

/**
 * The most pending proposals one queue read will return.
 *
 * NOT PAGINATION, AND DELIBERATELY NOT. A pending approval queue is a worklist
 * that people empty; it is a handful of rows in practice and a few dozen at
 * the very worst. Paging it would be machinery on a screen that never needs to
 * turn a page, and the approved task says not to overengineer this. The cap is
 * here so that a bug elsewhere - a thousand proposals raised by a loop - cannot
 * turn one screen into an unbounded read, not as a page size.
 */
const QUEUE_MAX_ROWS = 500;

/** A filter id as a number, or null when it was not supplied. */
function toId(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A DECIMAL column, which the driver hands back as a string, as a number. */
function toAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * What is changing, in rupees and as a percentage of what came before.
 *
 * `null` WHEN THERE IS NOTHING TO COMPARE WITH. An opening salary has no
 * previous figure; reporting "+100%" for it would be arithmetic on a number
 * that does not exist. A current gross of zero gets an amount but no
 * percentage, for the same reason - the division has no meaning, and "infinite
 * increase" is not a thing to put in front of an approver.
 *
 * ROUNDED TO TWO PLACES, and it is a DISPLAY figure. Nothing downstream
 * computes anything from it: the amounts on the record are what a payslip and a
 * filing are built from.
 */
function differenceBetween(currentGross, proposedGross) {
  if (currentGross === null || proposedGross === null) return null;
  const amount = Math.round((proposedGross - currentGross) * 100) / 100;
  const percentage =
    currentGross > 0 ? Math.round((amount / currentGross) * 10000) / 100 : null;
  return { amount, percentage };
}

/** The upper bound the `revision_reason` column can actually hold. */
const REASON_MAX_LENGTH = 500;

function checkReasonLength(reason) {
  if (reason !== null && reason.length > REASON_MAX_LENGTH) {
    throw validationError(
      `A revision reason may be at most ${REASON_MAX_LENGTH} characters`
    );
  }
  return reason;
}

class EmployeeSalaryUsecase {
  /**
   * `options.now` is the clock, and it exists so the future-dating rules can
   * be tested as rules rather than as "whatever date the suite happens to run
   * on". It is NOT a caller input: nothing reaches it from a request body, and
   * the server builds this usecase without it.
   */
  constructor(salaryRepo, options = {}) {
    this.salaryRepo = salaryRepo;
    this._now = typeof options.now === "function" ? options.now : today;
  }

  /** Today, as a date-only string. The one place the clock is read. */
  _today() {
    return normalizeDate(this._now(), "today");
  }

  /* ------------------------------------------------------------ calculate */

  /**
   * The pure calculation service, for one employee.
   *
   * This is what the preview endpoint exposes and what `createInitialSalary`
   * uses to fill a record, so a preview cannot disagree with what is saved a
   * second later — there is one implementation, not two.
   */
  async calculateForEmployee(employeeId, input = {}) {
    const employee = await this.salaryRepo.getStatutoryContext(employeeId);
    if (!employee) throw notFound(`Employee ${employeeId} was not found`);

    const effectiveFrom = input.effective_from
      ? normalizeDate(input.effective_from, "effective_from")
      : engine.resolveOpeningEffectiveFrom(employee.date_of_joining);

    const result = engine.calculateSalary({
      monthly_gross: input.monthly_gross,
      manual_components: input.manual_components,
      manual_override: input.manual_override,
      override_reason: input.override_reason,
      // The statutory facts come from the employee master, never the caller.
      pf_applicable: employee.pf_applicable,
      esi_applicable: employee.esi_applicable,
      // Two separate history facts. The EPS split reads the EPS one; the PF
      // one travels beside it and is never read as a substitute for it.
      previous_pf_member: employee.previous_pf_member,
      previous_eps_member: employee.previous_eps_member,
      dob: employee.dob,
      date_of_joining: employee.date_of_joining,
      effective_from: effectiveFrom,
      as_of: effectiveFrom,
      // Monthly-payroll context. Absent today; the engine says so rather than
      // inventing an ESI wage from the gross.
      esi_wage: input.esi_wage,
      contribution_period_continues: input.contribution_period_continues,
      employee_contribution_exempt: input.employee_contribution_exempt,
    });

    if (!result.valid) throw validationError(result.errors.join("; "), { errors: result.errors });

    return {
      ...result,
      employee_id: employee.employee_id,
      employee_name: employee.employee_name,
      effective_from: effectiveFrom,
      period_lock: periodLock.checkLock(effectiveFrom),
    };
  }

  /* --------------------------------------------------------------- create */

  /**
   * ONE PENDING SALARY PROPOSAL PER EMPLOYEE. NOT ONE PER EFFECTIVE DATE.
   *
   * A salary proposal is one decision at a time. Where a proposal is already
   * outstanding, the next thing that happens to that employee's pay is that
   * SOMEBODY DECIDES IT - it is amended (`edit_salary`), approved, or
   * rejected. Raising a second one does not queue anything up; it puts two
   * different answers to "what is this person going to be paid" in front of an
   * approver with nothing on the record saying which supersedes which, and the
   * one they approve silently changes what the other one meant.
   *
   * WHY THE EFFECTIVE DATE DOES NOT RESCUE IT. M2 already refuses a second
   * proposal at the SAME date, and refuses a second FUTURE-dated live
   * revision. Neither of those catches "a pending proposal for October and a
   * second pending proposal for December" - two undecided pay changes, both
   * legitimate-looking, neither agreed. That is the gap this closes, and both
   * M2 rules stay exactly as they are underneath it.
   *
   * REJECTED PROPOSALS NEVER BLOCK ANYTHING. Only a PENDING row is read here,
   * so a refused proposal leaves the employee free to be proposed again - the
   * same principle `hasLiveSalary` already follows. An APPROVED one does not
   * block either: it has been decided, and what governs the next one after it
   * is M2's effective-date and future-revision rules.
   *
   * THIS IS THE MESSAGE, NOT THE GUARANTEE. The guarantee is
   * `uq_salary_pending_proposal` in the database, because a check here and an
   * insert a moment later is a race two concurrent requests can both win. What
   * this adds is a sentence somebody can act on, and the refusal happening
   * BEFORE anything is calculated or written.
   */
  async _refuseSecondPendingProposal(employeeId) {
    const pending = await this.salaryRepo.getPendingForEmployee(employeeId);
    if (!pending) return;

    throw validationError(
      "A salary proposal is already pending for this employee; amend, approve or " +
        "reject it before creating another.",
      {
        conflict: {
          kind: "PENDING_PROPOSAL_EXISTS",
          salary_id: pending.salary_id,
          effective_from: engine.toDateOnly(pending.effective_from),
          status: STATUS.PENDING,
        },
      }
    );
  }

  /**
   * Create a salary record, always as PENDING.
   *
   * NOTHING IS EVER CREATED APPROVED, including by an administrator. Proposing
   * a salary and agreeing to it are two decisions with two permissions, and
   * collapsing them would make `approve_salary_revision` decorative — the
   * person who can add would already have approved by adding.
   *
   * M5 — `options.source` FORCES THE STORED SOURCE, AND IT IS INTERNAL ONLY.
   *
   * `routes/employee_salary.js` calls this with THREE arguments, so nothing a
   * caller can put in a request body reaches it - the route cannot pass an
   * `options` it does not construct, and Joi runs without `allowUnknown` so a
   * body naming `source` is refused before this layer is reached at all. The
   * one caller that supplies it is `usecase/salary_bulk_upload.js`, which
   * stamps IMPORT so a bulk-loaded row says in its own audit trail where it
   * came from.
   *
   * IT CHANGES THE STAMP, NOT THE RULES. The CLASSIFICATION - is this the
   * employee's first live salary or a change to one - is still worked out here
   * from `hasLiveSalary`, and it is still the classification that decides the
   * effective date and whether a reason is required. So a bulk REVISION stored
   * as IMPORT must still say why it is changing, and a bulk OPENING salary
   * still takes the server's opening date rather than the file's.
   */
  async createInitialSalary(employeeId, input = {}, actor = {}, options = {}) {
    const employee = await this.salaryRepo.getStatutoryContext(employeeId);
    if (!employee) throw notFound(`Employee ${employeeId} was not found`);

    /*
     * CHECKED FIRST, BEFORE ANYTHING IS CALCULATED OR WRITTEN. Where a
     * proposal is already outstanding there is nothing to work out: the answer
     * is the same whatever gross, date or reason was sent, so asking the
     * engine to price a proposal that cannot be created would only make the
     * refusal slower and would put a preview-shaped object in front of
     * somebody who is not getting one.
     */
    await this._refuseSecondPendingProposal(employeeId);

    // Rejected rows do not count: if every proposal so far was refused, this
    // is still the employee's FIRST salary and takes the opening date.
    const existing = await this.salaryRepo.hasLiveSalary(employeeId);

    /*
     * THE OPENING RULE. The first record for an employee is dated the later of
     * the opening floor and their date of joining, and the caller does not get
     * to choose it — that is what makes "opening salary" a fact rather than a
     * preference. A later revision names its own date.
     */
    const effectiveFrom = existing
      ? normalizeDate(input.effective_from, "effective_from")
      : engine.resolveOpeningEffectiveFrom(employee.date_of_joining);

    /*
     * TWO NAMES FOR TWO DIFFERENT THINGS.
     *
     * `classification` is what this proposal IS - the employee's first live
     * salary, or a change to one - and it is derived from the record, never
     * from the caller. `source` is what gets STAMPED on the row, which is the
     * same thing unless an internal caller (M5's bulk upload) says the origin
     * was an import.
     *
     * Every rule below reads the CLASSIFICATION. Letting the stamp decide them
     * would mean a bulk revision quietly escaping the reason requirement,
     * because IMPORT is not in `SOURCES_REQUIRING_REASON`.
     */
    const classification = existing ? SOURCE.REVISION : SOURCE.OPENING_SALARY;
    const source = options.source === undefined ? classification : options.source;

    /*
     * M4 — WHY, and it is decided by the CLASSIFICATION rather than by the
     * caller. Refused before anything is calculated or written, so a proposal
     * that cannot say why it exists never reaches the table.
     */
    const revisionReason = checkReasonLength(
      resolveRevisionReason(classification, input.revision_reason)
    );

    const lock = periodLock.checkLock(effectiveFrom);
    if (lock.locked) throw validationError(periodLock.blockedReason(effectiveFrom));

    const clash = await this.salaryRepo.getActiveRevisionAt(employeeId, effectiveFrom);
    if (clash) {
      throw validationError(
        `A ${clash.status.toLowerCase()} salary revision already exists for ${effectiveFrom}`,
        { conflict: { salary_id: clash.salary_id, status: clash.status } }
      );
    }

    const calculated = await this.calculateForEmployee(employeeId, {
      ...input,
      effective_from: effectiveFrom,
    });

    /*
     * TWO FUTURE-DATED REVISIONS AT ONCE ARE REFUSED.
     *
     * An employee who already has a live revision dated ahead of today has a
     * pay change that is agreed (APPROVED) or awaiting a decision (PENDING)
     * and has not happened yet. Queueing a SECOND future change behind it
     * means nobody can answer the only question that matters — what will this
     * person be paid next month — without replaying a queue, and the second
     * one silently changes what the first one meant. In M2 the answer is to
     * refuse, and to say what is already there: the existing revision is
     * decided (approved, rejected, or superseded by amending it in place)
     * before another future one is proposed.
     *
     * REJECTED HISTORY NEVER BLOCKS. `getFutureRevisions` excludes REJECTED
     * rows, so a refused proposal at a future date leaves that date open, in
     * the same way it leaves the opening-salary path open.
     *
     * THIS DOES NOT REPLACE ANYTHING. M2 has no path that edits or supersedes
     * another future revision on the caller's behalf — an existing future row
     * is left exactly as it is and the new request is refused, rather than one
     * quietly winning.
     */
    const todayDate = this._today();
    if (effectiveFrom > todayDate) {
      const liveFutures = await this.salaryRepo.getFutureRevisions(employeeId, todayDate);
      const blocking = (liveFutures || []).filter(
        (f) => engine.toDateOnly(f.effective_from) !== effectiveFrom
      );
      if (blocking.length > 0) {
        const detail = blocking
          .map((f) => `${f.status.toLowerCase()} revision effective ${engine.toDateOnly(f.effective_from)}`)
          .join(", ");
        throw validationError(
          `This employee already has a future-dated salary revision (${detail}); ` +
            "decide that one before proposing another future revision",
          {
            conflict: {
              kind: "FUTURE_REVISION_EXISTS",
              requested_effective_from: effectiveFrom,
              existing: blocking.map((f) => ({
                salary_id: f.salary_id,
                effective_from: engine.toDateOnly(f.effective_from),
                status: f.status,
              })),
            },
          }
        );
      }
    }

    /*
     * BACK-DATING UNDER A FUTURE REVISION STAYS LEGITIMATE, AND STAYS
     * REPORTED. A correction dated on or before today does not create a queue
     * of undecided future pay, so it is not refused — but it does change which
     * record is current on which day, so the future revisions it lands behind
     * are still handed back rather than discovered later on a payslip.
     */
    const futures = await this.salaryRepo.getFutureRevisions(employeeId, effectiveFrom);

    const row = this._toRow(employeeId, effectiveFrom, source, calculated, actor, revisionReason);
    const salaryId = await this.salaryRepo.create(row);

    return {
      salary_id: salaryId,
      employee_id: employeeId,
      status: STATUS.PENDING,
      source,
      // What this proposal IS, beside what it is stamped as. They differ only
      // for a bulk import, and a caller that needs to tell an opening salary
      // from a revision must read this one rather than the stamp.
      classification,
      effective_from: effectiveFrom,
      revision_reason: revisionReason,
      calculated,
      future_conflicts: (futures || []).map((f) => ({
        salary_id: f.salary_id,
        effective_from: engine.toDateOnly(f.effective_from),
        status: f.status,
      })),
    };
  }

  /**
   * The database row, built ONLY from the engine's output.
   *
   * Every value here is calculated; not one is copied from the request body.
   * That is the whole of "never trust client-calculated values" — it is not a
   * filter applied to the caller's object, it is a row assembled from a
   * different object entirely.
   */
  _toRow(employeeId, effectiveFrom, source, c, actor, revisionReason = null) {
    return {
      employee_id: employeeId,
      monthly_gross: c.monthly_gross,
      daily_salary: c.daily_salary,
      basic: c.components.basic,
      conveyance: c.components.conveyance,
      hra: c.components.hra,
      special_allowance: c.components.special_allowance,
      manual_override: c.manual_override ? 1 : 0,
      override_reason: c.override_reason || null,
      pf_status: c.pf.status,
      pf_wage: c.pf.pf_wage,
      employee_pf: c.pf.employee_pf,
      employer_pf_total: c.pf.employer_pf_total,
      employer_epf: c.pf.employer_epf,
      employer_eps: c.pf.employer_eps,
      edli: c.pf.edli,
      pf_admin_charge: c.pf.pf_admin_charge,
      esi_status: c.esi.status,
      esi_wage: c.esi.esi_wage,
      employee_esi: c.esi.employee_esi,
      employer_esi: c.esi.employer_esi,
      monthly_ctc: c.monthly_ctc,
      ctc_status: c.ctc_status === engine.STATUS.APPLIED ? "APPLIED" : "PENDING",
      unresolved_notes: JSON.stringify(c.unresolved || []),
      statutory_snapshot: JSON.stringify(c.statutory_snapshot),
      statutory_config_version: c.statutory_snapshot.config_version,
      effective_from: effectiveFrom,
      status: STATUS.PENDING,
      source,
      // The one value on this row that is the CALLER'S words rather than the
      // engine's arithmetic - and it is a reason, never an amount.
      revision_reason: revisionReason,
      created_by: actor.employeeId ?? null,
    };
  }

  /* ------------------------------------------------------------- resolver */

  /**
   * The CURRENT salary: the latest APPROVED record effective on or before the
   * as-of date.
   *
   * Pending and rejected records are never current, and an approved record
   * dated in the future becomes current on its effective date and not a day
   * earlier. Returning `null` is a real answer — most employees have no salary
   * record at all today — and callers must treat it as "not recorded yet"
   * rather than as zero.
   *
   * THE KEY IS `current_salary`, NOT `salary`, AND THAT IS DELIBERATE. `salary`
   * is a B3 sensitive field name (`constants/sensitive_fields.js`), and
   * `middlewares/sensitive.js#filterResponse` REMOVES keys by name at any
   * depth. Naming this key `salary` would mean that for any caller without
   * `view_employee_sensitive` the whole payload silently vanished from the
   * response — not an error, not a 403, just a missing key — which is the
   * hardest kind of bug to see from a screen.
   */
  async getCurrentSalary(employeeId, asOf) {
    const asOfDate = asOf ? normalizeDate(asOf, "as_of") : this._today();
    const row = await this.salaryRepo.getCurrentSalary(employeeId, asOfDate);
    if (!row) return { employee_id: Number(employeeId), as_of: asOfDate, current_salary: null };
    return { employee_id: Number(employeeId), as_of: asOfDate, current_salary: this._present(row) };
  }

  /** Every revision, newest first. */
  async getHistory(employeeId) {
    const rows = await this.salaryRepo.getHistory(employeeId);
    return (rows || []).map((r) => this._present(r));
  }

  /**
   * A stored row as the API returns it.
   *
   * The two JSON columns come back as strings from some driver versions and as
   * objects from others, so they are normalised here rather than at every call
   * site. Dates are flattened to `YYYY-MM-DD`: a salary effective date has no
   * time, and letting one through invites a timezone to move it.
   */
  _present(row) {
    const parse = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === "object") return v;
      try {
        return JSON.parse(v);
      } catch (err) {
        return null;
      }
    };
    return {
      ...row,
      effective_from: engine.toDateOnly(row.effective_from),
      unresolved_notes: parse(row.unresolved_notes),
      statutory_snapshot: parse(row.statutory_snapshot),
      manual_override: Number(row.manual_override) === 1,
    };
  }

  /* ----------------------------------------------------- the approval queue */

  /**
   * M4 — EVERY PENDING PROPOSAL, FOR THE SALARY APPROVAL SCREEN.
   *
   * PENDING ONLY. Approved and rejected rows are never selected, so there is
   * no filter for an approver to relax and no way for this screen to offer a
   * second decision on something already decided.
   *
   * EACH ROW CARRIES WHAT THE DECISION NEEDS: who the employee is, where they
   * work, what they are on today, what is being proposed, from when, why, and
   * who asked. That is one query - see `getPendingQueue` in the repository -
   * rather than a history read per employee from the browser.
   *
   * THE DIFFERENCE IS WORKED OUT HERE, NOT IN THE BROWSER. It is a subtraction
   * of two grosses rather than a statutory calculation, but the rule this
   * module exists to hold is that salary figures are the server's answer, and
   * a screen that does its own arithmetic on pay is a screen that can disagree
   * with the record. `null` where there is nothing to compare against - a
   * first salary has no previous figure, and calling that a rise of 100% would
   * be an invention.
   *
   * SELF-APPROVAL IS FLAGGED, NOT FILTERED. A proposal the caller created
   * themselves stays in their queue with `own_proposal: true`, because they may
   * still reject it - withdrawing your own proposal is allowed, agreeing to it
   * is not. The refusal itself lives in `_refuseSelfApproval` and is the
   * server's; this flag only lets the screen say so before the click.
   */
  async getPendingQueue(filters = {}, actor = {}) {
    const asOf = filters.as_of ? normalizeDate(filters.as_of, "as_of") : this._today();

    const effectiveFrom = filters.effective_from
      ? normalizeDate(filters.effective_from, "effective_from")
      : null;
    const effectiveTo = filters.effective_to
      ? normalizeDate(filters.effective_to, "effective_to")
      : null;
    if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
      throw validationError("effective_from must be on or before effective_to");
    }

    const rows = await this.salaryRepo.getPendingQueue({
      employee_id: toId(filters.employee_id),
      store_id: toId(filters.store_id),
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      as_of: asOf,
      limit: QUEUE_MAX_ROWS,
    });

    const approverId = actor.employeeId;
    const isAdmin = isAdminActor(actor);

    return (rows || []).map((row) => {
      const record = this._present(row);
      const currentGross = toAmount(row.current_monthly_gross);
      const proposedGross = toAmount(row.monthly_gross);

      /*
       * `own_proposal` compares EMPLOYEE identity against employee identity,
       * exactly as `_refuseSelfApproval` does, and an actor with no employee id
       * cannot have created anything. Administrators are the standing exception
       * to the rule, so their own proposals are not flagged as un-approvable.
       */
      const ownProposal =
        !isAdmin &&
        approverId !== null &&
        approverId !== undefined &&
        record.created_by !== null &&
        record.created_by !== undefined &&
        Number(record.created_by) === Number(approverId);

      /*
       * The raw join columns are dropped rather than sent alongside the shaped
       * ones. `current_monthly_gross` and `current_salary.monthly_gross` would
       * otherwise be two names for one figure on the same object, and two
       * names for one figure is how a screen ends up reading the one nobody
       * maintained.
       */
      delete record.current_salary_id;
      delete record.current_monthly_gross;
      delete record.current_effective_from;
      delete record.outlet_nickname;

      return {
        ...record,
        employee_name: row.employee_name || null,
        store_id: row.store_id ?? null,
        outlet_name: row.outlet_nickname || row.outlet_name || null,
        designation_id: row.designation_id ?? null,
        designation_name: row.designation_name || null,
        /*
         * NAMED `current_salary`, NOT `salary`. `middlewares/sensitive.js`
         * strips keys called `salary` at any depth, so that name would delete
         * this object from the response for anybody without the B3 key -
         * silently, with no error to see. The same trap `getCurrentSalary`
         * documents.
         */
        current_salary: currentGross === null
          ? null
          : {
              salary_id: row.current_salary_id ?? null,
              monthly_gross: row.current_monthly_gross,
              effective_from: engine.toDateOnly(row.current_effective_from),
            },
        difference: differenceBetween(currentGross, proposedGross),
        own_proposal: ownProposal,
      };
    });
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Amend a PENDING proposal. Approved and rejected records are never edited. */
  async updatePendingSalary(salaryId, input = {}, actor = {}) {
    const existing = await this.salaryRepo.getById(salaryId);
    if (!existing) throw notFound(`Salary revision ${salaryId} was not found`);
    if (existing.status !== STATUS.PENDING) {
      throw validationError(
        `Only a pending salary revision can be changed; this one is ${existing.status.toLowerCase()}`
      );
    }

    const effectiveFrom = engine.toDateOnly(existing.effective_from);
    const lock = periodLock.checkLock(effectiveFrom);
    if (lock.locked) throw validationError(periodLock.blockedReason(effectiveFrom));

    /*
     * M4 — AN AMENDED REVISION STILL HAS TO SAY WHY.
     *
     * The source is the STORED one: amending cannot turn a revision into an
     * opening salary, so it cannot be a way around the rule either.
     *
     * An omitted `revision_reason` keeps whatever is on the record rather than
     * clearing it, so an amendment that only corrects a figure need not retype
     * the sentence. What it may NOT do is leave a revision with no reason at
     * all - including a pending row created before this column existed, which
     * is the one case where the stored value is null and the amendment is
     * asked to supply one.
     */
    const revisionReason = checkReasonLength(
      resolveRevisionReason(
        existing.source,
        input.revision_reason === undefined ? existing.revision_reason : input.revision_reason
      )
    );

    const calculated = await this.calculateForEmployee(existing.employee_id, {
      ...input,
      effective_from: effectiveFrom,
    });

    const row = this._toRow(
      existing.employee_id,
      effectiveFrom,
      existing.source,
      calculated,
      actor,
      revisionReason
    );
    // The identity of the row is not up for amendment: only its numbers are.
    delete row.employee_id;
    delete row.effective_from;
    delete row.source;
    delete row.status;
    delete row.created_by;

    /*
     * M4 review fix — THE AMENDMENT IS RECORDED AS AN AMENDMENT.
     *
     * This is the only path that changes a PENDING proposal, so it is the only
     * place `changed_by` and `changed_at` are ever written. The repository
     * stamps them in the same UPDATE that makes the change - the actor's
     * EMPLOYEE id, the same identity `created_by` holds, and the DATABASE's
     * clock for the time - so an amendment cannot happen without the record of
     * who made it.
     *
     * NULL ONLY WHEN THERE GENUINELY IS NO ACTOR. An actor with no employee id
     * is a system account; naming a number that is not an employee would be
     * worse than the honest blank.
     *
     * `updated_at` IS NOT THIS. It moves on approval and on rejection too,
     * which is precisely why the amendment needed its own two columns rather
     * than being read off the generic one.
     */
    const affected = await this.salaryRepo.updatePending(
      salaryId,
      row,
      actor.employeeId ?? null
    );
    if (affected === 0) {
      throw validationError("The salary revision was changed by somebody else; reload and try again");
    }
    return {
      salary_id: salaryId,
      status: STATUS.PENDING,
      revision_reason: revisionReason,
      changed_by: actor.employeeId ?? null,
      calculated,
    };
  }

  /**
   * NOBODY APPROVES THEIR OWN SALARY PROPOSAL — administrators excepted.
   *
   * `approve_salary_revision` says a person MAY approve salary revisions. It
   * does not say they may approve their own, and a four-eyes rule that exists
   * only as a convention is not a control: whoever holds both `add_salary` and
   * `approve_salary_revision` would otherwise be able to raise a pay change and
   * agree to it in the same minute, with the audit trail naming them twice and
   * flagging nothing.
   *
   * ENFORCED HERE, NOT IN THE ROUTE OR THE SCREEN. This is the only layer every
   * approval path goes through, and a rule that lives in route wiring is one
   * new endpoint away from not existing.
   *
   * THE EXCEPTION IS ADMIN, AND IT IS THE EXISTING ONE. `user_type = 2` already
   * bypasses every permission check in `middlewares/permissions.js`; this
   * honours that same bypass rather than inventing a second notion of
   * privilege. It is emphatically NOT a per-user override — there is no list of
   * people exempted from this rule, and M2 adds no mechanism for one.
   *
   * WHO "THEMSELVES" IS. `created_by` holds the actor's EMPLOYEE id, which is
   * what `_toRow` writes, so the comparison is employee identity against
   * employee identity. An actor with no employee id (a system account) cannot
   * have created the row, and a row with no `created_by` was not created by
   * anybody, so neither case collides.
   */
  _refuseSelfApproval(existing, actor) {
    if (isAdminActor(actor)) return;

    const creator = existing.created_by;
    const approver = actor.employeeId;
    if (creator === null || creator === undefined) return;
    if (approver === null || approver === undefined) return;
    if (Number(creator) !== Number(approver)) return;

    throw validationError(
      "You cannot approve a salary revision you created yourself; it needs a different approver"
    );
  }

  /** Approve a pending revision. */
  async approveSalary(salaryId, actor = {}) {
    const existing = await this.salaryRepo.getById(salaryId);
    if (!existing) throw notFound(`Salary revision ${salaryId} was not found`);
    if (existing.status !== STATUS.PENDING) {
      throw validationError(`This revision is already ${existing.status.toLowerCase()}`);
    }
    /*
     * Checked AFTER the record is known to be pending, so a second approval of
     * an already-approved row still reports the lifecycle state rather than
     * the authorship rule — the more specific answer for the caller.
     *
     * REJECTION IS DELIBERATELY NOT GUARDED. Refusing your own proposal
     * withdraws it; the rule this enforces is about agreeing to your own pay
     * change, and `rejectSalary` keeps the existing workflow exactly.
     */
    this._refuseSelfApproval(existing, actor);
    const affected = await this.salaryRepo.approve(salaryId, actor.employeeId ?? null);
    if (affected === 0) {
      throw validationError("The salary revision was changed by somebody else; reload and try again");
    }
    return { salary_id: salaryId, status: STATUS.APPROVED };
  }

  /** Reject a pending revision, with a required reason. */
  async rejectSalary(salaryId, reason, actor = {}) {
    const text = typeof reason === "string" ? reason.trim() : "";
    if (text === "") throw validationError("A reason is required to reject a salary revision");

    const existing = await this.salaryRepo.getById(salaryId);
    if (!existing) throw notFound(`Salary revision ${salaryId} was not found`);
    if (existing.status !== STATUS.PENDING) {
      throw validationError(`This revision is already ${existing.status.toLowerCase()}`);
    }
    const affected = await this.salaryRepo.reject(salaryId, actor.employeeId ?? null, text);
    if (affected === 0) {
      throw validationError("The salary revision was changed by somebody else; reload and try again");
    }
    return { salary_id: salaryId, status: STATUS.REJECTED };
  }
}

module.exports = (salaryRepo, options) => new EmployeeSalaryUsecase(salaryRepo, options);
module.exports.EmployeeSalaryUsecase = EmployeeSalaryUsecase;
module.exports.SOURCE = SOURCE;
module.exports.ADMIN_USER_TYPE = ADMIN_USER_TYPE;
module.exports.validationError = validationError;
module.exports.normalizeDate = normalizeDate;
module.exports.SOURCES_REQUIRING_REASON = SOURCES_REQUIRING_REASON;
module.exports.REASON_MAX_LENGTH = REASON_MAX_LENGTH;
module.exports.QUEUE_MAX_ROWS = QUEUE_MAX_ROWS;
module.exports.differenceBetween = differenceBetween;
