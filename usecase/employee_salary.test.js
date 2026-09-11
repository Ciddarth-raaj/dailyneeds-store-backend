/**
 * M2 — the salary lifecycle.
 *
 *   node --test usecase/employee_salary.test.js
 *
 * Run against a fake repository: these are assertions about the RULES, and
 * the rules are what has to hold whatever the database does. The arithmetic
 * itself is proved in `utils/salary_engine.test.js`; what is proved here is
 * when a salary may be created, what date it lands on, which record is
 * current, and what may never be changed.
 *
 * The things that would be wrong silently:
 *
 *   a pending or rejected record resolving as somebody's current salary
 *   a future increment becoming current early
 *   an approved record being edited instead of superseded
 *   a client-supplied `basic` or `employee_pf` reaching the row
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const build = require("./employee_salary");
const { SOURCE } = require("./employee_salary");

const EMPLOYEE = {
  employee_id: 42,
  employee_name: "Test Person",
  status: 1,
  pf_applicable: 1,
  esi_applicable: 0,
  previous_pf_member: 1,
  dob: "1990-05-10",
  date_of_joining: "2019-06-01",
};

/**
 * A fake `employee_salary` repository holding rows in memory.
 *
 * It enforces the one rule the real one delegates to the database - at most
 * one non-rejected revision per employee and effective date - because that
 * rule is part of the behaviour the usecase is written against.
 */
function makeRepo(employee = EMPLOYEE, rows = []) {
  let nextId = rows.length + 1;
  return {
    rows,
    employee,
    async getStatutoryContext(id) {
      return Number(id) === Number(this.employee.employee_id) ? { ...this.employee } : null;
    },
    async hasLiveSalary(id) {
      return this.rows.some(
        (r) => Number(r.employee_id) === Number(id) && r.status !== "REJECTED"
      );
    },
    async getActiveRevisionAt(id, date) {
      return (
        this.rows.find(
          (r) =>
            Number(r.employee_id) === Number(id) &&
            r.effective_from === date &&
            r.status !== "REJECTED"
        ) || null
      );
    },
    async getFutureRevisions(id, after) {
      return this.rows.filter(
        (r) =>
          Number(r.employee_id) === Number(id) && r.effective_from > after && r.status !== "REJECTED"
      );
    },
    async getCurrentSalary(id, asOf) {
      const eligible = this.rows
        .filter(
          (r) =>
            Number(r.employee_id) === Number(id) &&
            r.status === "APPROVED" &&
            r.effective_from <= asOf
        )
        .sort((a, b) =>
          a.effective_from === b.effective_from
            ? b.salary_id - a.salary_id
            : a.effective_from < b.effective_from
            ? 1
            : -1
        );
      return eligible[0] || null;
    },
    async getHistory(id) {
      return this.rows.filter((r) => Number(r.employee_id) === Number(id));
    },
    async getById(salaryId) {
      return this.rows.find((r) => Number(r.salary_id) === Number(salaryId)) || null;
    },
    async create(row) {
      const clash = await this.getActiveRevisionAt(row.employee_id, row.effective_from);
      if (clash) throw new Error("duplicate active revision");
      const saved = { ...row, salary_id: nextId++ };
      this.rows.push(saved);
      return saved.salary_id;
    },
    async updatePending(salaryId, patch) {
      const row = this.rows.find((r) => Number(r.salary_id) === Number(salaryId));
      if (!row || row.status !== "PENDING") return 0;
      Object.assign(row, patch);
      return 1;
    },
    async approve(salaryId, by) {
      const row = this.rows.find((r) => Number(r.salary_id) === Number(salaryId));
      if (!row || row.status !== "PENDING") return 0;
      row.status = "APPROVED";
      row.approved_by = by;
      return 1;
    },
    async reject(salaryId, by, reason) {
      const row = this.rows.find((r) => Number(r.salary_id) === Number(salaryId));
      if (!row || row.status !== "PENDING") return 0;
      row.status = "REJECTED";
      row.rejected_by = by;
      row.rejection_reason = reason;
      return 1;
    },
  };
}

