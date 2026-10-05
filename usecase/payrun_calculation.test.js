/**
 * Payrun Calculation & Review - the stage, driven with fake repositories.
 *
 *   node --test usecase/payrun_calculation.test.js
 *
 * The fakes below are an in-memory version of the two tables this stage owns
 * plus the reads it makes of initialization, attendance and adjustments. That
 * is enough to prove the things no pure test can reach:
 *
 *   only INITIALIZED employees take part
 *   a source that moved is DETECTED and changes no stored figure
 *   recalculation refreshes the sources and preserves the adjustments and the
 *     pay type
 *   a pending adjustment confirmation blocks approval
 *   approval is individual AND bulk by the same path
 *   approval locks ONE EMPLOYEE, and the rest of the month stays editable
 *   a locked employee cannot be recalculated, cannot have their adjustments
 *     edited and cannot have their pay type changed
 *   approved_locked => payslip_eligible, and nothing else is
 *
 * The FIGURES are proved as arithmetic in `utils/payrun_calculation.test.js`.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const buildCalculation = require("./payrun_calculation");
const buildPayrun = require("./payrun");
const buildAdjustments = require("./payrun_adjustment");
const { CALC_STATUS, ROW_RESULT, NRM_SOURCE } = require("../constants/payrun_calculation");
const { COMPONENT } = require("../constants/payrun_adjustments");
const { dayRowsFingerprint } = require("../utils/attendance_month_freshness");

/* ============================================================== the fakes */

/**
 * ONE IN-MEMORY WORLD BEHIND ALL THREE STAGES, so that "a locked employee's
 * adjustments cannot be edited" is proved against the SAME lock the
 * calculation stage took, rather than against a second mock of it.
 */
class World {
  constructor() {
    this.year = 2026;
    this.month = 8;
    this.employees = new Map();      // employee_id -> snapshot row
    this.attendance = new Map();     // employee_id -> monthly payroll row
    this.nrm = new Map();            // employee_id -> grouped day rows
    this.days = new Map();           // employee_id -> stored attendance day rows
    this.pending = new Map();        // employee_id -> { pending_regularizations, pending_ot }
    this.salaries = new Map();       // employee_id -> current approved salary
    this.amounts = new Map();        // employee_id -> { component: amount }
    this.states = new Map();         // employee_id -> { confirmed_no_adjustment }
    this.calculations = new Map();   // employee_id -> calculation row
    this.audit = [];
    this.resets = [];                // the reset audit
    this.lifecycle = [];             // the lifecycle audit
    this.payslips = [];              // payrun_payslip rows
    this.notifications = [];         // payrun_payslip_notification rows
    this.telegramLinks = new Map();  // employee_id -> active employee_telegram_identity
    this.telegramFailFor = new Set();// employee ids whose Telegram send throws
    this.telegramSent = [];          // what the fake bot sent
    this.extras = new Map();         // employee_id -> { account_no, pan_no, bank_name, department_name }
    this.statutory = new Map();      // employee_id -> LIVE Employee Master statutory overrides
    this.companies = [{ company_id: 1, company_name: "Daily Needs Departmental Store", reg_address: "188/1 Iyyanar Koil Street", pf_number: "TN/MAS/0012345", esi_number: "51000123450001001", status: 1 }];
    this.legacy = false;             // read as the pre-readiness code did
    this.failResetFor = new Set();   // employee ids whose reset transaction throws
    this.period = null;
    this.nextId = 1;
  }

  /** An ordinary initialized employee with a clean, fully attended month. */
  add(employeeId, over = {}) {
    this.employees.set(employeeId, {
      payrun_employee_id: 100 + employeeId,
      employee_id: employeeId,
      employee_name: `Employee ${employeeId}`,
      store_id: 1,
      store_name: "Main",
      designation_name: "Assistant",
      date_of_joining: "2018-04-01",
      salary_id: 500 + employeeId,
      salary_effective_from: "2026-04-01",
      monthly_gross: 26000,
      basic: 13000,
      conveyance: 2500,
      hra: 5000,
      special_allowance: 5500,
      pf_applicable: 1,
      esi_applicable: 1,
      uan: "100200300400",
      esi_number: "3100000000",
      pay_type: "BANK",
      pay_type_source: "EMPLOYEE_MASTER",
      ...(over.employee || {}),
    });
    this.salaries.set(employeeId, {
      employee_id: employeeId,
      salary_id: 500 + employeeId,
      effective_from: "2026-04-01",
      monthly_gross: 26000,
      ...(over.salary || {}),
    });
    this.attendance.set(employeeId, {
      employee_id: employeeId,
      attendance_monthly_payroll_id: 900 + employeeId,
      payroll_version: 1,
      calculated_at: "2026-09-01 02:00:00.000",
      is_final: 1,
      salary_days: 26,
      extra_days: 0,
      salary_day_earnings: 26000,
      extra_day_earnings: 0,
      shortage_minutes: 0,
      missing_minute_deduction: 0,
      approved_ot_minutes: 0,
      approved_ot_earnings: 0,
      ...(over.attendance || {}),
    });
    /*
     * THE DAY-LEVEL NRM EVIDENCE, CARRYING THE SAME APPROVED OT the monthly
     * roll-up above reports. The two are one engine's two views of one fact
     * and the calculation refuses them when they disagree, so a fixture that
     * let them drift would be testing the wrong thing.
     *
     * The default is one 8-hour group carrying the whole month's approved OT;
     * a test that needs the overtime split across NRMs passes its own groups.
     */
    const monthlyOt = Number(this.attendance.get(employeeId).approved_ot_minutes || 0);
    this.nrm.set(
      employeeId,
      (over.nrm_groups || [
        {
          nrm_minutes: 480,
          break_allowance_source: NRM_SOURCE.SHIFT,
          day_count: 26,
          approved_ot_minutes: monthlyOt,
        },
      ]).map((g) => ({ employee_id: employeeId, ...g }))
    );

    /*
     * THE STORED DAY ROWS THE GROUPS ABOVE SUMMARISE - one per date of the
     * month, settled, with each group's approved OT on its first day - and the
     * summary's fingerprint taken over them, exactly as the month persist
     * records it. So the ordinary employee's attendance is complete AND
     * current, and a test that wants it stale or unsettled changes one thing.
     */
    const rows = [];
    let date = 1;
    this.nrm.get(employeeId).forEach((g) => {
      for (let i = 0; i < Number(g.day_count); i += 1) {
        rows.push({
          attendance_date: `2026-08-${String(date).padStart(2, "0")}`,
          status: "FINAL", is_final: 1, attendance_day_count: 1,
          nrm_minutes: g.nrm_minutes, base_nrm_minutes: g.nrm_minutes,
          worked_minutes: g.nrm_minutes, shortage_minutes: 0,
          approved_ot_minutes: i === 0 ? Number(g.approved_ot_minutes || 0) : 0,
          ot_rate: 1, permission_minutes: 0, calculation_version: 10,
          attendance_calculation_mode: "SHIFT_BASED",
        });
        date += 1;
      }
    });
    for (; date <= 31; date += 1) {
      rows.push({
        attendance_date: `2026-08-${String(date).padStart(2, "0")}`,
        status: "ABSENT", is_final: 1, attendance_day_count: 0,
        nrm_minutes: 480, base_nrm_minutes: 480, worked_minutes: 0, shortage_minutes: 0,
        approved_ot_minutes: 0, ot_rate: 1, permission_minutes: 0, calculation_version: 10,
        attendance_calculation_mode: "SHIFT_BASED",
      });
    }
    this.days.set(employeeId, rows);
    this.attendance.get(employeeId).day_rows_fingerprint = dayRowsFingerprint(rows);

    // Confirmed as having no adjustment, so the ordinary employee is READY and
    // each test can take exactly one thing away.
    this.states.set(employeeId, { employee_id: employeeId, confirmed_no_adjustment: 1, remarks: null });
    return this;
  }
}

class FakeCalculationRepo {
  constructor(world) {
    this.world = world;
  }

  async listInitialized({ store_ids = null, employee_ids = null }) {
    return [...this.world.employees.values()]
      .filter((e) => (store_ids === null ? true : store_ids.includes(e.store_id)))
      .filter((e) => (employee_ids === null ? true : employee_ids.includes(e.employee_id)))
      .map((e) => ({ ...e }));
  }

  async listAttendanceMonths(ids) {
    return ids.map((id) => this.world.attendance.get(id)).filter(Boolean).map((r) => ({ ...r }));
  }

  async listAttendanceDayRows(ids) {
    // `legacy` simulates the code before payroll readiness existed, so a test
    // can create the calculations that rule allowed and production still has.
    if (this.world.legacy) return null;
    return ids.flatMap((id) => (this.world.days.get(id) || []).map((d) => ({ employee_id: id, ...d })));
  }

  async listEffectiveNrm(ids) {
    return ids.flatMap((id) => this.world.nrm.get(id) || []);
  }

  async listStatutoryContext(ids) {
    return ids.map((id) => ({
      employee_id: id,
      dob: "1990-06-15",
      previous_eps_member: 0,
      previous_pf_member: 1,
      date_of_joining: this.world.employees.get(id).date_of_joining || "2018-04-01",
      pf_applicable: this.world.employees.get(id).pf_applicable,
      esi_applicable: this.world.employees.get(id).esi_applicable,
      uan: this.world.employees.get(id).uan,
      pf_number: this.world.employees.get(id).pf_number,
      ...(this.world.statutory.get(id) || {}),
    }));
  }

  async listCalculations({ employee_ids = null }) {
    return [...this.world.calculations.values()]
      .filter((c) => employee_ids === null || employee_ids.includes(c.employee_id))
      .map((c) => ({ ...c }));
  }

  async listLockedEmployeeIds({ employee_ids = null }) {
    return [...this.world.calculations.values()]
      .filter((c) => c.status === "APPROVED_LOCKED")
      .filter((c) => employee_ids === null || employee_ids.includes(c.employee_id))
      .map((c) => Number(c.employee_id));
  }

  async listAudit({ employee_id }) {
    return this.world.audit.filter((a) => a.employee_id === employee_id).reverse();
  }

  /** The real one's ON DUPLICATE KEY UPDATE, including its locked-row guard. */
  async saveCalculations(rows) {
    const written = [];
    rows.forEach((row) => {
      const existing = this.world.calculations.get(row.employee_id);
      if (existing && existing.status === "APPROVED_LOCKED") {
        written.push({ ...existing });
        return;
      }
      const next = {
        ...row,
        payrun_calculation_id: existing ? existing.payrun_calculation_id : this.world.nextId++,
        calculation_revision: existing ? Number(existing.calculation_revision) + 1 : 1,
        status: "CALCULATED",
        approved_by: null,
        approved_at: null,
        locked_by: null,
        locked_at: null,
        calculated_at: "2026-09-05 10:00:00",
      };
      this.world.calculations.set(row.employee_id, next);
      this.world.audit.push({
        employee_id: row.employee_id,
        action: next.calculation_revision > 1 ? "RECALCULATE" : "CALCULATE",
        calculation_revision: next.calculation_revision,
        net_pay: row.net_pay,
      });
      written.push({ ...next });
    });
    return written;
  }

  async approve({ employees, approved_by }) {
    return employees.map((entry) => {
      const row = this.world.calculations.get(entry.employee_id);
      if (!row) return { employee_id: entry.employee_id, outcome: "NO_CALCULATION" };
      if (row.status === "APPROVED_LOCKED") {
        return { employee_id: entry.employee_id, outcome: "ALREADY_LOCKED" };
      }
      if (entry.calculation_hash && entry.calculation_hash !== row.calculation_hash) {
        return { employee_id: entry.employee_id, outcome: "CALCULATION_MOVED" };
      }
      row.status = "APPROVED_LOCKED";
      row.approved_by = approved_by;
      row.approved_at = "2026-09-05 11:00:00";
      row.locked_by = approved_by;
      row.locked_at = "2026-09-05 11:00:00";
      this.world.audit.push({
        employee_id: entry.employee_id,
        action: "APPROVE_LOCK",
        calculation_hash: row.calculation_hash,
        net_pay: row.net_pay,
      });
      return {
        employee_id: entry.employee_id,
        outcome: "APPROVED",
        net_pay: row.net_pay,
        calculation_hash: row.calculation_hash,
      };
    });
  }
}

/**
 * The real `resetCalculation`'s contract: the month lock re-read, the row
 * found by identity, ONLY a stored CALCULATED row removed, the audit written
 * with it - or, on a thrown error, nothing changed at all.
 */
FakeCalculationRepo.prototype.resetCalculation = async function resetCalculation({
  year, month, employee_id, previous_status, reason, remark, mode, reset_by,
}) {
  if (this.world.failResetFor.has(employee_id)) throw new Error("simulated failure");
  if (this.world.period && this.world.period.status === "LOCKED") {
    return { employee_id, outcome: "MONTH_LOCKED" };
  }
  const row = this.world.calculations.get(employee_id);
  if (!row) return { employee_id, outcome: "NOT_CALCULATED" };
  if (row.status !== "CALCULATED") return { employee_id, outcome: "LOCKED", stored_status: row.status };
  this.world.resets.push({
    employee_id, period_year: year, period_month: month,
    payrun_employee_id: row.payrun_employee_id,
    payrun_calculation_id: row.payrun_calculation_id,
    previous_status, previous_stored_status: row.status,
    reset_reason: reason, reset_remark: remark, reset_mode: mode, reset_by,
    net_pay: row.net_pay,
  });
  this.world.calculations.delete(employee_id);
  return { employee_id, outcome: "RESET", payrun_calculation_id: row.payrun_calculation_id };
};

/**
 * The real `lifecycle`'s contract: the month lock, the row by identity, the
 * expected state repeated in the update, and a lifecycle audit row with it.
 */
FakeCalculationRepo.prototype.lifecycle = async function lifecycle({
  action, year, month, employee_id, reason, remark, mode, actor = {}, payslip = null,
}) {
  if (this.world.period && this.world.period.status === "LOCKED") return { employee_id, outcome: "MONTH_LOCKED" };
  const row = this.world.calculations.get(employee_id);
  if (!row) return { employee_id, outcome: "NOT_CALCULATED" };
  const locked = row.status === "APPROVED_LOCKED";
  const published = locked && Boolean(row.published_at);
  const previous = published ? "PUBLISHED" : row.status;
  let next;
  if (action === "UNLOCK") {
    if (published) return { employee_id, outcome: "PUBLISHED" };
    if (!locked) return { employee_id, outcome: "NOT_LOCKED" };
    Object.assign(row, {
      status: "CALCULATED", approved_by: null, approved_at: null, locked_by: null, locked_at: null,
      unlocked_by: actor.employeeId, unlocked_at: "2026-09-06 10:00:00", unlock_reason: reason,
    });
    next = "CALCULATED";
  } else if (action === "PUBLISH") {
    if (published) return { employee_id, outcome: "ALREADY_PUBLISHED" };
    if (!locked) return { employee_id, outcome: "NOT_LOCKED" };
    if (!payslip || !payslip.text || !payslip.sha256) throw new Error("PUBLISH requires a frozen payslip snapshot");
    if (Number(payslip.payrun_calculation_id) !== Number(row.payrun_calculation_id)
      || payslip.calculation_hash !== row.calculation_hash) {
      return { employee_id, outcome: "CALCULATION_CHANGED" };
    }
    Object.assign(row, { published_by: actor.employeeId, published_at: "2026-09-06 11:00:00" });
    next = "PUBLISHED";
  } else {
    if (!published) return { employee_id, outcome: locked ? "NOT_PUBLISHED" : "NOT_LOCKED" };
    Object.assign(row, { published_by: null, published_at: null });
    next = "APPROVED_LOCKED";
  }
  let payslipId = null;
  if (action === "PUBLISH") {
    const versions = this.world.payslips.filter((p) => p.payrun_employee_id === row.payrun_employee_id);
    payslipId = this.world.payslips.length + 1;
    this.world.payslips.push({
      payslip_id: payslipId, payslip_ref: payslip.payslip_ref, payrun_employee_id: row.payrun_employee_id,
      payrun_calculation_id: row.payrun_calculation_id, employee_id, period_year: year, period_month: month,
      payslip_version: versions.length + 1, calculation_hash: row.calculation_hash,
      calculation_revision: row.calculation_revision,
      template_version: payslip.template_version, snapshot_schema_version: payslip.schema_version,
      snapshot_json: payslip.text, snapshot_sha256: payslip.sha256, status: "ACTIVE",
      published_by: actor.employeeId, published_at: row.published_at,
      first_viewed_at: null, last_viewed_at: null, view_count: 0,
    });
    // The outbox row, in the same "transaction".
    this.world.notifications.push({
      notification_id: this.world.notifications.length + 1, payslip_id: payslipId, employee_id,
      attempt_no: 1, trigger_type: "PUBLISH", result: "QUEUED", requested_by: actor.employeeId,
    });
  } else if (action === "UNPUBLISH") {
    const active = this.world.payslips.find((p) => p.payrun_employee_id === row.payrun_employee_id && p.status === "ACTIVE");
    if (active) {
      Object.assign(active, { status: "ARCHIVED", archived_by: actor.employeeId, archive_reason: reason });
      payslipId = active.payslip_id;
      this.world.notifications
        .filter((n) => n.payslip_id === payslipId && n.result === "QUEUED")
        .forEach((n) => Object.assign(n, { result: "FAILED", failure_code: "PAYSLIP_UNPUBLISHED" }));
    }
  }
  this.world.lifecycle.push({
    employee_id, period_year: year, period_month: month, action, previous_status: previous,
    new_status: next, reason, remark, mode, acted_by_employee_id: actor.employeeId,
    calculation_hash: row.calculation_hash, net_pay: row.net_pay,
  });
  this.world.lifecycle[this.world.lifecycle.length - 1].payslip_id = payslipId;
  if (action === "UNLOCK") this.world.audit.push({ employee_id, action: "UNLOCK", net_pay: row.net_pay });
  return { employee_id, outcome: action, previous_status: previous, new_status: next, payslip_id: payslipId };
};

/** `repository/payrun_payslip.js` over the world - the reads and writes Publish uses. */
class FakePayslipRepo {
  constructor(world) {
    this.world = world;
  }
  async listEmployeeExtras(ids) {
    return ids.map((id) => ({ employee_id: id, ...(this.world.extras.get(id) || {}) }));
  }
  _latest(payslipId) {
    const mine = this.world.notifications.filter((n) => n.payslip_id === payslipId);
    return mine.length ? mine[mine.length - 1] : null;
  }
  async listMonthStatus({ year, month, employee_ids = null }) {
    return this.world.payslips
      .filter((p) => p.status === "ACTIVE" && p.period_year === year && p.period_month === month)
      .filter((p) => !employee_ids || employee_ids.includes(p.employee_id))
      .map((p) => {
        const n = this._latest(p.payslip_id);
        return {
          payslip_id: p.payslip_id, employee_id: p.employee_id, payslip_version: p.payslip_version,
          payslip_published_at: p.published_at, first_viewed_at: p.first_viewed_at,
          last_viewed_at: p.last_viewed_at, view_count: p.view_count,
          notification_result: n ? n.result : null, notification_attempts: n ? n.attempt_no : null,
          notification_failure_code: n ? n.failure_code : null, notification_attempted_at: n ? "2026-09-06 11:00:01" : null,
        };
      });
  }
  async getActiveForMonth({ year, month, employee_id }) {
    return this.world.payslips.find((p) => p.status === "ACTIVE" && p.period_year === year
      && p.period_month === month && p.employee_id === employee_id) || null;
  }
  async listVersions({ year, month, employee_id }) {
    return this.world.payslips
      .filter((p) => p.period_year === year && p.period_month === month && p.employee_id === employee_id)
      .map(({ snapshot_json, ...rest }) => rest)
      .reverse();
  }
  async listNotifications(payslipId) {
    return this.world.notifications.filter((n) => n.payslip_id === payslipId).slice().reverse();
  }
  async listCompanies() {
    return this.world.companies;
  }
  async enqueueRetry({ payslip_id, employee_id, requested_by }) {
    const mine = this.world.notifications.filter((n) => n.payslip_id === payslip_id);
    if (mine.some((n) => n.result === "QUEUED" || n.result === "SENDING")) return { queued: false, reason: "ALREADY_PENDING" };
    this.world.notifications.push({
      notification_id: this.world.notifications.length + 1, payslip_id, employee_id,
      attempt_no: mine.length + 1, trigger_type: "RETRY", result: "QUEUED", requested_by,
    });
    return { queued: true };
  }
  async claimQueued({ limit, token }) {
    const picked = this.world.notifications.filter((n) => n.result === "QUEUED").slice(0, limit);
    picked.forEach((n) => Object.assign(n, { result: "SENDING", claim_token: token }));
    return picked.map((n) => {
      const slip = this.world.payslips.find((p) => p.payslip_id === n.payslip_id);
      const calc = this.world.calculations.get(n.employee_id);
      const deliverable = slip.status === "ACTIVE" && calc && calc.status === "APPROVED_LOCKED" && Boolean(calc.published_at);
      return { ...n, period_year: slip.period_year, period_month: slip.period_month, deliverable: deliverable ? 1 : 0 };
    });
  }
  async completeNotification({ notification_id, claim_token, ...outcome }) {
    const n = this.world.notifications.find((x) => x.notification_id === notification_id && x.claim_token === claim_token && x.result === "SENDING");
    if (!n) return false;
    Object.assign(n, outcome);
    return true;
  }
  async recoverInterrupted() {
    return 0;
  }
}

