/**
 * M4 — Salary Revision & Approval: the rules this module adds, and the ones it
 * must leave exactly as they were.
 *
 *   node --test usecase/m4_salary_revision_approval.test.js
 *
 * M4 builds two screens on M2's lifecycle and changes the server in two ways
 * only: a proposal that CHANGES pay has to say why, and an approver can read
 * every outstanding proposal in one request. Everything else about the
 * lifecycle - the resolver, immutability, the conflicts, the override rules,
 * the self-approval block - is M2's and is proved in
 * `usecase/employee_salary.test.js`. What is proved HERE is the delta, plus
 * the handful of M2 guarantees that a change this shape could plausibly break
 * without anybody noticing:
 *
 *   a revision reason being satisfied by `override_reason` or by a rejection
 *   the queue quietly showing an approved or rejected row as pending
 *   the queue letting somebody agree to their own proposal
 *   a screen's difference figure disagreeing with the record
 *   a client-supplied contribution reaching a row through the new field
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./employee_salary");
const { SOURCE } = require("./employee_salary");

/** The same fixed clock the M2 suite uses, and for the same reason. */
const NOW = "2026-09-11";
const build = (repo) => buildUsecase(repo, { now: () => NOW });

const EMPLOYEE = {
  employee_id: 42,
  employee_name: "Test Person",
  status: 1,
  pf_applicable: 1,
  esi_applicable: 0,
  previous_pf_member: 1,
  previous_eps_member: 1,
  dob: "1990-05-10",
  date_of_joining: "2019-06-01",
};

const ACTOR = { employeeId: 7 };
const REASON = "Annual review increment";

/** The database's clock, as the fake stands in for `CURRENT_TIMESTAMP`. */
const AMENDED_AT = "2026-09-11T10:00:00Z";

/** A stored row, in the shape the repository hands back. */
const row = (over) => ({
  salary_id: over.salary_id,
  employee_id: 42,
  monthly_gross: 20000,
  status: "APPROVED",
  effective_from: "2026-04-01",
  source: SOURCE.OPENING_SALARY,
  manual_override: 0,
  revision_reason: null,
  unresolved_notes: "[]",
  statutory_snapshot: "{}",
  ...over,
});

