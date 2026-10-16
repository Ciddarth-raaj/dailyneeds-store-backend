const {
  FNF_COMPONENTS,
  FNF_COMPONENT_BY_KEY,
  FNF_AMOUNT_MAX,
  FNF_REMARKS_MAX,
  PAYMENT_MODE,
  SETTLEMENT_REFERENCE_MAX,
  SETTLEMENT_REASON_MAX,
  EXIT_REASON,
  INTERVIEW_RATINGS,
  YES_NO,
  INTERVIEW_TEXT_MAX,
  REHIRE_ELIGIBILITY,
  REHIRE_NOTE_MAX,
} = require("../constants/fnf");
const { isExitMonth, settlementStage, dateOnly } = require("../utils/fnf");
const { monthWindow } = require("../utils/payrun_eligibility");
const { istToday } = require("../utils/istDate");

/**
 * FULL & FINAL SETTLEMENT, EXIT INTERVIEW AND REHIRE ELIGIBILITY.
 *
 * ======================================= WHAT THIS DOES NOT DO ===========
 *
 * IT CALCULATES NO PAYROLL. The F&F month is calculated, approved, locked
 * and published by the ordinary payrun (`usecase/payrun_calculation.js`):
 * salary days, OT (approved only), PF, ESI, adjustments - advance recovery
 * included - and the F&F items entered here all go through the one engine.
 * This usecase records the F&F items, reports where each exit's settlement
 * stands, records that a published F&F was paid, and keeps the confidential
 * exit interview and rehire assessments.
 *
 * IT NEVER CHANGES AN APPROVED OR PUBLISHED MONTH. Items are refused under
 * the calculation row's lock once the month is Approved & Locked; Settle only
 * records a fact about the published figures; Unlock / Unpublish of a SETTLED
 * month is refused by the payroll lifecycle itself.
 */

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.name = "NotFoundError";
  return err;
}

function conflict(message) {
  const err = new Error(message);
  err.name = "ConflictError";
  err.status = 409;
  return err;
}

const toMoney = (value) => (value === null || value === undefined ? null : Number(value));

/** A rupee amount with at most two decimals, inside the accepted range; null clears. */
function normalizeAmount(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > FNF_AMOUNT_MAX) {
    throw validationError(`${label} must be between 0 and ${FNF_AMOUNT_MAX}`);
  }
  if (Math.round(n * 100) !== Math.round(n * 100 * 1e6) / 1e6) {
    throw validationError(`${label} may have at most two decimals`);
  }
  // ZERO IS "NONE", as an Adjustment's zero is: it clears the line.
  return n === 0 ? null : Math.round(n * 100) / 100;
}

const textOrNull = (value, max, label) => {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  if (t === "") return null;
  if (t.length > max) throw validationError(`${label} may be at most ${max} characters`);
  return t;
};

class EmployeeExitUsecase {
  constructor(repo, { today = istToday } = {}) {
    this.repo = repo;
    this.today = today;
  }

