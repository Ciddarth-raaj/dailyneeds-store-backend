/**
 * THE BRANCH RULE ITSELF, with no database and no Express.
 *
 *   node --test utils/employee_branch_scope.test.js
 *
 * Everything here is a pure function, so every case below is the rule and not
 * a route's interpretation of it. The end-to-end proof that the routes apply
 * it - the numbered scenarios from the approved task - is in
 * `middlewares/employee_branch_scope.test.js`.
 *
 * THE FAIL-CLOSED CASES ARE WHAT THIS FILE EXISTS FOR. Any of them answering
 * "allowed" is a company-wide disclosure, and each is asserted explicitly
 * rather than left to fall out of the logic.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EMPLOYEE_BRANCH_SCOPE: KIND,
  BRANCH_SCOPE_REASON,
  decideScope,
  isActiveEmployeeRow,
  branchIds,
  parseRequestedBranches,
  isEmployeeInScope,
  effectiveBranchIds,
  isWideningAttempt,
  scopeForClient,
} = require("./employee_branch_scope");

const own = (...ids) => ({ kind: KIND.OWN_BRANCHES, store_ids: ids });
const all = { kind: KIND.ALL_BRANCHES, store_ids: null };
const none = { kind: KIND.NONE, store_ids: [] };

/* ================================================== who is company-wide == */

test("an administrator is all branches, by user type and not by key", () => {
  const decided = decideScope({ is_admin: true, has_all_branches: false });
  assert.equal(decided.kind, KIND.ALL_BRANCHES);
  assert.equal(decided.reason, BRANCH_SCOPE_REASON.ADMINISTRATOR);
});

test("the all-branches key is company-wide — this is how HR is expressed", () => {
  const decided = decideScope({ is_admin: false, has_all_branches: true });
  assert.equal(decided.kind, KIND.ALL_BRANCHES);
  assert.equal(decided.reason, BRANCH_SCOPE_REASON.ALL_BRANCHES_PERMISSION);
});

test("everybody else is scoped to their own branches, holding no key at all", () => {
  assert.equal(decideScope({}).kind, KIND.OWN_BRANCHES);
  assert.equal(decideScope({ is_admin: false, has_all_branches: false }).kind, KIND.OWN_BRANCHES);
});

/* ========================================= may this caller reach this row */

test("same branch is allowed; a different branch is not", () => {
  assert.equal(isEmployeeInScope(own(1), 1), true);
  assert.equal(isEmployeeInScope(own(1), 2), false);
});

test("A MULTI-BRANCH USER REACHES THEIR BRANCHES AND NO OTHERS", () => {
  const scope = own(1, 3);
  assert.equal(isEmployeeInScope(scope, 1), true);
  assert.equal(isEmployeeInScope(scope, 3), true);
  assert.equal(isEmployeeInScope(scope, 2), false);
  assert.equal(isEmployeeInScope(scope, 4), false);
});

test("all branches reaches every employee, including one with no branch", () => {
  assert.equal(isEmployeeInScope(all, 1), true);
  assert.equal(isEmployeeInScope(all, 999), true);
  assert.equal(isEmployeeInScope(all, null), true);
});

test("FAIL CLOSED: no scope, NONE, an empty branch set, or an unknown branch", () => {
  // Each of these would be a company-wide disclosure if it answered true.
  assert.equal(isEmployeeInScope(null, 1), false, "no scope at all");
  assert.equal(isEmployeeInScope(undefined, 1), false);
  assert.equal(isEmployeeInScope(none, 1), false, "NONE reaches nothing");
  assert.equal(isEmployeeInScope(own(), 1), false, "assigned nowhere is nowhere, not everywhere");
  assert.equal(isEmployeeInScope({ kind: "SOMETHING_ELSE", store_ids: [1] }, 1), false);
});

test("FAIL CLOSED: an employee whose branch cannot be determined", () => {
  for (const value of [null, undefined, "", 0, -1, "abc", NaN, {}, []]) {
    assert.equal(
      isEmployeeInScope(own(1), value),
      false,
      `${JSON.stringify(value)} is not a branch this caller is authorized for`
    );
  }
});