const ACTOR = { employeeId: 7 };

/** A stored row, for the resolver tests. */
const row = (over) => ({
  salary_id: over.salary_id,
  employee_id: 42,
  monthly_gross: 20000,
  status: "APPROVED",
  effective_from: "2026-04-01",
  manual_override: 0,
  unresolved_notes: "[]",
  statutory_snapshot: "{}",
  ...over,
});

/* --------------------------------------------------------------- creation */

describe("creating an opening salary", () => {
  it("dates the FIRST record at the later of the floor and the DOJ", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    const r = await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    assert.equal(r.effective_from, "2026-04-01", "a 2019 joiner starts at the floor");
    assert.equal(r.source, SOURCE.OPENING_SALARY);
  });

  it("dates a later joiner at their DOJ", async () => {
    const repo = makeRepo({ ...EMPLOYEE, date_of_joining: "2026-09-15" });
    const uc = build(repo);
    const r = await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    assert.equal(r.effective_from, "2026-09-15");
  });

  it("falls back to the floor when the DOJ was never recorded", async () => {
    // 425 of the 630 production rows have no date of joining at all.
    const repo = makeRepo({ ...EMPLOYEE, date_of_joining: null });
    const uc = build(repo);
    const r = await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    assert.equal(r.effective_from, "2026-04-01");
  });

  it("IGNORES a caller-supplied effective date on the opening record", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    const r = await uc.createInitialSalary(
      42,
      { monthly_gross: 20000, effective_from: "2020-01-01" },
      ACTOR
    );
    assert.equal(r.effective_from, "2026-04-01", "the opening date is a fact, not a preference");
  });

  it("NEVER creates an approved record", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    const r = await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    assert.equal(r.status, "PENDING");
    assert.equal(repo.rows[0].status, "PENDING");
    assert.equal(repo.rows[0].approved_by, undefined);
  });

  it("does not copy the legacy new_employee.salary", async () => {
    const repo = makeRepo({ ...EMPLOYEE, salary: "18000" });
    const uc = build(repo);
    await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    assert.equal(repo.rows[0].monthly_gross, 20000, "the gross is the one that was entered");
    assert.equal(repo.rows[0].salary, undefined, "no legacy column reaches the row");
  });

  it("records who created it", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    assert.equal(repo.rows[0].created_by, 7);
  });

  it("refuses an employee that does not exist", async () => {
    const uc = build(makeRepo());
    await assert.rejects(() => uc.createInitialSalary(999, { monthly_gross: 1 }, ACTOR), /not found/);
  });

  it("a SECOND record is a revision and takes the caller's date", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    const second = await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01" },
      ACTOR
    );
    assert.equal(second.source, SOURCE.REVISION);
    assert.equal(second.effective_from, "2026-10-01");
  });

  it("refuses a second live revision at the same effective date", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    await assert.rejects(
      () => uc.createInitialSalary(42, { monthly_gross: 30000, effective_from: "2026-04-01" }, ACTOR),
      /already exists/
    );
  });

  it("reports a FUTURE conflict rather than hiding it", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    await uc.createInitialSalary(42, { monthly_gross: 30000, effective_from: "2026-12-01" }, ACTOR);
    const backdated = await uc.createInitialSalary(
      42,
      { monthly_gross: 22000, effective_from: "2026-07-01" },
      ACTOR
    );
    assert.equal(backdated.future_conflicts.length, 1);
    assert.equal(backdated.future_conflicts[0].effective_from, "2026-12-01");
  });
});

/* ---------------------------------------------- never trust the caller */