/** The in-memory repository, matching the M2 suite's fake. */
function makeRepo(employee = EMPLOYEE, rows = []) {
  let nextId = rows.length + 1;
  return {
    rows,
    employee,
    queueCalls: [],
    pendingCalls: [],
    async getStatutoryContext(id) {
      return Number(id) === Number(this.employee.employee_id) ? { ...this.employee } : null;
    },
    async hasLiveSalary(id) {
      return this.rows.some((r) => Number(r.employee_id) === Number(id) && r.status !== "REJECTED");
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
    /*
     * M4 review fix — THE ONE-PENDING-PROPOSAL READ, filtered exactly as the
     * SQL filters it: PENDING in the read itself, so a test cannot pass on a
     * condition the real query does not have.
     */
    async getPendingForEmployee(id) {
      this.pendingCalls.push(Number(id));
      return (
        this.rows
          .filter((r) => Number(r.employee_id) === Number(id) && r.status === "PENDING")
          .sort((a, b) => a.salary_id - b.salary_id)[0] || null
      );
    },
    async hasPending(id) {
      return (await this.getPendingForEmployee(id)) !== null;
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
    async create(rowToSave) {
      const clash = await this.getActiveRevisionAt(rowToSave.employee_id, rowToSave.effective_from);
      if (clash) throw new Error("duplicate active revision");
      /*
       * `uq_salary_pending_proposal`, as the fake enforces it. The usecase
       * refuses a second pending proposal with a sentence somebody can act on;
       * THIS is the database backstop behind it, and it is here so that a test
       * proving the usecase check cannot accidentally be proving nothing.
       */
      if (
        rowToSave.status === "PENDING" &&
        this.rows.some(
          (r) => Number(r.employee_id) === Number(rowToSave.employee_id) && r.status === "PENDING"
        )
      ) {
        throw new Error("duplicate pending proposal");
      }
      const saved = { ...rowToSave, salary_id: nextId++ };
      this.rows.push(saved);
      return saved.salary_id;
    },
    /*
     * The real statement writes `changed_by` and `changed_at` itself, in the
     * same UPDATE that makes the change, and strips them from the patch so a
     * caller cannot dictate its own audit. The fake does both.
     */
    async updatePending(salaryId, patch, changedBy = null) {
      const found = this.rows.find((r) => Number(r.salary_id) === Number(salaryId));
      if (!found || found.status !== "PENDING") return 0;
      const values = { ...patch };
      delete values.changed_by;
      delete values.changed_at;
      Object.assign(found, values, { changed_by: changedBy, changed_at: AMENDED_AT });
      return 1;
    },
    async approve(salaryId, by) {
      const found = this.rows.find((r) => Number(r.salary_id) === Number(salaryId));
      if (!found || found.status !== "PENDING") return 0;
      found.status = "APPROVED";
      found.approved_by = by;
      return 1;
    },
    async reject(salaryId, by, reason) {
      const found = this.rows.find((r) => Number(r.salary_id) === Number(salaryId));
      if (!found || found.status !== "PENDING") return 0;
      found.status = "REJECTED";
      found.rejected_by = by;
      found.rejection_reason = reason;
      return 1;
    },
    /**
     * The queue, filtered exactly as the SQL filters it - PENDING in the read
     * itself rather than afterwards, so a test cannot pass on a filter the
     * real query does not have.
     */
    async getPendingQueue(filters) {
      this.queueCalls.push(filters);
      return this.rows
        .filter((r) => r.status === "PENDING")
        .filter((r) => filters.employee_id === null || Number(r.employee_id) === filters.employee_id)
        .filter((r) => filters.store_id === null || Number(r.store_id) === filters.store_id)
        .filter((r) => !filters.effective_from || r.effective_from >= filters.effective_from)
        .filter((r) => !filters.effective_to || r.effective_from <= filters.effective_to)
        .map((r) => {
          const current = this.rows
            .filter(
              (c) =>
                Number(c.employee_id) === Number(r.employee_id) &&
                c.status === "APPROVED" &&
                c.effective_from <= filters.as_of
            )
            .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
          return {
            ...r,
            employee_name: "Test Person",
            store_id: r.store_id ?? 3,
            outlet_nickname: "DN Main",
            designation_name: "Cashier",
            created_by_name: "Proposer",
            current_salary_id: current ? current.salary_id : null,
            current_monthly_gross: current ? current.monthly_gross : null,
            current_effective_from: current ? current.effective_from : null,
          };
        });
    },
  };
}

/** An employee already on an APPROVED opening salary. */
const withOpening = (gross = 20000) =>
  makeRepo(EMPLOYEE, [
    row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01", monthly_gross: gross }),
  ]);

/* ==================================================== A. the revision reason */

describe("a REVISION must say why; an OPENING SALARY need not", () => {
  it("REFUSES a revision with no reason", async () => {
    const uc = build(withOpening());
    await assert.rejects(
      () => uc.createInitialSalary(42, { monthly_gross: 25000, effective_from: "2026-10-01" }, ACTOR),
      /revision reason is required/
    );
  });

  it("refuses a reason that is only whitespace", async () => {
    // The field being present is not the rule; somebody having answered the
    // question is. A space bar is not an answer.
    const uc = build(withOpening());
    await assert.rejects(
      () =>
        uc.createInitialSalary(
          42,
          { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: "   \n\t " },
          ACTOR
        ),
      /revision reason is required/
    );
  });

  it("WRITES NOTHING when the reason is missing", async () => {
    // Refused before the row is built, so a proposal that cannot say why it
    // exists never reaches the table and never needs rejecting.
    const repo = withOpening();
    await build(repo)
      .createInitialSalary(42, { monthly_gross: 25000, effective_from: "2026-10-01" }, ACTOR)
      .catch(() => {});
    assert.equal(repo.rows.length, 1, "only the opening record is there");
  });

  it("accepts a revision that gives one, and TRIMS it", async () => {
    const repo = withOpening();
    const r = await build(repo).createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: `  ${REASON}  ` },
      ACTOR
    );
    assert.equal(r.source, SOURCE.REVISION);
    assert.equal(r.revision_reason, REASON);
    assert.equal(repo.rows[1].revision_reason, REASON, "and it is what was stored");
  });

  it("AN OPENING SALARY IS NOT A CHANGE, so it needs no reason", async () => {
    // There is no prior figure for a reason to be a reason about, and
    // demanding one would produce six hundred rows reading "opening salary".
    const repo = makeRepo();
    const r = await build(repo).createInitialSalary(42, { monthly_gross: 20000 }, ACTOR);
    assert.equal(r.source, SOURCE.OPENING_SALARY);
    assert.equal(r.revision_reason, null);
    assert.equal(repo.rows[0].revision_reason, null);
  });

  it("an opening salary MAY still carry one, and it is kept", async () => {
    const repo = makeRepo();
    const r = await build(repo).createInitialSalary(
      42,
      { monthly_gross: 20000, revision_reason: "Structure agreed at offer stage" },
      ACTOR
    );
    assert.equal(r.revision_reason, "Structure agreed at offer stage");
  });

  it("a proposal AFTER a rejected one is still an opening salary, so still needs no reason", async () => {
    // M2's rule: rejected rows do not count, so the next attempt is still the
    // employee's FIRST salary. M4 must not make that path unreachable by
    // demanding a reason for a record that changes nothing.
    const repo = makeRepo(EMPLOYEE, [row({ salary_id: 1, status: "REJECTED" })]);
    const r = await build(repo).createInitialSalary(42, { monthly_gross: 21000 }, ACTOR);
    assert.equal(r.source, SOURCE.OPENING_SALARY);
    assert.equal(r.revision_reason, null);
  });

  it("refuses a reason longer than the column can hold", async () => {
    const uc = build(withOpening());
    await assert.rejects(
      () =>
        uc.createInitialSalary(
          42,
          {
            monthly_gross: 25000,
            effective_from: "2026-10-01",
            revision_reason: "x".repeat(501),
          },
          ACTOR
        ),
      /at most 500 characters/
    );
  });
});