test("a branch id compares by value, so '1' and 1 are the same branch", () => {
  assert.equal(isEmployeeInScope(own(1), "1"), true);
  assert.equal(isEmployeeInScope({ kind: KIND.OWN_BRANCHES, store_ids: ["1"] }, 1), true);
});

/* ============================================== what a LIST may look at = */

test("all branches: no filter means no restriction, a filter is honoured", () => {
  assert.equal(effectiveBranchIds(all, null), null, "null is no restriction");
  assert.deepEqual(effectiveBranchIds(all, [2, 3]), [2, 3]);
});

test("own branches: no filter means exactly the authorized branches", () => {
  assert.deepEqual(effectiveBranchIds(own(1, 3), null), [1, 3]);
});

test("own branches: a filter can only narrow, and narrows by intersection", () => {
  assert.deepEqual(effectiveBranchIds(own(1, 3), [3]), [3]);
  assert.deepEqual(effectiveBranchIds(own(1, 3), [2]), [], "another branch intersects to nothing");
  assert.deepEqual(effectiveBranchIds(own(1, 3), [1, 2, 3]), [1, 3]);
});

test("NONE is an EMPTY LIST, never null — the two must not be collapsed", () => {
  const empty = effectiveBranchIds(none, null);
  assert.deepEqual(empty, []);
  assert.notEqual(empty, null, "[] means no branch; null means no restriction");
  assert.deepEqual(effectiveBranchIds(null, [1]), []);
});

test("naming a branch outside the scope is a widening attempt, not a narrowing", () => {
  assert.equal(isWideningAttempt(own(1), [2]), true);
  assert.equal(isWideningAttempt(own(1), [1, 2]), true, "one foreign branch is enough");
  assert.equal(isWideningAttempt(own(1), [1]), false);
  assert.equal(isWideningAttempt(own(1), null), false, "no filter is not an attempt");
  assert.equal(isWideningAttempt(all, [2]), false, "nothing is outside all branches");
});

/* ================================================================ inputs = */

test("requested branches parse from a list or a comma string, junk dropped", () => {
  assert.deepEqual(parseRequestedBranches(["2", "3"]), [2, 3]);
  assert.deepEqual(parseRequestedBranches("2,3"), [2, 3]);
  assert.deepEqual(parseRequestedBranches("2, 2 ,3"), [2, 3], "de-duplicated");
  assert.equal(parseRequestedBranches(""), null);
  assert.equal(parseRequestedBranches(undefined), null);
  assert.equal(parseRequestedBranches(["abc", "-1", "0"]), null, "nothing usable is no filter");
});

test("branchIds keeps positive integers only", () => {
  assert.deepEqual(branchIds([1, "2", 0, -3, null, "x", 2]), [1, 2]);
});

/* ============================================== the active-employee rule = */

test("ACTIVE MEANS status = 1, exactly as the rest of the application says", () => {
  const authEmployeeActive = require("../middlewares/auth").employeeActive;
  const dashboardActive = require("./dashboard_scope").isActiveEmployeeRow;

  for (const status of [1, "1", 0, 2, null, undefined, "", "x", -1]) {
    const mine = isActiveEmployeeRow({ status });
    assert.equal(
      mine,
      authEmployeeActive({ is_system_account: 0, employee_id: 5, employee_status: status }),
      `status ${JSON.stringify(status)} must mean the same here as in auth`
    );
    assert.equal(
      mine,
      dashboardActive({ employee_status: status }),
      `status ${JSON.stringify(status)} must mean the same here as on the dashboards`
    );
  }
  assert.equal(isActiveEmployeeRow(null), false, "no row is not an active employee");
});

/* ==================================================== what the client sees */

test("the client is told the kind and its own branches, and nothing else", () => {
  assert.deepEqual(scopeForClient(own(1, 3)), {
    kind: KIND.OWN_BRANCHES,
    store_ids: [1, 3],
    can_choose_branch: false,
  });
  assert.deepEqual(scopeForClient(all), {
    kind: KIND.ALL_BRANCHES,
    store_ids: [],
    can_choose_branch: true,
  });
  assert.deepEqual(scopeForClient(null), {
    kind: KIND.NONE,
    store_ids: [],
    can_choose_branch: false,
  });
});
