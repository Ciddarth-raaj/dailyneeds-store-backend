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
   * Create a salary record, always as PENDING.
   *
   * NOTHING IS EVER CREATED APPROVED, including by an administrator. Proposing
   * a salary and agreeing to it are two decisions with two permissions, and
   * collapsing them would make `approve_salary_revision` decorative — the
   * person who can add would already have approved by adding.
   */
  async createInitialSalary(employeeId, input = {}, actor = {}) {
    const employee = await this.salaryRepo.getStatutoryContext(employeeId);
    if (!employee) throw notFound(`Employee ${employeeId} was not found`);

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

    const source = existing ? SOURCE.REVISION : SOURCE.OPENING_SALARY;

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

    const row = this._toRow(employeeId, effectiveFrom, source, calculated, actor);
    const salaryId = await this.salaryRepo.create(row);

    return {
      salary_id: salaryId,
      employee_id: employeeId,
      status: STATUS.PENDING,
      source,
      effective_from: effectiveFrom,
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
  _toRow(employeeId, effectiveFrom, source, c, actor) {
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

    const calculated = await this.calculateForEmployee(existing.employee_id, {
      ...input,
      effective_from: effectiveFrom,
    });

    const row = this._toRow(existing.employee_id, effectiveFrom, existing.source, calculated, actor);
    // The identity of the row is not up for amendment: only its numbers are.
    delete row.employee_id;
    delete row.effective_from;
    delete row.source;
    delete row.status;
    delete row.created_by;

    const affected = await this.salaryRepo.updatePending(salaryId, row);
    if (affected === 0) {
      throw validationError("The salary revision was changed by somebody else; reload and try again");
    }
    return { salary_id: salaryId, status: STATUS.PENDING, calculated };
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