/** The real notifier, over a fake identity repository and a fake bot. */
function payslipNotifier(world) {
  return require("./payslip_notification")({
    intervalMs: 0,
    payslipRepo: new FakePayslipRepo(world),
    identityRepo: {
      getActiveIdentityByEmployee: async (id) => world.telegramLinks.get(id) || null,
    },
    telegram: {
      sendMessage: async (chatId, text, options) => {
        const employee = [...world.telegramLinks.entries()].find(([, l]) => l.private_chat_id === chatId);
        if (employee && world.telegramFailFor.has(employee[0])) {
          const err = new Error("Forbidden: bot was blocked by the user");
          err.response = { status: 403, data: { error_code: 403, description: "Forbidden: bot was blocked by the user" } };
          throw err;
        }
        world.telegramSent.push({ chatId, text, options });
        return { code: 200, message_id: 9000 + world.telegramSent.length };
      },
    },
    getMiniAppUrl: () => "https://dnds.example/telegram/attendance",
  });
}

/** Only the four methods the calculation stage borrows from initialization. */
class FakePayrunRepo {
  constructor(world) {
    this.world = world;
    this.payTypeAudit = [];
  }
  async getPeriod() {
    return this.world.period;
  }
  async listApprovedSalaries(ids) {
    return ids.map((id) => this.world.salaries.get(id)).filter(Boolean).map((s) => ({ ...s }));
  }
  async listPendingApprovals(ids) {
    return ids
      .map((id) => this.world.pending.get(id))
      .filter(Boolean)
      .map((p) => ({ ...p }));
  }
  async listPopulation() {
    return [...this.world.employees.values()].map((e) => ({ ...e }));
  }
  async changePayType({ employee_id, pay_type }) {
    const employee = this.world.employees.get(employee_id);
    if (!employee) return null;
    const old = employee.pay_type;
    employee.pay_type = pay_type;
    employee.pay_type_source = "MANUAL";
    this.payTypeAudit.push({ employee_id, old, pay_type });
    return { old_pay_type: old, new_pay_type: pay_type, changed: old !== pay_type };
  }
}

class FakeAdjustmentRepo {
  constructor(world) {
    this.world = world;
  }
  async listInitialized({ employee_ids = null }) {
    return [...this.world.employees.values()]
      .filter((e) => employee_ids === null || employee_ids.includes(e.employee_id))
      .map((e) => ({ ...e }));
  }
  async listAmounts({ employee_ids = null }) {
    const rows = [];
    this.world.amounts.forEach((byComponent, employeeId) => {
      if (employee_ids !== null && !employee_ids.includes(employeeId)) return;
      Object.keys(byComponent).forEach((component) =>
        rows.push({ employee_id: employeeId, component, amount: byComponent[component] })
      );
    });
    return rows;
  }
  async listStates({ employee_ids = null }) {
    return [...this.world.states.values()].filter(
      (s) => employee_ids === null || employee_ids.includes(s.employee_id)
    );
  }
  async saveAdjustments({ entries }) {
    entries.forEach((entry) => {
      const current = this.world.amounts.get(entry.employee_id) || {};
      Object.keys(entry.amounts || {}).forEach((key) => {
        if (entry.amounts[key] === null) delete current[key];
        else current[key] = entry.amounts[key];
      });
      this.world.amounts.set(entry.employee_id, current);
    });
    return { amounts_set: entries.length, amounts_cleared: 0, remarks_set: 0, confirmations_revoked: 0 };
  }
  async confirmNoAdjustment({ employees }) {
    return employees.map((e) => {
      this.world.states.set(e.employee_id, {
        employee_id: e.employee_id,
        confirmed_no_adjustment: 1,
      });
      return { employee_id: e.employee_id, result: "CONFIRMED" };
    });
  }
  async listAudit() {
    return [];
  }
}

/* ============================================================== the setup */

const ACTOR = { employeeId: 77 };
let world;
let calculation;
let payrun;
let adjustments;

function build() {
  world = new World();
  const calcRepo = new FakeCalculationRepo(world);
  const payrunRepo = new FakePayrunRepo(world);
  const adjustmentRepo = new FakeAdjustmentRepo(world);
  const locks = { listLockedEmployeeIds: (args) => calcRepo.listLockedEmployeeIds(args) };

  calculation = buildCalculation(calcRepo, payrunRepo, adjustmentRepo);
  world.notifier = payslipNotifier(world);
  calculation.setPayslipServices({
    payslipRepo: new FakePayslipRepo(world),
    notifier: world.notifier,
    companyEnv: () => ({}),
  });
  payrun = buildPayrun(payrunRepo, locks);
  adjustments = buildAdjustments(adjustmentRepo, payrunRepo, locks);
  return { calcRepo, payrunRepo, adjustmentRepo };
}

const MONTH = { year: 2026, month: 8 };

/*
 * CALCULATED UNDER THE PREVIOUS RULE. Before payroll readiness, Calculate
 * accepted an employee whose attendance was missing or unsettled; those rows
 * exist in production and must still be presented and gated correctly. The
 * new rule refuses to create them, so they are created here as the old code
 * did - with the day-row read switched off for the one calculate call.
 */
const calculateUnderPreviousRule = async (employeeId) => {
  world.legacy = true;
  try {
    return await calculation.calculate({ ...MONTH, employee_ids: [employeeId], actor: ACTOR });
  } finally {
    world.legacy = false;
  }
};
const monthView = () => calculation.getMonth({ ...MONTH });
const rowOf = async (employeeId) =>
  (await monthView()).rows.find((r) => r.employee_id === employeeId);

beforeEach(() => {
  build();
});

/* ============================================================== the tests */

describe("calculating", () => {
  it("calculates from the initialized snapshot and stores the figures", async () => {
    world.add(1);
    const result = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    assert.equal(result.calculated_count, 1);
    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.equal(Number(row.net_pay), 24301); // 26,000 - PF 1,560 - ESI 139
    assert.equal(row.calculation_revision, 1);
  });

  it("takes in only employees who are initialized for the month", async () => {
    world.add(1);
    const result = await calculation.calculate({ ...MONTH, employee_ids: [1, 999], actor: ACTOR });
    assert.equal(result.calculated_count, 1);
    assert.equal(result.not_in_scope_count, 1);
  });

  /**
   * "CALCULATE ALL ELIGIBLE" MEANS THE ONES WITH NO CALCULATION, and it is
   * decided on the server. An employee somebody has already reviewed is not
   * silently recomputed.
   */
  it("calculates everybody eligible, and skips those already calculated", async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const all = await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(all.calculated_count, 1);
    assert.deepEqual(all.results.map((r) => r.employee_id), [2]);

    const again = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(again.skipped_count, 1);
  });

  it("refuses employee_ids and all_eligible together rather than guessing", async () => {
    world.add(1);
    await assert.rejects(
      () => calculation.calculate({ ...MONTH, employee_ids: [1], all_eligible: true, actor: ACTOR }),
      /either employee_ids or all_eligible/
    );
  });
});

/* ------------------------------------------------- source change detection */

describe("a source that moves after the calculation", () => {
  /**
   * THE CENTRAL REQUIREMENT. A salary revision approved after the month was
   * calculated changes the STATUS and not one stored figure, and the employee
   * cannot be approved until somebody explicitly recalculates them.
   */
  it("is detected, changes no figure, and blocks approval", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const before = await rowOf(1);

    world.salaries.set(1, {
      employee_id: 1,
      salary_id: 9001,
      effective_from: "2026-08-01",
      monthly_gross: 30000,
    });

    const after = await rowOf(1);
    assert.equal(after.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.equal(after.net_pay, before.net_pay, "the stored net pay must not have moved");
    assert.ok(after.recalculation_reasons.some((r) => r.code === "SALARY_CHANGED"));

    const approval = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(approval.approved_count, 0);
    assert.equal(approval.blocked_count, 1);
  });

  it("notices an attendance re-run and an OT approval separately", async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });

    world.attendance.get(1).payroll_version = 2;
    world.attendance.get(2).approved_ot_minutes = 120;

    assert.ok((await rowOf(1)).recalculation_reasons.some((r) => r.code === "ATTENDANCE_CHANGED"));
    assert.ok((await rowOf(2)).recalculation_reasons.some((r) => r.code === "APPROVED_OT_CHANGED"));
  });

  it("notices an adjustment entered after the calculation", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    await adjustments.saveEmployee({
      ...MONTH,
      employee_id: 1,
      amounts: { [COMPONENT.INCENTIVE]: 1500 },
      actor: ACTOR,
    });

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(row.recalculation_reasons.some((r) => r.code === "ADJUSTMENTS_CHANGED"));
  });
  /**
   * THE MONTHLY PAY TYPE IS AN INPUT LIKE ANY OTHER, and this is what makes it
   * safe to leave the control on the Calculation & Review screen: changing it
   * after the month was calculated does not quietly re-sign the calculation.
   * It goes through the SAME inputs hash the adjustments go through, so the
   * employee falls to RECALCULATION_REQUIRED, their stored figures stay
   * exactly as they were, and approval refuses until somebody recalculates.
   */
  it("notices a pay type changed after the calculation, and blocks approval", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const before = await rowOf(1);
    assert.equal(before.status, CALC_STATUS.READY_FOR_APPROVAL);

    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR });

    const row = await rowOf(1);
    assert.equal(row.pay_type, "CASH", "the live monthly pay type is what the screen shows");
    assert.equal(row.calculated_pay_type, "BANK", "the CALCULATION still holds the old one");
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.equal(row.net_pay, before.net_pay, "no stored figure moved");

    const approval = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(approval.approved_count, 0);
    assert.equal(approval.blocked_count, 1);

    // And an explicit Recalculate is what settles it.
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    const settled = await rowOf(1);
    assert.equal(settled.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.equal(settled.calculated_pay_type, "CASH");
  });

  it("CASH -> BANK moves it back the same way", async () => {
    world.add(1);
    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);

    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "BANK", actor: ACTOR });
    const row = await rowOf(1);
    assert.equal(row.pay_type, "BANK");
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
  });

  it("changing it writes only the payrun row - the adjustments are untouched", async () => {
    world.add(1);
    await adjustments.saveEmployee({
      ...MONTH,
      employee_id: 1,
      amounts: { [COMPONENT.INCENTIVE]: 1200, [COMPONENT.ADVANCE_RECOVERY]: 300 },
      actor: ACTOR,
    });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR });

    assert.deepEqual(world.amounts.get(1), {
      [COMPONENT.INCENTIVE]: 1200,
      [COMPONENT.ADVANCE_RECOVERY]: 300,
    });
    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });
    assert.equal(Number(detail.breakup.adjustments.incentive), 1200);
  });
});

/* --------------------------------------------------------- recalculating */

describe("recalculating", () => {
  it("refreshes the source data and clears the stale status", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    // A revision, and an attendance month that now carries two extra days.
    world.salaries.set(1, {
      employee_id: 1,
      salary_id: 9001,
      effective_from: "2026-08-01",
      monthly_gross: 30000,
    });
    Object.assign(world.attendance.get(1), {
      payroll_version: 2,
      extra_days: 2,
      extra_day_earnings: 2000,
    });

    const result = await calculation.calculate({
      ...MONTH,
      employee_ids: [1],
      mode: "RECALCULATE",
      actor: ACTOR,
    });
    assert.equal(result.recalculated_count, 1);

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.equal(row.extra_days, 2);
    assert.equal(row.calculation_revision, 2);
  });

  /**
   * A RECALCULATION PRESERVES EVERYTHING THE PAYRUN OWNS. The adjustments and
   * the monthly pay type are read from the tables that own them and are never
   * written by this stage - so they come through a refresh untouched.
   */
  it("preserves the adjustments and the monthly pay type", async () => {
    world.add(1);
    await adjustments.saveEmployee({
      ...MONTH,
      employee_id: 1,
      amounts: {
        [COMPONENT.INCENTIVE]: 1000,
        [COMPONENT.ADVANCE_RECOVERY]: 500,
        [COMPONENT.BALANCE_ADVANCE]: 7000,
      },
      actor: ACTOR,
    });
    await payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR });

    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    world.attendance.get(1).payroll_version = 3;
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });

    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });
    assert.equal(Number(detail.breakup.adjustments.incentive), 1000);
    assert.equal(Number(detail.breakup.adjustments.advance_recovery), 500);
    assert.equal(Number(detail.breakup.adjustments.balance_advance), 7000);
    assert.equal(detail.breakup.final.pay_type, "CASH");
    assert.deepEqual(world.amounts.get(1), {
      [COMPONENT.INCENTIVE]: 1000,
      [COMPONENT.ADVANCE_RECOVERY]: 500,
      [COMPONENT.BALANCE_ADVANCE]: 7000,
    });
    assert.equal(world.states.get(1).confirmed_no_adjustment, 1);
  });

  it("will not recalculate somebody who has never been calculated", async () => {
    world.add(1);
    const result = await calculation.calculate({
      ...MONTH,
      employee_ids: [1],
      mode: "RECALCULATE",
      actor: ACTOR,
    });
    assert.equal(result.skipped_count, 1);
  });
});

/* ------------------------------------------------------- the ready rules */

describe("readiness", () => {
  it("blocks approval while the adjustment stage is not complete for the employee", async () => {
    world.add(1);
    world.states.delete(1); // nobody has said anything about this person
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.CALCULATED);
    assert.ok(row.blockers.some((b) => b.code === "ADJUSTMENT_PENDING_CONFIRMATION"));

    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);

    // ...and confirming it makes them ready, with nothing else changing.
    await adjustments.confirmNoAdjustment({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);
  });

  /**
   * ==================================================================
   * THE ATTENDANCE GATES LIVE HERE, AND NOWHERE ELSE, AND THEY HOLD.
   *
   * Initialization stopped refusing on attendance: an unsettled month, an
   * open regularization and an open OT approval no longer keep somebody out
   * of the payrun. THIS is the gate that replaced it, and these tests exist
   * to prove the change did not quietly move the refusal to nowhere. Each one
   * asserts the BLOCKER **and** that `approve` actually refuses - a blocker
   * nobody enforces is a label.
   * ==================================================================
   */
  it("a pending attendance regularization still refuses Approve & Lock", async () => {
    world.add(1);
    world.pending.set(1, { employee_id: 1, pending_regularizations: 1, pending_ot: 0 });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    assert.ok((await rowOf(1)).blockers.some((b) => b.code === "PENDING_ATTENDANCE_REGULARIZATION"));
    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  it("a pending OT approval still refuses Approve & Lock", async () => {
    world.add(1);
    world.pending.set(1, { employee_id: 1, pending_regularizations: 0, pending_ot: 1 });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    assert.ok((await rowOf(1)).blockers.some((b) => b.code === "PENDING_OT_APPROVAL"));
    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  it("attendance that is not final still refuses Approve & Lock", async () => {
    world.add(1);
    world.attendance.get(1).is_final = 0;
    // Calculate itself now refuses it, by name...
    const refusedCalc = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refusedCalc.blocked_count, 1);
    assert.ok(refusedCalc.results[0].blockers.some((b) => b.code === "ATTENDANCE_SUMMARY_NOT_FINAL"));
    // ...and a row calculated before the fix is still refused at approval.
    await calculateUnderPreviousRule(1);

    assert.ok((await rowOf(1)).blockers.some((b) => b.code === "ATTENDANCE_SUMMARY_NOT_FINAL"));
    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  it("an incomplete statutory setup still refuses Approve & Lock", async () => {
    world.add(2);
    world.employees.get(2).uan = null;
    world.employees.get(2).pf_number = null;
    await calculation.calculate({ ...MONTH, employee_ids: [2], actor: ACTOR });

    assert.ok((await rowOf(2)).blockers.some((b) => b.code === "STATUTORY_SETUP_INCOMPLETE"));
    const refused = await calculation.approve({ ...MONTH, employee_ids: [2], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
  });
});

/* -------------------------------------------------------- approve & lock */

describe("approving and locking", () => {
  it("approves one employee, and records who and when", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const result = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(result.approved_count, 1);

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.APPROVED_LOCKED);
    assert.equal(row.approved_by, 77);
    assert.ok(row.approved_at);
    assert.equal(row.locked_by, 77);
    assert.ok(row.locked_at);
    // THE APPROVAL IS RECORDED AGAINST A CALCULATION REFERENCE.
    assert.ok(row.calculation_hash);
    assert.ok(world.audit.some((a) => a.action === "APPROVE_LOCK" && a.employee_id === 1));
  });

  it("approves everybody ready in one act, by the same path", async () => {
    world.add(1).add(2).add(3);
    world.states.delete(3); // 3 is still pending confirmation
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });

    const result = await calculation.approve({ ...MONTH, all_ready: true, actor: ACTOR });
    assert.equal(result.approved_count, 2);

    const view = await monthView();
    assert.equal(view.summary.approved_locked, 2);
    assert.equal(view.summary.calculated, 1);
  });

  it("says so rather than approving twice", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const again = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(again.approved_count, 0);
    assert.equal(again.already_locked_count, 1);
  });
});

/* -------------------------------------------------------------- the lock */

describe("what a lock refuses", () => {
  beforeEach(async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
  });

  it("refuses to recalculate a locked employee", async () => {
    const result = await calculation.calculate({
      ...MONTH,
      employee_ids: [1],
      mode: "RECALCULATE",
      actor: ACTOR,
    });
    assert.equal(result.locked_count, 1);
    assert.equal(result.recalculated_count, 0);
  });

  it("refuses to change a locked employee's pay type", async () => {
    await assert.rejects(
      () => payrun.changePayType({ ...MONTH, employee_id: 1, pay_type: "CASH", actor: ACTOR }),
      /approved and locked/
    );
    assert.equal(world.employees.get(1).pay_type, "BANK");
  });

  it("refuses to edit a locked employee's adjustments", async () => {
    await assert.rejects(
      () =>
        adjustments.saveEmployee({
          ...MONTH,
          employee_id: 1,
          amounts: { [COMPONENT.INCENTIVE]: 5000 },
          actor: ACTOR,
        }),
      /approved and locked/
    );
    assert.equal(world.amounts.get(1), undefined);
  });

  /**
   * THE LOCK IS PER EMPLOYEE AND NEVER PER MONTH. Employee 2 is in the same
   * month, was calculated in the same act, and is completely unaffected by
   * employee 1 being approved.
   */
  it("leaves every other employee in the month fully editable", async () => {
    await payrun.changePayType({ ...MONTH, employee_id: 2, pay_type: "CASH", actor: ACTOR });
    assert.equal(world.employees.get(2).pay_type, "CASH");

    await adjustments.saveEmployee({
      ...MONTH,
      employee_id: 2,
      amounts: { [COMPONENT.BONUS]: 750 },
      actor: ACTOR,
    });
    assert.equal(world.amounts.get(2)[COMPONENT.BONUS], 750);

    const refreshed = await calculation.calculate({
      ...MONTH,
      employee_ids: [2],
      mode: "RECALCULATE",
      actor: ACTOR,
    });
    assert.equal(refreshed.recalculated_count, 1);
  });

  /** THE PAYSLIP ELIGIBILITY CONTRACT, per employee and both ways round. */
  it("approval alone is not payslip eligible; publishing the approved employee is, and the other stays not", async () => {
    let view = await monthView();
    assert.equal(view.rows.find((r) => r.employee_id === 1).payslip_eligible, false);
    assert.equal(view.summary.payslip_eligible, 0);

    await calculation.lifecycle({ ...MONTH, action: "PUBLISH", employee_ids: [1], mode: "INDIVIDUAL", actor: ACTOR });
    view = await monthView();
    const one = view.rows.find((r) => r.employee_id === 1);
    const two = view.rows.find((r) => r.employee_id === 2);
    assert.equal(one.status, CALC_STATUS.PUBLISHED);
    assert.equal(one.payslip_eligible, true);
    assert.equal(two.payslip_eligible, false);
    assert.equal(view.summary.payslip_eligible, 1);
  });
});

