const logger = require("../utils/logger");
const masterRepo = require("../repository/employee_master");

const { EDITABLE_FIELDS, SECURITY_RELEVANT_FIELDS, LIFECYCLE_CONTROLLED_FIELDS, STATUS } = masterRepo;

/**
 * Stage 0C / C2 — HR owns the employee lifecycle locally.
 *
 * Four actions: create, edit, resign, rejoin. Between them they produce
 *
 *   join -> resign -> rejoin -> resign -> rejoin
 *
 * as periods 1, 2, 3 under one permanent `employee_id`.
 *
 * C1c IS THE ONLY LIFECYCLE ENGINE. Not one rule about periods is restated
 * here. Each action changes `new_employee` and then calls
 * `employeeLifecycleUsecase.reconcileEmployee(id, { tx })` on its own
 * transaction; the reconciler reads the master exactly as it would after a
 * sync and decides what the periods should be. If C1c's rules change, these
 * actions change with them, because they never had a copy.
 *
 * ONE LOGICAL OPERATION. The master change, the period change, the lifecycle
 * event, the supporting resignation row and the session cutoff all run inside
 * one transaction on one connection. There is no window in which an employee
 * is marked inactive but their period is still open.
 *
 * NO DATE IS EVER INVENTED. Every action takes its effective date from the
 * caller. `today`, `created_at` and `updated_at` are not read.
 */

/** Actions the reconciler may legitimately take for each HR action. */
const EXPECTED = {
  create: ["open_initial"],
  resign: ["close"],
  rejoin: ["open_rejoin"],
};

class ValidationError extends Error {
  constructor(message, code = 422) {
    super(message);
    this.name = "ValidationError";
    this.httpCode = code;
  }
}
class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
    this.httpCode = 409;
  }
}
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.httpCode = 404;
  }
}

/**
 * An effective date, as YYYY-MM-DD. Deliberately strict: HR actions supply a
 * date explicitly, so there is no reason to accept the loose historical
 * formats that `new_employee.date_of_joining` carries, and every reason not
 * to guess at an ambiguous one.
 */
function effectiveDate(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new ValidationError(`${label} is required`);
  }
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ValidationError(`${label} must be an exact calendar date as YYYY-MM-DD, not '${text}'`);
  }
  const d = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) {
    throw new ValidationError(`${label} '${text}' is not a real calendar date`);
  }
  return text;
}

/** Today in UTC, used only to reject a future date - never as a date itself. */
const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * C2 has no scheduler. A transition dated in the future would either have to
 * be applied now - which would be a lie - or held somewhere until it came
 * due, which is machinery this system does not have. It is refused, clearly.
 */
function rejectFutureDate(date, label) {
  if (date > todayUtc()) {
    throw new ValidationError(
      `${label} '${date}' is in the future. C2 applies a transition immediately and has no ` +
        `scheduler, so a future-dated change cannot be recorded honestly. Submit it on or after the day it takes effect.`
    );
  }
}

const dateOnly = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const t = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
};

class EmployeeMasterUsecase {
  /**
   * `lifecycleUsecase` is C1c. `lifecycleRepo` is C1c's repository, used for
   * exactly two things this layer cannot do without duplicating it: reading
   * the newest period to validate a date against, and filling a previously
   * unknown end date through C1c's own NULL-only path.
   */
  constructor(employeeMasterRepo, lifecycleUsecase, lifecycleRepo) {
    this.repo = employeeMasterRepo;
    this.lifecycle = lifecycleUsecase;
    this.lifecycleRepo = lifecycleRepo;
  }

  _log(level, code, description, ref = {}) {
    logger.Log({
      level,
      component: "USECASE.EMPLOYEE_MASTER",
      code: `USECASE.EMPLOYEE_MASTER.${code}`,
      description,
      category: "",
      ref,
    });
  }

  /**
   * Runs the reconciler on the caller's transaction and insists it did what
   * the action implies. A create that produced anything but a new open period
   * is a bug, and the transaction is rolled back rather than committed half
   * right.
   */
  async _reconcile(tx, employeeId, action, actorEmployeeId) {
    const outcome = await this.lifecycle.reconcileEmployee(employeeId, { tx, actorEmployeeId });
    const allowed = EXPECTED[action];
    if (allowed && !allowed.includes(outcome.action)) {
      throw new ConflictError(
        `lifecycle reconciliation did not perform the expected '${allowed.join("/")}' for employee ` +
          `${employeeId}; it reported '${outcome.action}'. Nothing has been committed.`
      );
    }
    return outcome;
  }