describe("the server calculates everything", () => {
  it("a body full of invented statutory amounts changes nothing", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    await uc.createInitialSalary(
      42,
      {
        monthly_gross: 20000,
        // Every one of these is a lie a client might send.
        basic: 19000,
        employee_pf: 1,
        employer_epf: 2,
        employer_eps: 3,
        monthly_ctc: 4,
        daily_salary: 5,
        status: "APPROVED",
        source: "IMPORT",
        approved_by: 999,
      },
      ACTOR
    );
    const saved = repo.rows[0];
    assert.equal(saved.basic, 10000, "the breakup is computed, not accepted");
    assert.equal(saved.employee_pf, 1200);
    assert.equal(saved.daily_salary, 769.23);
    assert.equal(saved.status, "PENDING", "a caller cannot create an approved record");
    assert.equal(saved.source, SOURCE.OPENING_SALARY, "nor choose the source");
    assert.equal(saved.approved_by, undefined);
  });

  it("statutory facts come from the employee master, not the request", async () => {
    const repo = makeRepo({ ...EMPLOYEE, pf_applicable: 0 });
    const uc = build(repo);
    await uc.createInitialSalary(42, { monthly_gross: 20000, pf_applicable: 1 }, ACTOR);
    assert.equal(repo.rows[0].pf_status, "NOT_APPLICABLE", "the master says no; the body cannot say yes");
    assert.equal(repo.rows[0].employee_pf, 0);
  });

  it("an unresolved statutory question is stored as a named reason", async () => {
    const repo = makeRepo({ ...EMPLOYEE, pf_applicable: null });
    const uc = build(repo);
    await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    const saved = repo.rows[0];
    assert.equal(saved.pf_status, "PENDING");
    assert.equal(saved.employee_pf, null, "never a plausible-looking zero");
    assert.match(saved.unresolved_notes, /PF_APPLICABILITY_NOT_RECORDED/);
    assert.equal(saved.monthly_ctc, null);
    assert.equal(saved.ctc_status, "PENDING");
  });

  it("every record stores the snapshot that explains it", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    await uc.createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    const snapshot = JSON.parse(repo.rows[0].statutory_snapshot);
    assert.equal(snapshot.pf_wage_ceiling, 15000);
    assert.ok(repo.rows[0].statutory_config_version);
  });
});

/* ------------------------------------------------------- manual override */

describe("manual override", () => {
  it("is refused without a reason when Basic moves", async () => {
    const uc = build(makeRepo());
    await assert.rejects(
      () =>
        uc.createInitialSalary(
          42,
          {
            monthly_gross: 50000,
            manual_components: { basic: 20000, conveyance: 2500, hra: 10000, special_allowance: 17500 },
            manual_override: true,
          },
          ACTOR
        ),
      /reason is required/
    );
  });

  it("is stored with its reason and flag when accepted", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    await uc.createInitialSalary(
      42,
      {
        monthly_gross: 50000,
        manual_components: { basic: 20000, conveyance: 2500, hra: 10000, special_allowance: 17500 },
        manual_override: true,
        override_reason: "Retained structure from previous employer",
      },
      ACTOR
    );
    const saved = repo.rows[0];
    assert.equal(saved.manual_override, 1);
    assert.equal(saved.override_reason, "Retained structure from previous employer");
    assert.equal(saved.basic, 20000);
    assert.equal(saved.employee_pf, 1800, "statutory rules still apply to an overridden Basic");
  });

  it("is refused when the components do not add up to the gross", async () => {
    const uc = build(makeRepo());
    await assert.rejects(
      () =>
        uc.createInitialSalary(
          42,
          {
            monthly_gross: 50000,
            manual_components: { basic: 20000, conveyance: 2500, hra: 10000, special_allowance: 1 },
            manual_override: true,
            override_reason: "x",
          },
          ACTOR
        ),
      /add up to the monthly gross/
    );
  });
});

/* --------------------------------------------------------- the resolver */