/* ------------------------------- the two rules the review pass corrected */

describe("the ESI contribution period, through the stage", () => {
  /**
   * THE EVIDENCE IS FETCHED BY THE SERVER, at the date the salary engine names
   * - which is a DIFFERENT date from the one the month is priced on, and
   * usually an earlier one. This proves the stage goes and gets it rather than
   * handing `calculateEsi` a wage and nothing else.
   */
  it("reads the approved salary in force at the contribution period's entry", async () => {
    world.add(1, {
      employee: {
        monthly_gross: 40000,
        basic: 20000,
        conveyance: 2500,
        hra: 10000,
        special_allowance: 7500,
      },
      attendance: { salary_day_earnings: 40000 },
    });
    /* Covered when the period began in April; well above the ceiling now. */
    world.salaries.set(1, {
      employee_id: 1,
      salary_id: 77,
      effective_from: "2026-04-01",
      monthly_gross: 20000,
      basic: 10000,
      conveyance: 2500,
      hra: 4000,
      special_allowance: 3500,
    });

    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });

    assert.equal(detail.breakup.statutory.esi_coverage_basis, "COVERED_AT_ENTRY");
    assert.equal(detail.breakup.statutory.esi_contribution_period_continues, true);
    assert.equal(detail.breakup.statutory.esi_period_start, "2026-04-01");
    assert.ok(
      Number(detail.breakup.statutory.employee_esi) > 0,
      "a covered employee contributes even above the ceiling"
    );
  });

  /**
   * THE COVERAGE BASIS IS A SOURCE. A revision back-dated into the month the
   * period began changes whether this month is covered while every other
   * marker stays put, so it has to make the calculation stale - with its own
   * reason, because "a salary changed" would send somebody to look at this
   * month's revision rather than at last April's.
   */
  it("goes stale when the entry salary changes, with its own reason", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);

    world.salaries.set(1, {
      employee_id: 1,
      salary_id: 999,
      effective_from: "2026-04-01",
      monthly_gross: 26000,
      basic: 13000,
      conveyance: 2500,
      hra: 5000,
      special_allowance: 5500,
    });

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(row.recalculation_reasons.some((r) => r.code === "ESI_COVERAGE_CHANGED"));
  });

  /** An unprovable position blocks the approval rather than zeroing quietly. */
  it("blocks approval when the position at entry cannot be established", async () => {
    world.add(1, {
      employee: {
        monthly_gross: 40000,
        basic: 20000,
        conveyance: 2500,
        hra: 10000,
        special_allowance: 7500,
      },
      attendance: { salary_day_earnings: 40000 },
    });
    world.salaries.delete(1); // nothing in force at entry

    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const row = await rowOf(1);

    assert.equal(row.employee_esi, null, "never a silent zero");
    assert.ok(row.blockers.some((b) => b.code === "CALCULATION_INCOMPLETE"));

    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
  });
});

describe("overtime across two NRMs, through the stage", () => {
  it("stores the per-group breakdown and the summed amount", async () => {
    world.add(1, {
      attendance: { approved_ot_minutes: 180 },
      nrm_groups: [
        { nrm_minutes: 660, break_allowance_source: "SHIFT", day_count: 10, approved_ot_minutes: 120 },
        { nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 16, approved_ot_minutes: 60 },
      ],
    });

    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });

    assert.equal(Number(detail.breakup.ot.ot_amount), 306.82);
    assert.equal(detail.breakup.ot.ot_groups.length, 2);
    assert.equal(detail.breakup.ot.ot_hourly_rate, null, "no single rate is claimed");
    assert.deepEqual(
      detail.breakup.ot.ot_groups.map((g) => [g.nrm_minutes, g.ot_amount]),
      [[480, 125], [660, 181.82]]
    );
  });

  /**
   * MOVING OT BETWEEN NRMS IS A SOURCE CHANGE, even when the total minutes and
   * the headline NRM are unchanged. Without the split in the markers it would
   * be invisible - and the amount would be different.
   */
  it("goes stale when the same total OT moves to a different NRM", async () => {
    world.add(1, {
      attendance: { approved_ot_minutes: 120 },
      nrm_groups: [
        { nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 20, approved_ot_minutes: 120 },
        { nrm_minutes: 660, break_allowance_source: "SHIFT", day_count: 6, approved_ot_minutes: 0 },
      ],
    });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const before = await rowOf(1);
    assert.equal(before.status, CALC_STATUS.READY_FOR_APPROVAL);

    world.nrm.set(1, [
      { employee_id: 1, nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 20, approved_ot_minutes: 0 },
      { employee_id: 1, nrm_minutes: 660, break_allowance_source: "SHIFT", day_count: 6, approved_ot_minutes: 120 },
    ]);

    const after = await rowOf(1);
    assert.equal(after.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(after.recalculation_reasons.some((r) => r.code === "EFFECTIVE_NRM_CHANGED"));

    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });
    assert.equal(Number(detail.breakup.ot.ot_amount), 181.82, "repriced on the NRM it moved to");
  });
});

/* ------------------------------------------------------------ the detail */

describe("one employee's breakup", () => {
  it("returns the stored calculation grouped as the review screen reads it", async () => {
    world.add(1, { attendance: { approved_ot_minutes: 120, extra_days: 1, extra_day_earnings: 1000 } });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1 });
    assert.equal(detail.breakup.salary.daily_rate, 1000);
    assert.equal(detail.breakup.salary.extra_day_amount, 1000);
    assert.equal(detail.breakup.ot.approved_ot_hours, 2);
    assert.equal(detail.breakup.ot.effective_nrm_minutes, 480);
    assert.equal(detail.breakup.ot.ot_hourly_rate, 125);
    assert.equal(detail.breakup.ot.ot_amount, 250);
    assert.equal(detail.breakup.statutory.pf_wage, 13000);
    assert.ok(detail.breakup.final.net_pay);
  });

  it("refuses an employee who is not initialized for the month", async () => {
    await assert.rejects(
      () => calculation.getEmployee({ ...MONTH, employee_id: 4242 }),
      /no initialized payrun/
    );
  });
});

/* ===================================================================== */
/*  the month an initialized employee has no attendance for              */
/* ===================================================================== */

/**
 * SEPTEMBER 2026, PRODUCTION: one employee initialized, no attendance month,
 * no final day rows, no approved OT, no adjustment - and Calculation & Review
 * showed a read failure with every counter at zero.
 *
 * THE FAILURE ITSELF WAS SCHEMA DRIFT, not this assembly path: the deployed
 * `payrun_employee_calculation` was missing eight columns the repository
 * selects, so the month's SELECT died in MySQL before any of this ran. That is
 * repaired by `migrations/.../20261024120000-payrun-calculation-column-drift`
 * and guarded by `migrations/payrun_calculation_column_drift.test.js`.
 *
 * THESE TESTS GUARD THE OTHER HALF: that the state itself - an initialized
 * employee with NOTHING from attendance - is a MONTH THAT LOADS, with the
 * employee in it, and never an API failure. Initialization stopped refusing on
 * attendance, so this state is now ordinary rather than impossible, and every
 * empty collection below has to be a valid input.
 *
 * NO RULE MOVES HERE. The employee is NOT_CALCULATED before anybody calculates
 * them, attendance that is missing is an approval blocker exactly as
 * attendance that is not final is, and Approve & Lock still refuses.
 */
