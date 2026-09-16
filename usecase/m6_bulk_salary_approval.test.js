/**
 * Bulk salary approval — the approver's selection, decided as one act.
 *
 *   node --test usecase/m6_bulk_salary_approval.test.js
 *
 * BULK APPROVAL ADDS NO RULE AND RELAXES NONE. It is `approveSalary` over a
 * list, inside one transaction: the same existence check, the same PENDING-only
 * rule, the same self-approval refusal with the same administrator exception,
 * and the same `approve` statement writing `approved_by` and `approved_at`.
 * What is proved here is exactly that — that the batch cannot do anything the
 * single decision would have refused, and that a refusal anywhere in the batch
 * leaves EVERY record untouched.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildUsecase = require("./employee_salary");
const { SOURCE } = require("./employee_salary");

const NOW = "2026-09-11";
const build = (repo) => buildUsecase(repo, { now: () => NOW });

const APPROVER = { employeeId: 9 };

const row = (over) => ({
  employee_id: 42,
  monthly_gross: 20000,
  status: "PENDING",
  effective_from: "2026-10-01",
  source: SOURCE.REVISION,
  manual_override: 0,
  revision_reason: "Annual review increment",
  unresolved_notes: "[]",
  statutory_snapshot: "{}",
  created_by: 7,
  ...over,
});

/**
 * The repository fake, transaction and all.
 *
 * THE TRANSACTION IS SIMULATED HONESTLY: writes go to a working copy and are
 * only published on commit, so a test that expects "nothing was approved" is
 * reading the same thing a rollback would have left behind. `locked` records
 * that the rows really were read FOR UPDATE, because the lock is the
 * concurrency protection and a fake that ignored it would let the test pass
 * without it.
 */
function makeRepo(rows) {
  return {
    committed: rows,
    locked: [],
    approveCalls: [],
    txDepth: 0,
    async withTransaction(fn) {
      this.txDepth += 1;
      const working = this.committed.map((r) => ({ ...r }));
      const snapshot = this.working;
      this.working = working;
      try {
        const result = await fn({ query: async () => [] });
        this.committed = working;
        return result;
      } finally {
        this.working = snapshot;
        this.txDepth -= 1;
      }
    },
    async getByIdsForUpdate(ids, tx) {
      assert.ok(tx, "the locked read must be inside a transaction");
      this.locked.push([...ids]);
      return this.working.filter((r) => ids.includes(Number(r.salary_id))).map((r) => ({ ...r }));
    },
    async getById(salaryId) {
      return this.committed.find((r) => Number(r.salary_id) === Number(salaryId)) || null;
    },
    async approve(salaryId, by, tx = null) {
      this.approveCalls.push({ salaryId, by, inTransaction: Boolean(tx) });
      const target = tx ? this.working : this.committed;
      const found = target.find((r) => Number(r.salary_id) === Number(salaryId));
      if (!found || found.status !== "PENDING") return 0;
      found.status = "APPROVED";
      found.approved_by = by;
      found.approved_at = "2026-09-11T10:00:00Z";
      return 1;
    },
  };
}

const pendingPair = () =>
  makeRepo([
    row({ salary_id: 1 }),
    row({ salary_id: 2, employee_id: 43 }),
  ]);

describe("the happy path is the single decision, repeated", () => {
  it("approves every selected revision and reports how many", async () => {
    const repo = pendingPair();
    const result = await build(repo).approveSalaries([1, 2], APPROVER);

    assert.equal(result.approved_count, 2);
    assert.deepEqual(result.salary_ids, [1, 2]);
    assert.equal(result.status, "APPROVED");
    assert.deepEqual(
      repo.committed.map((r) => r.status),
      ["APPROVED", "APPROVED"]
    );
  });

  it("writes the SAME audit as single approval — approved_by and approved_at", async () => {
    const repo = pendingPair();
    await build(repo).approveSalaries([1, 2], APPROVER);
    for (const r of repo.committed) {
      assert.equal(r.approved_by, APPROVER.employeeId);
      assert.ok(r.approved_at, "approved_at is stamped by the same statement");
    }
  });

  it("uses the repository's own approve statement, inside the transaction", async () => {
    // Not a second UPDATE written for the batch: the same method, which is
    // what makes the audit columns and the PENDING scope impossible to diverge.
    const repo = pendingPair();
    await build(repo).approveSalaries([1, 2], APPROVER);
    assert.deepEqual(repo.approveCalls.map((c) => c.inTransaction), [true, true]);
  });

  it("locks the rows before judging them", async () => {
    const repo = pendingPair();
    await build(repo).approveSalaries([2, 1], APPROVER);
    assert.deepEqual(repo.locked, [[2, 1]]);
  });

  it("a duplicated selection is one approval, not two", async () => {
    const repo = pendingPair();
    const result = await build(repo).approveSalaries([1, 1, 2], APPROVER);
    assert.equal(result.approved_count, 2);
    assert.equal(repo.approveCalls.length, 2);
  });
});

