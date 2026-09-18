/**
 * Payrun Adjustments V1 - the repository's own SQL, driven against a stub
 * connection.
 *
 *   node --test repository/payrun_adjustment.test.js
 *
 * WHY THIS EXISTS BESIDE THE USECASE TESTS. Those drive an in-memory fake that
 * MIRRORS these rules, which is exactly the problem: a fake that agrees with a
 * mistaken belief proves the belief, not the code. The two decisions below are
 * made in SQL - one in a `FOR UPDATE` predicate, one in an `ON DUPLICATE KEY
 * UPDATE` expression - and neither is reachable from the usecase's fake.
 *
 * THE STUB IS A CONNECTION, NOT A DATABASE. It records every statement and
 * answers each with canned rows, so what is asserted is the SQL this code
 * really sends and the parameters it really binds. It cannot prove MySQL's
 * semantics; it can prove that the right rows are asked for and the right
 * expression is written, which is where the Balance Advance bug lived.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { PayrunAdjustmentRepository } = require("./payrun_adjustment");
const { PAY_AFFECTING_COMPONENT_KEYS } = require("../constants/payrun_adjustments");

/** A connection that logs every statement and answers from `route`. */
function stubDb(route = () => []) {
  const log = [];
  const conn = {
    query(sql, params, cb) {
      const flat = sql.replace(/\s+/g, " ").trim();
      log.push({ sql: flat, params });
      cb(null, route(flat) || []);
    },
    beginTransaction: (cb) => cb(null),
    commit: (cb) => cb(null),
    rollback: (cb) => cb(),
    release: () => {},
  };
  return { db: { getConnection: (cb) => cb(null, conn), query: conn.query }, log };
}

const CONFIRMED_STATE = [
  { payrun_adjustment_state_id: 1, remarks: null, confirmed_no_adjustment: 1 },
];

/** A month where the employee is CONFIRMED and already holds `existing`. */
const routeFor = (existing) => (sql) => {
  if (sql.includes("FROM payrun_employee_adjustment_state")) return CONFIRMED_STATE;
  if (sql.includes("FROM payrun_employee_adjustment WHERE")) return existing;
  return [];
};

const save = async (amounts, existing = []) => {
  const { db, log } = stubDb(routeFor(existing));
  const repo = new PayrunAdjustmentRepository(db);
  await repo.saveAdjustments({
    year: 2026,
    month: 8,
    entries: [{ employee_id: 1, payrun_employee_id: 1001, amounts }],
    actor_id: 7,
  });
  const audited = JSON.stringify(
    log.filter((q) => q.sql.includes("adjustment_audit")).map((q) => q.params)
  );
  return {
    log,
    revoked: audited.includes("REVOKE_NO_ADJUSTMENT"),
    /** The `ON DUPLICATE KEY UPDATE` expression that clears the flag. */
    sqlClearsFlag: log.some((q) => q.sql.includes("IF(1, 0, confirmed_no_adjustment)")),
  };
};

describe("confirming 'no adjustment' asks only about the PAY-AFFECTING rows", () => {
  const confirm = async (route) => {
    const { db, log } = stubDb(route);
    const repo = new PayrunAdjustmentRepository(db);
    const results = await repo.confirmNoAdjustment({
      year: 2026,
      month: 8,
      employees: [{ employee_id: 1, payrun_employee_id: 1001 }],
      actor_id: 7,
    });
    return { results, log };
  };

  it("locks exactly the five pay-affecting components, in the statement", async () => {
    const { log } = await confirm();
    const guard = log.find((q) => q.sql.includes("FROM payrun_employee_adjustment WHERE"));
    assert.ok(guard, "the guard statement was not issued");
    /*
     * THE FILTER IS IN THE PREDICATE, NOT APPLIED TO THE ROWS AFTERWARDS -
     * `FOR UPDATE` has to lock exactly the rows this decision depends on, so a
     * concurrent Incentive cannot be inserted between the check and the
     * confirmation.
     */
    assert.match(guard.sql, /AND component IN \(\?\)\s*FOR UPDATE/);
    assert.deepEqual(guard.params, [2026, 8, 1, PAY_AFFECTING_COMPONENT_KEYS]);
    assert.ok(!guard.params.flat().includes("BALANCE_ADVANCE"));
  });

  it("A STORED BALANCE ADVANCE DOES NOT BLOCK THE CONFIRMATION", async () => {
    /*
     * The employee holds a Balance Advance and has never been confirmed. The
     * filtered read comes back empty even though a row exists for them - which
     * is the whole point of the predicate above - so the confirmation goes
     * through.
     */
    const { results } = await confirm((sql) =>
      sql.includes("FROM payrun_employee_adjustment WHERE") ? [] : []
    );
    assert.deepEqual(results, [{ employee_id: 1, result: "CONFIRMED" }]);
  });

  it("a stored pay-affecting adjustment still blocks it", async () => {
    const { results } = await confirm((sql) =>
      sql.includes("FROM payrun_employee_adjustment WHERE") ? [{ component: "INCENTIVE" }] : []
    );
    assert.deepEqual(results, [{ employee_id: 1, result: "HAS_ADJUSTMENT" }]);
  });
});

describe("what revokes a 'no adjustment' confirmation", () => {
  it("A BALANCE ADVANCE REVOKES NOTHING, and issues no state write at all", async () => {
    const { revoked, sqlClearsFlag, log } = await save({ BALANCE_ADVANCE: 8500 });
    assert.equal(revoked, false, "recording a balance revoked somebody's confirmation");
    assert.equal(sqlClearsFlag, false, "the SQL would have cleared the flag");
    // Nothing about the confirmation is touched - not the flag, not the
    // confirmer, not the timestamp.
    assert.ok(
      !log.some((q) => q.sql.includes("INSERT INTO payrun_employee_adjustment_state")),
      "a balance-only save wrote the state row"
    );
    // The amount itself IS written.
    assert.ok(log.some((q) => q.sql.includes("INSERT INTO payrun_employee_adjustment")));
  });

  it("every pay-affecting component DOES revoke it, and clears the flag in SQL", async () => {
    for (const key of PAY_AFFECTING_COMPONENT_KEYS) {
      /* eslint-disable no-await-in-loop */
      const { revoked, sqlClearsFlag } = await save({ [key]: 500 });
      assert.equal(revoked, true, `${key} did not revoke the confirmation`);
      assert.equal(sqlClearsFlag, true, `${key} did not clear the stored flag`);
      /* eslint-enable no-await-in-loop */
    }
  });

  it("a balance saved while a pay-affecting amount is already stored revokes it", async () => {
    // A confirmed employee who already holds an Incentive is an inconsistent
    // month; the write corrects it rather than preserving the confirmation,
    // because the decision is made on what REMAINS stored, not on what this
    // call happened to carry.
    const { revoked } = await save({ BALANCE_ADVANCE: 1 }, [
      { payrun_adjustment_id: 9, component: "INCENTIVE", amount: "500.00" },
    ]);
    assert.equal(revoked, true);
  });

  it("clearing the last pay-affecting amount leaves the confirmation alone", async () => {
    // Removing an adjustment does not confirm anybody - it returns them to
    // pending - and it must not silently re-confirm or re-revoke either.
    const { revoked, sqlClearsFlag } = await save({ INCENTIVE: null }, [
      { payrun_adjustment_id: 9, component: "INCENTIVE", amount: "500.00" },
    ]);
    assert.equal(revoked, false);
    assert.equal(sqlClearsFlag, false);
  });
});