describe("THE THREE REASON FIELDS ARE THREE DIFFERENT QUESTIONS", () => {
  it("an override reason does NOT satisfy the revision reason", async () => {
    // "Basic held at last year's figure" explains a BREAKUP. It does not
    // explain why anybody's pay is changing, and a record that let one stand
    // in for the other could answer neither question later.
    const uc = build(withOpening());
    await assert.rejects(
      () =>
        uc.createInitialSalary(
          42,
          {
            monthly_gross: 26000,
            effective_from: "2026-10-01",
            manual_override: true,
            manual_components: { basic: 13000, conveyance: 1600, hra: 5200, special_allowance: 6200 },
            override_reason: "Basic held at last year's figure",
          },
          ACTOR
        ),
      /revision reason is required/
    );
  });

  it("the two are stored side by side, each saying its own thing", async () => {
    const repo = withOpening();
    await build(repo).createInitialSalary(
      42,
      {
        monthly_gross: 26000,
        effective_from: "2026-10-01",
        revision_reason: REASON,
        manual_override: true,
        manual_components: { basic: 13000, conveyance: 1600, hra: 5200, special_allowance: 6200 },
        override_reason: "Basic held at last year's figure",
      },
      ACTOR
    );
    const saved = repo.rows[1];
    assert.equal(saved.revision_reason, REASON);
    assert.equal(saved.override_reason, "Basic held at last year's figure");
    assert.notEqual(saved.revision_reason, saved.override_reason);
  });

  it("a REJECTION never overwrites the proposer's reason", async () => {
    // `rejection_reason` is the APPROVER's answer, written by somebody else at
    // a different moment. The proposal's own justification survives its
    // refusal - which is the whole point of keeping rejected rows.
    const repo = withOpening();
    const uc = build(repo);
    const created = await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    await uc.rejectSalary(created.salary_id, "Budget not approved for this quarter", {
      employeeId: 9,
    });
    const rejected = repo.rows.find((r) => r.salary_id === created.salary_id);
    assert.equal(rejected.status, "REJECTED");
    assert.equal(rejected.revision_reason, REASON, "the proposer's reason is untouched");
    assert.equal(rejected.rejection_reason, "Budget not approved for this quarter");
  });
});

describe("the reason travels with the record", () => {
  it("history returns it, so the audit trail can be read", async () => {
    const repo = makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01" }),
      row({
        salary_id: 2,
        status: "APPROVED",
        effective_from: "2026-10-01",
        source: SOURCE.REVISION,
        revision_reason: REASON,
      }),
    ]);
    const history = await build(repo).getHistory(42);
    assert.equal(history.length, 2);
    assert.equal(history.find((h) => h.salary_id === 2).revision_reason, REASON);
    assert.equal(history.find((h) => h.salary_id === 1).revision_reason, null, "and null is a real answer");
  });
});

describe("amending a PENDING revision", () => {
  const pendingRevision = () =>
    makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01" }),
      row({
        salary_id: 2,
        status: "PENDING",
        effective_from: "2026-10-01",
        source: SOURCE.REVISION,
        revision_reason: REASON,
        monthly_gross: 25000,
      }),
    ]);

  it("keeps the stored reason when the amendment does not mention it", async () => {
    // Correcting a figure should not mean retyping the sentence.
    const repo = pendingRevision();
    const r = await build(repo).updatePendingSalary(2, { monthly_gross: 26000 }, ACTOR);
    assert.equal(r.revision_reason, REASON);
    assert.equal(repo.rows[1].revision_reason, REASON);
  });

  it("replaces it when the amendment gives a new one", async () => {
    const repo = pendingRevision();
    await build(repo).updatePendingSalary(
      2,
      { monthly_gross: 26000, revision_reason: "Promotion to Senior Cashier" },
      ACTOR
    );
    assert.equal(repo.rows[1].revision_reason, "Promotion to Senior Cashier");
  });

  it("REFUSES an amendment that blanks it out", async () => {
    const repo = pendingRevision();
    await assert.rejects(
      () => build(repo).updatePendingSalary(2, { monthly_gross: 26000, revision_reason: "  " }, ACTOR),
      /revision reason is required/
    );
    assert.equal(repo.rows[1].monthly_gross, 25000, "and nothing was written");
  });

  it("makes a PRE-M4 pending revision supply one before it can be amended", async () => {
    // The one case where the stored value is legitimately null on a revision:
    // a row proposed before the column existed. It is not rewritten by the
    // migration - nobody may invent a reason somebody else did not give - so
    // the next person to touch it is asked for one.
    const repo = makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01" }),
      row({
        salary_id: 2,
        status: "PENDING",
        effective_from: "2026-10-01",
        source: SOURCE.REVISION,
        revision_reason: null,
      }),
    ]);
    await assert.rejects(
      () => build(repo).updatePendingSalary(2, { monthly_gross: 26000 }, ACTOR),
      /revision reason is required/
    );
  });

  it("AMENDING CANNOT TURN A REVISION INTO AN OPENING SALARY", async () => {
    // The source is read off the STORED row, so the requirement cannot be
    // escaped by claiming a different one on the way in. (`source` is not in
    // the Joi schema either; this is the layer that would matter if it were.)
    const repo = pendingRevision();
    await assert.rejects(
      () =>
        build(repo).updatePendingSalary(
          2,
          { monthly_gross: 26000, revision_reason: "", source: SOURCE.OPENING_SALARY },
          ACTOR
        ),
      /revision reason is required/
    );
  });

  it("approved and rejected records are still never amended", async () => {
    const repo = pendingRevision();
    repo.rows.push(
      row({ salary_id: 3, status: "REJECTED", effective_from: "2026-11-01", source: SOURCE.REVISION })
    );
    const uc = build(repo);
    await assert.rejects(
      () => uc.updatePendingSalary(1, { monthly_gross: 99999, revision_reason: REASON }, ACTOR),
      /Only a pending salary revision can be changed/
    );
    await assert.rejects(
      () => uc.updatePendingSalary(3, { monthly_gross: 99999, revision_reason: REASON }, ACTOR),
      /Only a pending salary revision can be changed/
    );
  });
});

/* ================================================== B. the approval queue */

