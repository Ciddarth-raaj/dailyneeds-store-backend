/**
 * The rules around a bulk work shift assignment.
 *
 *   node --test usecase/employee_work_shift.test.js
 *
 * The repository test covers what reaches the database. This covers what is
 * refused before it gets there, and the one transformation this layer makes:
 * deduplication.
 */
const test = require("node:test");
const assert = require("node:assert");

const buildUsecase = require("./employee_work_shift");

/** A repository that records the call instead of making it. */
function spyRepo(result = { code: 200 }) {
  const calls = [];
  return {
    calls,
    bulkAssignWorkShift: (employeeIds, workShiftId) => {
      calls.push({ employeeIds, workShiftId });
      return Promise.resolve(result);
    },
  };
}

const rejects = (usecase, payload) =>
  assert.rejects(() => usecase.bulkAssign(payload), (err) => {
    assert.strictEqual(err.name, "ValidationError");
    return true;
  });

/* --------------------------------------------------------- what is refused */

test("an empty selection is refused, and never reaches the database", async () => {
  const repo = spyRepo();
  const usecase = buildUsecase(repo);

  await rejects(usecase, { employee_ids: [], work_shift_id: 9 });
  assert.strictEqual(repo.calls.length, 0, "an empty IN (?) would be a SQL error anyway");
});

test("a missing or non-array employee_ids is refused", async () => {
  const usecase = buildUsecase(spyRepo());

  await rejects(usecase, { work_shift_id: 9 });
  await rejects(usecase, { employee_ids: "1,2,3", work_shift_id: 9 });
  await rejects(usecase, { employee_ids: null, work_shift_id: 9 });
});

test("employee ids must be positive integers", async () => {
  const usecase = buildUsecase(spyRepo());

  await rejects(usecase, { employee_ids: [1, 0], work_shift_id: 9 });
  await rejects(usecase, { employee_ids: [1, -5], work_shift_id: 9 });
  await rejects(usecase, { employee_ids: [1, "abc"], work_shift_id: 9 });
  await rejects(usecase, { employee_ids: [1, 2.5], work_shift_id: 9 });
});

test("a missing work_shift_id is refused - there is no unassign in this phase", async () => {
  const repo = spyRepo();
  const usecase = buildUsecase(repo);

  await rejects(usecase, { employee_ids: [1] });
  await rejects(usecase, { employee_ids: [1], work_shift_id: null });
  await rejects(usecase, { employee_ids: [1], work_shift_id: 0 });

  // Notably: an absent shift must NOT be read as "clear the assignment".
  assert.strictEqual(repo.calls.length, 0);
});

test("a non-object body is refused rather than throwing on property access", async () => {
  const usecase = buildUsecase(spyRepo());

  await rejects(usecase, null);
  await rejects(usecase, undefined);
  await rejects(usecase, "employee_ids=1");
});

test("every problem with a request is reported at once, not one per round trip", async () => {
  const usecase = buildUsecase(spyRepo());

  await assert.rejects(
    () => usecase.bulkAssign({ employee_ids: [], work_shift_id: null }),
    (err) => {
      assert.strictEqual(err.details.length, 2, err.message);
      return true;
    }
  );
});

/* ------------------------------------------------------ what gets through */

test("a valid request reaches the repository unchanged", async () => {
  const repo = spyRepo();
  const usecase = buildUsecase(repo);

  const result = await usecase.bulkAssign({ employee_ids: [4, 7, 12], work_shift_id: 9 });

  assert.strictEqual(result.code, 200);
  assert.deepStrictEqual(repo.calls[0].employeeIds, [4, 7, 12]);
  assert.strictEqual(repo.calls[0].workShiftId, 9);
});

test("duplicate employee ids are collapsed before the write", async () => {
  const repo = spyRepo();
  const usecase = buildUsecase(repo);

  await usecase.bulkAssign({ employee_ids: [4, 4, 7, 4, 7], work_shift_id: 9 });

  // Otherwise `assigned_count` would disagree with the number the
  // confirmation dialog quoted.
  assert.deepStrictEqual(repo.calls[0].employeeIds, [4, 7]);
});

test("numeric strings from a JSON body are normalised to numbers", async () => {
  const repo = spyRepo();
  const usecase = buildUsecase(repo);

  await usecase.bulkAssign({ employee_ids: ["4", 4, "7"], work_shift_id: "9" });

  // "4" and 4 are the same employee, and must not be sent as two.
  assert.deepStrictEqual(repo.calls[0].employeeIds, [4, 7]);
  assert.strictEqual(repo.calls[0].workShiftId, 9);
});

test("a repository rejection is passed through, not swallowed", async () => {
  const repo = spyRepo({ code: 400, rejected_employee_ids: [2] });
  const usecase = buildUsecase(repo);

  const result = await usecase.bulkAssign({ employee_ids: [1, 2], work_shift_id: 9 });

  assert.strictEqual(result.code, 400);
  assert.deepStrictEqual(result.rejected_employee_ids, [2]);
});

/* ------------------------------------------------------------- no mapping */

test("nothing in this layer infers an assignment", async () => {
  // There is no code path that fills in a work shift the caller did not name:
  // a request without one is refused above rather than defaulted here. This
  // pins that the usecase exposes no such helper.
  const usecase = buildUsecase(spyRepo());

  const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(usecase));
  for (const name of surface) {
    assert.ok(
      !/backfill|infer|match|migrate|sync|derive/i.test(name),
      `unexpected mapping helper: ${name}`
    );
  }
});
