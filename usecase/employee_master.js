const logger = require("../utils/logger");
const masterRepo = require("../repository/employee_master");
const {
  normaliseContact,
  normaliseDob,
  searchableNameTokens,
  rankCandidates,
} = require("../utils/duplicate_person");

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
  constructor(employeeMasterRepo, lifecycleUsecase, lifecycleRepo, aadhaarUsecase, workShiftLookup) {
    this.repo = employeeMasterRepo;
    // M1. Answers `getActiveWorkShift(id)` - the employee work shift
    // repository - so a create can refuse an unknown or inactive initial
    // shift the same way Employee Shift Assignment does. Optional: without
    // it, a create that names a shift is refused rather than trusted.
    this.workShifts = workShiftLookup || null;
    this.lifecycle = lifecycleUsecase;
    this.lifecycleRepo = lifecycleRepo;
    // Optional: a deployment with no Aadhaar keys configured still creates
    // employees, it just cannot attach an identity.
    this.aadhaar = aadhaarUsecase || null;
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
    // A key present with no value is not a value. The route's schema strips
    // these, but a direct caller - the rehearsal, a script - may pass
    // `employee_name: undefined` meaning "take it from the Aadhaar", and that
    // must not become an INSERT of NULL into a NOT NULL column.
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
    for (const f of LIFECYCLE_CONTROLLED_FIELDS) delete fields[f];
    // The lifecycle owns these two, and sets them to exactly this.
    fields.date_of_joining = joinedOn;
    fields.status = STATUS.ACTIVE;
    fields.resignation_date = null;

    // M1. The initial shift is the NEW master's id, checked before anything
    // is written. `null` means "not chosen" and is not stored as a value.
    if (fields.default_work_shift_id === null) delete fields.default_work_shift_id;
    if (fields.default_work_shift_id !== undefined) {
      await this._requireActiveWorkShift(fields.default_work_shift_id);
    }

    const verificationId = input.aadhaar_verification_id;
    if (verificationId !== undefined && verificationId !== null && !this.aadhaar) {
      throw new ValidationError("Aadhaar verification is not configured on this server");
    }
    delete fields.aadhaar_verification_id;

    return this.repo.withTransaction(async (tx) => {
      // The verified demographics are read BEFORE the insert and fill only the
      // fields HR left blank. `employee_name` is NOT NULL, so filling it after
      // the insert would be too late; and the allowlist is the Aadhaar layer's
      // own, so a provider payload still cannot reach a designation, a store,
      // a salary or a status.
      let prefilled = [];
      if (verificationId !== undefined && verificationId !== null) {
        const preview = await this.aadhaar.previewDemographics(verificationId);
        for (const [key, value] of Object.entries(preview)) {
          const supplied = fields[key] !== undefined && fields[key] !== null && String(fields[key]).trim() !== "";
          if (!supplied) {
            fields[key] = value;
            prefilled.push(key);
          }
        }
      }

      const employeeId = await this.repo.createEmployee(tx, fields);

      // The Aadhaar identity is written INSIDE this transaction, so an
      // employee cannot exist with a half-attached identity, and a duplicate
      // caught under the unique fingerprint rolls the whole create back
      // rather than leaving a stray employee behind.
      let aadhaar = null;
      if (verificationId !== undefined && verificationId !== null) {
        const attached = await this.aadhaar.attachToEmployee(tx, verificationId, employeeId, {
          actorEmployeeId,
        });
        // Anything the pre-fill above did not already apply - a field the
        // locked row turns out to carry that the preview did not - is applied
        // here, through the same allowlist.
        const demographic = attached.demographic_fields || {};
        const applicable = Object.keys(demographic).filter(
          (k) => !prefilled.includes(k) && (fields[k] === undefined || fields[k] === null || String(fields[k]).trim() === "")
        );
        if (applicable.length) {
          await this.repo.updateEmployee(
            tx,
            employeeId,
            Object.fromEntries(applicable.map((k) => [k, demographic[k]]))
          );
        }
        aadhaar = {
          aadhaar_last4: attached.aadhaar_last4,
          verified_at: attached.verified_at,
          verification_id: verificationId,
          demographic_fields_applied: [...prefilled, ...applicable],
        };
      }

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
        aadhaar,
        // "Skip for now" is not an error state and not a separate code path -
        // it is simply this employee having no Aadhaar yet. Nothing was
        // written to say so.
        aadhaar_status: aadhaar ? "VERIFIED" : "PENDING",
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
  /** Refuses a `default_work_shift_id` that is not an active work shift. */
  async _requireActiveWorkShift(workShiftId) {
    const id = Number(workShiftId);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ValidationError("default_work_shift_id must be a work shift id");
    }
    if (!this.workShifts || typeof this.workShifts.getActiveWorkShift !== "function") {
      throw new ValidationError("Work shift assignment is not configured on this server");
    }
    const shift = await this.workShifts.getActiveWorkShift(id);
    if (!shift) throw new ValidationError(`work shift ${id} does not exist`, 404);
    if (!Number(shift.active)) {
      throw new ValidationError("That work shift is inactive and cannot be assigned");
    }
    return shift;
  }

  /**
   * M1. Stage 4 of onboarding: the education columns, written by the same
   * `employee_create` holder who just created the employee. Restricted to
   * the three education fields here as well as at the route, so a direct
   * caller cannot reach the ordinary editor through the onboarding key.
   */
  async saveOnboardingEducation(employeeId, input, { actorEmployeeId = null } = {}) {
    const patch = {};
    for (const f of ["qualification", "additional_course", "previous_experience"]) {
      if (input && input[f] !== undefined) patch[f] = input[f] === null ? "" : String(input[f]);
    }
    if (Object.keys(patch).length === 0) throw new ValidationError("nothing to change");
    return this.editEmployee(employeeId, patch, { actorEmployeeId });
  }

  async editEmployee(employeeId, patch, { actorEmployeeId = null } = {}) {
    const offered = Object.keys(patch || {});
    const forbidden = offered.filter((k) => LIFECYCLE_CONTROLLED_FIELDS.includes(k));
    if (forbidden.length) {
      throw new ValidationError(
        `${forbidden.join(", ")} cannot be changed here. employee_id is permanent; status and ` +
          `resignation_date are set by the create, resign and rejoin actions; a wrongly recorded ` +
          `date_of_joining is corrected through the joining-date action.`
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
  /*  correct joining date                                                */
  /* ==================================================================== */
  /**
   * HR corrects a joining date that was typed wrongly. Behind `employee_edit`
   * at the route - the same user-based right as the rest of the employee
   * record - but deliberately NOT part of `editEmployee`: the date describes
   * the CURRENT employment period as well as the master row, so C1c moves
   * the period's date in the same transaction and records the change as a
   * `period_corrected` event with the old and new value. Nothing here opens
   * or closes a period; the reconciler is not called.
   *
   * This layer checks the date's shape, that it is not in the future, and
   * that it is not after a recorded resignation. The period-ordering rules
   * (not after the spell's own end, after the previous spell ended) belong
   * to C1c and are applied there.
   */
  async correctJoiningDate(employeeId, input, { actorEmployeeId = null } = {}) {
    const joinedOn = effectiveDate(input && input.date_of_joining, "date_of_joining");
    rejectFutureDate(joinedOn, "date_of_joining");

    return this.repo.withTransaction(async (tx) => {
      const employee = await this.repo.lockEmployee(tx, employeeId);
      if (!employee) throw new NotFoundError(`employee ${employeeId} does not exist`);

      const resignedOn = dateOnly(employee.resignation_date);
      if (Number(employee.status) !== STATUS.ACTIVE && resignedOn !== null && joinedOn > resignedOn) {
        throw new ValidationError(`date_of_joining '${joinedOn}' is after the resignation date '${resignedOn}'`);
      }

      const current = await this.lifecycleRepo.getLatestPeriod(tx, employeeId);
      if (current && dateOnly(current.joined_on) === joinedOn && dateOnly(employee.date_of_joining) === joinedOn) {
        throw new ValidationError("nothing to change");
      }

      // The row is locked above, so a 0 here only means the master already
      // held this date and the period did not - which is exactly a mismatch
      // this action exists to repair.
      await this.repo.setJoiningDate(tx, employeeId, joinedOn);

      const period = await this.lifecycle.correctJoinedOn(employeeId, joinedOn, { tx, actorEmployeeId });

      this._log(logger.LEVEL.INFO, "JOINING-DATE", `employee ${employeeId} joining date corrected to ${joinedOn}`, {
        employeeId,
        actorEmployeeId,
        previousJoinedOn: period.previous_joined_on,
      });
      return {
        code: 200,
        employee_id: employeeId,
        period_no: period.period_no,
        previous_joined_on: period.previous_joined_on,
        joined_on: joinedOn,
        needs_review: period.needs_review,
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
  /*  Aadhaar, after the fact                                             */
  /* ==================================================================== */
  /**
   * Attaches a verified Aadhaar to an employee who already exists.
   *
   * This is the other half of "Skip for now". An employee created without an
   * Aadhaar is a complete employee - they can be paid, rostered and resigned -
   * and their Aadhaar can arrive a week or a year later. It attaches to the
   * SAME permanent employee_id; nothing here creates an employee.
   *
   * The duplicate check runs again, under the same unique index Create uses,
   * so an Aadhaar can never end up on two employee_ids by coming in through
   * this door instead.
   */
  async attachAadhaar(employeeId, input, { actorEmployeeId = null } = {}) {
    if (!this.aadhaar) throw new ValidationError("Aadhaar verification is not configured on this server");
    const verificationId = input && input.aadhaar_verification_id;
    if (verificationId === undefined || verificationId === null) {
      throw new ValidationError("aadhaar_verification_id is required");
    }

    return this.repo.withTransaction(async (tx) => {
      const employee = await this.repo.lockEmployee(tx, employeeId);
      if (!employee) throw new NotFoundError(`employee ${employeeId} does not exist`);

      const already = await this.aadhaar.getIdentity(employeeId);
      if (already) {
        throw new ConflictError(
          `employee ${employeeId} already has a verified Aadhaar on record (ending ${already.aadhaar_last4}). ` +
            "Nothing was changed."
        );
      }

      // Throws a ConflictError carrying `existing_employee_id` when this
      // Aadhaar belongs to somebody else - the fingerprint is unique, and the
      // check runs inside this transaction under that index.
      const attached = await this.aadhaar.attachToEmployee(tx, verificationId, employeeId, {
        actorEmployeeId,
      });

      // The verified demographics fill only what is still blank. An employee
      // who has been working for a year has a name, a date of birth and an
      // address that HR has since corrected; a KYC payload does not overwrite
      // them.
      const demographic = attached.demographic_fields || {};
      const applicable = Object.keys(demographic).filter((k) => {
        const current = employee[k];
        return current === undefined || current === null || String(current).trim() === "";
      });
      if (applicable.length) {
        await this.repo.updateEmployee(
          tx,
          employeeId,
          Object.fromEntries(applicable.map((k) => [k, demographic[k]]))
        );
      }

      this._log(logger.LEVEL.INFO, "AADHAAR-ATTACHED", `employee ${employeeId}: Aadhaar attached after creation`, {
        employeeId,
        actorEmployeeId,
      });

      return {
        code: 200,
        employee_id: employeeId,
        aadhaar_status: "VERIFIED",
        aadhaar: {
          aadhaar_last4: attached.aadhaar_last4,
          verified_at: attached.verified_at,
          verification_id: verificationId,
          demographic_fields_applied: applicable,
        },
      };
    });
  }

  /**
   * VERIFIED or PENDING, derived - never stored.
   *
   * There is no "Aadhaar pending" row anywhere, because a pending Aadhaar is
   * the ABSENCE of one. Writing a placeholder verification row for every
   * employee who skipped would mean a table of rows that verify nothing, and
   * an existing employee who never had an Aadhaar would need one backfilled.
   * Deriving it means the 630 employees already in the master answer PENDING
   * correctly today, with no migration and no invented data.
   */
  async getAadhaarStatus(employeeId) {
    const header = await this.repo.getEmployeeHeader(employeeId);
    if (!header) throw new NotFoundError(`employee ${employeeId} does not exist`);
    if (!this.aadhaar) {
      return {
        employee_id: header.employee_id,
        employee_name: header.employee_name,
        aadhaar_status: "PENDING",
        aadhaar_last4: null,
        verified_at: null,
        can_verify_now: false,
        message: "Aadhaar verification is not configured on this server.",
      };
    }

    const identity = await this.aadhaar.getIdentity(employeeId);
    if (!identity) {
      return {
        employee_id: header.employee_id,
        employee_name: header.employee_name,
        aadhaar_status: "PENDING",
        aadhaar_last4: null,
        verified_at: null,
        can_verify_now: true,
        message: "No Aadhaar on record. It can be verified at any time and attached to this employee.",
      };
    }
    return {
      employee_id: header.employee_id,
      employee_name: header.employee_name,
      aadhaar_status: "VERIFIED",
      aadhaar_last4: identity.aadhaar_last4,
      verified_at: identity.verified_at || null,
      can_verify_now: false,
      message: `Aadhaar ending ${identity.aadhaar_last4} is verified against this employee.`,
    };
  }

  /* ==================================================================== */
  /*  the pre-create duplicate warning                                    */
  /* ==================================================================== */
  /**
   * "Have we got this person already?", for a create with no Aadhaar.
   *
   * ADVISORY ONLY. It returns what it found and a suggested action; it never
   * merges, never rejoins, and never prevents a create. HR reviews and
   * decides, which is why the response is shaped for a screen rather than for
   * a branch.
   */
  async findPossibleDuplicates(input, { limit = 25 } = {}) {
    const name = input && input.employee_name ? String(input.employee_name) : "";
    const contact = normaliseContact(input && input.primary_contact_number);
    const dob = normaliseDob(input && input.dob);
    const tokens = searchableNameTokens(name);

    if (!contact && !dob && tokens.length === 0) {
      throw new ValidationError(
        "at least one of employee_name, primary_contact_number or dob is needed to check for duplicates"
      );
    }

    const candidates = await this.repo.findPossibleDuplicates(
      { name_tokens: tokens, contact, dob },
      limit
    );
    const matches = rankCandidates({ employee_name: name, primary_contact_number: contact, dob }, candidates);
    const inactive = matches.filter((m) => !m.is_active);

    return {
      code: 200,
      searched_on: {
        employee_name: name || null,
        // Whether a mobile was searched, never the number back again.
        primary_contact_number: contact ? true : false,
        dob: dob ? true : false,
      },
      possible_duplicates: matches.length > 0,
      // Always false. Said explicitly so C3 cannot mistake this for a gate.
      blocking: false,
      count: matches.length,
      suggested_action: inactive.length ? "rejoin" : matches.length ? "review" : "create",
      message: matches.length
        ? "Possible existing employee found. Review before creating a new employee ID."
        : "No possible duplicate found.",
      matches,
    };
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

module.exports = (employeeMasterRepo, lifecycleUsecase, lifecycleRepo, aadhaarUsecase, workShiftLookup) =>
  new EmployeeMasterUsecase(employeeMasterRepo, lifecycleUsecase, lifecycleRepo, aadhaarUsecase, workShiftLookup);
module.exports.EmployeeMasterUsecase = EmployeeMasterUsecase;
module.exports.effectiveDate = effectiveDate;
module.exports.rejectFutureDate = rejectFutureDate;
module.exports.ValidationError = ValidationError;
module.exports.ConflictError = ConflictError;
module.exports.NotFoundError = NotFoundError;