describe("the pending approval queue", () => {
  /** Two employees, one approved history each and one pending proposal each. */
  const queueRepo = () =>
    makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01", monthly_gross: 20000 }),
      row({
        salary_id: 2,
        status: "PENDING",
        effective_from: "2026-10-01",
        monthly_gross: 25000,
        source: SOURCE.REVISION,
        revision_reason: REASON,
        created_by: 7,
      }),
      row({ salary_id: 3, status: "REJECTED", effective_from: "2026-11-01", source: SOURCE.REVISION }),
      row({
        salary_id: 4,
        employee_id: 55,
        store_id: 9,
        status: "PENDING",
        effective_from: "2026-12-01",
        monthly_gross: 18000,
        source: SOURCE.OPENING_SALARY,
        created_by: 8,
      }),
    ]);

  it("RETURNS PENDING RECORDS AND NOTHING ELSE", async () => {
    const queue = await build(queueRepo()).getPendingQueue({}, { employeeId: 99 });
    assert.deepEqual(
      queue.map((q) => q.salary_id).sort(),
      [2, 4],
      "the approved and the rejected rows are not in an approval queue"
    );
    for (const item of queue) assert.equal(item.status, "PENDING");
  });

  it("carries the employee metadata the decision needs, and no more", async () => {
    const queue = await build(queueRepo()).getPendingQueue({}, { employeeId: 99 });
    const item = queue.find((q) => q.salary_id === 2);
    assert.equal(item.employee_id, 42);
    assert.equal(item.employee_name, "Test Person");
    assert.equal(item.outlet_name, "DN Main");
    assert.equal(item.designation_name, "Cashier");
    assert.equal(item.created_by_name, "Proposer");
    assert.equal(item.revision_reason, REASON);
    assert.equal(item.source, SOURCE.REVISION);

    // Deciding a pay revision is not a reason to read somebody's identity
    // documents or their bank account.
    for (const forbidden of [
      "pan_no",
      "aadhaar_number",
      "aadhaar_fingerprint",
      "account_no",
      "ifsc",
      "bank_name",
      "uan",
      "salary",
    ]) {
      assert.ok(!(forbidden in item), `${forbidden} must not be in the queue payload`);
    }
  });

  it("THE CURRENT APPROVED SALARY COMES WITH THE PROPOSAL", async () => {
    // The question the queue exists to answer is "from what, to what".
    const queue = await build(queueRepo()).getPendingQueue({}, { employeeId: 99 });
    const item = queue.find((q) => q.salary_id === 2);
    assert.equal(Number(item.current_salary.monthly_gross), 20000);
    assert.equal(item.current_salary.effective_from, "2026-04-01");
    assert.equal(Number(item.monthly_gross), 25000, "and the proposed figure beside it");
  });

  it("names it `current_salary`, never `salary` — a key B3 would delete", async () => {
    // `middlewares/sensitive.js#filterResponse` strips keys called `salary` at
    // any depth. Naming it that would make the figure vanish for anybody
    // without the B3 key: no error, no 403, just a missing number.
    const queue = await build(queueRepo()).getPendingQueue({}, { employeeId: 99 });
    for (const item of queue) {
      assert.ok(!("salary" in item));
      assert.ok("current_salary" in item);
    }
  });

  it("reports the difference in rupees and per cent", async () => {
    const queue = await build(queueRepo()).getPendingQueue({}, { employeeId: 99 });
    const item = queue.find((q) => q.salary_id === 2);
    assert.deepEqual(item.difference, { amount: 5000, percentage: 25 });
  });

  it("A FIRST SALARY HAS NO DIFFERENCE, and does not pretend to", async () => {
    // There is nothing to compare an opening salary against; calling it a rise
    // of 100% would be arithmetic on a number that does not exist.
    const queue = await build(queueRepo()).getPendingQueue({}, { employeeId: 99 });
    const opening = queue.find((q) => q.salary_id === 4);
    assert.equal(opening.current_salary, null);
    assert.equal(opening.difference, null);
  });

  it("reports a CUT as a negative difference rather than hiding it", async () => {
    const repo = makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01", monthly_gross: 20000 }),
      row({
        salary_id: 2,
        status: "PENDING",
        effective_from: "2026-10-01",
        monthly_gross: 18000,
        source: SOURCE.REVISION,
        revision_reason: "Role change to part time",
      }),
    ]);
    const [item] = await build(repo).getPendingQueue({}, { employeeId: 99 });
    assert.deepEqual(item.difference, { amount: -2000, percentage: -10 });
  });

  it("filters by employee, by outlet and by an effective-date window", async () => {
    const uc = build(queueRepo());
    assert.deepEqual(
      (await uc.getPendingQueue({ employee_id: "42" }, {})).map((q) => q.salary_id),
      [2]
    );
    assert.deepEqual(
      (await uc.getPendingQueue({ store_id: "9" }, {})).map((q) => q.salary_id),
      [4]
    );
    assert.deepEqual(
      (await uc.getPendingQueue({ effective_from: "2026-11-01" }, {})).map((q) => q.salary_id),
      [4]
    );
    assert.deepEqual(
      (await uc.getPendingQueue({ effective_to: "2026-10-31" }, {})).map((q) => q.salary_id),
      [2]
    );
  });

  it("A FILTER CAN ONLY NARROW: no filter reaches the status", async () => {
    const repo = queueRepo();
    await build(repo).getPendingQueue(
      { employee_id: 42, status: "APPROVED", store_id: 3 },
      {}
    );
    const passed = repo.queueCalls[0];
    assert.ok(!("status" in passed), "status is fixed in the query, never taken from a caller");
  });

  it("refuses a backwards date window rather than silently returning nothing", async () => {
    await assert.rejects(
      () => build(queueRepo()).getPendingQueue({ effective_from: "2026-12-01", effective_to: "2026-01-01" }, {}),
      /effective_from must be on or before effective_to/
    );
  });

  it("resolves 'current' against TODAY by default, from the usecase's own clock", async () => {
    const repo = queueRepo();
    await build(repo).getPendingQueue({}, {});
    assert.equal(repo.queueCalls[0].as_of, NOW);
  });

  it("is capped, so one screen can never become an unbounded read", async () => {
    const repo = queueRepo();
    await build(repo).getPendingQueue({}, {});
    assert.equal(repo.queueCalls[0].limit, buildUsecase.QUEUE_MAX_ROWS);
    assert.ok(buildUsecase.QUEUE_MAX_ROWS > 0);
  });
});