  /** Stage 0A revocation, inside the transaction, when C1c says one is owed. */
  async _revokeIfOwed(tx, outcome) {
    if (outcome && outcome.revocationOwedFor) {
      await this.repo.bumpTokenValidFrom(tx, outcome.revocationOwedFor);
      return true;
    }
    return false;
  }

  /* ==================================================================== */
  /*  create                                                              */
  /* ==================================================================== */
  /**
   * A new local hire. The joining date is REQUIRED: the 425 historical rows
   * with no joining date are grandfathered data, not a precedent, and an
   * employee created from here on must be dateable.
   *
   * A login is NOT created. Stage 0A keeps account provisioning separate and
   * secure; C2 does not generate a credential as a side effect of an HR
   * record existing.
   */
  async createEmployee(input, { actorEmployeeId = null } = {}) {
    const joinedOn = effectiveDate(input.date_of_joining, "date_of_joining");
    rejectFutureDate(joinedOn, "date_of_joining");

    const fields = { ...input };
    for (const f of LIFECYCLE_CONTROLLED_FIELDS) delete fields[f];
    // The lifecycle owns these two, and sets them to exactly this.
    fields.date_of_joining = joinedOn;
    fields.status = STATUS.ACTIVE;
    fields.resignation_date = null;

    return this.repo.withTransaction(async (tx) => {
      const employeeId = await this.repo.createEmployee(tx, fields);
      const outcome = await this._reconcile(tx, employeeId, "create", actorEmployeeId);
      const periods = await this.lifecycleRepo.getLatestPeriod(tx, employeeId);

      this._log(logger.LEVEL.INFO, "CREATE", `employee ${employeeId} created, period 1 opened`, {
        employeeId,
        actorEmployeeId,
      });
      return {
        code: 200,
        employee_id: employeeId,
        lifecycle_action: outcome.action,
        period: periods ? { period_no: periods.period_no, period_state: periods.period_state } : null,
      };
    });
  }

  /* ==================================================================== */
  /*  edit                                                                */
  /* ==================================================================== */
  /**
   * Ordinary HR fields only. `employee_id`, `status` and the lifecycle dates
   * are rejected by name rather than silently dropped, so a caller that tries
   * to resign somebody through the edit form is told to use the right action.
   *
   * Changing designation or store changes what an existing token may do - the
   * auth middleware reads both from the session, and the permission cache is
   * keyed on designation - so those edits revoke the employee's sessions
   * through the Stage 0A cutoff.
   */
  async editEmployee(employeeId, patch, { actorEmployeeId = null } = {}) {
    const offered = Object.keys(patch || {});
    const forbidden = offered.filter((k) => LIFECYCLE_CONTROLLED_FIELDS.includes(k));
    if (forbidden.length) {
      throw new ValidationError(
        `${forbidden.join(", ")} cannot be changed here. employee_id is permanent; status, ` +
          `date_of_joining and resignation_date are set by the create, resign and rejoin actions.`
      );
    }
    const unknown = offered.filter((k) => !EDITABLE_FIELDS.includes(k));
    if (unknown.length) throw new ValidationError(`not an editable employee field: ${unknown.join(", ")}`);
    if (offered.length === 0) throw new ValidationError("nothing to change");

    return this.repo.withTransaction(async (tx) => {
      const before = await this.repo.lockEmployee(tx, employeeId);
      if (!before) throw new NotFoundError(`employee ${employeeId} does not exist`);

      const securityRelevant = offered.filter(
        (k) => SECURITY_RELEVANT_FIELDS.includes(k) && String(patch[k]) !== String(before[k])
      );

      const changed = await this.repo.updateEmployee(tx, employeeId, patch);

      let sessionsRevoked = false;
      if (securityRelevant.length > 0) {
        await this.repo.bumpTokenValidFrom(tx, employeeId);
        sessionsRevoked = true;
        this._log(
          logger.LEVEL.INFO,
          "EDIT-REVOKED",
          `employee ${employeeId}: ${securityRelevant.join(", ")} changed, sessions revoked`,
          { employeeId, securityRelevant }
        );
      }

      // No lifecycle transition: an edit does not move anybody between
      // periods. The reconciler is not called, and must not be - calling it
      // would be asking it to react to a change it has no opinion about.
      return {
        code: 200,
        employee_id: employeeId,
        fields_changed: offered,
        rows_changed: changed,
        security_relevant: securityRelevant,
        sessions_revoked: sessionsRevoked,
      };
    });
  }

