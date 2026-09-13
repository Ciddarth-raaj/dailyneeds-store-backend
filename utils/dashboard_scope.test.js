/**
 * Global Dashboard access - the shared authorization vocabulary.
 *
 *   node --test utils/dashboard_scope.test.js
 *
 * These pin the rules that every dashboard will inherit, so a future HR or
 * Sales screen cannot quietly get a different answer to the same question:
 * which scope a caller has, what a request may and may not do to it, and what
 * the browser is allowed to be told about it.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DASHBOARD_SCOPE,
  DASHBOARD_PERMISSION,
  DASHBOARD_SCOPE_KEY,
  SCOPE_MESSAGE,
  SCOPE_REASON,
  decideScope,
  effectiveStoreIds,
  isActiveEmployeeRow,
  isWideningAttempt,
  parseRequestedStores,
  scopeForClient,
} = require("./dashboard_scope");

describe("the vocabulary", () => {
  it("has one feature key per dashboard, and they are distinct", () => {
    assert.deepEqual(Object.keys(DASHBOARD_PERMISSION).sort(), ["ATTENDANCE", "HR", "MY", "SALES"]);
    assert.equal(new Set(Object.values(DASHBOARD_PERMISSION)).size, 4);
    assert.equal(DASHBOARD_PERMISSION.ATTENDANCE, "view_attendance_dashboard");
  });

  it("keeps the SCOPE keys separate from every feature key", () => {
    // A feature key permits a SCREEN; it never widens a LOCATION. Conflating
    // the two is what the first Attendance implementation did.
    const features = new Set(Object.values(DASHBOARD_PERMISSION));
    Object.values(DASHBOARD_SCOPE_KEY).forEach((key) => assert.ok(!features.has(key), key));
  });

  it("DOES NOT REUSE the application-wide all_stores permission", () => {
    // It has its own established meaning elsewhere in the application, and
    // borrowing it would tie two unrelated capabilities together in both
    // directions.
    const everything = [
      ...Object.values(DASHBOARD_PERMISSION),
      ...Object.values(DASHBOARD_SCOPE_KEY),
    ];
    assert.ok(!everything.includes("all_stores"));
  });

  it("has exactly three scope answers", () => {
    assert.deepEqual(Object.keys(DASHBOARD_SCOPE).sort(), ["ALL_STORES", "NONE", "OWN_STORE"]);
  });
});

describe("deciding which scope a caller has", () => {
  it("AN ADMINISTRATOR IS ALL STORES, before anything else is considered", () => {
    // This must be first: the permission middleware gives user_type 2 every row
    // of `all_permissions`, so an administrator necessarily holds BOTH scope
    // keys and the conflict rule below would lock them out of every dashboard.
    const admin = decideScope({ is_admin: true, has_all_stores: true, has_own_store: true });
    assert.equal(admin.kind, DASHBOARD_SCOPE.ALL_STORES);
    assert.equal(admin.reason, SCOPE_REASON.ADMINISTRATOR);
    // And an administrator holding neither key is still All Stores: the user
    // type is the grant, not a duplicate scope assignment.
    assert.equal(decideScope({ is_admin: true }).kind, DASHBOARD_SCOPE.ALL_STORES);
  });

  it("BOTH KEYS ON A NON-ADMINISTRATOR FAILS CLOSED", () => {
    // The keys are meant to be exclusive; the rights table cannot enforce it.
    // Guessing which was meant would turn a mis-click into company-wide access,
    // so it refuses and names the fault instead.
    const both = decideScope({ has_all_stores: true, has_own_store: true });
    assert.equal(both.kind, DASHBOARD_SCOPE.NONE);
    assert.equal(both.reason, SCOPE_REASON.CONFLICTING_SCOPE);
    assert.match(SCOPE_MESSAGE.CONFLICTING_SCOPE, /exactly one must be granted/i);
  });

  it("resolves each key on its own", () => {
    assert.equal(decideScope({ has_all_stores: true }).kind, DASHBOARD_SCOPE.ALL_STORES);
    assert.equal(decideScope({ has_own_store: true }).kind, DASHBOARD_SCOPE.OWN_STORE);
  });

  it("NEITHER KEY IS NONE - a feature key grants no location", () => {
    const none = decideScope({});
    assert.equal(none.kind, DASHBOARD_SCOPE.NONE);
    assert.equal(none.reason, SCOPE_REASON.NO_SCOPE_GRANTED);
    assert.equal(decideScope().kind, DASHBOARD_SCOPE.NONE, "no input at all is also NONE");
  });

  it("never silently upgrades anything to All Stores", () => {
    // Every input combination that is not an explicit All Stores grant, and not
    // an administrator, must not come back company-wide.
    [
      { has_own_store: true },
      {},
      { has_all_stores: true, has_own_store: true },
    ].forEach((input) => {
      assert.notEqual(decideScope(input).kind, DASHBOARD_SCOPE.ALL_STORES, JSON.stringify(input));
    });
  });
});

describe("reading a requested store filter", () => {
  it("accepts the comma list the routes validate, and an array", () => {
    assert.deepEqual(parseRequestedStores("1,2,3"), [1, 2, 3]);
    assert.deepEqual(parseRequestedStores([2, 3]), [2, 3]);
    assert.deepEqual(parseRequestedStores(" 4 , 5 "), [4, 5]);
  });

  it("treats absence as absence, not as zero or everything", () => {
    [null, undefined, ""].forEach((v) => assert.equal(parseRequestedStores(v), null));
  });

  it("drops anything that is not a positive whole id, and de-duplicates", () => {
    assert.deepEqual(parseRequestedStores("1,1,2"), [1, 2]);
    assert.equal(parseRequestedStores("0,-1,abc"), null, "nothing usable is the same as no filter");
  });
});

describe("narrowing a request against a scope", () => {
  const ALL = { kind: DASHBOARD_SCOPE.ALL_STORES, store_ids: null };
  const OWN = { kind: DASHBOARD_SCOPE.OWN_STORE, store_ids: [7] };
  const NONE = { kind: DASHBOARD_SCOPE.NONE, store_ids: [] };

  it("All Stores: a filter is an ordinary filter", () => {
    assert.equal(effectiveStoreIds(ALL, null), null);
    assert.deepEqual(effectiveStoreIds(ALL, [2]), [2]);
  });

  it("OWN STORE IS THE ASSIGNED BRANCH, WHATEVER WAS REQUESTED", () => {
    // The answer does not depend on the request at all, which is the point:
    // there is no arithmetic here to get wrong.
    [null, [], [7], [9], [7, 9], [1, 2, 3]].forEach((asked) => {
      assert.deepEqual(effectiveStoreIds(OWN, asked), [7], JSON.stringify(asked));
    });
  });

  it("NONE IS AN EMPTY SET, WHICH IS NOT NULL", () => {
    // null means "no restriction" to every layer below. Collapsing an empty
    // authorized set into it is the classic fail-open.
    const out = effectiveStoreIds(NONE, [1, 2]);
    assert.deepEqual(out, []);
    assert.notEqual(out, null);
    assert.deepEqual(effectiveStoreIds(null, [1]), [], "an absent scope is not an open one");
  });

  it("returns a copy, so a caller cannot mutate the scope through it", () => {
    const out = effectiveStoreIds(OWN, null);
    out.push(9);
    assert.deepEqual(OWN.store_ids, [7]);
  });
});

describe("detecting an attempt to reach outside the scope", () => {
  const OWN = { kind: DASHBOARD_SCOPE.OWN_STORE, store_ids: [7] };

  it("naming another branch is an attempt - even alongside its own", () => {
    assert.equal(isWideningAttempt(OWN, [9]), true);
    assert.equal(isWideningAttempt(OWN, [7, 9]), true);
  });

  it("naming only its own branch, or naming none, is not", () => {
    assert.equal(isWideningAttempt(OWN, [7]), false);
    assert.equal(isWideningAttempt(OWN, null), false);
    assert.equal(isWideningAttempt(OWN, []), false);
  });

  it("only Own Store can attempt it", () => {
    // All Stores has nothing outside it, and NONE is refused before any filter
    // is read, so neither can produce this refusal.
    assert.equal(isWideningAttempt({ kind: DASHBOARD_SCOPE.ALL_STORES, store_ids: null }, [9]), false);
    assert.equal(isWideningAttempt({ kind: DASHBOARD_SCOPE.NONE, store_ids: [] }, [9]), false);
    assert.equal(isWideningAttempt(null, [9]), false);
  });
});

describe("what the browser is told", () => {
  it("carries the kind, the pinned outlet and whether to offer a picker", () => {
    const own = scopeForClient({ kind: DASHBOARD_SCOPE.OWN_STORE, store_ids: [7] });
    assert.deepEqual(own, {
      kind: "OWN_STORE",
      store_ids: [7],
      can_choose_outlet: false,
    });
    const all = scopeForClient({ kind: DASHBOARD_SCOPE.ALL_STORES, store_ids: null });
    assert.deepEqual(all, { kind: "ALL_STORES", store_ids: [], can_choose_outlet: true });
  });

  it("NEVER CARRIES A PERMISSION KEY OR A REASON CODE", () => {
    // A screen does not need those, and a payload that has them is one more
    // place they can leak.
    const payload = JSON.stringify(
      scopeForClient({
        kind: DASHBOARD_SCOPE.OWN_STORE,
        store_ids: [7],
        reason: SCOPE_REASON.OWN_STORE_SCOPE,
        employee_id: 42,
      })
    );
    assert.doesNotMatch(payload, /dashboard_scope_|all_stores|view_/);
    assert.doesNotMatch(payload, /reason|employee_id/);
  });

  it("an absent scope is reported as offering nothing", () => {
    assert.deepEqual(scopeForClient(null), {
      kind: "NONE",
      store_ids: [],
      can_choose_outlet: false,
    });
  });
});

/* ==================================================================== */
/* AN INACTIVE EMPLOYEE HAS NO OWN STORE.                                */
/*                                                                      */
/* The row that says which branch somebody works at is the same row that */
/* says whether they still work here. Reading one half and ignoring the  */
/* other is the defect these pin.                                       */
/* ==================================================================== */