describe("an initialized employee whose attendance does not exist yet", () => {
  /** Initialized, and nothing whatever from the attendance engine. */
  const addWithNoAttendance = (employeeId) => {
    world.add(employeeId);
    world.attendance.delete(employeeId);  // no attendance_monthly_payroll row
    world.nrm.delete(employeeId);         // no final attendance_day_calculation rows
    world.days.delete(employeeId);        // ...and no stored day rows at all
    world.pending.delete(employeeId);     // no approved and no pending OT
  };

  it("loads the month, and the employee is in it", async () => {
    addWithNoAttendance(1952);

    const month = await monthView();
    assert.equal(month.rows.length, 1);
    assert.equal(month.rows[0].employee_id, 1952);
    assert.equal(month.period_year, 2026);
    assert.equal(month.period_month, 8);
  });

  it("counts the employee as initialized and not calculated", async () => {
    addWithNoAttendance(1952);

    const month = await monthView();
    assert.equal(month.summary.initialized, 1);
    assert.equal(month.summary.not_calculated, 1);
    assert.equal(month.summary.ready_for_approval, 0);
    assert.equal(month.summary.approved_locked, 0);
  });

  it("is NOT_CALCULATED before the first calculation, and says so rather than failing", async () => {
    addWithNoAttendance(1952);

    const row = await rowOf(1952);
    assert.equal(row.status, CALC_STATUS.NOT_CALCULATED);
    assert.ok(row.blockers.some((b) => b.code === "NOT_CALCULATED"));
    assert.equal(row.net_pay, null);
    assert.equal(row.payslip_eligible, false);
  });

  it("loads with no NRM groups at all", async () => {
    world.add(1952);
    world.nrm.set(1952, []);  // nothing final, so no NRM evidence

    const month = await monthView();
    assert.equal(month.summary.initialized, 1);
    assert.ok(month.rows.some((r) => r.employee_id === 1952));
  });

  it("loads with no approved OT anywhere in the month", async () => {
    world.add(1952);
    world.attendance.get(1952).approved_ot_minutes = 0;
    world.nrm.set(1952, []);

    const month = await monthView();
    assert.equal(month.summary.initialized, 1);
    assert.equal((await rowOf(1952)).status, CALC_STATUS.NOT_CALCULATED);
  });

  it("loads for NO_ADJUSTMENT_CONFIRMED with no attendance", async () => {
    addWithNoAttendance(1952);
    world.states.set(1952, { employee_id: 1952, confirmed_no_adjustment: 1 });

    const row = await rowOf(1952);
    assert.equal(row.adjustment_state, "NO_ADJUSTMENT_CONFIRMED");
    assert.equal(row.status, CALC_STATUS.NOT_CALCULATED);
  });

  /**
   * THE GATE DID NOT MOVE. A missing attendance month is exactly as much of a
   * refusal at Approve & Lock as a non-final one - and the refusal is proved
   * by `approve` declining, not by the blocker being listed.
   */
  it("still refuses Approve & Lock once the month has been calculated", async () => {
    addWithNoAttendance(1952);
    // The new gate refuses to calculate it at all, naming why...
    const refusedCalc = await calculation.calculate({ ...MONTH, employee_ids: [1952], actor: ACTOR });
    assert.equal(refusedCalc.blocked_count, 1);
    assert.ok(refusedCalc.results[0].blockers.some((b) => b.code === "ATTENDANCE_MONTH_NOT_CALCULATED"));
    // ...and a month calculated under the previous rule is still not approvable.
    await calculateUnderPreviousRule(1952);

    const row = await rowOf(1952);
    // The month WAS calculated - the refusal below is the approval gate
    // refusing a calculated employee, not the absence of a calculation. The
    // VISIBLE status is ATTENDANCE_PENDING, because the figures it produced
    // were priced from an attendance month that is not settled.
    assert.equal(row.status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.ok(row.calculation_hash);
    assert.ok(row.blockers.some((b) => b.code === "ATTENDANCE_MONTH_NOT_CALCULATED"));

    const refused = await calculation.approve({ ...MONTH, employee_ids: [1952], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
    assert.notEqual((await rowOf(1952)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  /**
   * ONE EMPLOYEE'S MISSING DATA IS ONE EMPLOYEE'S PROBLEM. A month is six
   * hundred people; one of them with no attendance row must not take the other
   * five hundred and ninety-nine off the screen.
   */
  it("does not take the rest of the month down with it", async () => {
    world.add(1);                 // ordinary, fully attended
    addWithNoAttendance(1952);    // nothing from attendance at all
    world.add(2);
    world.attendance.get(2).is_final = 0;   // settled by the engine, but not final

    const month = await monthView();
    assert.equal(month.summary.initialized, 3);
    assert.deepEqual(month.rows.map((r) => r.employee_id).sort((a, b) => a - b), [1, 2, 1952]);
    month.rows.forEach((row) => assert.equal(row.status, CALC_STATUS.NOT_CALCULATED));
  });

  it("leaves an employee with final attendance behaving exactly as before", async () => {
    world.add(1);
    addWithNoAttendance(1952);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });

    const ordinary = await rowOf(1);
    assert.equal(ordinary.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.deepEqual(ordinary.blockers, []);
    assert.equal(ordinary.salary_days, 26);
    assert.ok(Number(ordinary.net_pay) > 0);

    const approved = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(approved.approved_count, 1);
    assert.equal((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
    assert.equal((await rowOf(1)).payslip_eligible, false, "eligible only once published");

    // ...and the one with no attendance is still there, still refused.
    assert.notEqual((await rowOf(1952)).status, CALC_STATUS.APPROVED_LOCKED);
  });
});

/* ===================================================================== */
/*  a provisional figure is not a result                                 */
/* ===================================================================== */

/**
 * SEPTEMBER 2026, EMPLOYEE 1952: the screen read CALCULATED, Salary Days 0,
 * Extra Days 0, Net Pay 0.00 for somebody whose attendance month had never
 * been settled. Every one of those zeroes was arithmetic on an attendance
 * month that does not exist, and in the column a payroll is read from a zero
 * is a statement that the person earned nothing.
 *
 * SO THE VISIBLE STATUS IS ATTENDANCE_PENDING AND THE ATTENDANCE-DEPENDENT
 * FIGURES ARE ABSENT. The stored calculation is untouched - it is still there,
 * still compared against the sources, still what a recalculation refreshes -
 * and what changed is only which of its figures this stage will present as an
 * answer.
 *
 * THE LINE IS DRAWN AT "DOES ATTENDANCE DECIDE THIS". Salary Days, Extra Days,
 * the OT, the PF, the ESI and the Net Pay are suppressed; the six adjustment
 * components and the pay type are not, because those are the payrun's own and
 * are as true now as they will be afterwards.
 *
 * AND A GENUINE ZERO IS NOT TOUCHED. The rule reads the attendance's
 * `is_final`, never the value of a figure, so a settled month that really does
 * come to nothing still says nothing rather than "not known".
 */
describe("attendance that is not settled is shown as pending, not as zero", () => {
  /** Initialized and calculated, with no attendance row at all. */
  const calculatedWithNoAttendance = async (employeeId) => {
    world.add(employeeId);
    world.attendance.delete(employeeId);
    world.nrm.delete(employeeId);
    world.days.delete(employeeId);
    await calculateUnderPreviousRule(employeeId);
  };

  /** Initialized and calculated, with an attendance month the engine has not finalized. */
  const calculatedWithNonFinalAttendance = async (employeeId) => {
    world.add(employeeId);
    world.attendance.get(employeeId).is_final = 0;
    await calculateUnderPreviousRule(employeeId);
  };

  it("a missing attendance month reads ATTENDANCE_PENDING", async () => {
    await calculatedWithNoAttendance(1952);

    const row = await rowOf(1952);
    assert.equal(row.status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.equal(row.status_label, "Attendance needs action");
    assert.equal(row.attendance_pending, true);
    // The exact reason, not a generic "Attendance incomplete".
    assert.ok(row.blockers.some((b) => b.code === "ATTENDANCE_MONTH_NOT_CALCULATED"));
    assert.ok(!row.blockers.some((b) => b.code === "ATTENDANCE_INCOMPLETE"));
  });

  it("an attendance month that is not final reads ATTENDANCE_PENDING", async () => {
    await calculatedWithNonFinalAttendance(1952);

    const row = await rowOf(1952);
    assert.equal(row.status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.equal(row.attendance_pending, true);
  });

  /**
   * THE SIX ATTENDANCE-DEPENDENT COLUMNS, EACH ASSERTED BY NAME. `null` is
   * what the list renders as an em dash; a zero here would be the bug.
   */
  it("suppresses Salary Days rather than showing a provisional zero", async () => {
    await calculatedWithNoAttendance(1952);
    assert.equal((await rowOf(1952)).salary_days, null);
  });

  it("suppresses Extra Days rather than showing a provisional zero", async () => {
    await calculatedWithNoAttendance(1952);
    assert.equal((await rowOf(1952)).extra_days, null);
  });

  it("suppresses Approved OT rather than showing a provisional zero", async () => {
    await calculatedWithNoAttendance(1952);
    assert.equal((await rowOf(1952)).approved_ot_hours, null);
  });

  it("suppresses PF rather than showing a provisional zero", async () => {
    await calculatedWithNoAttendance(1952);
    assert.equal((await rowOf(1952)).employee_pf, null);
  });

  it("suppresses ESI rather than showing a provisional zero", async () => {
    await calculatedWithNoAttendance(1952);
    assert.equal((await rowOf(1952)).employee_esi, null);
  });

  it("suppresses Net Pay rather than showing a provisional zero", async () => {
    await calculatedWithNoAttendance(1952);
    assert.equal((await rowOf(1952)).net_pay, null);
  });

  /**
   * AND THE PAYRUN'S OWN INPUTS SURVIVE, which is the other half of the rule.
   * Somebody entered these; blanking them would hide work already done.
   */
  it("keeps Additions and Deductions, which the payrun owns", async () => {
    world.add(1952);
    world.attendance.delete(1952);
    world.nrm.delete(1952);
    world.amounts.set(1952, {
      [COMPONENT.INCENTIVE]: 1500,
      [COMPONENT.BONUS]: 500,
      [COMPONENT.ADVANCE_RECOVERY]: 300,
    });
    await calculateUnderPreviousRule(1952);

    const row = await rowOf(1952);
    assert.equal(row.status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.equal(Number(row.additions), 2000);
    assert.equal(Number(row.deductions), 300);
  });

  it("keeps the pay type visible, and still editable before the lock", async () => {
    await calculatedWithNoAttendance(1952);

    assert.equal((await rowOf(1952)).pay_type, "BANK");

    // Editable: the adjustments stage still accepts the change, and it drops
    // the employee to RECALCULATION_REQUIRED through the inputs hash.
    await payrun.changePayType({ ...MONTH, employee_id: 1952, pay_type: "CASH", actor: ACTOR });

    const after = await rowOf(1952);
    assert.equal(after.pay_type, "CASH");
    assert.equal(after.status, CALC_STATUS.RECALCULATION_REQUIRED);
    // ...and the figures stay suppressed, because the attendance is still not
    // settled - stale figures from an unsettled month are provisional twice.
    assert.equal(after.attendance_pending, true);
    assert.equal(after.net_pay, null);
  });

  /**
   * THE DRAWER ANSWERS "WHY IS IT THAT NUMBER", so while there is no number
   * yet it has to say so rather than explain a zero in five groups.
   */
  it("the detail breakup suppresses the same provisional figures", async () => {
    world.add(1952);
    world.attendance.delete(1952);
    world.nrm.delete(1952);
    world.amounts.set(1952, { [COMPONENT.INCENTIVE]: 1500 });
    await calculateUnderPreviousRule(1952);

    const detail = await calculation.getEmployee({ ...MONTH, employee_id: 1952 });
    assert.equal(detail.status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.equal(detail.attendance_pending, true);

    const b = detail.breakup;
    assert.ok(b, "the stored calculation is still there to explain");

    assert.equal(b.salary.salary_days, null);
    assert.equal(b.salary.salary_earnings, null);
    assert.equal(b.salary.missing_hours, null);
    assert.equal(b.salary.missing_hours_deduction, null);
    assert.equal(b.salary.extra_days, null);
    assert.equal(b.salary.extra_day_amount, null);

    assert.equal(b.ot.approved_ot_hours, null);
    assert.equal(b.ot.ot_hourly_rate, null);
    assert.equal(b.ot.ot_amount, null);
    assert.deepEqual(b.ot.ot_groups, []);

    assert.equal(b.statutory.pf_wage, null);
    assert.equal(b.statutory.employee_pf, null);
    assert.equal(b.statutory.esi_wage, null);
    assert.equal(b.statutory.employee_esi, null);

    assert.equal(b.final.total_earnings, null);
    assert.equal(b.final.net_pay, null);

    // The salary snapshot, the adjustments and the pay type are facts that do
    // not wait on attendance, and are still shown.
    assert.ok(Number(b.salary.monthly_gross) > 0);
    assert.ok(Number(b.salary.daily_rate) > 0);
    assert.equal(Number(b.adjustments.incentive), 1500);
    assert.equal(b.final.pay_type, "BANK");
  });

  /**
   * AND IT COMES BACK. Attendance turning final is a SOURCE moving, so the
   * employee goes to RECALCULATION_REQUIRED by the existing rule - and after
   * the recalculation somebody performs, the real figures are shown under an
   * ordinary status.
   */
  it("restores the real figures once attendance is final and recalculated", async () => {
    await calculatedWithNonFinalAttendance(1952);
    assert.equal((await rowOf(1952)).net_pay, null);

    // The attendance engine settles the month.
    const attendance = world.attendance.get(1952);
    attendance.is_final = 1;
    attendance.payroll_version = 2;
    attendance.calculated_at = "2026-09-02 03:00:00.000";

    const stale = await rowOf(1952);
    assert.equal(stale.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(
      stale.recalculation_reasons.some((r) => r.code === "ATTENDANCE_CHANGED"),
      "attendance turning final is a source change"
    );
    assert.equal(stale.attendance_pending, false);

    await calculation.calculate({
      ...MONTH,
      employee_ids: [1952],
      mode: "RECALCULATE",
      actor: ACTOR,
    });

    const settled = await rowOf(1952);
    assert.equal(settled.attendance_pending, false);
    assert.equal(settled.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.equal(settled.salary_days, 26);
    assert.equal(settled.extra_days, 0);
    assert.ok(Number(settled.net_pay) > 0);
    assert.notEqual(settled.employee_pf, null);
    assert.notEqual(settled.employee_esi, null);
  });

  /**
   * THE DISTINCTION THE WHOLE CHANGE RESTS ON. A settled month that really
   * does come to zero says ZERO, because that is a fact about the employee and
   * somebody has to see it. The rule reads `is_final`, never the figure.
   */
  it("a genuine zero from a FINAL attendance month is still a zero", async () => {
    world.add(1952);
    const attendance = world.attendance.get(1952);
    attendance.is_final = 1;      // settled, and the answer is nothing
    attendance.salary_days = 0;
    attendance.extra_days = 0;
    attendance.salary_day_earnings = 0;
    attendance.extra_day_earnings = 0;
    attendance.approved_ot_minutes = 0;
    world.nrm.set(1952, []);
    await calculation.calculate({ ...MONTH, employee_ids: [1952], actor: ACTOR });

    const row = await rowOf(1952);
    assert.equal(row.attendance_pending, false);
    assert.notEqual(row.status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.equal(row.salary_days, 0);
    assert.equal(row.extra_days, 0);
    assert.equal(Number(row.net_pay), 0);
    assert.notEqual(row.net_pay, null);
  });

  /** THE GATE IS UNCHANGED, and it refuses through the blocker as it always did. */
  it("ATTENDANCE_PENDING can never be approved", async () => {
    await calculatedWithNoAttendance(1952);
    await calculatedWithNonFinalAttendance(1953);

    for (const employeeId of [1952, 1953]) {
      assert.equal((await rowOf(employeeId)).status, CALC_STATUS.ATTENDANCE_PENDING);
      const refused = await calculation.approve({
        ...MONTH,
        employee_ids: [employeeId],
        actor: ACTOR,
      });
      assert.equal(refused.approved_count, 0);
      assert.equal(refused.blocked_count, 1);
      assert.notEqual((await rowOf(employeeId)).status, CALC_STATUS.APPROVED_LOCKED);
      assert.equal((await rowOf(employeeId)).payslip_eligible, false);
    }
  });

  it("counts them separately from the calculated ones", async () => {
    await calculatedWithNoAttendance(1952);
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const month = await monthView();
    assert.equal(month.summary.initialized, 2);
    assert.equal(month.summary.attendance_pending, 1);
    assert.equal(month.summary.ready_for_approval, 1);
    assert.equal(month.summary.calculated, 0);
  });
});

/* ============ the three attendance rules that now share this stage ======== */

/**
 * ATTENDANCE_PENDING, the post-lock SOURCE_MOVED revalidation and the
 * attendance writer's payroll lock arrived from two directions - the first
 * from production, the other two from the attendance feature - and they must
 * coexist rather than one quietly disabling another.
 *
 * They act at three different moments, which is why they can:
 *
 *   ATTENDANCE_PENDING   presentation and readiness, BEFORE any approval:
 *                        unsettled attendance is a blocker and the figures it
 *                        would have produced are suppressed rather than shown
 *                        as zeroes.
 *   SOURCE_MOVED         inside the approval transaction, AFTER the row lock:
 *                        attendance that moved since the calculation was
 *                        prepared refuses the approval
 *                        (`repository/payrun_approval_source_revalidation.test.js`).
 *   the payroll lock     inside the attendance write's transaction, on the
 *                        same payrun row: an approved month refuses attendance
 *                        modification
 *                        (`repository/attendance_payroll_lock.test.js`).
 *
 * What is asserted here is the first one's half of the contract and the fact
 * that it does not reach - and therefore cannot bypass - the second.
 */
describe("ATTENDANCE_PENDING, and what it does NOT bypass", () => {
  it("an ATTENDANCE_PENDING employee is refused before the approval transaction is ever opened", async () => {
    world.add(1);
    world.attendance.get(1).is_final = 0;
    await calculateUnderPreviousRule(1);

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.equal(row.attendance_pending, true);
    assert.ok(row.blockers.some((b) => b.code === "ATTENDANCE_SUMMARY_NOT_FINAL"));

    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
    // The row never became APPROVED_LOCKED, so no attendance write is now
    // locked out on its account either.
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  it("the attendance gate at Approve & Lock is unchanged: regularization and OT still block", async () => {
    world.add(2);
    world.pending.set(2, { employee_id: 2, pending_regularizations: 1, pending_ot: 0 });
    await calculation.calculate({ ...MONTH, employee_ids: [2], actor: ACTOR });
    assert.ok((await rowOf(2)).blockers.some((b) => b.code === "PENDING_ATTENDANCE_REGULARIZATION"));
    assert.equal((await calculation.approve({ ...MONTH, employee_ids: [2], actor: ACTOR })).approved_count, 0);

    world.pending.set(2, { employee_id: 2, pending_regularizations: 0, pending_ot: 1 });
    await calculation.calculate({ ...MONTH, employee_ids: [2], mode: "RECALCULATE", actor: ACTOR });
    assert.ok((await rowOf(2)).blockers.some((b) => b.code === "PENDING_OT_APPROVAL"));
    assert.equal((await calculation.approve({ ...MONTH, employee_ids: [2], actor: ACTOR })).approved_count, 0);
  });

  it("settled attendance still approves - none of the three blocks a clean month", async () => {
    world.add(3);
    await calculation.calculate({ ...MONTH, employee_ids: [3], actor: ACTOR });
    assert.equal((await rowOf(3)).status, CALC_STATUS.READY_FOR_APPROVAL);

    const approved = await calculation.approve({ ...MONTH, employee_ids: [3], actor: ACTOR });
    assert.equal(approved.approved_count, 1);
    assert.equal((await rowOf(3)).status, CALC_STATUS.APPROVED_LOCKED);
  });
});

/* ===================================================================== */
/*  attendance accepted for payroll, through the calculation stage       */
/* ===================================================================== */

/**
 * WHAT A CLOSE DOES AT THIS STAGE, AND WHAT IT CAREFULLY DOES NOT.
 *
 * IT DOES: satisfy the attendance part of approval readiness, so the employee
 * can be approved on a basis somebody accepted; and stop the figures being
 * suppressed, because an accepted basis is what this person is being paid on
 * and has to be visible before anybody signs it.
 *
 * IT DOES NOT: claim the attendance is final, hide a later source change, or
 * survive as a reason to skip a recalculation. The close is about the gate,
 * never about the arithmetic.
 */
describe("attendance closed for payroll", () => {
  /** Unsettled attendance, with a pending regularization and a pending OT. */
  const unsettled = (employeeId, over = {}) => {
    world.add(employeeId, over);
    world.attendance.get(employeeId).is_final = 0;
    world.pending.set(employeeId, {
      employee_id: employeeId,
      pending_regularizations: 1,
      pending_ot: 1,
    });
  };

  it("an employee who was NOT closed stays blocked from approval", async () => {
    unsettled(1);
    const refusedCalc = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refusedCalc.blocked_count, 1, "an unclosed, unsettled month is not calculable");
    await calculateUnderPreviousRule(1);

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.ok(row.blockers.some((b) => b.code === "ATTENDANCE_SUMMARY_NOT_FINAL"));
    assert.ok(row.blockers.some((b) => b.code === "PENDING_ATTENDANCE_REGULARIZATION"));
    assert.ok(row.blockers.some((b) => b.code === "PENDING_OT_APPROVAL"));

    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
    assert.equal(refused.blocked_count, 1);
  });

  it("a closed employee can be calculated and shows the accepted figures", async () => {
    unsettled(1, { employee: { attendance_closed_for_payroll: 1 } });
    const result = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(result.calculated_count, 1);

    const row = await rowOf(1);
    /* NOT suppressed: an accepted basis is not provisional. */
    assert.equal(row.attendance_pending, false);
    assert.notEqual(row.salary_days, null);
    assert.notEqual(row.net_pay, null);
    assert.equal(row.attendance_closed_for_payroll, true);
  });

  it("a close satisfies the attendance portion of approval readiness", async () => {
    unsettled(1, { employee: { attendance_closed_for_payroll: 1 } });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.READY_FOR_APPROVAL);
    assert.deepEqual(row.blockers, []);

    const approved = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(approved.approved_count, 1);
    assert.equal((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  /**
   * AND THE OTHER GATES ARE UNTOUCHED. The close accepts ATTENDANCE. It is not
   * a general waiver, and an employee whose adjustment stage is incomplete is
   * refused exactly as before.
   */
  it("it waives attendance and nothing else", async () => {
    unsettled(2, { employee: { attendance_closed_for_payroll: 1 } });
    world.states.delete(2); // nobody has confirmed the adjustments
    await calculation.calculate({ ...MONTH, employee_ids: [2], actor: ACTOR });

    const row = await rowOf(2);
    assert.ok(row.blockers.some((b) => b.code === "ADJUSTMENT_PENDING_CONFIRMATION"));
    assert.notEqual(row.status, CALC_STATUS.READY_FOR_APPROVAL);
    const refused = await calculation.approve({ ...MONTH, employee_ids: [2], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
  });

  /* ------------ 12-13: a source that moves AFTER the close -------------- */

  it("attendance changing after the close requires an explicit recalculation", async () => {
    unsettled(1, { employee: { attendance_closed_for_payroll: 1 } });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);

    const storedBefore = { ...world.calculations.get(1) };

    // The regularization is decided and attendance is re-run.
    const attendance = world.attendance.get(1);
    attendance.is_final = 1;
    attendance.payroll_version = 2;
    attendance.calculated_at = "2026-09-02 03:00:00.000";
    attendance.salary_days = 25;

    const stale = await rowOf(1);
    assert.equal(stale.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(stale.recalculation_reasons.some((r) => r.code === "ATTENDANCE_CHANGED"));

    /* NOTHING WAS SILENTLY REPLACED. The stored figures are exactly what they
       were; only the status says they no longer describe the sources. */
    assert.deepEqual({ ...world.calculations.get(1) }, storedBefore);

    const refused = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
  });

  it("approved OT granted after the close is named as the reason", async () => {
    unsettled(1, { employee: { attendance_closed_for_payroll: 1 } });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    world.attendance.get(1).approved_ot_minutes = 60;
    world.nrm.set(1, [
      { employee_id: 1, nrm_minutes: 480, break_allowance_source: NRM_SOURCE.SHIFT, day_count: 26, approved_ot_minutes: 60 },
    ]);

    const stale = await rowOf(1);
    assert.equal(stale.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(
      stale.recalculation_reasons.some((r) => r.code === "APPROVED_OT_CHANGED"),
      "the reason should name the overtime"
    );
  });

  it("the close survives the recalculation it required", async () => {
    unsettled(1, { employee: { attendance_closed_for_payroll: 1 } });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    world.attendance.get(1).payroll_version = 2;
    assert.equal((await rowOf(1)).status, CALC_STATUS.RECALCULATION_REQUIRED);

    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });

    const row = await rowOf(1);
    /* The snapshot's close is untouched by any calculation path, so the
       employee is ready again without anybody closing them a second time. */
    assert.equal(row.attendance_closed_for_payroll, true);
    assert.equal(row.status, CALC_STATUS.READY_FOR_APPROVAL);
  });

  it("a locked employee is frozen, close or no close", async () => {
    unsettled(1, { employee: { attendance_closed_for_payroll: 1 } });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const before = { ...world.calculations.get(1) };
    world.attendance.get(1).payroll_version = 9;

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.APPROVED_LOCKED);

    const refused = await calculation.calculate({
      ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR,
    });
    assert.equal(refused.recalculated_count || 0, 0);
    assert.deepEqual({ ...world.calculations.get(1) }, before);
  });

  /**
   * AND THE DISTINCTION SURVIVES. A closed employee's figures are real and
   * shown - including a genuine zero - but the row still says the basis was
   * accepted rather than settled, so nobody reads it as a finished month.
   */
  it("a genuine zero on an accepted basis still displays as zero", async () => {
    world.add(1, { employee: { attendance_closed_for_payroll: 1 } });
    const attendance = world.attendance.get(1);
    attendance.is_final = 0;
    attendance.salary_days = 0;
    attendance.extra_days = 0;
    attendance.salary_day_earnings = 0;
    attendance.extra_day_earnings = 0;
    world.nrm.set(1, []);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });

    const row = await rowOf(1);
    assert.equal(row.attendance_pending, false);
    assert.equal(row.salary_days, 0);
    assert.notEqual(row.salary_days, null);
    assert.equal(Number(row.net_pay), 0);
    assert.equal(row.attendance_closed_for_payroll, true);
  });
});

/* ============ a stale monthly attendance summary is refused, with why ==== */

describe("ATTENDANCE_STALE at Approve & Lock", () => {
  it("is BLOCKED with the instruction to recalculate attendance, and nothing is locked", async () => {
    const { calcRepo } = build();
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    calcRepo.approve = async ({ employees }) =>
      employees.map((e) => ({ employee_id: e.employee_id, outcome: "ATTENDANCE_STALE", reason: "DAYS_CHANGED" }));
    const out = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(out.approved_count, 0);
    assert.equal(out.blocked_count, 1);
    const [row] = out.results;
    assert.equal(row.attendance_stale, "DAYS_CHANGED");
    assert.match(row.message, /Recalculate Attendance for this employee and month/);
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  it("an UNTRACKED summary is refused with the upgrade condition, not the stale-days message", async () => {
    const { calcRepo } = build();
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    calcRepo.approve = async ({ employees }) =>
      employees.map((e) => ({ employee_id: e.employee_id, outcome: "ATTENDANCE_STALE", reason: "UNTRACKED" }));
    const out = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(out.blocked_count, 1);
    const [row] = out.results;
    assert.equal(row.attendance_stale, "UNTRACKED");
    assert.match(row.message, /before attendance freshness tracking was introduced/);
    assert.match(row.message, /Recalculate Attendance once/);
    assert.match(row.message, /then recalculate Payroll before approving and locking/);
    assert.doesNotMatch(row.message, /days changed/);
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });
});

/* ====================================================== Reset Calculation */

describe("Reset Calculation", () => {
  const reset = (over = {}) =>
    calculation.reset({
      ...MONTH,
      reason: "ATTENDANCE_CORRECTED",
      mode: "INDIVIDUAL",
      actor: ACTOR,
      ...over,
    });
  const lock = (employeeId) => {
    const row = world.calculations.get(employeeId);
    row.status = "APPROVED_LOCKED";
    row.approved_by = 5;
  };

  it("resets one calculated employee back to NOT CALCULATED", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);

    const result = await reset({ employee_ids: [1] });
    assert.equal(result.reset_count, 1);
    assert.equal(result.results[0].result, ROW_RESULT.RESET);
    assert.equal(result.results[0].previous_status, CALC_STATUS.READY_FOR_APPROVAL);

    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.NOT_CALCULATED);
    assert.equal(row.net_pay, null);
    assert.equal(world.calculations.has(1), false);
  });

  it("leaves every other employee's calculation exactly as it was", async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, employee_ids: [1, 2], actor: ACTOR });
    const before = JSON.stringify(world.calculations.get(2));

    await reset({ employee_ids: [1] });
    assert.equal(JSON.stringify(world.calculations.get(2)), before);
    assert.equal((await rowOf(2)).status, CALC_STATUS.READY_FOR_APPROVAL);
  });

  it("keeps the payrun's own inputs: adjustments, confirmation and pay type", async () => {
    world.add(1);
    world.amounts.set(1, { [COMPONENT.INCENTIVE]: 500 });
    world.employees.get(1).pay_type = "CASH";
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const sources = JSON.stringify([
      world.employees.get(1), world.amounts.get(1), world.states.get(1),
      world.attendance.get(1), world.salaries.get(1), world.nrm.get(1), world.pending.get(1),
    ]);

    await reset({ employee_ids: [1] });
    assert.equal(
      JSON.stringify([
        world.employees.get(1), world.amounts.get(1), world.states.get(1),
        world.attendance.get(1), world.salaries.get(1), world.nrm.get(1), world.pending.get(1),
      ]),
      sources
    );
  });

  it("blocks an Approved & Locked employee with a clear message and changes nothing", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    lock(1);

    const result = await reset({ employee_ids: [1] });
    assert.equal(result.reset_count, 0);
    assert.equal(result.locked_count, 1);
    assert.match(result.results[0].message, /Approved & Locked/);
    assert.equal(world.calculations.get(1).status, "APPROVED_LOCKED");
    assert.equal(world.resets.length, 0);
  });

  it("blocks every employee in a locked (finalized) payroll month", async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, employee_ids: [1, 2], actor: ACTOR });
    world.period = { status: "LOCKED" };

    const result = await reset({ employee_ids: [1, 2], mode: "BULK" });
    assert.equal(result.reset_count, 0);
    assert.equal(result.locked_count, 2);
    assert.match(result.results[0].message, /month 2026-08 is locked/);
    assert.equal(world.calculations.size, 2);
  });

  it("bulk: resets the eligible, skips the locked and the not-calculated, and fails nothing", async () => {
    world.add(1).add(2).add(3).add(4).add(5);
    await calculation.calculate({ ...MONTH, employee_ids: [1, 2, 3, 4], actor: ACTOR });
    lock(3);
    lock(4);

    const result = await reset({ employee_ids: [1, 2, 3, 4, 5, 999], mode: "BULK" });
    assert.equal(result.reset_count, 2);
    assert.equal(result.locked_count, 2);
    assert.equal(result.skipped_count, 1);
    assert.equal(result.not_in_scope_count, 1);
    assert.deepEqual(
      result.results.map((r) => [r.employee_id, r.result]),
      [[1, "RESET"], [2, "RESET"], [3, "LOCKED"], [4, "LOCKED"], [5, "SKIPPED"], [999, "NOT_IN_SCOPE"]]
    );
    assert.deepEqual([...world.calculations.keys()].sort(), [3, 4]);
    assert.ok(world.resets.every((r) => r.reset_mode === "BULK"));
  });

  it("one employee's failure does not stop the rest of the batch", async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, employee_ids: [1, 2], actor: ACTOR });
    world.failResetFor.add(1);

    const result = await reset({ employee_ids: [1, 2], mode: "BULK" });
    assert.equal(result.failed_count, 1);
    assert.equal(result.reset_count, 1);
    assert.equal(world.calculations.has(1), true, "the failed employee keeps their calculation");
    assert.equal(world.calculations.has(2), false);
  });

  it("enforces the branch scope: an employee outside it is NOT_IN_SCOPE and untouched", async () => {
    world.add(1).add(2, { employee: { store_id: 2, store_name: "Branch 2" } });
    await calculation.calculate({ ...MONTH, employee_ids: [1, 2], actor: ACTOR });

    const result = await reset({ employee_ids: [1, 2], mode: "BULK", store_ids: [1] });
    assert.equal(result.reset_count, 1);
    assert.equal(result.not_in_scope_count, 1);
    assert.equal(world.calculations.has(2), true);

    const none = await reset({ employee_ids: [2], store_ids: [] });
    assert.equal(none.not_in_scope_count, 1, "an empty scope is no branches, never all of them");
    assert.equal(world.calculations.has(2), true);
  });

  it("is idempotent: a second reset finds nothing to reset and writes no audit", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await reset({ employee_ids: [1] });
    const again = await reset({ employee_ids: [1] });
    assert.equal(again.skipped_count, 1);
    assert.match(again.results[0].message, /nothing to reset/);
    assert.equal(world.resets.length, 1);
  });

  it("requires a reason from the closed list", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    for (const reason of [undefined, null, "", "BECAUSE"]) {
      await assert.rejects(() => reset({ employee_ids: [1], reason }), /reset reason is required/);
    }
    assert.equal(world.calculations.has(1), true);
  });

  it("requires a remark for Other, and caps its length", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await assert.rejects(() => reset({ employee_ids: [1], reason: "OTHER" }), /remark is required/);
    await assert.rejects(
      () => reset({ employee_ids: [1], reason: "OTHER", remark: "   " }),
      /remark is required/
    );
    await assert.rejects(
      () => reset({ employee_ids: [1], reason: "WRONG_OT", remark: "x".repeat(501) }),
      /at most 500/
    );
    assert.equal(world.calculations.has(1), true);

    const ok = await reset({ employee_ids: [1], reason: "OTHER", remark: "  Joined late, HR fixed DOJ  " });
    assert.equal(ok.reset_count, 1);
    assert.equal(world.resets[0].reset_remark, "Joined late, HR fixed DOJ");
  });

  it("an INDIVIDUAL reset names exactly one employee; the mode must be one of the two", async () => {
    world.add(1).add(2);
    await assert.rejects(() => reset({ employee_ids: [1, 2] }), /exactly one employee/);
    await assert.rejects(() => reset({ employee_ids: [1], mode: "ALL" }), /mode must be one of/);
    await assert.rejects(() => reset({ employee_ids: [] }), /must not be empty/);
  });

  it("validates the month and writes the audit against the requested month only", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await assert.rejects(() => reset({ employee_ids: [1], month: 13 }), /month 1-12/);

    await reset({ employee_ids: [1], reason: "WRONG_ADDITION_DEDUCTION", remark: "bonus typo" });
    assert.deepEqual(
      {
        ...world.resets[0],
      },
      {
        employee_id: 1,
        period_year: 2026,
        period_month: 8,
        payrun_employee_id: 101,
        payrun_calculation_id: world.resets[0].payrun_calculation_id,
        previous_status: CALC_STATUS.READY_FOR_APPROVAL,
        previous_stored_status: "CALCULATED",
        reset_reason: "WRONG_ADDITION_DEDUCTION",
        reset_remark: "bonus typo",
        reset_mode: "INDIVIDUAL",
        reset_by: 77,
        net_pay: world.resets[0].net_pay,
      }
    );
    assert.equal(Number(world.resets[0].net_pay), 24301);
  });

  it("resets a RECALCULATION_REQUIRED employee too, and recalculating gives a fresh revision-1 calculation from current sources", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(world.calculations.get(1).calculation_revision, 2);

    // Attendance corrected: one fewer salary day, as a re-run would store it.
    Object.assign(world.attendance.get(1), {
      salary_days: 25, salary_day_earnings: 25000, payroll_version: 2,
      calculated_at: "2026-09-03 02:00:00.000",
    });
    assert.equal((await rowOf(1)).status, CALC_STATUS.RECALCULATION_REQUIRED);

    const result = await reset({ employee_ids: [1] });
    assert.equal(result.results[0].previous_status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.equal((await rowOf(1)).status, CALC_STATUS.NOT_CALCULATED);

    const again = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(again.calculated_count, 1);
    const fresh = world.calculations.get(1);
    assert.equal(fresh.calculation_revision, 1);
    assert.equal(fresh.salary_days, 25);
    assert.equal(fresh.attendance_payroll_version, 2);
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);
  });
});

/* ============================================= payroll readiness (shared) */

/**
 * THE MONTH PERSIST, AS FAR AS PAYROLL CAN SEE IT: the summary recomputed from
 * the stored days (finality, approved OT) with a fresh fingerprint and a new
 * version, and the NRM groups re-read from the same days. It is what
 * `attendanceCalculationUsecase.calculateMonth({ persist: true })` leaves
 * behind, and the ONLY thing Process Attendance may call.
 */
function fakeAttendanceProcessor() {
  const calls = [];
  return {
    calls,
    async calculateMonth({ employee_id, year, month, persist }) {
      calls.push({ employee_id, year, month, persist });
      const days = world.days.get(employee_id) || [];
      const final = days.filter((d) => Number(d.is_final) === 1);
      const summary = world.attendance.get(employee_id) || {
        employee_id, attendance_monthly_payroll_id: 900 + employee_id, payroll_version: 0,
        salary_days: 26, extra_days: 0, salary_day_earnings: 26000, extra_day_earnings: 0,
        shortage_minutes: 0, missing_minute_deduction: 0, approved_ot_earnings: 0,
      };
      Object.assign(summary, {
        is_final: final.length === days.length ? 1 : 0,
        approved_ot_minutes: final.reduce((t, d) => t + Number(d.approved_ot_minutes || 0), 0),
        payroll_version: Number(summary.payroll_version) + 1,
        calculated_at: "2026-10-03 09:00:00.000",
        day_rows_fingerprint: dayRowsFingerprint(days),
      });
      world.attendance.set(employee_id, summary);
      const groups = new Map();
      final.filter((d) => Number(d.nrm_minutes) > 0).forEach((d) => {
        const g = groups.get(d.nrm_minutes) || {
          employee_id, nrm_minutes: d.nrm_minutes, break_allowance_source: "SHIFT", day_count: 0, approved_ot_minutes: 0,
        };
        g.day_count += 1;
        g.approved_ot_minutes += Number(d.approved_ot_minutes || 0);
        groups.set(d.nrm_minutes, g);
      });
      world.nrm.set(employee_id, [...groups.values()]);
      return {};
    },
  };
}

const dayOf = (employeeId, date) => world.days.get(employeeId).find((d) => d.attendance_date === date);
const codesOf = (row) => row.blockers.map((b) => b.code);

describe("Problem 1 - Attendance Pending reads the real, authoritative reason", () => {
  /** Persisted while 7 Aug awaited a regularization; approved afterwards. */
  const settledAfterProcessing = (employeeId) => {
    world.add(employeeId);
    const day = dayOf(employeeId, "2026-08-07");
    day.status = "REGULARIZATION_PENDING";
    day.is_final = 0;
    world.attendance.get(employeeId).is_final = 0;
    world.attendance.get(employeeId).day_rows_fingerprint = dayRowsFingerprint(world.days.get(employeeId));
    // The approval rewrites the DAY only - the summary is not refreshed.
    day.status = "FINAL";
    day.is_final = 1;
  };

  it("a month settled after it was processed is STALE, not 'Attendance incomplete', and Process Attendance clears it", async () => {
    settledAfterProcessing(1);
    let row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.NOT_CALCULATED);
    assert.equal(row.calculable, false);
    assert.equal(row.attendance_processable, true);
    assert.ok(codesOf(row).includes("ATTENDANCE_STALE"));
    assert.ok(!codesOf(row).includes("ATTENDANCE_INCOMPLETE"));

    const processor = fakeAttendanceProcessor();
    calculation.setAttendanceProcessor(processor);
    const processed = await calculation.processAttendance({ ...MONTH, employee_ids: [1] });
    assert.equal(processed.processed_count, 1);
    assert.equal(processed.cleared_count, 1);
    assert.deepEqual(processor.calls, [{ employee_id: 1, year: 2026, month: 8, persist: true }]);

    row = await rowOf(1);
    assert.equal(row.calculable, true);
    const result = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(result.calculated_count, 1);
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);
  });

  it("an ALREADY CALCULATED employee in that state moves out of Attendance Pending once attendance is processed", async () => {
    world.add(1);
    world.attendance.get(1).is_final = 0; // summary persisted mid-way
    await calculateUnderPreviousRule(1);
    assert.equal((await rowOf(1)).status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.ok(codesOf(await rowOf(1)).includes("ATTENDANCE_SUMMARY_NOT_FINAL"));

    calculation.setAttendanceProcessor(fakeAttendanceProcessor());
    await calculation.processAttendance({ ...MONTH, employee_ids: [1] });
    const row = await rowOf(1);
    // The summary moved, so the stored figures are recalculated deliberately.
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.equal(row.attendance_pending, false);
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);
  });

  it("genuinely incomplete attendance names the date and status, and Process Attendance does not pretend to fix it", async () => {
    world.add(1);
    const day = dayOf(1, "2026-08-07");
    day.status = "REGULARIZATION_PENDING";
    day.is_final = 0;
    world.attendance.get(1).is_final = 0;
    world.attendance.get(1).day_rows_fingerprint = dayRowsFingerprint(world.days.get(1));

    const row = await rowOf(1);
    const reason = row.blockers.find((b) => b.code === "ATTENDANCE_DAY_ROWS_INCOMPLETE");
    assert.ok(reason);
    assert.match(reason.message, /2026-08-07 \(REGULARIZATION_PENDING\)/);
    assert.equal(row.attendance_processable, false);

    const processor = fakeAttendanceProcessor();
    calculation.setAttendanceProcessor(processor);
    const processed = await calculation.processAttendance({ ...MONTH, employee_ids: [1] });
    assert.equal(processed.skipped_count, 1);
    assert.match(processed.results[0].message, /would not clear this/);
    assert.equal(processor.calls.length, 0, "the engine is not run where it cannot help");
  });

  it("a summary processed mid-month names the dates never processed, and processing fills them", async () => {
    world.add(1);
    world.days.set(1, world.days.get(1).slice(0, 15));
    world.attendance.get(1).day_rows_fingerprint = dayRowsFingerprint(world.days.get(1));
    const row = await rowOf(1);
    const reason = row.blockers.find((b) => b.code === "ATTENDANCE_DAY_ROWS_INCOMPLETE");
    assert.deepEqual(reason.missing_dates.slice(0, 2), ["2026-08-16", "2026-08-17"]);
    assert.equal(reason.missing_dates.length, 16);
    assert.equal(row.attendance_processable, true);
  });

  it("no attendance month at all reads ATTENDANCE_MONTH_NOT_CALCULATED", async () => {
    world.add(1);
    world.attendance.delete(1);
    const row = await rowOf(1);
    assert.ok(codesOf(row).includes("ATTENDANCE_MONTH_NOT_CALCULATED"));
    assert.equal(row.calculable, false);
  });

  it("pending approvals are named and an explicit Close Attendance for Payroll still accepts them", async () => {
    world.add(1).add(2, { employee: { attendance_closed_for_payroll: 1 } });
    [1, 2].forEach((id) => world.pending.set(id, { employee_id: id, pending_regularizations: 1, pending_ot: 1 }));
    const open = await rowOf(1);
    assert.ok(codesOf(open).includes("PENDING_ATTENDANCE_REGULARIZATION"));
    assert.ok(codesOf(open).includes("PENDING_OT_APPROVAL"));
    assert.equal(open.calculable, false);
    const closed = await rowOf(2);
    assert.equal(closed.calculable, true);
  });
});