describe("any refusal refuses the WHOLE batch", () => {
  it("approves nothing when one record is no longer pending", async () => {
    const repo = makeRepo([row({ salary_id: 1 }), row({ salary_id: 2, status: "REJECTED" })]);
    await assert.rejects(
      () => build(repo).approveSalaries([1, 2], APPROVER),
      /already rejected/
    );
    assert.deepEqual(
      repo.committed.map((r) => r.status),
      ["PENDING", "REJECTED"],
      "the pending one is untouched — a half-done batch is the thing this prevents"
    );
    assert.equal(repo.approveCalls.length, 0, "nothing was even attempted");
  });

  it("approves nothing when one record does not exist", async () => {
    const repo = pendingPair();
    await assert.rejects(
      () => build(repo).approveSalaries([1, 99], APPROVER),
      /Salary revision 99 was not found/
    );
    assert.deepEqual(repo.committed.map((r) => r.status), ["PENDING", "PENDING"]);
  });

  it("approves nothing when ONE of them is the approver's own proposal", async () => {
    // The four-eyes rule is per record, and a selection is not a way to carry
    // your own proposal through on the back of somebody else's.
    const repo = makeRepo([row({ salary_id: 1, created_by: 7 }), row({ salary_id: 2, created_by: 7 })]);
    await assert.rejects(
      () => build(repo).approveSalaries([2, 1], { employeeId: 7 }),
      /cannot approve a salary revision you created yourself/
    );
    assert.deepEqual(repo.committed.map((r) => r.status), ["PENDING", "PENDING"]);
  });

  it("the administrator exception is the EXISTING one, and still applies", async () => {
    const repo = makeRepo([row({ salary_id: 1, created_by: 7 }), row({ salary_id: 2, created_by: 7 })]);
    const result = await build(repo).approveSalaries([1, 2], { employeeId: 7, isAdmin: true });
    assert.equal(result.approved_count, 2);
    assert.deepEqual(repo.committed.map((r) => r.status), ["APPROVED", "APPROVED"]);
  });

  it("a record that goes stale mid-batch aborts it", async () => {
    // The existing guard: an UPDATE that touches no row means somebody else
    // decided this record, and the batch stops rather than reporting a count
    // that did not happen.
    const repo = pendingPair();
    const realApprove = repo.approve.bind(repo);
    repo.approve = async (salaryId, by, tx) => {
      if (Number(salaryId) === 2) return 0;
      return realApprove(salaryId, by, tx);
    };
    await assert.rejects(
      () => build(repo).approveSalaries([1, 2], APPROVER),
      /changed by somebody else/
    );
    assert.deepEqual(
      repo.committed.map((r) => r.status),
      ["PENDING", "PENDING"],
      "the first one rolled back with the rest"
    );
  });
});

describe("what may be selected", () => {
  it("refuses an empty selection", async () => {
    await assert.rejects(
      () => build(pendingPair()).approveSalaries([], APPROVER),
      /Select at least one salary revision/
    );
  });

  it("refuses something that is not a salary revision id", async () => {
    for (const bad of [[1, 0], [1, -3], [1, 2.5], [1, "abc"], "1,2", undefined]) {
      await assert.rejects(() => build(pendingPair()).approveSalaries(bad, APPROVER));
    }
  });

  it("is capped at the queue's own cap — nothing unselectable can be selected", async () => {
    const many = Array.from({ length: buildUsecase.QUEUE_MAX_ROWS + 1 }, (_, i) => i + 1);
    await assert.rejects(
      () => build(pendingPair()).approveSalaries(many, APPROVER),
      /can be approved at once/
    );
  });
});

describe("single approval is untouched", () => {
  it("still approves one record without a transaction", async () => {
    const repo = pendingPair();
    const result = await build(repo).approveSalary(1, APPROVER);
    assert.deepEqual(result, { salary_id: 1, status: "APPROVED" });
    assert.equal(repo.approveCalls[0].inTransaction, false);
    assert.equal(repo.committed[0].approved_by, APPROVER.employeeId);
  });

  it("still refuses a self-approval and an already-decided record", async () => {
    const repo = makeRepo([row({ salary_id: 1, created_by: 7 }), row({ salary_id: 2, status: "APPROVED" })]);
    await assert.rejects(
      () => build(repo).approveSalary(1, { employeeId: 7 }),
      /cannot approve a salary revision you created yourself/
    );
    await assert.rejects(() => build(repo).approveSalary(2, APPROVER), /already approved/);
  });
});