  _month(year, month) {
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) throw validationError("A valid month is required");
    return { year: y, month: m, ...monthWindow(y, m) };
  }

  /* ============================================================ F&F list */

  /**
   * EVERY EXIT IN THE MONTH and where its F&F stands. Exits payroll has
   * already initialized come with their stored status and figures; exits it
   * has not reached yet are listed as NOT_IN_PAYROLL so nobody is forgotten.
   */
  async getMonth({ year, month, store_ids = null }) {
    const p = this._month(year, month);
    const [inPayroll, outside] = await Promise.all([
      this.repo.listMonthPayrunExits({ ...p, store_ids }),
      this.repo.listMonthUninitializedExits({ ...p, store_ids }),
    ]);
    const rows = inPayroll.map((r) => {
      const published = r.calc_stored_status === "APPROVED_LOCKED" && Boolean(r.published_at);
      const calcStatus = published ? "PUBLISHED" : r.calc_stored_status || null;
      return {
        employee_id: Number(r.employee_id),
        employee_name: r.employee_name,
        location: r.store_name,
        designation_name: r.designation_name,
        exit_date: r.exit_date,
        initialized: true,
        calculated: Boolean(r.payrun_calculation_id),
        calc_status: calcStatus,
        net_pay: toMoney(r.net_pay),
        fnf_additions: toMoney(r.fnf_additions),
        fnf_deductions: toMoney(r.fnf_deductions),
        document_type: r.document_type || null,
        settlement_id: r.fnf_settlement_id ? Number(r.fnf_settlement_id) : null,
        settlement_status: r.settlement_status || "PENDING",
        settled_net_amount: toMoney(r.settled_net_amount),
        payment_mode: r.payment_mode || null,
        payment_reference: r.payment_reference || null,
        paid_on: r.paid_on || null,
        settled_at: r.settled_at || null,
        warning: null,
        ...settlementStage({ settlement_status: r.settlement_status, initialized: true, calc_status: calcStatus }),
      };
    });
    outside.forEach((r) => {
      rows.push({
        employee_id: Number(r.employee_id),
        employee_name: r.employee_name,
        location: null,
        designation_name: null,
        exit_date: r.exit_date,
        initialized: false,
        calculated: false,
        calc_status: null,
        net_pay: null,
        fnf_additions: null,
        fnf_deductions: null,
        document_type: null,
        settlement_id: r.fnf_settlement_id ? Number(r.fnf_settlement_id) : null,
        settlement_status: r.settlement_status || "PENDING",
        settled_net_amount: toMoney(r.settled_net_amount),
        payment_mode: r.payment_mode || null,
        payment_reference: r.payment_reference || null,
        paid_on: r.paid_on || null,
        settled_at: r.settled_at || null,
        /*
         * INITIALIZED BEFORE THE RESIGNATION WAS RECORDED: the payrun snapshot
         * has no last working day, so this month would publish an ordinary
         * payslip, not an F&F. Shown so it is never missed; nothing here
         * changes the payroll.
         */
        warning: Number(r.initialized_without_exit) === 1
          ? "This month was initialized before the resignation was recorded. Its payroll snapshot has no last working day, so it would publish a regular payslip, not an F&F statement."
          : null,
        ...settlementStage({ settlement_status: r.settlement_status, initialized: false, calc_status: null }),
      });
    });
    const counts = rows.reduce((acc, r) => {
      acc[r.stage] = (acc[r.stage] || 0) + 1;
      return acc;
    }, {});
    return { period_year: p.year, period_month: p.month, rows, counts, components: FNF_COMPONENTS };
  }

  async _inScopeExit(p, employeeId, store_ids) {
    const [row] = await this.repo.listMonthPayrunExits({ ...p, store_ids, employee_ids: [Number(employeeId)] });
    if (!row) {
      throw notFound(
        "This employee has no exit in the selected month's payroll, or is outside your branch scope"
      );
    }
    return row;
  }

  /** One exit month's F&F items, their history and whether they may still change. */
  async getItems({ year, month, employee_id, store_ids = null }) {
    const p = this._month(year, month);
    const row = await this._inScopeExit(p, employee_id, store_ids);
    const [items, audit] = await Promise.all([
      this.repo.listItems({ year: p.year, month: p.month, employee_id: Number(employee_id) }),
      this.repo.listItemAudit({ year: p.year, month: p.month, employee_id: Number(employee_id) }),
    ]);
    return {
      period_year: p.year,
      period_month: p.month,
      employee_id: Number(employee_id),
      employee_name: row.employee_name,
      exit_date: row.exit_date,
      editable: row.calc_stored_status !== "APPROVED_LOCKED",
      components: FNF_COMPONENTS,
      items: items.map((i) => ({ ...i, amount: toMoney(i.amount) })),
      audit,
    };
  }

  /**
   * SET / CLEAR F&F AMOUNTS. Every component named is validated before
   * anything is written; the write itself is one transaction that refuses a
   * locked month and a non-exit month under the lock (see the repository).
   * The stored calculation becomes stale through its inputs hash, exactly as
   * an Adjustment makes it - so the month must be recalculated before it can
   * be approved, and a month approved in the meantime can never be published
   * with figures that no longer match its inputs.
   */
  async saveItems({ year, month, employee_id, items, store_ids = null, actor = {} }) {
    const p = this._month(year, month);
    if (!Array.isArray(items) || items.length === 0) throw validationError("Name at least one F&F component");
    const seen = new Set();
    const entries = items.map((item) => {
      const def = FNF_COMPONENT_BY_KEY[item && item.component];
      if (!def) throw validationError(`Unknown F&F component ${String(item && item.component)}`);
      if (seen.has(def.key)) throw validationError(`${def.label} is named twice`);
      seen.add(def.key);
      return {
        component: def.key,
        amount: normalizeAmount(item.amount, def.label),
        remarks: textOrNull(item.remarks, FNF_REMARKS_MAX, "Remarks"),
      };
    });
    await this._inScopeExit(p, employee_id, store_ids);
    const res = await this.repo.saveItems({
      year: p.year,
      month: p.month,
      employee_id: Number(employee_id),
      entries,
      actor: actor.employeeId ?? null,
      isExitMonth,
    });
    const refusals = {
      MONTH_LOCKED: "The payroll month is locked.",
      APPROVED_LOCKED: "This employee's month is approved & locked. Unlock it before changing F&F amounts.",
      NOT_INITIALIZED: "This employee is not initialized for the selected month.",
      NOT_EXIT_MONTH: "F&F amounts can only be entered in the month of the employee's last working day.",
    };
    if (refusals[res.outcome]) throw conflict(refusals[res.outcome]);
    return {
      code: 200,
      set: res.set,
      cleared: res.cleared,
      message: "Saved. Recalculate this employee before approving.",
      ...(await this.getItems({ year: p.year, month: p.month, employee_id, store_ids })),
    };
  }

  /* ============================================ settlement completion */

  async settle({ year, month, employee_id, payment_mode, payment_reference, paid_on, store_ids = null, actor = {} }) {
    const p = this._month(year, month);
    if (!Object.values(PAYMENT_MODE).includes(payment_mode)) throw validationError("payment_mode must be BANK or CASH");
    const paidOn = dateOnly(paid_on);
    if (!paidOn) throw validationError("paid_on must be a date (YYYY-MM-DD)");
    if (paidOn > this.today()) throw validationError("paid_on cannot be in the future");
    const reference = textOrNull(payment_reference, SETTLEMENT_REFERENCE_MAX, "Payment reference");
    if (payment_mode === PAYMENT_MODE.BANK && !reference) {
      throw validationError("A bank settlement needs its payment reference (UTR / transaction id)");
    }
    const row = await this._inScopeExit(p, employee_id, store_ids);
    if (row.exit_date && paidOn < row.exit_date) throw validationError("paid_on cannot be before the last working day");
    const res = await this.repo.settle({
      year: p.year,
      month: p.month,
      employee_id: Number(employee_id),
      payment_mode,
      payment_reference: reference,
      paid_on: paidOn,
      actor,
    });
    const refusals = {
      NOT_CALCULATED: "This employee's exit month is not calculated.",
      NOT_PUBLISHED: "The F&F statement must be approved and published before it can be marked settled.",
      NOT_FNF: "The published document for this month is not a Full & Final Settlement statement.",
      CALCULATION_CHANGED: "The published statement does not match the calculation. Reload and try again.",
      ALREADY_SETTLED: "This Full & Final Settlement is already marked settled.",
    };
    if (refusals[res.outcome]) throw conflict(refusals[res.outcome]);
    return { code: 200, outcome: res.outcome, settlement: res.case };
  }

  async reopen({ year, month, employee_id, reason, store_ids = null, actor = {} }) {
    const p = this._month(year, month);
    const why = textOrNull(reason, SETTLEMENT_REASON_MAX, "Reason");
    if (!why) throw validationError("A reason is required to reopen a settled F&F");
    await this._inScopeExit(p, employee_id, store_ids);
    const res = await this.repo.reopen({ year: p.year, month: p.month, employee_id: Number(employee_id), reason: why, actor });
    if (res.outcome === "NOT_SETTLED") throw conflict("This Full & Final Settlement is not marked settled.");
    return { code: 200, outcome: res.outcome, settlement: res.case };
  }

  /* ===================================================== exit history */

  /**
   * EVERY EXIT OF ONE EMPLOYEE - CONFIDENTIAL (view_exit_interview). Each
   * recorded case with its settlement, whether an interview exists and the
   * current rehire assessment; plus closed employment periods with no case
   * yet, which can still be interviewed.
   */
  async employeeExits(employeeId) {
    const id = Number(employeeId);
    const { cases, periods } = await this.repo.listEmployeeExits(id);
    const withRehire = await Promise.all(
      cases.map(async (c) => {
        const history = await this.repo.listRehire(c.fnf_settlement_id);
        return {
          settlement_id: Number(c.fnf_settlement_id),
          exit_date: c.exit_date,
          period_id: c.period_id === null ? null : Number(c.period_id),
          settlement_status: c.settlement_status,
          settled_net_amount: toMoney(c.settled_net_amount),
          paid_on: c.paid_on,
          has_interview: Number(c.has_interview) > 0,
          rehire: history[0] || null,
          rehire_history_count: history.length,
        };
      })
    );
    const known = new Set(cases.map((c) => c.exit_date));
    const pending = periods
      .filter((pr) => pr.ended_on && !known.has(pr.ended_on))
      .map((pr) => ({
        settlement_id: null,
        exit_date: pr.ended_on,
        period_id: Number(pr.period_id),
        settlement_status: "PENDING",
        has_interview: false,
        rehire: null,
        rehire_history_count: 0,
      }));
    const exits = [...withRehire, ...pending].sort((a, b) => (a.exit_date < b.exit_date ? 1 : -1));
    return { employee_id: id, exits, latest_rehire: (await this.repo.latestRehireForEmployee(id)) || null };
  }

  /**
   * THE EXIT A WRITE IS ABOUT. Only a real exit of THIS employee - a closed
   * employment period's end date, or a recorded case - may be named; a
   * case is created for it if needed (idempotent).
   */
  async _caseFor(employeeId, exitDate, actor) {
    const date = dateOnly(exitDate);
    if (!date) throw validationError("exit_date must be a date (YYYY-MM-DD)");
    const { cases, periods } = await this.repo.listEmployeeExits(Number(employeeId));
    const real = cases.some((c) => c.exit_date === date) || periods.some((pr) => pr.ended_on === date);
    if (!real) throw notFound("This employee has no recorded exit on that date");
    return this.repo.ensureCase({ employee_id: Number(employeeId), exit_date: date, actor: actor.employeeId ?? null });
  }

  async _ownCase(employeeId, caseId) {
    const c = await this.repo.getCase(Number(caseId));
    if (!c || Number(c.employee_id) !== Number(employeeId)) throw notFound("Exit record not found");
    return c;
  }

  async exitDetail(employeeId, caseId) {
    const c = await this._ownCase(employeeId, caseId);
    const [interview, rehire, events] = await Promise.all([
      this.repo.getInterview(c.fnf_settlement_id),
      this.repo.listRehire(c.fnf_settlement_id),
      this.repo.listSettlementEvents(c.fnf_settlement_id),
    ]);
    return {
      settlement: c,
      interview,
      rehire_current: rehire[0] || null,
      rehire_history: rehire,
      settlement_events: events,
    };
  }

  /* ===================================================== exit interview */

  async saveInterview(employeeId, input, actor = {}) {
    const fields = {};
    const interviewDate = dateOnly(input.interview_date);
    if (!interviewDate) throw validationError("interview_date must be a date (YYYY-MM-DD)");
    if (interviewDate > this.today()) throw validationError("interview_date cannot be in the future");
    fields.interview_date = interviewDate;
    if (!Object.values(EXIT_REASON).includes(input.primary_reason)) throw validationError("primary_reason is not one of the listed reasons");
    fields.primary_reason = input.primary_reason;
    INTERVIEW_RATINGS.forEach(({ key, label }) => {
      const v = input[key];
      if (v === null || v === undefined || v === "") {
        fields[key] = null;
        return;
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) throw validationError(`${label} must be a rating from 1 to 5`);
      fields[key] = n;
    });
    ["would_recommend", "would_return"].forEach((key) => {
      const v = input[key];
      if (v === null || v === undefined || v === "") {
        fields[key] = null;
        return;
      }
      if (!Object.values(YES_NO).includes(v)) throw validationError(`${key} must be YES or NO`);
      fields[key] = v;
    });
    fields.feedback = textOrNull(input.feedback, INTERVIEW_TEXT_MAX, "Feedback");
    fields.suggestions = textOrNull(input.suggestions, INTERVIEW_TEXT_MAX, "Suggestions");

    const caseId = await this._caseFor(employeeId, input.exit_date, actor);
    const interview = await this.repo.saveInterview(caseId, Number(employeeId), fields, actor.employeeId ?? null);
    return { code: 200, settlement_id: caseId, interview };
  }

  /* ================================================= rehire eligibility */

  /**
   * RECORD OR OVERRIDE A FIT-FOR-REHIRE ASSESSMENT. Append-only: the first
   * assessment of an exit needs `manage_exit_interview`; changing it needs
   * `override_rehire_eligibility` and a reason, and becomes a new row - the
   * earlier decision is never edited or deleted.
   */
  async assessRehire(employeeId, input, { canManage, canOverride }, actor = {}) {
    if (!Object.values(REHIRE_ELIGIBILITY).includes(input.eligibility)) {
      throw validationError("eligibility must be YES, NO or CONDITIONAL");
    }
    const conditions = textOrNull(input.conditions, REHIRE_NOTE_MAX, "Conditions");
    if (input.eligibility === REHIRE_ELIGIBILITY.CONDITIONAL && !conditions) {
      throw validationError("A CONDITIONAL assessment must say its conditions");
    }
    const note = textOrNull(input.note, REHIRE_NOTE_MAX, "Note");
    const overrideReason = textOrNull(input.override_reason, REHIRE_NOTE_MAX, "Override reason");

    const caseId = await this._caseFor(employeeId, input.exit_date, actor);
    const history = await this.repo.listRehire(caseId);
    const isOverride = history.length > 0;
    if (isOverride && !canOverride) {
      const err = new Error("Changing an existing rehire assessment needs the Override Rehire Eligibility permission");
      err.name = "ForbiddenError";
      err.status = 403;
      throw err;
    }
    if (!isOverride && !canManage) {
      const err = new Error("Recording a rehire assessment needs the Manage Exit Interview permission");
      err.name = "ForbiddenError";
      err.status = 403;
      throw err;
    }
    if (isOverride && !overrideReason) throw validationError("An override needs a reason");
    const res = await this.repo.addRehire(
      caseId,
      Number(employeeId),
      {
        eligibility: input.eligibility,
        conditions: input.eligibility === REHIRE_ELIGIBILITY.CONDITIONAL ? conditions : null,
        note,
        override_reason: overrideReason,
        expectFirst: !isOverride,
      },
      actor
    );
    if (res.outcome === "ALREADY_ASSESSED") {
      throw conflict("Somebody assessed this exit at the same time. Reload and override if needed.");
    }
    return { code: 200, outcome: res.outcome, settlement_id: caseId, history: await this.repo.listRehire(caseId) };
  }

  /** The employee's current rehire standing (newest assessment of the newest assessed exit). */
  async rehireStatus(employeeId) {
    return { employee_id: Number(employeeId), rehire: (await this.repo.latestRehireForEmployee(Number(employeeId))) || null };
  }
}

module.exports = (repo, opts) => new EmployeeExitUsecase(repo, opts);
module.exports.EmployeeExitUsecase = EmployeeExitUsecase;