describe("Problem 2 - Calculate All Eligible counts only what Calculate accepts", () => {
  /** OT approved for 5 Aug AFTER the month was processed: day 84, summary 0. */
  const otApprovedAfterProcessing = (employeeId) => {
    world.add(employeeId);
    dayOf(employeeId, "2026-08-01").approved_ot_minutes = 84;
    world.nrm.get(employeeId)[0].approved_ot_minutes = 84; // the day rows payroll groups
  };
  /** Approved OT on a final day with NRM 0 - summary and fingerprint agree. */
  const otOnRestDay = (employeeId) => {
    world.add(employeeId);
    const day = dayOf(employeeId, "2026-08-30");
    day.nrm_minutes = 0;
    day.approved_ot_minutes = 60;
    world.attendance.get(employeeId).approved_ot_minutes = 60;
    world.attendance.get(employeeId).day_rows_fingerprint = dayRowsFingerprint(world.days.get(employeeId));
  };

  it("reproduces the defect: the old count included employees Calculate rejects", async () => {
    otApprovedAfterProcessing(1);
    // The previous rule - eligible means "not calculated" - counted it...
    world.legacy = true;
    const before = await monthView();
    world.legacy = false;
    assert.equal(before.summary.not_calculated, 1);
    // ...and the calculation itself rejects it.
    world.legacy = true;
    const failed = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    world.legacy = false;
    assert.equal(failed.failed_count, 1);
    assert.match(failed.results[0].message, /Approved OT does not reconcile: the attendance month reports 0 minutes and its day rows report 84/);
    assert.equal(world.calculations.has(1), false);
  });

  it("an OT mismatch is not eligible, names the date, and is refused by Calculate as BLOCKED rather than FAILED", async () => {
    otApprovedAfterProcessing(1);
    const month = await monthView();
    assert.equal(month.summary.not_calculated, 1);
    assert.equal(month.summary.eligible_to_calculate, 0);
    assert.equal(month.summary.not_calculated_blocked, 1);
    const row = month.rows[0];
    const ot = row.blockers.find((b) => b.code === "APPROVED_OT_MISMATCH");
    assert.match(ot.message, /0 approved OT minutes but the settled days have 84 \(2026-08-01: 84\)/);
    assert.ok(codesOf(row).includes("ATTENDANCE_STALE"));

    const all = await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(all.results.length, 0, "Calculate All Eligible does not include it");
    const one = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(one.blocked_count, 1);
    assert.equal(one.failed_count, 0);
    assert.equal(world.attendance.get(1).approved_ot_minutes, 0, "approved OT was not silently altered");
    assert.equal(dayOf(1, "2026-08-01").approved_ot_minutes, 84);

    calculation.setAttendanceProcessor(fakeAttendanceProcessor());
    await calculation.processAttendance({ ...MONTH, employee_ids: [1] });
    const after = await monthView();
    assert.equal(after.summary.eligible_to_calculate, 1);
    const calculated = await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(calculated.calculated_count, 1);
    assert.equal(world.calculations.get(1).approved_ot_minutes, 84);
  });

  it("OT on a day with no NRM is an NRM_MISMATCH with the date; processing cannot clear it and is not run", async () => {
    otOnRestDay(1);
    const row = await rowOf(1);
    const nrm = row.blockers.find((b) => b.code === "NRM_MISMATCH");
    assert.match(nrm.message, /2026-08-30 \(60 min\)/);
    assert.equal(row.calculable, false);
    assert.equal(row.attendance_processable, false);
    const processor = fakeAttendanceProcessor();
    calculation.setAttendanceProcessor(processor);
    const processed = await calculation.processAttendance({ ...MONTH, employee_ids: [1] });
    assert.equal(processed.skipped_count, 1);
    assert.equal(processor.calls.length, 0);
  });

  it("a snapshot with no salary is SALARY_NOT_READY and not eligible", async () => {
    world.add(1, { employee: { monthly_gross: null, basic: null } });
    const row = await rowOf(1);
    assert.ok(codesOf(row).includes("SALARY_NOT_READY"));
    assert.equal(row.calculable, false);
  });

  it("THE INVARIANT: on a mixed month, the eligible count equals exactly what Calculate All Eligible calculates", async () => {
    world.add(1).add(2).add(3); // clean
    otApprovedAfterProcessing(4);
    otOnRestDay(5);
    world.add(6);
    world.attendance.delete(6);
    world.add(7, { employee: { monthly_gross: null } });
    world.add(8);
    dayOf(8, "2026-08-02").is_final = 0; // settled? no - and summary now stale
    dayOf(8, "2026-08-02").status = "REVIEW_REQUIRED";

    const before = await monthView();
    assert.equal(before.summary.not_calculated, 8);
    assert.equal(before.summary.eligible_to_calculate, 3);

    const result = await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(result.calculated_count, before.summary.eligible_to_calculate);
    assert.equal(result.failed_count, 0);
    assert.deepEqual(result.results.map((r) => r.employee_id).sort(), [1, 2, 3]);

    // And every employee counted eligible calculates individually too.
    world.calculations.clear();
    for (const id of before.rows.filter((r) => r.calculable).map((r) => r.employee_id)) {
      const one = await calculation.calculate({ ...MONTH, employee_ids: [id], actor: ACTOR });
      assert.equal(one.calculated_count, 1, `employee ${id} was counted eligible but did not calculate`);
    }
  });
});

describe("Process Attendance - safety", () => {
  it("never touches an Approved & Locked employee or a locked month", async () => {
    world.add(1).add(2);
    await calculation.calculate({ ...MONTH, employee_ids: [1, 2], actor: ACTOR });
    world.calculations.get(1).status = "APPROVED_LOCKED";
    dayOf(2, "2026-08-03").approved_ot_minutes = 30; // make 2 processable
    const processor = fakeAttendanceProcessor();
    calculation.setAttendanceProcessor(processor);

    const result = await calculation.processAttendance({ ...MONTH, employee_ids: [1, 2] });
    assert.deepEqual(result.results.map((r) => r.result), ["LOCKED", "PROCESSED"]);
    assert.deepEqual(processor.calls.map((c) => c.employee_id), [2]);

    world.period = { status: "LOCKED" };
    processor.calls.length = 0;
    const locked = await calculation.processAttendance({ ...MONTH, employee_ids: [2] });
    assert.equal(locked.locked_count, 1);
    assert.equal(processor.calls.length, 0);
  });

  it("enforces the branch scope and reports an engine refusal per employee", async () => {
    world.add(1).add(2, { employee: { store_id: 2 } });
    dayOf(1, "2026-08-03").approved_ot_minutes = 30;
    calculation.setAttendanceProcessor({
      async calculateMonth() {
        throw new Error("payroll month is locked for this employee");
      },
    });
    const result = await calculation.processAttendance({ ...MONTH, employee_ids: [1, 2], store_ids: [1] });
    assert.equal(result.failed_count, 1);
    assert.match(result.results[0].message, /payroll month is locked/);
    assert.equal(result.not_in_scope_count, 1);
  });
});

/* ================================================ Unlock / Publish / Unpublish */