describe("the queue tells an approver what they may not approve", () => {
  const own = () =>
    makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01" }),
      row({
        salary_id: 2,
        status: "PENDING",
        effective_from: "2026-10-01",
        source: SOURCE.REVISION,
        revision_reason: REASON,
        created_by: 7,
      }),
    ]);

  it("FLAGS a proposal the caller created themselves", async () => {
    const [item] = await build(own()).getPendingQueue({}, { employeeId: 7 });
    assert.equal(item.own_proposal, true);
  });

  it("does not flag somebody else's", async () => {
    const [item] = await build(own()).getPendingQueue({}, { employeeId: 9 });
    assert.equal(item.own_proposal, false);
  });

  it("FLAGS BUT NEVER FILTERS — rejecting your own proposal is still allowed", async () => {
    // Only self-APPROVAL is blocked. Withdrawing your own proposal by
    // rejecting it is a normal thing to do, so it has to stay visible.
    const repo = own();
    const uc = build(repo);
    const queue = await uc.getPendingQueue({}, { employeeId: 7 });
    assert.equal(queue.length, 1, "it is still in their queue");
    await uc.rejectSalary(2, "Raised in error", { employeeId: 7 });
    assert.equal(repo.rows[1].status, "REJECTED");
  });

  it("an administrator's own proposal is not flagged, matching the standing exception", async () => {
    const [item] = await build(own()).getPendingQueue({}, { employeeId: 7, isAdmin: true });
    assert.equal(item.own_proposal, false);
  });

  it("THE FLAG IS NOT THE RULE — the server still refuses the approval", async () => {
    // The whole point: the screen is told so it can say so, and the refusal is
    // the server's regardless of what any screen did with the flag.
    const uc = build(own());
    await assert.rejects(
      () => uc.approveSalary(2, { employeeId: 7 }),
      /cannot approve a salary revision you created yourself/
    );
  });

  it("and the administrator exception still works", async () => {
    const repo = own();
    await build(repo).approveSalary(2, { employeeId: 7, isAdmin: true });
    assert.equal(repo.rows[1].status, "APPROVED");
  });
});

/* ================================= C. what M4 must NOT have changed ====== */

describe("M2 guarantees M4 leaves exactly as they were", () => {
  it("a rejection still needs a reason", async () => {
    const repo = withOpening();
    repo.rows.push(
      row({ salary_id: 2, status: "PENDING", effective_from: "2026-10-01", source: SOURCE.REVISION })
    );
    await assert.rejects(
      () => build(repo).rejectSalary(2, "   ", { employeeId: 9 }),
      /A reason is required to reject/
    );
    assert.equal(repo.rows[1].status, "PENDING", "and nothing was decided");
  });

  it("a REJECTED future revision still does not block a new one", async () => {
    const repo = makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01" }),
      row({ salary_id: 2, status: "REJECTED", effective_from: "2026-12-01", source: SOURCE.REVISION }),
    ]);
    const r = await build(repo).createInitialSalary(
      42,
      { monthly_gross: 30000, effective_from: "2027-01-01", revision_reason: REASON },
      ACTOR
    );
    assert.equal(r.status, "PENDING");
  });

  it("the same-effective-date conflict still refuses", async () => {
    const repo = withOpening();
    await assert.rejects(
      () =>
        build(repo).createInitialSalary(
          42,
          { monthly_gross: 30000, effective_from: "2026-04-01", revision_reason: REASON },
          ACTOR
        ),
      /already exists/
    );
  });

  it("a second outstanding future revision still refuses", async () => {
    // The first future change is APPROVED here, so what is under test is M2's
    // future-dating rule rather than M4's one-pending rule - both refuse, and
    // both still hold. The undecided case has its own tests below.
    const repo = withOpening();
    const uc = build(repo);
    const first = await uc.createInitialSalary(
      42,
      { monthly_gross: 30000, effective_from: "2026-12-01", revision_reason: REASON },
      ACTOR
    );
    await uc.approveSalary(first.salary_id, { employeeId: 9 });
    await assert.rejects(
      () =>
        uc.createInitialSalary(
          42,
          { monthly_gross: 35000, effective_from: "2027-01-01", revision_reason: REASON },
          ACTOR
        ),
      /already has a future-dated salary revision/
    );
  });

  it("an approved FUTURE revision is still not current before its date", async () => {
    const repo = makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01", monthly_gross: 20000 }),
      row({
        salary_id: 2,
        status: "APPROVED",
        effective_from: "2026-12-01",
        monthly_gross: 30000,
        source: SOURCE.REVISION,
      }),
    ]);
    const uc = build(repo);
    assert.equal(Number((await uc.getCurrentSalary(42)).current_salary.monthly_gross), 20000);
    assert.equal(
      Number((await uc.getCurrentSalary(42, "2026-12-01")).current_salary.monthly_gross),
      30000
    );
  });

  it("A CLIENT-SUPPLIED CONTRIBUTION OR CTC STILL NEVER REACHES THE ROW", async () => {
    // The new field is a string reason, and adding it must not have turned the
    // create path into one that copies the request body.
    const repo = withOpening();
    await build(repo).createInitialSalary(
      42,
      {
        monthly_gross: 25000,
        effective_from: "2026-10-01",
        revision_reason: REASON,
        employee_pf: 1,
        employer_epf: 2,
        monthly_ctc: 3,
        basic: 4,
        daily_salary: 5,
      },
      ACTOR
    );
    const saved = repo.rows[1];
    assert.notEqual(Number(saved.employee_pf), 1);
    assert.notEqual(Number(saved.employer_epf), 2);
    assert.notEqual(Number(saved.monthly_ctc), 3);
    assert.notEqual(Number(saved.basic), 4);
    assert.notEqual(Number(saved.daily_salary), 5);
  });

  it("nothing is ever created APPROVED, administrators included", async () => {
    const repo = withOpening();
    const r = await build(repo).createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      { employeeId: 7, isAdmin: true }
    );
    assert.equal(r.status, "PENDING");
  });

  it("THE LEGACY new_employee.salary IS STILL NEVER WRITTEN", async () => {
    const repo = withOpening();
    await build(repo).createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    for (const saved of repo.rows) {
      assert.ok(!("salary" in saved), "no bare salary key is written anywhere");
    }
  });

  it("there is still no delete path of any kind", () => {
    const uc = build(makeRepo());
    for (const name of ["deleteSalary", "removeSalary", "destroy", "purge", "deletePending"]) {
      assert.equal(typeof uc[name], "undefined", `${name} must not exist`);
    }
  });
});