describe("the current-salary resolver", () => {
  const uc = (rows) => build(makeRepo(EMPLOYEE, rows));

  it("returns null when nothing has ever been recorded", async () => {
    const r = await uc([]).getCurrentSalary(42, "2026-06-01");
    assert.equal(r.current_salary, null, "not recorded is a real answer, and it is not zero");
  });

  it("returns the latest APPROVED record effective on or before the date", async () => {
    const r = await uc([
      row({ salary_id: 1, effective_from: "2026-04-01", monthly_gross: 20000 }),
      row({ salary_id: 2, effective_from: "2026-06-01", monthly_gross: 25000 }),
    ]).getCurrentSalary(42, "2026-07-01");
    assert.equal(r.current_salary.salary_id, 2);
    assert.equal(r.current_salary.monthly_gross, 25000);
  });

  it("a PENDING record is never current", async () => {
    const r = await uc([
      row({ salary_id: 1, effective_from: "2026-04-01" }),
      row({ salary_id: 2, effective_from: "2026-06-01", status: "PENDING", monthly_gross: 99999 }),
    ]).getCurrentSalary(42, "2026-07-01");
    assert.equal(r.current_salary.salary_id, 1);
  });

  it("a REJECTED record is never current", async () => {
    const r = await uc([
      row({ salary_id: 1, effective_from: "2026-04-01" }),
      row({ salary_id: 2, effective_from: "2026-06-01", status: "REJECTED", monthly_gross: 99999 }),
    ]).getCurrentSalary(42, "2026-07-01");
    assert.equal(r.current_salary.salary_id, 1);
  });

  it("a FUTURE approved record is not current until its effective date", async () => {
    const rows = [
      row({ salary_id: 1, effective_from: "2026-04-01", monthly_gross: 20000 }),
      row({ salary_id: 2, effective_from: "2026-12-01", monthly_gross: 30000 }),
    ];
    const before = await uc(rows).getCurrentSalary(42, "2026-11-30");
    assert.equal(before.current_salary.salary_id, 1, "not a day early");

    const on = await uc(rows).getCurrentSalary(42, "2026-12-01");
    assert.equal(on.current_salary.salary_id, 2, "current exactly on the effective date");
  });

  it("returns null before the first record's effective date", async () => {
    const r = await uc([row({ salary_id: 1, effective_from: "2026-04-01" })]).getCurrentSalary(
      42,
      "2026-03-31"
    );
    assert.equal(r.current_salary, null);
  });

  it("the payload is NOT keyed `salary` — B3 would strip that key by name", async () => {
    const r = await uc([row({ salary_id: 1 })]).getCurrentSalary(42, "2026-06-01");
    assert.equal(r.salary, undefined);
    assert.ok(r.current_salary);
  });

  it("flattens the effective date and parses the JSON columns", async () => {
    const r = await uc([
      row({ salary_id: 1, unresolved_notes: '[{"code":"X"}]', statutory_snapshot: '{"a":1}' }),
    ]).getCurrentSalary(42, "2026-06-01");
    assert.equal(r.current_salary.effective_from, "2026-04-01");
    assert.deepEqual(r.current_salary.unresolved_notes, [{ code: "X" }]);
    assert.deepEqual(r.current_salary.statutory_snapshot, { a: 1 });
    assert.equal(r.current_salary.manual_override, false);
  });
});

/* -------------------------------------------------------- the lifecycle */