describe("Unlock, Publish and Unpublish", () => {
  const act = (action, employee_ids, over = {}) =>
    calculation.lifecycle({
      ...MONTH, action, employee_ids,
      reason: action === "PUBLISH" ? null : "Attendance corrected after review",
      mode: employee_ids.length === 1 ? "INDIVIDUAL" : "BULK",
      actor: ACTOR, ...over,
    });
  const approved = async (...ids) => {
    ids.forEach((id) => world.add(id));
    await calculation.calculate({ ...MONTH, employee_ids: ids, actor: ACTOR });
    const out = await calculation.approve({ ...MONTH, employee_ids: ids, actor: ACTOR });
    assert.equal(out.approved_count, ids.length);
  };
  const sources = (id) => JSON.stringify([
    world.employees.get(id), world.attendance.get(id), world.salaries.get(id), world.nrm.get(id),
    world.amounts.get(id), world.states.get(id), world.days.get(id),
  ]);
  const FIGURES = ["net_pay", "net_pay_rounding", "salary_days", "employee_pf", "employee_esi", "ot_amount", "calculation_hash", "calculation_revision"];
  const figures = (id) => JSON.stringify(FIGURES.map((k) => world.calculations.get(id)[k]));

  it("Unlock: an Approved & Locked employee returns to a reviewable state with every figure kept", async () => {
    await approved(1);
    world.amounts.set(1, {}); // nothing changes the sources during the act
    const beforeFigures = figures(1);
    const beforeSources = sources(1);
    const out = await act("UNLOCK", [1]);
    assert.equal(out.unlocked_count, 1);
    const row = world.calculations.get(1);
    assert.ok(row, "the calculation row is not deleted");
    assert.equal(row.status, "CALCULATED");
    assert.equal(row.approved_by, null);
    assert.equal(row.locked_at, null);
    assert.equal(row.unlock_reason, "Attendance corrected after review");
    assert.equal(figures(1), beforeFigures, "salary figures unchanged until recalculated");
    assert.equal(sources(1), beforeSources, "attendance, salary, OT, adjustments untouched");
    assert.equal((await rowOf(1)).status, CALC_STATUS.READY_FOR_APPROVAL);
  });

  it("Unlock: the unlocked employee can be recalculated, reset and approved again", async () => {
    await approved(1);
    await act("UNLOCK", [1]);
    const recalc = await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(recalc.recalculated_count, 1);
    assert.equal((await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR })).approved_count, 1);
  });

  it("Unlock: a reason is required; Publish needs none", async () => {
    await approved(1);
    await assert.rejects(() => act("UNLOCK", [1], { reason: "" }), /reason of at least 5/);
    await assert.rejects(() => act("UNPUBLISH", [1], { reason: "x" }), /reason of at least 5/);
    assert.equal((await act("PUBLISH", [1])).published_count, 1);
  });

  it("Unlock: the branch scope is enforced", async () => {
    world.add(2, { employee: { store_id: 2 } });
    await approved(1);
    await calculation.calculate({ ...MONTH, employee_ids: [2], actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [2], actor: ACTOR });
    const out = await act("UNLOCK", [1, 2], { store_ids: [1] });
    assert.deepEqual(out.results.map((r) => r.result), ["UNLOCKED", "NOT_IN_SCOPE"]);
    assert.equal(world.calculations.get(2).status, "APPROVED_LOCKED");
  });

  it("Bulk Unlock: mixed selection - eligible unlocked, published and unapproved skipped, nothing else moves", async () => {
    await approved(1, 2, 3);
    world.add(4);
    await calculation.calculate({ ...MONTH, employee_ids: [4], actor: ACTOR });
    world.add(9);
    await calculation.calculate({ ...MONTH, employee_ids: [9], actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [9], actor: ACTOR });
    await act("PUBLISH", [3]);
    const untouched = JSON.stringify(world.calculations.get(9));

    const out = await act("UNLOCK", [1, 2, 3, 4]);
    assert.equal(out.unlocked_count, 2);
    assert.equal(out.skipped_count, 2);
    assert.deepEqual(out.results.map((r) => r.result), ["UNLOCKED", "UNLOCKED", "SKIPPED", "SKIPPED"]);
    assert.match(out.results[2].message, /already published/);
    assert.match(out.results[3].message, /not approved/);
    assert.equal(world.calculations.get(3).status, "APPROVED_LOCKED");
    assert.equal(JSON.stringify(world.calculations.get(9)), untouched);
    assert.ok(world.lifecycle.filter((a) => a.action === "UNLOCK").every((a) => a.mode === "BULK"));
  });

  it("Publish: only Approved & Locked publishes; metadata recorded; status reads PUBLISHED", async () => {
    await approved(1);
    world.add(2);
    await calculation.calculate({ ...MONTH, employee_ids: [2], actor: ACTOR });
    const out = await act("PUBLISH", [1, 2]);
    assert.deepEqual(out.results.map((r) => r.result), ["PUBLISHED", "SKIPPED"]);
    const row = world.calculations.get(1);
    assert.equal(row.status, "APPROVED_LOCKED", "the stored status - and every lock - is unchanged");
    assert.equal(row.published_by, ACTOR.employeeId);
    assert.ok(row.published_at);
    assert.equal((await rowOf(1)).status, CALC_STATUS.PUBLISHED);
    assert.equal(world.calculations.get(2).published_at, undefined);
  });

  it("Publish: a stale month (a source moved since approval) is refused, not released", async () => {
    await approved(1);
    world.salaries.get(1).salary_id = 777; // a revision approved after the lock
    const out = await act("PUBLISH", [1]);
    assert.equal(out.blocked_count, 1);
    assert.match(out.results[0].message, /salary changed.*Unlock, recalculate and approve again/);
    assert.ok(!world.calculations.get(1).published_at);
  });

  it("Bulk Publish works and every result is per employee", async () => {
    await approved(1, 2, 3);
    const out = await act("PUBLISH", [1, 2, 3]);
    assert.equal(out.published_count, 3);
  });

  it("Unpublish: back to Approved & Locked with the calculation intact; direct Unlock from Published is refused", async () => {
    await approved(1);
    await act("PUBLISH", [1]);
    const before = figures(1);
    const refused = await act("UNLOCK", [1]);
    assert.equal(refused.unlocked_count, 0);
    assert.match(refused.results[0].message, /Unpublish it before unlocking/);
    assert.equal(world.calculations.get(1).status, "APPROVED_LOCKED");

    const out = await act("UNPUBLISH", [1]);
    assert.equal(out.unpublished_count, 1);
    assert.equal((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
    assert.equal(world.calculations.get(1).published_at, null);
    assert.equal(figures(1), before);
    assert.equal((await act("UNLOCK", [1])).unlocked_count, 1, "after Unpublish, Unlock succeeds");
  });

  it("Bulk Unpublish works and skips what is not published", async () => {
    await approved(1, 2, 3);
    await act("PUBLISH", [1, 2]);
    const out = await act("UNPUBLISH", [1, 2, 3]);
    assert.deepEqual(out.results.map((r) => r.result), ["UNPUBLISHED", "UNPUBLISHED", "SKIPPED"]);
  });

  it("a PUBLISHED employee cannot be recalculated, reset or approved again", async () => {
    await approved(1);
    await act("PUBLISH", [1]);
    const recalc = await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(recalc.locked_count, 1);
    const reset = await calculation.reset({ ...MONTH, employee_ids: [1], reason: "WRONG_OT", mode: "INDIVIDUAL", actor: ACTOR });
    assert.equal(reset.locked_count, 1);
    const again = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(again.already_locked_count, 1);
  });

  it("a locked payroll month refuses all three", async () => {
    await approved(1);
    world.period = { status: "LOCKED" };
    for (const action of ["UNLOCK", "PUBLISH", "UNPUBLISH"]) {
      const out = await act(action, [1]);
      assert.equal(out.locked_count, 1, action);
    }
    assert.equal(world.calculations.get(1).status, "APPROVED_LOCKED");
  });

  it("AUDIT: every act is one lifecycle row with previous/new status, reason, mode and actor; approval history kept", async () => {
    await approved(1, 2);
    const approvals = world.audit.filter((a) => a.action === "APPROVE_LOCK").length;
    await act("PUBLISH", [1]);
    await act("UNPUBLISH", [1], { remark: "bank file wrong" });
    await act("UNLOCK", [1, 2]);
    assert.deepEqual(
      world.lifecycle.map((a) => [a.employee_id, a.action, a.previous_status, a.new_status, a.mode]),
      [
        [1, "PUBLISH", "APPROVED_LOCKED", "PUBLISHED", "INDIVIDUAL"],
        [1, "UNPUBLISH", "PUBLISHED", "APPROVED_LOCKED", "INDIVIDUAL"],
        [1, "UNLOCK", "APPROVED_LOCKED", "CALCULATED", "BULK"],
        [2, "UNLOCK", "APPROVED_LOCKED", "CALCULATED", "BULK"],
      ]
    );
    assert.equal(world.lifecycle[1].remark, "bank file wrong");
    assert.equal(world.lifecycle[1].reason, "Attendance corrected after review");
    assert.ok(world.lifecycle.every((a) => a.acted_by_employee_id === ACTOR.employeeId && a.period_month === 8));
    assert.equal(world.audit.filter((a) => a.action === "APPROVE_LOCK").length, approvals, "approval history preserved");
  });

  it("a newly calculated Net Pay is a whole rupee, and the screen shows exactly the stored figure", async () => {
    world.add(1);
    world.amounts.set(1, { [COMPONENT.INCENTIVE]: 0.17 });
    world.states.set(1, { employee_id: 1, confirmed_no_adjustment: 0 });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const stored = world.calculations.get(1);
    assert.equal(Number(stored.net_pay) % 1, 0);
    assert.equal(stored.calculation_version, 3);
    assert.equal((await rowOf(1)).net_pay, stored.net_pay);
    assert.equal(
      Math.round(stored.net_pay * 100),
      Math.round((stored.total_earnings - stored.total_employee_deductions + stored.net_pay_rounding) * 100)
    );
  });
});

/* ======================================================================= */
/*  PAYSLIP PUBLISH - snapshot, notification, retry, unpublish, republish   */
/* ======================================================================= */

describe("Payslip Publish", () => {
  const snapshotText = require("../utils/payslip_snapshot");
  const act = (action, employee_ids, over = {}) =>
    calculation.lifecycle({
      ...MONTH, action, employee_ids,
      reason: action === "PUBLISH" ? null : "Attendance corrected after review",
      mode: employee_ids.length === 1 ? "INDIVIDUAL" : "BULK",
      actor: ACTOR, ...over,
    });
  const approved = async (...ids) => {
    ids.forEach((id) => world.add(id));
    await calculation.calculate({ ...MONTH, employee_ids: ids, actor: ACTOR });
    const out = await calculation.approve({ ...MONTH, employee_ids: ids, actor: ACTOR });
    assert.equal(out.approved_count, ids.length);
  };
  const link = (id) => world.telegramLinks.set(id, { employee_telegram_id: 600 + id, employee_id: id, private_chat_id: 70000 + id });
  const activeOf = (id) => world.payslips.filter((p) => p.employee_id === id && p.status === "ACTIVE");

  it("Approved & Locked publishes: ONE snapshot, frozen from the stored calculation, payroll stays locked", async () => {
    await approved(1);
    link(1);
    const saves = [];
    const realSave = calculation.repo.saveCalculations.bind(calculation.repo);
    calculation.repo.saveCalculations = async (rows) => { saves.push(rows); return realSave(rows); };
    const stored = { ...world.calculations.get(1) };

    const out = await act("PUBLISH", [1]);
    assert.equal(out.published_count, 1);
    assert.equal(saves.length, 0, "Publish never recalculates or saves a calculation");
    assert.equal(world.payslips.length, 1, "exactly one snapshot");
    const slip = world.payslips[0];
    assert.equal(slip.status, "ACTIVE");
    assert.equal(slip.payslip_version, 1);
    assert.equal(slip.template_version, "payslip-v1");
    assert.equal(slip.snapshot_sha256, snapshotText.sha256(slip.snapshot_json), "hash matches contents");
    const snap = JSON.parse(slip.snapshot_json);
    assert.equal(Number(snap.final.net_pay), Number(stored.net_pay), "snapshot Net Pay = stored Net Pay");
    assert.equal(Number(snap.earnings.total), Number(stored.total_earnings));
    assert.equal(Number(snap.deductions.total), Number(stored.total_employee_deductions));
    assert.equal(snap.source.calculation_hash, stored.calculation_hash);
    assert.equal(snap.source.payrun_calculation_id, stored.payrun_calculation_id);
    const row = world.calculations.get(1);
    assert.equal(row.status, "APPROVED_LOCKED", "still locked");
    assert.equal(row.calculation_hash, stored.calculation_hash);
    assert.equal((await rowOf(1)).status, CALC_STATUS.PUBLISHED);
    assert.equal(world.lifecycle.at(-1).payslip_id, slip.payslip_id, "the lifecycle row names the payslip");
  });

  const drain = async () => {
    await new Promise((r) => setImmediate(r));
    await world.notifier.processQueue();
  };

  it("PUBLISH DOES NOT WAIT ON TELEGRAM: it returns with the notification QUEUED; the worker sends it afterwards", async () => {
    await approved(1);
    link(1);
    let release;
    const gate = new Promise((r) => { release = r; });
    const realSend = world.telegramSent;
    world.telegramFailFor.clear();
    const slowWorld = world;
    const origNotifier = world.notifier;
    // A Telegram that does not answer until released.
    const slow = require("./payslip_notification")({
      intervalMs: 0,
      payslipRepo: new FakePayslipRepo(slowWorld),
      identityRepo: { getActiveIdentityByEmployee: async (id) => slowWorld.telegramLinks.get(id) || null },
      telegram: { sendMessage: async (chatId, text) => { await gate; realSend.push({ chatId, text }); return { message_id: 1 }; } },
    });
    calculation.notifier = slow;
    const out = await act("PUBLISH", [1]);
    assert.equal(out.published_count, 1);
    assert.deepEqual(out.notification, { queued: 1 });
    assert.equal(out.results[0].notification_status, "QUEUED");
    assert.equal(world.telegramSent.length, 0, "nothing sent while the request was in flight");
    assert.equal((await rowOf(1)).status, CALC_STATUS.PUBLISHED, "publication committed regardless");
    release();
    await new Promise((r) => setImmediate(r));
    await slow.processQueue();
    assert.equal(world.telegramSent.length, 1);
    assert.equal(world.notifications[0].result, "SENT");
    calculation.notifier = origNotifier;
  });

  it("notifies with the figure-free message to the server-resolved chat, recorded SENT, separate from publication", async () => {
    await approved(1);
    link(1);
    const out = await act("PUBLISH", [1]);
    assert.deepEqual(out.notification, { queued: 1 });
    await drain();
    assert.equal(world.telegramSent.length, 1);
    assert.equal(world.telegramSent[0].chatId, 70001);
    assert.equal(world.telegramSent[0].text, "Your payslip for August 2026 is now available in My Payslips.");
    const net = String(Math.round(Number(world.calculations.get(1).net_pay)));
    assert.ok(!world.telegramSent[0].text.includes(net), "no Net Pay in the message");
    assert.deepEqual(world.notifications.map((n) => [n.result, n.trigger_type, n.attempt_no]), [["SENT", "PUBLISH", 1]]);
  });

  it("no Telegram link / Telegram failure: the payslip STAYS published; NO_TELEGRAM_LINK / FAILED recorded", async () => {
    await approved(1, 2, 3);
    link(1);
    link(2);
    world.telegramFailFor.add(2);
    const out = await act("PUBLISH", [1, 2, 3]);
    assert.equal(out.published_count, 3, "one failed notification fails nobody's publication");
    await drain();
    for (const id of [1, 2, 3]) assert.equal((await rowOf(id)).status, CALC_STATUS.PUBLISHED);
    const view = await calculation.getMonth({ ...MONTH });
    const statusOf = (id) => view.rows.find((r) => r.employee_id === id).payslip.notification_status;
    assert.deepEqual([statusOf(1), statusOf(2), statusOf(3)], ["SENT", "FAILED", "NO_TELEGRAM_LINK"]);
    assert.equal(world.notifications.find((n) => n.employee_id === 2).failure_code, "TELEGRAM_403");
  });

  it("Retry Notification: queues a NEW attempt, never a republish; already-notified, pending and unpublished are skipped", async () => {
    await approved(1, 2, 3);
    link(1);
    link(2);
    world.telegramFailFor.add(2);
    await act("PUBLISH", [1, 2]);
    await drain();
    const slipsBefore = JSON.stringify(world.payslips);
    const lifecycleBefore = world.lifecycle.length;
    world.telegramFailFor.delete(2);

    const out = await calculation.retryNotification({ ...MONTH, employee_ids: [1, 2, 3], actor: ACTOR });
    assert.deepEqual(out.results.map((r) => [r.employee_id, r.result]), [
      [1, "SKIPPED"], [2, "QUEUED"], [3, "SKIPPED"],
    ]);
    // A second retry while the first is still pending queues nothing more.
    const again = await calculation.retryNotification({ ...MONTH, employee_ids: [2], actor: ACTOR });
    assert.equal(again.results[0].result, "SKIPPED");
    await drain();
    assert.equal(JSON.stringify(world.payslips), slipsBefore, "no payslip written");
    assert.equal(world.lifecycle.length, lifecycleBefore, "no lifecycle act");
    const forTwo = world.notifications.filter((n) => n.employee_id === 2);
    assert.deepEqual(forTwo.map((n) => [n.attempt_no, n.trigger_type, n.result]), [[1, "PUBLISH", "FAILED"], [2, "RETRY", "SENT"]]);
  });

  it("Retry for an employee with no link records NO_TELEGRAM_LINK again and keeps the payslip published", async () => {
    await approved(1);
    await act("PUBLISH", [1]);
    await drain();
    const out = await calculation.retryNotification({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(out.results[0].result, "QUEUED");
    await drain();
    assert.deepEqual(world.notifications.map((n) => n.result), ["NO_TELEGRAM_LINK", "NO_TELEGRAM_LINK"]);
    assert.equal((await rowOf(1)).status, CALC_STATUS.PUBLISHED);
  });

  it("Unpublish before the worker runs withdraws the queued notification - the employee is not told", async () => {
    await approved(1);
    link(1);
    const realKick = calculation.notifier.kick;
    calculation.notifier.kick = () => {};
    try {
      await act("PUBLISH", [1]);
      await act("UNPUBLISH", [1]);
    } finally {
      calculation.notifier.kick = realKick;
    }
    await drain();
    assert.equal(world.telegramSent.length, 0);
    assert.deepEqual([world.notifications[0].result, world.notifications[0].failure_code], ["FAILED", "PAYSLIP_UNPUBLISHED"]);
  });

  it("company details come from Company Details, are frozen at Publish, and a later edit does not change the payslip", async () => {
    await approved(1);
    await act("PUBLISH", [1]);
    const snap = JSON.parse(world.payslips[0].snapshot_json);
    assert.deepEqual(snap.company, {
      name: "Daily Needs Departmental Store", address: "188/1 Iyyanar Koil Street",
      pf_establishment_code: "TN/MAS/0012345", esi_establishment_code: "51000123450001001", source: "company_details:1",
    });
    world.companies[0].company_name = "Renamed Ltd";
    assert.equal(JSON.parse(world.payslips[0].snapshot_json).company.name, "Daily Needs Departmental Store");
  });

  it("no usable company record: Publish is refused for everyone - nothing published with a made-up name", async () => {
    await approved(1);
    world.companies = [];
    await assert.rejects(act("PUBLISH", [1]), (e) => e.code === "PAYSLIP_COMPANY_NOT_CONFIGURED");
    assert.equal(world.payslips.length, 0);
    assert.equal((await rowOf(1)).status, CALC_STATUS.APPROVED_LOCKED);
  });

  it("Publish All Approved: only Approved & Locked, decided on the server; mixed states handled per employee", async () => {
    await approved(1, 2);
    world.add(3);
    await calculation.calculate({ ...MONTH, employee_ids: [3], actor: ACTOR });
    await act("PUBLISH", [2]);
    const before = world.payslips.length;
    const out = await calculation.publishAllApproved({ ...MONTH, actor: ACTOR });
    assert.deepEqual(out.results.map((r) => [r.employee_id, r.result]), [[1, "PUBLISHED"]]);
    assert.equal(world.payslips.length, before + 1, "no duplicate snapshot for the already published");
    assert.equal(activeOf(2).length, 1);
    assert.equal((await rowOf(3)).status === CALC_STATUS.PUBLISHED, false);
  });

  it("bulk selection: published, skipped, blocked and not-in-scope are independent; no duplicate snapshot", async () => {
    await approved(1, 2, 4);
    world.add(3);
    await calculation.calculate({ ...MONTH, employee_ids: [3], actor: ACTOR });
    await act("PUBLISH", [4]);
    // employee 2's salary moves after approval -> stale, refused.
    world.salaries.set(2, { ...world.salaries.get(2), salary_id: 999, monthly_gross: 30000 });
    const out = await act("PUBLISH", [1, 2, 3, 4, 99]);
    assert.deepEqual(out.results.map((r) => [r.employee_id, r.result]), [
      [1, "PUBLISHED"], [2, "BLOCKED"], [3, "SKIPPED"], [4, "SKIPPED"], [99, "NOT_IN_SCOPE"],
    ]);
    assert.equal(activeOf(4).length, 1);
    assert.equal(world.payslips.filter((p) => p.employee_id === 2).length, 0);
  });

  it("the published snapshot does not change when Salary Master / attendance / adjustments change later", async () => {
    await approved(1);
    await act("PUBLISH", [1]);
    const frozen = world.payslips[0].snapshot_json;
    const viewBefore = await calculation.getPayslip({ ...MONTH, employee_id: 1 });
    world.salaries.set(1, { ...world.salaries.get(1), salary_id: 777, monthly_gross: 99000 });
    world.attendance.set(1, { ...world.attendance.get(1), salary_days: 10, payroll_version: 2 });
    world.amounts.set(1, { [COMPONENT.INCENTIVE]: 5000 });
    const viewAfter = await calculation.getPayslip({ ...MONTH, employee_id: 1 });
    assert.equal(world.payslips[0].snapshot_json, frozen);
    assert.deepEqual(viewAfter.payslip.snapshot, viewBefore.payslip.snapshot);
  });

  it("Unpublish archives the snapshot (kept, not deleted); payroll stays Approved & Locked; then Unlock works", async () => {
    await approved(1);
    await act("PUBLISH", [1]);
    const out = await act("UNPUBLISH", [1]);
    assert.equal(out.unpublished_count, 1);
    assert.equal(world.payslips.length, 1, "history kept");
    assert.equal(world.payslips[0].status, "ARCHIVED");
    assert.equal(world.payslips[0].archive_reason, "Attendance corrected after review");
    assert.equal(world.calculations.get(1).status, "APPROVED_LOCKED");
    assert.equal((await rowOf(1)).payslip, null, "the screen shows no published payslip");
    assert.equal((await calculation.getPayslip({ ...MONTH, employee_id: 1 })).payslip, null);
    assert.equal((await act("UNLOCK", [1])).unlocked_count, 1);
  });

  it("Republish after Unpublish -> Unlock -> Recalculate -> Approve: a NEW version; the old one stays ARCHIVED", async () => {
    await approved(1);
    await act("PUBLISH", [1]);
    const v1 = world.payslips[0].snapshot_json;
    await act("UNPUBLISH", [1]);
    await act("UNLOCK", [1]);
    world.amounts.set(1, { [COMPONENT.INCENTIVE]: 1200 });
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.equal((await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR })).approved_count, 1);
    await act("PUBLISH", [1]);
    assert.deepEqual(world.payslips.map((p) => [p.payslip_version, p.status]), [[1, "ARCHIVED"], [2, "ACTIVE"]]);
    assert.equal(world.payslips[0].snapshot_json, v1, "the archived snapshot is not overwritten");
    const v2 = JSON.parse(world.payslips[1].snapshot_json);
    assert.equal(v2.earnings.lines.find((l) => l.key === "incentive").amount, "1200.00");
    const admin = await calculation.getPayslip({ ...MONTH, employee_id: 1 });
    assert.equal(admin.payslip.payslip_version, 2);
    assert.equal(admin.versions.length, 2);
  });

  it("a calculation that changed between the read and the lock is refused, not published", async () => {
    await approved(1);
    const realLifecycle = calculation.repo.lifecycle.bind(calculation.repo);
    calculation.repo.lifecycle = async (args) => {
      world.calculations.get(1).calculation_hash = "changed-under-the-lock";
      return realLifecycle(args);
    };
    const out = await act("PUBLISH", [1]);
    assert.equal(out.results[0].result, "BLOCKED");
    assert.equal(world.payslips.length, 0);
  });

  it("HR view: Not Viewed until the employee opens it; the admin viewer is branch-scoped", async () => {
    await approved(1);
    await act("PUBLISH", [1]);
    let row = await rowOf(1);
    assert.equal(row.payslip.viewed, false);
    world.payslips[0].first_viewed_at = "2026-10-04 09:42:00";
    row = await rowOf(1);
    assert.equal(row.payslip.viewed, true);
    assert.equal(row.payslip.first_viewed_at, "2026-10-04 09:42:00");
    await assert.rejects(
      calculation.getPayslip({ ...MONTH, employee_id: 1, store_ids: [42] }),
      (e) => e.name === "NotFoundError"
    );
  });
});