/* ============================================ the difference, as a function */

describe("differenceBetween", () => {
  const { differenceBetween } = buildUsecase;

  it("is null when there is nothing to compare against", () => {
    assert.equal(differenceBetween(null, 25000), null);
    assert.equal(differenceBetween(20000, null), null);
  });

  it("gives an amount but NO percentage when the previous figure is zero", () => {
    // The division has no meaning, and "infinite increase" is not something to
    // put in front of an approver.
    assert.deepEqual(differenceBetween(0, 25000), { amount: 25000, percentage: null });
  });

  it("rounds to paise and to two decimal places of per cent", () => {
    assert.deepEqual(differenceBetween(30000, 33333.33), { amount: 3333.33, percentage: 11.11 });
  });

  it("reports no change as zero rather than as nothing", () => {
    assert.deepEqual(differenceBetween(20000, 20000), { amount: 0, percentage: 0 });
  });
});

/* ================== M4 REVIEW FIX A. ONE PENDING PROPOSAL PER EMPLOYEE === */

/*
 * The business rule, finalized: a salary proposal is ONE DECISION AT A TIME.
 * An employee may have at most one PENDING proposal, whatever its effective
 * date. The proposal in hand is amended, approved or rejected before another
 * is raised.
 *
 * TWO LAYERS, AND BOTH ARE TESTED. The usecase refuses with a sentence
 * somebody can act on, before anything is calculated or written; the database
 * carries `uq_salary_pending_proposal` as the backstop for two concurrent
 * requests that both read "no pending proposal" a millisecond apart. The fake
 * repository enforces the unique key too, so a test proving the first layer
 * cannot quietly be proving nothing.
 */