  /* ==================================================================== */
  /*  resign                                                              */
  /* ==================================================================== */
  async resignEmployee(employeeId, input, { actorEmployeeId = null } = {}) {
    const endedOn = effectiveDate(input.resignation_date, "resignation_date");
    rejectFutureDate(endedOn, "resignation_date");

    return this.repo.withTransaction(async (tx) => {
      const employee = await this.repo.lockEmployee(tx, employeeId);
      if (!employee) throw new NotFoundError(`employee ${employeeId} does not exist`);
      if (Number(employee.status) !== STATUS.ACTIVE) {
        throw new ConflictError(`employee ${employeeId} is not currently active`);
      }

      const current = await this.lifecycleRepo.getLatestPeriod(tx, employeeId);
      if (!current || current.period_state !== "open") {
        throw new ConflictError(
          `employee ${employeeId} has no open employment period to close; the lifecycle data ` +
            `disagrees with the master and must be reviewed before a resignation is recorded.`
        );
      }
      const joinedOn = dateOnly(current.joined_on);
      if (joinedOn !== null && endedOn < joinedOn) {
        throw new ValidationError(
          `resignation_date '${endedOn}' precedes the current period's joining date '${joinedOn}'`
        );
      }

      const affected = await this.repo.markResigned(tx, employeeId, endedOn);
      if (affected === 0) throw new ConflictError(`employee ${employeeId} was changed concurrently`);

      const outcome = await this._reconcile(tx, employeeId, "resign", actorEmployeeId);
      const sessionsRevoked = await this._revokeIfOwed(tx, outcome);

      // The supporting record, linked to both the employee and the period it
      // belongs to, because for a resignation C2 performed itself both are
      // known. Old ambiguous name-keyed rows are never touched.
      let resignationId = null;
      if (input.reason_type) {
        resignationId = await this.repo.createResignationRecord(tx, {
          employee_id: employeeId,
          period_id: current.period_id,
          employee_name: employee.employee_name,
          reason: input.reason || input.reason_type,
          reason_type: input.reason_type,
          resignation_date: endedOn,
        });
      }

      this._log(logger.LEVEL.INFO, "RESIGN", `employee ${employeeId} resigned on ${endedOn}`, {
        employeeId,
        actorEmployeeId,
      });
      return {
        code: 200,
        employee_id: employeeId,
        lifecycle_action: outcome.action,
        closed_period_no: current.period_no,
        ended_on: endedOn,
        resignation_id: resignationId,
        sessions_revoked: sessionsRevoked,
      };
    });
  }