describe("the active-employee rule", () => {
  it("IS status = 1, and nothing else is active", () => {
    assert.equal(isActiveEmployeeRow({ employee_status: 1 }), true);
    assert.equal(isActiveEmployeeRow({ employee_status: "1" }), true, "the driver may hand back a string");
    [0, 2, -1, 99, "0", "resigned"].forEach((status) =>
      assert.equal(isActiveEmployeeRow({ employee_status: status }), false, String(status))
    );
  });

  it("AN ABSENT OR UNREADABLE STATUS IS NOT ACTIVE", () => {
    // A row that cannot be shown to be active must not be treated as one: the
    // safe direction for an authorization boundary is to refuse.
    [null, undefined, NaN, ""].forEach((status) =>
      assert.equal(isActiveEmployeeRow({ employee_status: status }), false, String(status))
    );
    assert.equal(isActiveEmployeeRow({}), false, "no status field at all");
    assert.equal(isActiveEmployeeRow(null), false, "no row at all");
  });

  it("AGREES WITH middlewares/auth.js#employeeActive ON EVERY VALUE", () => {
    // The drift guard. The rule is the application's, not this file's - auth
    // reads `Number(state.employee_status) === 1` and the login query refuses
    // anybody without `ne.status = 1`. If either side is ever changed alone,
    // this fails.
    const { employeeActive } = require("../middlewares/auth");
    [1, "1", 0, "0", 2, -1, null, undefined, "", "x"].forEach((status) => {
      assert.equal(
        isActiveEmployeeRow({ employee_status: status }),
        employeeActive({ employee_id: 1, is_system_account: 0, employee_status: status }),
        `disagreed on ${JSON.stringify(status)}`
      );
    });
  });

  it("does NOT consult resignation_date", () => {
    // A dated fact - "were they employed on this date" - is a different question
    // from "may this person use the application right now", and nothing in the
    // authentication layer reads it. Reading it here would invent a live-access
    // rule this system does not have.
    assert.equal(
      isActiveEmployeeRow({ employee_status: 1, resignation_date: "2020-01-01" }),
      true,
      "a past resignation date on an ACTIVE row does not make it inactive here"
    );
    assert.equal(
      isActiveEmployeeRow({ employee_status: 0, resignation_date: null }),
      false,
      "and no resignation date does not make an INACTIVE row active"
    );
  });

  it("has its own refusal reason and a message with no database detail in it", () => {
    assert.equal(SCOPE_REASON.EMPLOYEE_INACTIVE, "EMPLOYEE_INACTIVE");
    const msg = SCOPE_MESSAGE.EMPLOYEE_INACTIVE;
    assert.match(msg, /employee record is not active/i);
    assert.doesNotMatch(msg, /new_employee|status|column|table|sql|=\s*1/i);
  });

  it("leaves every other refusal reason untouched", () => {
    ["NO_EMPLOYEE_RECORD", "NO_STORE_ASSIGNED", "CONFLICTING_SCOPE", "NO_SCOPE_GRANTED"].forEach(
      (reason) => assert.equal(SCOPE_REASON[reason], reason)
    );
  });
});