describe("AT MOST ONE PENDING SALARY PROPOSAL", () => {
  const APPROVER = { employeeId: 9 };

  it("the FIRST pending proposal succeeds", async () => {
    const repo = withOpening();
    const created = await build(repo).createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    assert.equal(created.status, "PENDING");
    assert.equal(repo.rows.length, 2);
  });

  it("A SECOND ONE AT A DIFFERENT EFFECTIVE DATE IS REFUSED", async () => {
    // The gap the same-date rule and the future-dating rule between them left
    // open: a pending proposal for October and a second for December are two
    // undecided answers to what somebody will be paid, with nothing on the
    // record saying which supersedes which.
    const repo = withOpening();
    const uc = build(repo);
    await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    await assert.rejects(
      () =>
        uc.createInitialSalary(
          42,
          { monthly_gross: 27000, effective_from: "2026-12-01", revision_reason: REASON },
          ACTOR
        ),
      /A salary proposal is already pending for this employee; amend, approve or reject it before creating another\./
    );
    assert.equal(repo.rows.length, 2, "nothing was written");
  });

  it("names the outstanding proposal, so the caller can go and decide it", async () => {
    const repo = withOpening();
    const uc = build(repo);
    const first = await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    const err = await uc
      .createInitialSalary(
        42,
        { monthly_gross: 27000, effective_from: "2026-12-01", revision_reason: REASON },
        ACTOR
      )
      .then(() => null, (e) => e);
    assert.ok(err, "it refused");
    assert.equal(err.name, "ValidationError");
    assert.deepEqual(err.conflict, {
      kind: "PENDING_PROPOSAL_EXISTS",
      salary_id: first.salary_id,
      effective_from: "2026-10-01",
      status: "PENDING",
    });
  });

  it("a second one at the SAME effective date is refused too", async () => {
    const repo = withOpening();
    const uc = build(repo);
    await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    await assert.rejects(
      () =>
        uc.createInitialSalary(
          42,
          { monthly_gross: 26000, effective_from: "2026-10-01", revision_reason: REASON },
          ACTOR
        ),
      /already pending for this employee/
    );
    assert.equal(repo.rows.length, 2);
  });

  it("REFUSES BEFORE IT CALCULATES OR WRITES", async () => {
    // The answer is the same whatever gross, date or reason was sent, so
    // pricing a proposal that cannot be created would only make the refusal
    // slower and put a preview-shaped object in front of somebody who is not
    // getting one. The check is also the FIRST repository read after the
    // employee lookup.
    const repo = withOpening();
    const uc = build(repo);
    await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    const before = repo.rows.map((r) => ({ ...r }));
    await uc
      .createInitialSalary(42, { monthly_gross: 90000, effective_from: "2027-01-01" }, ACTOR)
      .catch(() => {});
    assert.deepEqual(repo.rows, before, "not a row written, not a row changed");
  });

  it("A REJECTED PROPOSAL NEVER BLOCKS A NEW ONE", async () => {
    const repo = withOpening();
    const uc = build(repo);
    const first = await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    await uc.rejectSalary(first.salary_id, "Budget not approved", APPROVER);

    const second = await uc.createInitialSalary(
      42,
      { monthly_gross: 24000, effective_from: "2026-11-01", revision_reason: REASON },
      ACTOR
    );
    assert.equal(second.status, "PENDING");
    assert.equal(repo.rows.length, 3, "the refused proposal stays on the record");
    assert.equal(repo.rows[1].status, "REJECTED", "and stays refused");
  });

  it("AN APPROVED PROPOSAL NO LONGER BLOCKS EITHER — the M2 rules take over", async () => {
    // Approving it decides it, so the one-pending rule has nothing to say. What
    // governs the next proposal after that is M2: the same-date rule and the
    // future-dating rule, exactly as before.
    const repo = withOpening();
    const uc = build(repo);
    const first = await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-09-01", revision_reason: REASON },
      ACTOR
    );
    await uc.approveSalary(first.salary_id, APPROVER);

    const second = await uc.createInitialSalary(
      42,
      { monthly_gross: 26000, effective_from: "2026-12-01", revision_reason: REASON },
      ACTOR
    );
    assert.equal(second.status, "PENDING");
    assert.equal(second.effective_from, "2026-12-01");
  });

  it("and the M2 future-dating rule still bites after an approval", async () => {
    const repo = withOpening();
    const uc = build(repo);
    const first = await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-12-01", revision_reason: REASON },
      ACTOR
    );
    await uc.approveSalary(first.salary_id, APPROVER);
    await assert.rejects(
      () =>
        uc.createInitialSalary(
          42,
          { monthly_gross: 26000, effective_from: "2027-02-01", revision_reason: REASON },
          ACTOR
        ),
      /already has a future-dated salary revision/
    );
  });

  it("THE DATABASE IS THE GUARANTEE, NOT THIS CHECK", async () => {
    // Two concurrent requests can both read "no pending proposal" and both go
    // on to insert one; only a unique key stops that. Simulated by reaching
    // past the usecase check straight into the repository, which is what a
    // race amounts to - `uq_salary_pending_proposal` refuses the insert.
    const repo = withOpening();
    const uc = build(repo);
    await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    await assert.rejects(
      () =>
        repo.create({
          employee_id: 42,
          status: "PENDING",
          effective_from: "2026-12-01",
          monthly_gross: 27000,
        }),
      /duplicate pending proposal/
    );
    assert.equal(repo.rows.length, 2);
  });

  it("the pending check is an indexed read, not a filtered history", async () => {
    // A yes/no question answered by `getPendingForEmployee`. Reading the whole
    // history and filtering in JavaScript would pull every revision an employee
    // has ever had across the wire on every single create.
    const repo = withOpening();
    await build(repo).createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    assert.deepEqual(repo.pendingCalls, [42], "asked once, about one employee");
  });

  it("AMENDING THE OUTSTANDING PROPOSAL IS THE WAY THROUGH", async () => {
    // The rule is not "you may not change your mind", it is "there is one
    // proposal". Amending it stays open the whole time it is pending.
    const repo = withOpening();
    const uc = build(repo);
    const first = await uc.createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    const amended = await uc.updatePendingSalary(
      first.salary_id,
      { monthly_gross: 27000, revision_reason: "Promotion to Senior Cashier" },
      ACTOR
    );
    assert.equal(amended.status, "PENDING");
    assert.equal(repo.rows.length, 2, "one proposal, changed - not two");
    assert.equal(Number(repo.rows[1].monthly_gross), 27000);
  });
});

/* ============== M4 REVIEW FIX B. WHO CHANGED A PENDING PROPOSAL, AND WHEN = */

/*
 * The finalized audit requirement is Created / Changed / Approved / Rejected,
 * each with an actor and a time. `updated_at` cannot answer the second of
 * those: it is `ON UPDATE CURRENT_TIMESTAMP`, so it moves when a proposal is
 * approved or rejected just as readily as when somebody amends it, and it
 * names nobody. So the amendment has its own two columns, written by the one
 * path that makes an amendment and by nothing else.
 */