/* ================================== Company Details -> Payslip Publish */

/**
 * MASTER → COMPANY DETAILS DRIVES PUBLISH. The company usecase is the real
 * one (`usecase/company.js`) over an in-memory repository that shares
 * `world.companies` with the payslip repository, so an edit made through the
 * screen's own code path is what the next Publish reads.
 */
describe("Company Details drives Payslip Publish", () => {
  const buildCompany = require("./company");
  const act = (action, employee_ids) =>
    calculation.lifecycle({
      ...MONTH, action, employee_ids,
      reason: action === "PUBLISH" ? null : "Company details corrected",
      mode: employee_ids.length === 1 ? "INDIVIDUAL" : "BULK",
      actor: ACTOR,
    });
  const approved = async (...ids) => {
    ids.forEach((id) => world.add(id));
    await calculation.calculate({ ...MONTH, employee_ids: ids, actor: ACTOR });
    const out = await calculation.approve({ ...MONTH, employee_ids: ids, actor: ACTOR });
    assert.equal(out.approved_count, ids.length);
  };
  /** The repository contract of repository/company.js, over world.companies. */
  const memoryCompanyRepo = () => ({
    async list() { return world.companies; },
    async get(id) { return world.companies.filter((c) => c.company_id === id); },
    async create(values, { payslip_active }) {
      const company_id = world.companies.reduce((m, c) => Math.max(m, c.company_id), 0) + 1;
      world.companies.push({ company_id, ...values, status: payslip_active ? 1 : 0 });
      if (payslip_active) world.companies.forEach((c) => { if (c.company_id !== company_id) c.status = 0; });
      return company_id;
    },
    async update(id, values, { payslip_active }) {
      const row = world.companies.find((c) => c.company_id === id);
      if (!row) return false;
      Object.assign(row, values, { status: payslip_active ? 1 : 0 });
      if (payslip_active) world.companies.forEach((c) => { if (c.company_id !== id) c.status = 0; });
      return true;
    },
    async setPayslipCompany(id) {
      if (!world.companies.some((c) => c.company_id === id)) return false;
      world.companies.forEach((c) => { c.status = c.company_id === id ? 1 : 0; });
      return true;
    },
  });
  const FORM = {
    company_name: "Daily Needs Departmental Store", reg_address: "188/1 Iyyanar Koil Street",
    pf_number: "TN/MAS/0012345", esi_number: "51000123450001001", payslip_active: true,
  };
  let company;
  beforeEach(() => {
    world.companies = [];
    company = buildCompany(memoryCompanyRepo());
  });

  it("no active company blocks Publish, and the Payroll status says so", async () => {
    await approved(1);
    const status = await calculation.getPayslipCompanyStatus();
    assert.equal(status.configured, false);
    assert.equal(status.message, "Payslip publishing is unavailable until Company Details is configured.");
    await assert.rejects(act("PUBLISH", [1]), (e) => e.code === "PAYSLIP_COMPANY_NOT_CONFIGURED");
    assert.equal(world.payslips.length, 0);
  });

  it("an inactive company is not a payslip company", async () => {
    await approved(1);
    await company.create({ ...FORM, payslip_active: false });
    assert.equal((await calculation.getPayslipCompanyStatus()).configured, false);
    await assert.rejects(act("PUBLISH", [1]), (e) => e.reason === "NONE");
  });

  it("creating the company Active for Payslip allows Publish", async () => {
    await approved(1);
    const { company_id } = await company.create(FORM);
    const status = await calculation.getPayslipCompanyStatus();
    assert.equal(status.configured, true);
    assert.deepEqual([status.company.company_id, status.company.name], [company_id, FORM.company_name]);
    const out = await act("PUBLISH", [1]);
    assert.equal(out.published_count, 1, JSON.stringify(out.results));
    assert.equal(JSON.parse(world.payslips[0].snapshot_json).company.source, `company_details:${company_id}`);
  });

  it("more than one active company refuses Publish until one is chosen", async () => {
    await approved(1);
    // Two rows active at once can only come from data written before this
    // screen (the screen itself keeps exactly one).
    world.companies.push({ company_id: 1, company_name: "A", reg_address: "x", pf_number: "TN/1", esi_number: "1234567890", status: 1 });
    world.companies.push({ company_id: 2, company_name: "B", reg_address: "y", pf_number: "TN/2", esi_number: "1234567890", status: 1 });
    const status = await calculation.getPayslipCompanyStatus();
    assert.deepEqual([status.configured, status.reason, status.active_count], [false, "MULTIPLE", 2]);
    await assert.rejects(act("PUBLISH", [1]), (e) => e.reason === "MULTIPLE");
    assert.equal(world.payslips.length, 0);

    await company.setPayslipCompany(2);
    assert.deepEqual(world.companies.map((c) => c.status), [0, 1], "exactly one active");
    const out = await act("PUBLISH", [1]);
    assert.equal(out.published_count, 1);
    assert.equal(JSON.parse(world.payslips[0].snapshot_json).company.name, "B");
  });

  it("marking another company Active for Payslip clears the first - only one is ever active", async () => {
    await company.create(FORM);
    await company.create({ ...FORM, company_name: "Second Ltd" });
    assert.deepEqual(world.companies.map((c) => [c.company_name, c.status]), [[FORM.company_name, 0], ["Second Ltd", 1]]);
    assert.equal((await company.list()).payslip.company.name, "Second Ltd");
  });

  it("the published snapshot freezes the company at Publish; a later edit changes only payslips published after it", async () => {
    await approved(1, 2);
    const { company_id } = await company.create(FORM);
    await act("PUBLISH", [1]);
    const firstText = world.payslips[0].snapshot_json;
    const firstSha = world.payslips[0].snapshot_sha256;
    assert.deepEqual(JSON.parse(firstText).company, {
      name: FORM.company_name, address: FORM.reg_address,
      pf_establishment_code: FORM.pf_number, esi_establishment_code: FORM.esi_number,
      source: `company_details:${company_id}`,
    });

    await company.update(company_id, {
      ...FORM, company_name: "Daily Needs Retail Pvt Ltd", reg_address: "New Address, Puducherry", pf_number: "TN/MAS/9999999",
    });
    assert.equal(world.payslips[0].snapshot_json, firstText, "the published payslip is byte-for-byte unchanged");
    assert.equal(world.payslips[0].snapshot_sha256, firstSha);

    await act("PUBLISH", [2]);
    const second = JSON.parse(world.payslips.find((p) => p.employee_id === 2).snapshot_json).company;
    assert.deepEqual([second.name, second.address, second.pf_establishment_code],
      ["Daily Needs Retail Pvt Ltd", "New Address, Puducherry", "TN/MAS/9999999"]);
    assert.equal(JSON.parse(world.payslips[0].snapshot_json).company.name, FORM.company_name);
  });

  it("PF applicable without a PF Establishment Code: that payslip is held with a Company Details fix, nothing published", async () => {
    await approved(1);
    await company.create({ ...FORM, pf_number: "" });
    const out = await act("PUBLISH", [1]);
    assert.equal(out.results[0].result, "BLOCKED");
    assert.match(out.results[0].message, /no PF Establishment Code\. Add it in Master → Company Details/);
    assert.equal(out.results[0].error_code, "SNAPSHOT_COMPANY_PF_CODE_MISSING");
    assert.equal(world.payslips.length, 0);
  });

  it("invalid company details are refused and nothing is written", async () => {
    await assert.rejects(company.create({ ...FORM, company_name: "" }), (e) => e.name === "ValidationError");
    await assert.rejects(company.create({ ...FORM, reg_address: "  " }), (e) => e.name === "ValidationError");
    assert.equal(world.companies.length, 0);
  });
});

/* ============================================== the summary cards (filters) */

/**
 * CALCULATION & REVIEW CARDS. Every card's count and the rows its filter
 * returns come from ONE membership rule (`utils/payrun_calculation.js#inCard`),
 * and "Calculated, not ready" is the backend's own CALCULATED status - a
 * current calculation on accepted attendance with an approval blocker - not a
 * subtraction done in a browser.
 */
describe("Calculation & Review summary cards", () => {
  const CARDS = [
    "ALL", "ATTENDANCE_NEEDS_ACTION", "NOT_CALCULATED", "CALCULATED", "CALCULATED_NOT_READY",
    "RECALCULATION_REQUIRED", "READY_FOR_APPROVAL", "APPROVED_LOCKED", "PUBLISHED",
  ];
  const ids = (view) => view.rows.map((r) => r.employee_id).sort((a, b) => a - b);
  const card = (c, extra = {}) => calculation.getMonth({ ...MONTH, card: c, ...extra });

  it("REGRESSION: the gap between Calculated and Ready for Approval is exactly the Calculated, Not Ready card, with reasons", async () => {
    // A production-shaped month: 220 clean, 3 calculated but blocked, and -
    // since the EPFO 2026 statutory setup hold - 2 who cannot be calculated.
    for (let id = 1; id <= 225; id += 1) world.add(id);
    [221, 222, 223].forEach((id) => world.states.delete(id)); // Adjustments not confirmed
    [224, 225].forEach((id) => {
      world.employees.get(id).uan = null; // PF applies, no UAN or PF number: HELD
      world.employees.get(id).pf_number = null;
    });
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });

    const all = await monthView();
    const c = all.summary.cards;
    // THE INVARIANT, whatever the numbers are.
    assert.equal(c.CALCULATED - c.READY_FOR_APPROVAL, c.CALCULATED_NOT_READY);
    assert.deepEqual([c.CALCULATED, c.READY_FOR_APPROVAL, c.CALCULATED_NOT_READY], [223, 220, 3]);

    const calculated = new Set(ids(await card("CALCULATED")));
    const ready = new Set(ids(await card("READY_FOR_APPROVAL")));
    const notReady = await card("CALCULATED_NOT_READY");
    assert.deepEqual(ids(notReady), [...calculated].filter((id) => !ready.has(id)).sort((a, b) => a - b));
    assert.deepEqual(ids(notReady), [221, 222, 223]);
    notReady.rows.forEach((r) => {
      assert.equal(r.status, CALC_STATUS.CALCULATED);
      assert.equal(r.status_label, "Calculated, not ready");
      assert.deepEqual(codesOf(r), ["ADJUSTMENT_PENDING_CONFIRMATION"]);
      r.blockers.forEach((b) => assert.ok(b.label && b.message, "every reason is labelled"));
    });
    const readyRows = await card("READY_FOR_APPROVAL");
    assert.ok(readyRows.rows.every((r) => r.blockers.length === 0));

    // THE HELD ARE OUTSIDE THAT RELATIONSHIP: never calculated, so in neither
    // Calculated nor Ready - only All Employees - each saying why.
    assert.deepEqual(ids(await card("NOT_CALCULATED")), [224, 225]);
    assert.equal(c.NOT_CALCULATED, 2);
    [224, 225].forEach((id) => {
      assert.ok(!calculated.has(id) && !ready.has(id));
      const row = all.rows.find((r) => r.employee_id === id);
      assert.equal(row.status, CALC_STATUS.NOT_CALCULATED);
      assert.ok(codesOf(row).includes("STATUTORY_SETUP_INCOMPLETE"));
    });
    assert.equal(c.ALL, 225);
  });

  it("every card's count equals the rows its filter returns", async () => {
    world.add(1).add(2).add(3).add(4).add(5).add(6);
    world.states.delete(2); // calculated, not ready
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    world.salaries.get(3).monthly_gross = 30000; // recalculation required
    world.salaries.get(3).salary_id = 9003;
    await calculation.approve({ ...MONTH, employee_ids: [4, 5], actor: ACTOR });
    await calculation.lifecycle({ ...MONTH, action: "PUBLISH", employee_ids: [5], mode: "INDIVIDUAL", actor: ACTOR });

    const all = await monthView();
    for (const c of CARDS) {
      assert.equal((await card(c)).rows.length, all.summary.cards[c], `${c} count and rows disagree`);
    }
    assert.deepEqual(ids(await card("CALCULATED")), [1, 2, 6]);
    assert.deepEqual(ids(await card("CALCULATED_NOT_READY")), [2]);
    assert.deepEqual(ids(await card("READY_FOR_APPROVAL")), [1, 6]);
    assert.deepEqual(ids(await card("RECALCULATION_REQUIRED")), [3]);
    assert.deepEqual(ids(await card("APPROVED_LOCKED")), [4]);
    assert.deepEqual(ids(await card("PUBLISHED")), [5]);
    assert.deepEqual(ids(await card("ALL")), [1, 2, 3, 4, 5, 6]);
  });

  it("Recalculation Required is its own state - a stale calculation is NOT counted as Calculated", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    world.salaries.get(1).monthly_gross = 30000;
    world.salaries.get(1).salary_id = 9001;
    const view = await monthView();
    assert.equal(view.rows[0].status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.equal(view.summary.cards.RECALCULATION_REQUIRED, 1);
    assert.equal(view.summary.cards.CALCULATED, 0);
    assert.equal(view.summary.cards.CALCULATED_NOT_READY, 0);
    assert.ok(codesOf(view.rows[0]).includes("RECALCULATION_REQUIRED"));
  });

  it("Attendance Needs Action overlaps the payroll state: a Recalculation Required employee on unsettled attendance is in both", async () => {
    world.add(1).add(2);
    world.attendance.get(1).is_final = 0;
    await calculateUnderPreviousRule(1); // calculated on unsettled attendance
    await calculation.calculate({ ...MONTH, employee_ids: [2], actor: ACTOR });
    world.salaries.get(1).monthly_gross = 30000;
    world.salaries.get(1).salary_id = 9001;

    const view = await monthView();
    const row1 = view.rows.find((r) => r.employee_id === 1);
    assert.equal(row1.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.equal(row1.attendance_needs_action, true);
    assert.deepEqual(ids(await card("ATTENDANCE_NEEDS_ACTION")), [1]);
    assert.deepEqual(ids(await card("RECALCULATION_REQUIRED")), [1]);
    // The settled employee is in neither.
    assert.equal(view.rows.find((r) => r.employee_id === 2).attendance_needs_action, false);
  });

  it("Attendance Needs Action includes the ATTENDANCE_PENDING status, labelled in the new words", async () => {
    world.add(1);
    world.attendance.get(1).is_final = 0;
    await calculateUnderPreviousRule(1);
    const row = (await card("ATTENDANCE_NEEDS_ACTION")).rows[0];
    assert.equal(row.status, CALC_STATUS.ATTENDANCE_PENDING);
    assert.equal(row.status_label, "Attendance needs action");
  });

  it("search works together with the selected card; the summary stays the month's", async () => {
    world.add(1).add(2).add(3);
    world.employees.get(2).employee_name = "Priya One";
    world.employees.get(3).employee_name = "Priya Two";
    world.states.delete(1);
    world.states.delete(2);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    const view = await card("CALCULATED_NOT_READY", { search: "priya" });
    assert.deepEqual(ids(view), [2]);
    assert.equal(view.summary.cards.CALCULATED_NOT_READY, 2, "search never changes the counts");
  });

  it("location scope changes the counts and the rows together", async () => {
    world.add(1).add(2, { employee: { store_id: 2 } }).add(3, { employee: { store_id: 2 } });
    world.states.delete(3);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    const one = await calculation.getMonth({ ...MONTH, store_ids: [1] });
    const two = await calculation.getMonth({ ...MONTH, store_ids: [2], card: "CALCULATED_NOT_READY" });
    assert.deepEqual([one.summary.cards.ALL, one.summary.cards.READY_FOR_APPROVAL, one.summary.cards.CALCULATED_NOT_READY], [1, 1, 0]);
    assert.deepEqual([two.summary.cards.ALL, two.summary.cards.READY_FOR_APPROVAL, two.summary.cards.CALCULATED_NOT_READY], [2, 1, 1]);
    assert.deepEqual(ids(two), [3]);
  });

  it("filtering by any card writes nothing", async () => {
    world.add(1).add(2);
    world.states.delete(2);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    const before = JSON.stringify([...world.calculations.values()]);
    const auditBefore = world.audit.length;
    for (const c of CARDS) await card(c, { search: "Employee" });
    assert.equal(JSON.stringify([...world.calculations.values()]), before);
    assert.equal(world.audit.length, auditBefore);
  });

  it("Approve All Ready approves exactly the backend-ready population, whatever card was being viewed", async () => {
    world.add(1).add(2).add(3);
    world.states.delete(3); // calculated, not ready
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    await card("CALCULATED_NOT_READY"); // looking at the not-ready card changes nothing
    const out = await calculation.approve({ ...MONTH, all_ready: true, actor: ACTOR });
    assert.equal(out.approved_count, 2);
    const view = await monthView();
    assert.equal(view.rows.find((r) => r.employee_id === 3).status, CALC_STATUS.CALCULATED);
    // ...and naming the not-ready employee explicitly is still refused.
    const refused = await calculation.approve({ ...MONTH, employee_ids: [3], actor: ACTOR });
    assert.equal(refused.approved_count, 0);
  });

  it("Publish All publishes only Approved & Locked employees", async () => {
    world.add(1).add(2).add(3);
    world.states.delete(3);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await calculation.publishAllApproved({ ...MONTH, actor: ACTOR });
    assert.deepEqual(ids(await card("PUBLISHED")), [1]);
    assert.deepEqual(ids(await card("READY_FOR_APPROVAL")), [2]);
    assert.deepEqual(ids(await card("CALCULATED_NOT_READY")), [3]);
  });
});

