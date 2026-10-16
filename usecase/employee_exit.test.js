/**
 * F&F SETTLEMENT, EXIT INTERVIEW AND REHIRE - the usecase rules, over an
 * in-memory repository that keeps the real repository's contract (the
 * outcomes its transactions return). The SQL of that contract - locks,
 * unique keys, concurrency - is proved in repository/employee_exit.mysql.test.js.
 *
 *   node --test usecase/employee_exit.test.js
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const buildUsecase = require("./employee_exit");
const { isExitMonth } = require("../utils/fnf");

function memoryRepo() {
  const state = {
    payrun: [], // { year, month, employee_id, employee_name, store_id, exit_date, calc_status, published, document_type }
    periods: [], // { employee_id, period_id, ended_on }
    cases: [], // { fnf_settlement_id, employee_id, exit_date, status, payrun_key }
    items: [],
    interviews: new Map(),
    rehire: [],
    saveCalls: [],
  };
  let nextCase = 1;
  const find = (y, m, e) => state.payrun.find((r) => r.year === y && r.month === m && r.employee_id === e);
  const caseOf = (e, d) => state.cases.find((c) => c.employee_id === e && c.exit_date === d);
  const repo = {
    state,
    async listMonthPayrunExits({ year, month, store_ids, employee_ids }) {
      return state.payrun
        .filter((r) => r.year === year && r.month === month && isExitMonth({ year, month, resignation_date: r.exit_date }))
        .filter((r) => !store_ids || store_ids.includes(r.store_id))
        .filter((r) => !employee_ids || employee_ids.includes(r.employee_id))
        .map((r) => {
          const c = caseOf(r.employee_id, r.exit_date);
          return {
            ...r,
            store_name: "Ecr",
            payrun_calculation_id: r.calc_status ? 1 : null,
            calc_stored_status: r.calc_status,
            published_at: r.published ? "2026-09-05 10:00:00" : null,
            net_pay: "5031.00",
            fnf_settlement_id: c ? c.fnf_settlement_id : null,
            settlement_status: c ? c.status : null,
          };
        });
    },
    async listMonthUninitializedExits() {
      return [];
    },
    async listItems() {
      return state.items;
    },
    async listItemAudit() {
      return [];
    },
    async saveItems(args) {
      state.saveCalls.push(args);
      const r = find(args.year, args.month, args.employee_id);
      if (!r) return { outcome: "NOT_INITIALIZED" };
      if (r.calc_status === "APPROVED_LOCKED") return { outcome: "APPROVED_LOCKED" };
      if (!args.isExitMonth({ year: args.year, month: args.month, resignation_date: r.exit_date })) return { outcome: "NOT_EXIT_MONTH" };
      return { outcome: "SAVED", set: args.entries.filter((e) => e.amount !== null).length, cleared: 0 };
    },
    async ensureCase({ employee_id, exit_date }) {
      let c = caseOf(employee_id, exit_date);
      if (!c) {
        c = { fnf_settlement_id: nextCase++, employee_id, exit_date, status: "PENDING" };
        state.cases.push(c);
      }
      return c.fnf_settlement_id;
    },
    async getCase(id) {
      const c = state.cases.find((x) => x.fnf_settlement_id === Number(id));
      return c ? { ...c, settlement_status: c.status } : null;
    },
    async settle({ year, month, employee_id }) {
      const r = find(year, month, employee_id);
      if (!r || !r.calc_status) return { outcome: "NOT_CALCULATED" };
      if (!r.published) return { outcome: "NOT_PUBLISHED" };
      if (r.document_type !== "FNF") return { outcome: "NOT_FNF" };
      const id = await repo.ensureCase({ employee_id, exit_date: r.exit_date });
      const c = state.cases.find((x) => x.fnf_settlement_id === id);
      if (c.status === "SETTLED") return { outcome: "ALREADY_SETTLED", case: c };
      c.status = "SETTLED";
      return { outcome: "SETTLED", case: c };
    },
    async reopen({ year, month, employee_id }) {
      const r = find(year, month, employee_id);
      const c = r && caseOf(employee_id, r.exit_date);
      if (!c || c.status !== "SETTLED") return { outcome: "NOT_SETTLED" };
      c.status = "PENDING";
      return { outcome: "REOPENED", case: c };
    },
    async listEmployeeExits(employeeId) {
      return {
        cases: state.cases.filter((c) => c.employee_id === employeeId).map((c) => ({ ...c, settlement_status: c.status, has_interview: state.interviews.has(c.fnf_settlement_id) ? 1 : 0 })),
        periods: state.periods.filter((p) => p.employee_id === employeeId),
      };
    },
    async saveInterview(caseId, employeeId, fields) {
      const prev = state.interviews.get(caseId);
      const row = { fnf_settlement_id: caseId, employee_id: employeeId, ...fields, revision: prev ? prev.revision + 1 : 1 };
      state.interviews.set(caseId, row);
      return row;
    },
    async getInterview(caseId) {
      return state.interviews.get(caseId) || null;
    },
    async listRehire(caseId) {
      return state.rehire.filter((r) => r.fnf_settlement_id === caseId).slice().reverse();
    },
    async addRehire(caseId, employeeId, input) {
      const prior = state.rehire.filter((r) => r.fnf_settlement_id === caseId).length;
      if (input.expectFirst && prior > 0) return { outcome: "ALREADY_ASSESSED" };
      state.rehire.push({ fnf_settlement_id: caseId, employee_id: employeeId, ...input, is_override: prior > 0 ? 1 : 0 });
      return { outcome: prior > 0 ? "OVERRIDDEN" : "ASSESSED" };
    },
    async latestRehireForEmployee(employeeId) {
      const mine = state.rehire.filter((r) => r.employee_id === employeeId);
      if (!mine.length) return null;
      const exitOf = (r) => state.cases.find((c) => c.fnf_settlement_id === r.fnf_settlement_id).exit_date;
      mine.sort((a, b) => (exitOf(a) < exitOf(b) ? -1 : 1));
      return mine[mine.length - 1];
    },
    async listSettlementEvents() {
      return [];
    },
  };
  return repo;
}

const AUG = { year: 2026, month: 8 };
let repo;
let uc;
beforeEach(() => {
  repo = memoryRepo();
  repo.state.payrun.push(
    { ...AUG, employee_id: 2095, employee_name: "PREETHA .S", store_id: 2, exit_date: "2026-08-16", calc_status: "CALCULATED", published: false, document_type: null },
    { ...AUG, employee_id: 300, employee_name: "Active A", store_id: 2, exit_date: null, calc_status: "CALCULATED", published: false, document_type: null }
  );
  repo.state.periods.push({ employee_id: 2095, period_id: 11, ended_on: "2026-08-16" });
  uc = buildUsecase(repo, { today: () => "2026-10-16" });
});

const settleInput = { ...AUG, employee_id: 2095, payment_mode: "BANK", payment_reference: "UTR123", paid_on: "2026-09-10" };

describe("the F&F list", () => {
  it("lists the month's exits only - an active employee is not an F&F", async () => {
    const m = await uc.getMonth(AUG);
    assert.deepEqual(m.rows.map((r) => r.employee_id), [2095]);
    assert.equal(m.rows[0].stage, "IN_PAYROLL");
  });
  it("respects the caller's branch scope", async () => {
    assert.equal((await uc.getMonth({ ...AUG, store_ids: [1] })).rows.length, 0);
  });
});

describe("F&F items", () => {
  it("validates before anything is written: unknown component, duplicate, negative, three decimals", async () => {
    for (const items of [
      [{ component: "OTHER", amount: 1 }],
      [{ component: "GRATUITY", amount: 1 }, { component: "GRATUITY", amount: 2 }],
      [{ component: "GRATUITY", amount: -1 }],
      [{ component: "GRATUITY", amount: 1.234 }],
    ]) {
      await assert.rejects(uc.saveItems({ ...AUG, employee_id: 2095, items }), { name: "ValidationError" });
    }
    assert.equal(repo.state.saveCalls.length, 0);
  });

  it("zero clears a line, like an Adjustment's zero", async () => {
    await uc.saveItems({ ...AUG, employee_id: 2095, items: [{ component: "GRATUITY", amount: 0 }] });
    assert.equal(repo.state.saveCalls[0].entries[0].amount, null);
  });

  it("an active employee (no exit this month) cannot be given F&F items", async () => {
    await assert.rejects(uc.saveItems({ ...AUG, employee_id: 300, items: [{ component: "GRATUITY", amount: 10 }] }), { name: "NotFoundError" });
  });

  it("an approved & locked month refuses F&F changes - the published payroll is never silently modified", async () => {
    repo.state.payrun[0].calc_status = "APPROVED_LOCKED";
    await assert.rejects(
      uc.saveItems({ ...AUG, employee_id: 2095, items: [{ component: "GRATUITY", amount: 10 }] }),
      (err) => err.name === "ConflictError" && /approved & locked/.test(err.message)
    );
  });
});

describe("settlement completion", () => {
  it("cannot be settled before the F&F is approved and published", async () => {
    await assert.rejects(uc.settle(settleInput), (err) => err.name === "ConflictError" && /published/.test(err.message));
  });

  it("a published F&F is settled ONCE; a second attempt is refused (no duplicate settlement)", async () => {
    Object.assign(repo.state.payrun[0], { calc_status: "APPROVED_LOCKED", published: true, document_type: "FNF" });
    const first = await uc.settle(settleInput);
    assert.equal(first.outcome, "SETTLED");
    await assert.rejects(uc.settle(settleInput), (err) => err.name === "ConflictError" && /already/.test(err.message));
    assert.equal(repo.state.cases.length, 1);
  });

  it("a month whose published document is a Salary Payslip is not an F&F to settle", async () => {
    Object.assign(repo.state.payrun[0], { calc_status: "APPROVED_LOCKED", published: true, document_type: "PAYSLIP" });
    await assert.rejects(uc.settle(settleInput), /not a Full & Final/);
  });

  it("validates the payment: mode, bank reference, date not in the future or before the exit", async () => {
    Object.assign(repo.state.payrun[0], { calc_status: "APPROVED_LOCKED", published: true, document_type: "FNF" });
    await assert.rejects(uc.settle({ ...settleInput, payment_mode: "UPI" }), { name: "ValidationError" });
    await assert.rejects(uc.settle({ ...settleInput, payment_reference: "" }), /reference/);
    await assert.rejects(uc.settle({ ...settleInput, paid_on: "2026-12-01" }), /future/);
    await assert.rejects(uc.settle({ ...settleInput, paid_on: "2026-08-01" }), /before the last working day/);
    const cash = await uc.settle({ ...settleInput, payment_mode: "CASH", payment_reference: null });
    assert.equal(cash.outcome, "SETTLED");
  });

  it("reopen needs a reason and a settled F&F", async () => {
    await assert.rejects(uc.reopen({ ...AUG, employee_id: 2095, reason: " " }), /reason/);
    await assert.rejects(uc.reopen({ ...AUG, employee_id: 2095, reason: "wrong UTR" }), /not marked settled/);
    Object.assign(repo.state.payrun[0], { calc_status: "APPROVED_LOCKED", published: true, document_type: "FNF" });
    await uc.settle(settleInput);
    assert.equal((await uc.reopen({ ...AUG, employee_id: 2095, reason: "wrong UTR" })).outcome, "REOPENED");
  });
});

describe("exit interview and rehire stay with their own exit", () => {
  it("an interview can only be recorded against a real exit of this employee", async () => {
    await assert.rejects(
      uc.saveInterview(2095, { exit_date: "2025-01-01", interview_date: "2026-08-16", primary_reason: "RELOCATION" }),
      { name: "NotFoundError" }
    );
  });

  it("a REJOINED employee's second exit is a separate case: the first exit's interview, rehire and settlement are untouched", async () => {
    await uc.saveInterview(2095, { exit_date: "2026-08-16", interview_date: "2026-08-16", primary_reason: "RELOCATION", rating_job_satisfaction: 4 });
    await uc.assessRehire(2095, { exit_date: "2026-08-16", eligibility: "YES" }, { canManage: true, canOverride: false });
    Object.assign(repo.state.payrun[0], { calc_status: "APPROVED_LOCKED", published: true, document_type: "FNF" });
    await uc.settle(settleInput);

    // Rejoined in October, resigned again in December.
    repo.state.periods.push({ employee_id: 2095, period_id: 12, ended_on: "2026-12-20" });
    const DEC = { year: 2026, month: 12 };
    repo.state.payrun.push({ ...DEC, employee_id: 2095, employee_name: "PREETHA .S", store_id: 2, exit_date: "2026-12-20", calc_status: "APPROVED_LOCKED", published: true, document_type: "FNF" });
    uc = buildUsecase(repo, { today: () => "2027-01-10" });
    await uc.saveInterview(2095, { exit_date: "2026-12-20", interview_date: "2026-12-20", primary_reason: "COMPENSATION" });
    await uc.assessRehire(2095, { exit_date: "2026-12-20", eligibility: "NO", note: "absconded notice" }, { canManage: true, canOverride: false });
    // A previous F&F completion does not prevent the new, legitimate settlement.
    const second = await uc.settle({ ...DEC, employee_id: 2095, payment_mode: "CASH", paid_on: "2027-01-05" });
    assert.equal(second.outcome, "SETTLED");

    const exits = await uc.employeeExits(2095);
    assert.deepEqual(exits.exits.map((e) => [e.exit_date, e.settlement_status, e.has_interview, e.rehire && e.rehire.eligibility]), [
      ["2026-12-20", "SETTLED", true, "NO"],
      ["2026-08-16", "SETTLED", true, "YES"],
    ]);
    assert.equal(exits.latest_rehire.eligibility, "NO");
    const first = repo.state.interviews.get(1);
    assert.equal(first.primary_reason, "RELOCATION");
    assert.equal(first.revision, 1);
  });

  it("an interview edit stays on the same exit and bumps its revision", async () => {
    const base = { exit_date: "2026-08-16", interview_date: "2026-08-16", primary_reason: "RELOCATION" };
    await uc.saveInterview(2095, base);
    const again = await uc.saveInterview(2095, { ...base, primary_reason: "HEALTH" });
    assert.equal(again.interview.revision, 2);
    assert.equal(repo.state.cases.length, 1);
  });

  it("validates the interview: reason from the list, ratings 1-5, no future date", async () => {
    const base = { exit_date: "2026-08-16", interview_date: "2026-08-16", primary_reason: "RELOCATION" };
    await assert.rejects(uc.saveInterview(2095, { ...base, primary_reason: "BORED" }), { name: "ValidationError" });
    await assert.rejects(uc.saveInterview(2095, { ...base, rating_compensation: 6 }), /1 to 5/);
    await assert.rejects(uc.saveInterview(2095, { ...base, interview_date: "2027-01-01" }), /future/);
  });
});

describe("rehire eligibility overrides", () => {
  const exit = { exit_date: "2026-08-16" };

  it("CONDITIONAL must say its conditions", async () => {
    await assert.rejects(uc.assessRehire(2095, { ...exit, eligibility: "CONDITIONAL" }, { canManage: true }), /conditions/);
    const ok = await uc.assessRehire(2095, { ...exit, eligibility: "CONDITIONAL", conditions: "Only at a different outlet" }, { canManage: true });
    assert.equal(ok.outcome, "ASSESSED");
  });

  it("the first assessment needs Manage; changing it needs Override AND a reason; history is kept", async () => {
    await assert.rejects(uc.assessRehire(2095, { ...exit, eligibility: "YES" }, { canManage: false, canOverride: true }), { name: "ForbiddenError" });
    await uc.assessRehire(2095, { ...exit, eligibility: "YES" }, { canManage: true, canOverride: false });
    await assert.rejects(uc.assessRehire(2095, { ...exit, eligibility: "NO" }, { canManage: true, canOverride: false }), { name: "ForbiddenError" });
    await assert.rejects(uc.assessRehire(2095, { ...exit, eligibility: "NO" }, { canManage: true, canOverride: true }), /reason/);
    const res = await uc.assessRehire(2095, { ...exit, eligibility: "NO", override_reason: "Cash shortage found after exit" }, { canManage: false, canOverride: true });
    assert.equal(res.outcome, "OVERRIDDEN");
    assert.deepEqual(res.history.map((h) => h.eligibility), ["NO", "YES"]);
    assert.equal((await uc.rehireStatus(2095)).rehire.eligibility, "NO");
  });

  it("two people giving the 'first' assessment at once: the second is refused, not silently an override", async () => {
    const realAdd = repo.addRehire;
    repo.addRehire = async (caseId, emp, input) => {
      // Somebody else's first assessment lands between the read and the write.
      repo.state.rehire.push({ fnf_settlement_id: caseId, employee_id: emp, eligibility: "YES" });
      return realAdd(caseId, emp, input);
    };
    await assert.rejects(uc.assessRehire(2095, { ...exit, eligibility: "NO" }, { canManage: true, canOverride: false }), { name: "ConflictError" });
  });
});