describe("CHANGED BY / CHANGED AT — the amendment audit", () => {
  const pendingRevision = () =>
    makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", effective_from: "2026-04-01" }),
      row({
        salary_id: 2,
        status: "PENDING",
        effective_from: "2026-10-01",
        source: SOURCE.REVISION,
        revision_reason: REASON,
        monthly_gross: 25000,
        created_by: 7,
        changed_by: null,
        changed_at: null,
      }),
    ]);

  it("A CREATED PROPOSAL HAS NEITHER, because nothing has been amended", async () => {
    const repo = withOpening();
    await build(repo).createInitialSalary(
      42,
      { monthly_gross: 25000, effective_from: "2026-10-01", revision_reason: REASON },
      ACTOR
    );
    const saved = repo.rows[1];
    assert.equal(saved.changed_by, undefined, "the insert does not name the column at all");
    assert.equal(saved.changed_at, undefined);
  });

  it("AN AMENDMENT SETS BOTH", async () => {
    const repo = pendingRevision();
    await build(repo).updatePendingSalary(2, { monthly_gross: 26000 }, { employeeId: 41 });
    assert.equal(repo.rows[1].changed_by, 41, "the actor's EMPLOYEE id, as created_by holds");
    assert.equal(repo.rows[1].changed_at, AMENDED_AT, "and the database's clock");
  });

  it("and reports the amender back to the caller", async () => {
    const repo = pendingRevision();
    const r = await build(repo).updatePendingSalary(2, { monthly_gross: 26000 }, { employeeId: 41 });
    assert.equal(r.changed_by, 41);
  });

  it("A SYSTEM ACTOR WITH NO EMPLOYEE ID LEAVES A NULL, not an invented number", async () => {
    const repo = pendingRevision();
    await build(repo).updatePendingSalary(2, { monthly_gross: 26000 }, {});
    assert.equal(repo.rows[1].changed_by, null);
  });

  it("THE CALLER CANNOT NAME SOMEBODY ELSE AS THE AMENDER", async () => {
    // Nothing from the request body reaches these columns: the row is built
    // from the engine's output, and the two audit values are written by the
    // statement itself.
    const repo = pendingRevision();
    await build(repo).updatePendingSalary(
      2,
      { monthly_gross: 26000, changed_by: 999, changed_at: "1999-01-01" },
      { employeeId: 41 }
    );
    assert.equal(repo.rows[1].changed_by, 41);
    assert.equal(repo.rows[1].changed_at, AMENDED_AT);
  });

  it("A LATER APPROVAL DOES NOT OVERWRITE THEM", async () => {
    // Approving a proposal is not amending it. The record of who last amended
    // it has to survive the decision, or the audit trail loses the step.
    const repo = pendingRevision();
    const uc = build(repo);
    await uc.updatePendingSalary(2, { monthly_gross: 26000 }, { employeeId: 41 });
    await uc.approveSalary(2, { employeeId: 9 });
    assert.equal(repo.rows[1].status, "APPROVED");
    assert.equal(repo.rows[1].changed_by, 41, "still the amender, not the approver");
    assert.equal(repo.rows[1].changed_at, AMENDED_AT);
    assert.equal(repo.rows[1].approved_by, 9);
  });

  it("A LATER REJECTION DOES NOT OVERWRITE THEM EITHER", async () => {
    const repo = pendingRevision();
    const uc = build(repo);
    await uc.updatePendingSalary(2, { monthly_gross: 26000 }, { employeeId: 41 });
    await uc.rejectSalary(2, "Budget not approved", { employeeId: 9 });
    assert.equal(repo.rows[1].status, "REJECTED");
    assert.equal(repo.rows[1].changed_by, 41);
    assert.equal(repo.rows[1].changed_at, AMENDED_AT);
    assert.equal(repo.rows[1].rejected_by, 9);
  });

  it("A PROPOSAL APPROVED WITHOUT EVER BEING AMENDED KEEPS ITS NULLS", async () => {
    // Which is the whole reason `updated_at` could not answer this question:
    // it would have moved on the approval and reported an amendment that never
    // happened.
    const repo = pendingRevision();
    await build(repo).approveSalary(2, { employeeId: 9 });
    assert.equal(repo.rows[1].changed_by, null);
    assert.equal(repo.rows[1].changed_at, null);
  });

  it("HISTORY RETURNS THE AMENDER'S NAME, AND KEEPS THE ID BESIDE IT", async () => {
    // Resolved server-side by a LEFT JOIN, exactly like the other three actor
    // names - no history read from the browser, one employee at a time. The id
    // stays, because a name is for reading and the id is what the record
    // asserts.
    const repo = makeRepo(EMPLOYEE, [
      row({
        salary_id: 2,
        status: "PENDING",
        effective_from: "2026-10-01",
        source: SOURCE.REVISION,
        revision_reason: REASON,
        created_by: 7,
        created_by_name: "Proposer",
        changed_by: 41,
        changed_by_name: "Amender",
        changed_at: AMENDED_AT,
      }),
    ]);
    const [record] = await build(repo).getHistory(42);
    assert.equal(record.changed_by, 41);
    assert.equal(record.changed_by_name, "Amender");
    assert.equal(record.changed_at, AMENDED_AT);
    assert.equal(record.created_by, 7);
    assert.equal(record.created_by_name, "Proposer");
  });

  it("and NULL is a real answer for a proposal nobody amended", async () => {
    const repo = makeRepo(EMPLOYEE, [
      row({ salary_id: 1, status: "APPROVED", changed_by: null, changed_at: null }),
    ]);
    const [record] = await build(repo).getHistory(42);
    assert.equal(record.changed_by, null);
    assert.equal(record.changed_at, null);
  });
});