describe("approval and immutability", () => {
  it("approves a pending revision and records who did it", async () => {
    const repo = makeRepo(EMPLOYEE, [row({ salary_id: 1, status: "PENDING" })]);
    const r = await build(repo).approveSalary(1, ACTOR);
    assert.equal(r.status, "APPROVED");
    assert.equal(repo.rows[0].approved_by, 7);
  });

  it("REFUSES TO EDIT AN APPROVED RECORD", async () => {
    const repo = makeRepo(EMPLOYEE, [row({ salary_id: 1, status: "APPROVED" })]);
    await assert.rejects(
      () => build(repo).updatePendingSalary(1, { monthly_gross: 99999 }, ACTOR),
      /Only a pending salary revision can be changed/
    );
    assert.equal(repo.rows[0].monthly_gross, 20000, "nothing changed");
  });

  it("refuses to edit a rejected record", async () => {
    const repo = makeRepo(EMPLOYEE, [row({ salary_id: 1, status: "REJECTED" })]);
    await assert.rejects(() => build(repo).updatePendingSalary(1, { monthly_gross: 1 }, ACTOR));
  });

  it("amends a PENDING record and recalculates it", async () => {
    const repo = makeRepo(EMPLOYEE, [row({ salary_id: 1, status: "PENDING", source: "OPENING_SALARY" })]);
    await build(repo).updatePendingSalary(1, { monthly_gross: 50000 }, ACTOR);
    assert.equal(repo.rows[0].monthly_gross, 50000);
    assert.equal(repo.rows[0].basic, 25000, "recalculated, not patched");
  });

  it("an amendment cannot move the record's identity", async () => {
    const repo = makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "PENDING", source: "OPENING_SALARY", effective_from: "2026-04-01" }),
    ]);
    await build(repo).updatePendingSalary(
      1,
      { monthly_gross: 30000, effective_from: "2027-01-01" },
      ACTOR
    );
    assert.equal(repo.rows[0].effective_from, "2026-04-01", "the date is not amendable");
    assert.equal(repo.rows[0].employee_id, 42);
    assert.equal(repo.rows[0].status, "PENDING");
  });

  it("approving twice does nothing the second time", async () => {
    const repo = makeRepo(EMPLOYEE, [row({ salary_id: 1, status: "PENDING" })]);
    const uc = build(repo);
    await uc.approveSalary(1, ACTOR);
    await assert.rejects(() => uc.approveSalary(1, ACTOR), /already approved/);
  });

  it("rejecting requires a reason", async () => {
    const repo = makeRepo(EMPLOYEE, [row({ salary_id: 1, status: "PENDING" })]);
    await assert.rejects(() => build(repo).rejectSalary(1, "   ", ACTOR), /reason is required/);
    assert.equal(repo.rows[0].status, "PENDING");
  });

  it("rejects a pending revision with its reason and rejecter", async () => {
    const repo = makeRepo(EMPLOYEE, [row({ salary_id: 1, status: "PENDING" })]);
    await build(repo).rejectSalary(1, "Wrong grade", ACTOR);
    assert.equal(repo.rows[0].status, "REJECTED");
    assert.equal(repo.rows[0].rejection_reason, "Wrong grade");
    assert.equal(repo.rows[0].rejected_by, 7);
  });

  it("a rejected date can be re-proposed", async () => {
    const repo = makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "REJECTED", effective_from: "2026-04-01" }),
    ]);
    const uc = build(repo);
    const r = await uc.createInitialSalary(42, { monthly_gross: 22000 }, ACTOR);
    assert.equal(r.effective_from, "2026-04-01", "a rejection does not block the date forever");
    assert.equal(
      r.source,
      SOURCE.OPENING_SALARY,
      "a refused proposal leaves the employee with no salary, so this is still their first"
    );
  });

  it("there is no delete method on the usecase", () => {
    const uc = build(makeRepo());
    for (const name of ["delete", "deleteSalary", "remove", "removeSalary", "destroy"]) {
      assert.equal(typeof uc[name], "undefined", `${name} must not exist - no salary delete`);
    }
  });
});

/* ------------------------------------------------------- the period lock */

describe("the salary period lock", () => {
  it("is consulted on create, and reports unlocked while payroll does not exist", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    const r = await uc.calculateForEmployee(42, { monthly_gross: 20000 });
    assert.equal(r.period_lock.locked, false);
    assert.equal(r.period_lock.reason, "PAYROLL_NOT_IMPLEMENTED");
    assert.equal(r.period_lock.period, "2026-04");
  });
});

/* ------------------------------------------------------------- preview */

describe("the preview", () => {
  it("saves nothing", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    await uc.calculateForEmployee(42, { monthly_gross: 20000 });
    assert.equal(repo.rows.length, 0);
  });

  it("agrees exactly with what the create path then stores", async () => {
    const repo = makeRepo();
    const uc = build(repo);
    const preview = await uc.calculateForEmployee(42, { monthly_gross: 37500 });
    await uc.createInitialSalary(42, { monthly_gross: 37500 }, ACTOR);
    const saved = repo.rows[0];
    assert.equal(preview.components.basic, saved.basic);
    assert.equal(preview.components.hra, saved.hra);
    assert.equal(preview.pf.employee_pf, saved.employee_pf);
    assert.equal(preview.monthly_ctc, saved.monthly_ctc);
    assert.equal(preview.effective_from, saved.effective_from);
  });
});