  /* ==================================================================== */
  /*  rejoin                                                              */
  /* ==================================================================== */
  /**
   * The same person, the same `employee_id`, a new period.
   *
   * C1c will only accept a joining date it can tell apart from the previous
   * spell's, which means the previous period's `ended_on` must be known. For
   * 93 historical periods it is not. Rather than let the rejoin open with no
   * joining date - silently losing the date HR just typed - the action either
   * takes `previous_ended_on` from the caller and fills that gap through
   * C1c's own NULL-only path, or refuses and says which date is missing.
   * Nothing is guessed either way.
   */
  async rejoinEmployee(employeeId, input, { actorEmployeeId = null } = {}) {
    const joinedOn = effectiveDate(input.date_of_joining, "date_of_joining");
    rejectFutureDate(joinedOn, "date_of_joining");

    return this.repo.withTransaction(async (tx) => {
      const employee = await this.repo.lockEmployee(tx, employeeId);
      if (!employee) throw new NotFoundError(`employee ${employeeId} does not exist`);
      if (Number(employee.status) === STATUS.ACTIVE) {
        throw new ConflictError(`employee ${employeeId} is already active`);
      }

      const previous = await this.lifecycleRepo.getLatestPeriod(tx, employeeId);
      if (!previous) throw new ConflictError(`employee ${employeeId} has no employment history to rejoin from`);
      if (previous.period_state !== "closed") {
        throw new ConflictError(
          `employee ${employeeId}'s latest period (${previous.period_no}) is still open; it must be ` +
            `closed by a resignation before a rejoin can be recorded.`
        );
      }

      // The previous spell's end must be known for the new date to be judged
      // against it. HR may supply it here if it was never recorded.
      let previousEnded = dateOnly(previous.ended_on);
      let filledPreviousEnd = null;
      if (previousEnded === null) {
        if (input.previous_ended_on === undefined || input.previous_ended_on === null) {
          throw new ValidationError(
            `employee ${employeeId}'s previous period (${previous.period_no}) has no recorded end date, ` +
              `so a rejoin date cannot be checked against it. Supply 'previous_ended_on' with the date that ` +
              `employment actually ended, or resolve the period from the review queue first.`
          );
        }
        previousEnded = effectiveDate(input.previous_ended_on, "previous_ended_on");
        rejectFutureDate(previousEnded, "previous_ended_on");
        const prevJoined = dateOnly(previous.joined_on);
        if (prevJoined !== null && previousEnded < prevJoined) {
          throw new ValidationError(
            `previous_ended_on '${previousEnded}' precedes that period's joining date '${prevJoined}'`
          );
        }
        // C1c's own fill: it writes only where the column is still NULL, so
        // a known historical end date can never be overwritten from here.
        const filled = await this.lifecycleRepo.fillNullDate(tx, previous.period_id, "ended_on", previousEnded, {
          needs_review: dateOnly(previous.joined_on) === null,
          actor_employee_id: actorEmployeeId,
        });
        if (filled === 0) throw new ConflictError("the previous period's end date was set concurrently");
        filledPreviousEnd = previousEnded;
      }

      if (joinedOn <= previousEnded) {
        throw new ValidationError(
          `date_of_joining '${joinedOn}' must be after the previous period ended on '${previousEnded}'`
        );
      }

      const affected = await this.repo.markRejoined(tx, employeeId, joinedOn);
      if (affected === 0) throw new ConflictError(`employee ${employeeId} was changed concurrently`);

      const outcome = await this._reconcile(tx, employeeId, "rejoin", actorEmployeeId);
      const sessionsRevoked = await this._revokeIfOwed(tx, outcome);
      const opened = await this.lifecycleRepo.getLatestPeriod(tx, employeeId);

      this._log(logger.LEVEL.INFO, "REJOIN", `employee ${employeeId} rejoined on ${joinedOn}`, {
        employeeId,
        actorEmployeeId,
      });
      return {
        code: 200,
        employee_id: employeeId,
        lifecycle_action: outcome.action,
        new_period_no: opened ? opened.period_no : null,
        joined_on: joinedOn,
        filled_previous_ended_on: filledPreviousEnd,
        sessions_revoked: sessionsRevoked,
      };
    });
  }

  /* ==================================================================== */
  /*  reads                                                               */
  /* ==================================================================== */
  async getLifecycleHistory(employeeId) {
    const header = await this.repo.getEmployeeHeader(employeeId);
    if (!header) throw new NotFoundError(`employee ${employeeId} does not exist`);
    const [periods, events] = await Promise.all([
      this.repo.getPeriods(employeeId),
      this.repo.getEvents(employeeId),
    ]);
    return {
      employee_id: header.employee_id,
      employee_name: header.employee_name,
      status: Number(header.status),
      is_active: Number(header.status) === STATUS.ACTIVE,
      current: {
        date_of_joining: header.date_of_joining,
        resignation_date: header.resignation_date,
        store_id: header.store_id,
        outlet_nickname: header.outlet_nickname,
        designation_id: header.designation_id,
        designation_name: header.designation_name,
        department_id: header.department_id,
        department_name: header.department_name,
        shift_id: header.shift_id,
      },
      periods,
      events,
    };
  }

  async getReviewList(options) {
    const [items, total] = await Promise.all([
      this.repo.getReviewList(options),
      this.repo.countReviewList(),
    ]);
    return { total, count: items.length, items };
  }
}

module.exports = (employeeMasterRepo, lifecycleUsecase, lifecycleRepo) =>
  new EmployeeMasterUsecase(employeeMasterRepo, lifecycleUsecase, lifecycleRepo);
module.exports.EmployeeMasterUsecase = EmployeeMasterUsecase;
module.exports.effectiveDate = effectiveDate;
module.exports.rejectFutureDate = rejectFutureDate;
module.exports.ValidationError = ValidationError;
module.exports.ConflictError = ConflictError;
module.exports.NotFoundError = NotFoundError;