/* ======================= EPFO 2026: the statutory setup hold and its safeguards */

describe("STATUTORY_SETUP_INCOMPLETE - held only for a real setup gap, never for Previous PF / EPS Member or DOB", () => {
  // The world's month is August 2026; a joiner is anybody whose DOJ falls in it.
  const JOINER = { employee: { date_of_joining: "2026-08-10" } };
  // A PF member with neither UAN nor PF number - the identifier rule, which holds everybody.
  const NO_ID = { employee: { date_of_joining: "2026-08-10", uan: null, pf_number: null } };

  it("a joiner with Previous PF / EPS Member and DOB all blank is NOT held: calculated, EPF + EPS... except the DOB-dependent EPS", async () => {
    world.add(1, JOINER);
    world.statutory.set(1, { previous_pf_member: null, previous_eps_member: null, dob: "1998-01-01" });
    const row = await rowOf(1);
    assert.equal(row.statutory_hold, null);
    const res = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(res.results[0].result, ROW_RESULT.CALCULATED);
    const stored = world.calculations.get(1);
    assert.equal(stored.is_complete, 1);
    assert.ok(Number(stored.employer_eps) > 0, "EPS is calculated");
  });

  it("a missing DOB does not hold: PF is calculated, only the EPS age decision is unresolved and approval waits for it", async () => {
    world.add(1, JOINER);
    world.statutory.set(1, { previous_pf_member: null, previous_eps_member: null, dob: null });
    assert.equal((await rowOf(1)).statutory_hold, null);
    const res = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(res.results[0].result, ROW_RESULT.CALCULATED);
    const stored = world.calculations.get(1);
    assert.equal(stored.is_complete, 0);
    assert.ok(Number(stored.employee_pf) > 0, "employee PF is still calculated");
    const unresolved = typeof stored.unresolved === "string" ? JSON.parse(stored.unresolved) : stored.unresolved;
    assert.deepEqual(unresolved.map((u) => u.code), ["EPS_DOB_NOT_RECORDED"]);
    const approval = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.notEqual(approval.results[0].result, ROW_RESULT.APPROVED);
  });

  it("a PF member with no UAN and no PF number IS held: refused by name, nothing written", async () => {
    world.add(1, NO_ID);
    world.statutory.set(1, { uan: null, pf_number: null });
    const row = await rowOf(1);
    assert.deepEqual(row.statutory_hold.missing_labels, ["UAN (or PF Number)"]);
    assert.match(row.statutory_hold.message, /^On hold - statutory setup incomplete/);
    assert.ok(row.blockers.some((b) => b.code === "STATUTORY_SETUP_INCOMPLETE"));
    assert.equal(row.calculable, false);
    const res = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(res.results[0].result, ROW_RESULT.BLOCKED);
    assert.match(res.results[0].message, /UAN \(or PF Number\)/);
    assert.equal(world.calculations.has(1), false, "no figure is stored for a held employee");
  });

  it("'Calculate All Eligible' leaves the held employee out and calculates everybody else", async () => {
    world.add(1, NO_ID).add(2);
    world.statutory.set(1, { uan: null, pf_number: null });
    const res = await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    assert.deepEqual(res.results.map((r) => [r.employee_id, r.result]), [[2, ROW_RESULT.CALCULATED]]);
    assert.equal(world.calculations.has(1), false);
    assert.equal(world.calculations.get(2).is_complete, 1);
  });

  it("a PF member with no Date of Joining is held; HR recording it releases the hold on the next read", async () => {
    world.add(1, { employee: { date_of_joining: null } });
    world.statutory.set(1, { date_of_joining: null });
    assert.deepEqual((await rowOf(1)).statutory_hold.missing_labels, ["Date of Joining"]);
    world.statutory.set(1, { date_of_joining: "2026-08-10" });
    assert.equal((await rowOf(1)).statutory_hold, null);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const approval = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(approval.results[0].result, ROW_RESULT.APPROVED);
  });

  it("approval refuses an employee whose setup became incomplete after calculation", async () => {
    world.add(1, JOINER);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    world.employees.get(1).uan = null;
    world.statutory.set(1, { uan: null, pf_number: null });
    const approval = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.notEqual(approval.results[0].result, ROW_RESULT.APPROVED);
    assert.equal(world.calculations.get(1).status, "CALCULATED");
  });
});

describe("existing PF members, Basic above 15,000, post-2014 DOJ, Previous EPS Member blank", () => {
  // Post-2014 joiners above the old ceiling: under the old rule a blank
  // Previous EPS Member left their EPS unresolved and blocked approval.
  [
    ["case 8", 19000, "2017-06-01"],
    ["case 9", 17200, "2019-03-01"],
    ["case 10", 16400, "2021-02-01"],
  ].forEach(([label, basic, doj]) =>
    it(`${label}: Basic ${basic}, joined ${doj} - EPF + EPS calculated, complete, approvable`, async () => {
      world.add(1, { employee: { basic, monthly_gross: basic * 2, date_of_joining: doj } });
      world.salaries.get(1).monthly_gross = basic * 2;
      world.statutory.set(1, { previous_pf_member: null, previous_eps_member: null, dob: "1985-01-01" });
      await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
      const stored = world.calculations.get(1);
      assert.equal(stored.is_complete, 1, `${label} must not be blocked`);
      assert.ok(Number(stored.employer_eps) > 0, "EPS is calculated");
      assert.equal(
        Number(stored.employer_eps) + Number(stored.employer_epf),
        Number(stored.employer_pf_total),
        "employer share split EPS + EPF"
      );
      const approval = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
      assert.equal(approval.results[0].result, ROW_RESULT.APPROVED);
    })
  );
});

describe("HR changes statutory master data after a month was calculated", () => {
  it("a DOB change makes the calculation RECALCULATION_REQUIRED with 'Statutory setup changed' - never approved stale", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.RECALCULATION_REQUIRED);
    world.statutory.set(1, { dob: "1960-01-01" });
    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.RECALCULATION_REQUIRED);
    assert.ok(row.recalculation_reasons.some((r) => r.code === "STATUTORY_CONTEXT_CHANGED"));
  });

  it("a Previous PF / EPS Member change does NOT - no payroll rule reads them", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    world.statutory.set(1, { previous_eps_member: 1, previous_pf_member: 0 });
    assert.notEqual((await rowOf(1)).status, CALC_STATUS.RECALCULATION_REQUIRED);
  });

  it("an APPROVED, LOCKED month is never marked and never rewritten", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const before = { ...world.calculations.get(1) };
    world.statutory.set(1, { previous_eps_member: 1, dob: "1960-01-01" });
    const row = await rowOf(1);
    assert.equal(row.status, CALC_STATUS.APPROVED_LOCKED);
    const res = await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(res.results[0].result, ROW_RESULT.LOCKED);
    assert.deepEqual(world.calculations.get(1), before);
  });
});

describe("the ECR, from approved payroll only", () => {
  it("a calculated but unapproved month files nothing; once approved it files one line from the stored figures", async () => {
    world.add(1);
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    let ecr = await calculation.getEcr({ ...MONTH });
    assert.equal(ecr.lines.length, 0);
    assert.equal(ecr.errors[0].code, "NOT_APPROVED");
    await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    ecr = await calculation.getEcr({ ...MONTH });
    const stored = world.calculations.get(1);
    assert.equal(ecr.lines.length, 1);
    assert.equal(ecr.members[0].ee_share, Math.round(Number(stored.employee_pf)));
    assert.equal(ecr.members[0].eps_share, Math.round(Number(stored.employer_eps)));
  });

  it("an existing 58+ member whose UAN was missing at initialization: EPS 0 by the age rule, and the UAN HR adds later is used", async () => {
    world.add(1, { employee: { uan: null, pf_number: "TN/MAS/1/1" } });
    world.statutory.set(1, { dob: "1960-03-01", previous_eps_member: 1, uan: null });
    await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    const stored = world.calculations.get(1);
    assert.equal(Number(stored.employer_eps), 0);
    assert.equal(Number(stored.employer_epf), Number(stored.employer_pf_total));
    let ecr = await calculation.getEcr({ ...MONTH });
    assert.equal(ecr.errors[0].code, "UAN_MISSING");
    world.statutory.set(1, { dob: "1960-03-01", previous_eps_member: 1, uan: "100200300499" });
    ecr = await calculation.getEcr({ ...MONTH });
    assert.equal(ecr.lines.length, 1);
    assert.ok(ecr.lines[0].startsWith("100200300499#~#"));
  });
});

/* ============== the EPFO statutory setup hold, through the summary cards */

/**
 * A HELD EMPLOYEE (`payroll_readiness.statutoryHoldReason`) IS NOT
 * CALCULABLE. Never calculated, they are NOT_CALCULATED and sit only under All
 * Employees; calculated before the hold appeared, the statutory marker moves
 * and they are RECALCULATION_REQUIRED. In neither case are they Calculated,
 * Calculated, Not Ready or Ready for Approval, and no card lets them through.
 */
describe("the EPFO statutory setup hold, through the Calculation & Review cards", () => {
  const JOINER = { employee: { date_of_joining: "2026-08-10", uan: null, pf_number: null } };
  const NO_ID = { uan: null, pf_number: null };
  // The hold's other live trigger: a PF member with no Date of Joining.
  const NO_DOJ = { date_of_joining: null };
  const WITH_DOJ = { date_of_joining: "2026-08-10" };
  const ids = (view) => view.rows.map((r) => r.employee_id).sort((a, b) => a - b);
  const card = (c, extra = {}) => calculation.getMonth({ ...MONTH, card: c, ...extra });
  const holdOf = (row) => row.blockers.find((b) => b.code === "STATUTORY_SETUP_INCOMPLETE");

  it("held + never calculated -> Not Calculated card, and the row says exactly what is missing", async () => {
    world.add(1, JOINER).add(2);
    world.statutory.set(1, NO_ID);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });

    const view = await monthView();
    const row = view.rows.find((r) => r.employee_id === 1);
    assert.equal(row.status, CALC_STATUS.NOT_CALCULATED);
    assert.equal(row.calculable, false);
    const hold = holdOf(row);
    assert.equal(hold.label, "Statutory setup incomplete - on hold");
    assert.match(hold.message, /^On hold - statutory setup incomplete: UAN \(or PF Number\) not recorded\./);
    for (const c of ["CALCULATED", "CALCULATED_NOT_READY", "READY_FOR_APPROVAL", "RECALCULATION_REQUIRED", "ATTENDANCE_NEEDS_ACTION"]) {
      assert.ok(!ids(await card(c)).includes(1), `a held employee must not be in ${c}`);
    }
    assert.ok(ids(await card("ALL")).includes(1));
    assert.deepEqual(ids(await card("NOT_CALCULATED")), [1]);
    assert.equal(view.summary.cards.NOT_CALCULATED, 1);
    assert.equal(view.summary.not_calculated_blocked, 1);
    // Calculate refuses them by name; nothing is written.
    const refused = await calculation.calculate({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(refused.results[0].result, ROW_RESULT.BLOCKED);
    assert.equal(world.calculations.has(1), false);
  });

  it("Approve All Ready - and naming the held employee - never approves them, whatever card is being viewed", async () => {
    world.add(1, JOINER).add(2);
    world.statutory.set(1, NO_ID);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    await card("CALCULATED_NOT_READY");
    const all = await calculation.approve({ ...MONTH, all_ready: true, actor: ACTOR });
    assert.equal(all.approved_count, 1);
    assert.deepEqual(ids(await card("APPROVED_LOCKED")), [2]);
    const named = await calculation.approve({ ...MONTH, employee_ids: [1], actor: ACTOR });
    assert.equal(named.approved_count, 0);
    assert.equal(world.calculations.has(1), false, "nothing was written for the held employee");
  });

  it("resolving the setup releases the hold: calculate, and the employee moves into Calculated and Ready for Approval", async () => {
    world.add(1, { employee: { date_of_joining: null } });
    world.statutory.set(1, NO_DOJ);
    assert.equal((await monthView()).summary.cards.CALCULATED, 0);
    assert.deepEqual(ids(await card("NOT_CALCULATED")), [1]);
    world.statutory.set(1, WITH_DOJ);
    // The hold lifts on the next read: still Not Calculated, but calculable.
    const released = (await card("NOT_CALCULATED")).rows[0];
    assert.equal(released.calculable, true);
    assert.equal(holdOf(released), undefined);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    assert.deepEqual(ids(await card("READY_FOR_APPROVAL")), [1]);
    assert.deepEqual(ids(await card("CALCULATED")), [1]);
    assert.deepEqual(ids(await card("NOT_CALCULATED")), []);
    assert.equal(holdOf((await monthView()).rows[0]), undefined);
  });

  it("a hold that appears AFTER calculation makes the row Recalculation Required, shows the hold, and refuses approval and recalculation", async () => {
    world.add(1, { employee: { date_of_joining: "2026-08-10" } }).add(2);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    assert.deepEqual(ids(await card("READY_FOR_APPROVAL")), [1, 2]);

    world.employees.get(1).date_of_joining = null;
    world.statutory.set(1, NO_DOJ);
    const row = (await card("RECALCULATION_REQUIRED")).rows[0];
    assert.equal(row.employee_id, 1);
    assert.ok(row.recalculation_reasons.some((r) => r.code === "STATUTORY_CONTEXT_CHANGED"));
    assert.ok(holdOf(row), "the hold is shown on the stale row");
    assert.ok(!ids(await card("CALCULATED")).includes(1));
    assert.ok(!ids(await card("CALCULATED_NOT_READY")).includes(1));

    const approved = await calculation.approve({ ...MONTH, all_ready: true, actor: ACTOR });
    assert.equal(approved.approved_count, 1); // employee 2 only
    const recalc = await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.notEqual(recalc.results[0].result, ROW_RESULT.RECALCULATED);

    // Completing the setup lets the recalculation through, back to Ready.
    world.statutory.set(1, WITH_DOJ);
    await calculation.calculate({ ...MONTH, employee_ids: [1], mode: "RECALCULATE", actor: ACTOR });
    assert.deepEqual(ids(await card("READY_FOR_APPROVAL")), [1]);
  });

  it("every card's count still equals the rows its filter returns with held employees in the month", async () => {
    world.add(1, JOINER).add(2).add(3);
    world.statutory.set(1, NO_ID);
    world.states.delete(3);
    await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    const all = await monthView();
    for (const c of Object.keys(all.summary.cards)) {
      assert.equal((await card(c)).rows.length, all.summary.cards[c], `${c} count and rows disagree`);
    }
    assert.equal(all.summary.cards.CALCULATED - all.summary.cards.READY_FOR_APPROVAL, all.summary.cards.CALCULATED_NOT_READY);
  });
});

describe("the Not Calculated card: awaiting calculation vs blocked from it", () => {
  const JOINER = { employee: { date_of_joining: "2026-08-10", uan: null, pf_number: null } };
  const NO_ID = { uan: null, pf_number: null };
  const ids = (view) => view.rows.map((r) => r.employee_id).sort((a, b) => a - b);

  it("holds every NOT_CALCULATED employee; `calculable` and the blockers tell ordinary from held", async () => {
    world.add(1).add(2, JOINER).add(3);
    world.statutory.set(2, NO_ID);
    await calculation.calculate({ ...MONTH, employee_ids: [3], actor: ACTOR });

    const view = await calculation.getMonth({ ...MONTH, card: "NOT_CALCULATED" });
    assert.deepEqual(ids(view), [1, 2]);
    const ordinary = view.rows.find((r) => r.employee_id === 1);
    const held = view.rows.find((r) => r.employee_id === 2);
    // Ordinary: Calculate would accept them; the only "reason" is that it has not run.
    assert.equal(ordinary.calculable, true);
    assert.equal(ordinary.statutory_hold, null);
    assert.deepEqual(codesOf(ordinary), ["NOT_CALCULATED"]);
    // Held: Calculate would refuse them, and the hold names the fields.
    assert.equal(held.calculable, false);
    assert.deepEqual(held.statutory_hold.missing_labels, ["UAN (or PF Number)"]);
    assert.ok(codesOf(held).includes("STATUTORY_SETUP_INCOMPLETE"));
    // Calculate All Eligible takes the ordinary one only.
    assert.equal(view.summary.eligible_to_calculate, 1);
    assert.equal(view.summary.not_calculated_blocked, 1);
    assert.equal(view.summary.cards.NOT_CALCULATED, 2);
    const run = await calculation.calculate({ ...MONTH, all_eligible: true, actor: ACTOR });
    assert.deepEqual(run.results.map((r) => [r.employee_id, r.result]), [[1, ROW_RESULT.CALCULATED]]);
    assert.deepEqual(ids(await calculation.getMonth({ ...MONTH, card: "NOT_CALCULATED" })), [2]);
  });

  it("Not Calculated and Recalculation Required stay outside Calculated = Not Ready + Ready", async () => {
    world.add(1).add(2).add(3).add(4);
    world.states.delete(3);
    await calculation.calculate({ ...MONTH, employee_ids: [2, 3, 4], actor: ACTOR });
    world.salaries.get(4).monthly_gross = 30000;
    world.salaries.get(4).salary_id = 9004;
    const c = (await monthView()).summary.cards;
    assert.deepEqual(
      [c.NOT_CALCULATED, c.CALCULATED, c.CALCULATED_NOT_READY, c.READY_FOR_APPROVAL, c.RECALCULATION_REQUIRED],
      [1, 2, 1, 1, 1]
    );
    assert.equal(c.CALCULATED, c.CALCULATED_NOT_READY + c.READY_FOR_APPROVAL);
    assert.equal(c.ALL, c.NOT_CALCULATED + c.CALCULATED + c.RECALCULATION_REQUIRED);
  });
});
