/**
 * The employee -> work shift mapping, at the SQL boundary.
 *
 *   node --test repository/employee_work_shift.test.js
 *
 * These tests render the SQL the way the `mysql` driver actually puts it on
 * the wire, the same technique `employee_directory_filter.test.js` uses,
 * because the interesting failures here are not exceptions - they are queries
 * that run fine and touch the wrong column or return the wrong people.
 *
 * The load-bearing test in this file is THE LEGACY SHIFT IS UNTOUCHED. The
 * whole point of this phase is a second, independent mapping that leaves
 * `shift_master`, `new_employee.shift_id` and `new_employee.shift_code`
 * exactly as they were, and the way that promise breaks is a stray column in
 * an UPDATE, which no amount of reading the diff catches as reliably as
 * asserting on the rendered statement.
 */
const test = require("node:test");
const assert = require("node:assert");
const mysql = require("mysql");

const buildRepo = require("./employee_work_shift");

/* ------------------------------------------------------------- read side */

/** Capture the SELECT `getEmployeesForAssignment` would send, without a DB. */
function captureRead(filters, actor = null) {
  let captured = null;
  const repo = buildRepo({
    query: (sql, params) => {
      captured = { sql, params };
    },
  });
  repo.getEmployeesForAssignment(filters, actor).catch(() => {});
  assert.ok(captured, "the repository must have issued a query");
  return captured;
}

/** What the driver actually renders, whitespace-normalised. */
const renderedRead = (filters, actor = null) => {
  const { sql, params } = captureRead(filters, actor);
  return mysql.format(sql, params).replace(/\s+/g, " ").trim();
};

/* ============================================ THE LEGACY SHIFT IS UNTOUCHED */

test("READ: the legacy shift columns and shift_master are never referenced", () => {
  const sql = renderedRead({});

  assert.ok(!/shift_master/.test(sql), "shift_master must not be joined or read");
  assert.ok(
    !/new_employee\.shift_id/.test(sql),
    "the legacy shift_id must not be selected or filtered on"
  );
  assert.ok(
    !/shift_code/.test(sql) || /work_shift\.shift_code/.test(sql),
    "the only shift_code in play is work_shift's, never new_employee's"
  );
  assert.ok(
    !/new_employee\.shift_code/.test(sql),
    "the Digisme-synced shift_code must not be read here"
  );
});

test("READ: no SELECT *, and no sensitive employee column is exposed", () => {
  const sql = renderedRead({});

  assert.ok(!/SELECT \*/.test(sql), "an explicit column list, never a wildcard");

  // `new_employee` carries all of these, and none belongs on a shift screen.
  for (const column of [
    "salary",
    "account_no",
    "ifsc",
    "bank_name",
    "pan_no",
    "uan",
    "esi_number",
    "pf_number",
    "permanent_address",
    "residential_address",
    "primary_contact_number",
    "alternate_contact_number",
    "dob",
  ]) {
    assert.ok(!new RegExp(column).test(sql), `${column} must not be selected`);
  }
});

/* ========================================================== the population */

test("READ: active employees only, by the employee master's own constant", () => {
  const sql = renderedRead({});
  assert.ok(/new_employee\.status = 1/.test(sql), sql.slice(0, 300));
});

test("READ: the directory's resigned-NAME exclusion is not inherited", () => {
  // `employee_scope.js` records that rule as legacy debt keyed on a VARCHAR
  // name and says new consumers must not take it on. Inheriting it here would
  // hide people for the wrong reason.
  const sql = renderedRead({});
  assert.ok(!/resignation/.test(sql), "the resignation table must not be joined");
  assert.ok(!/employee_name NOT IN/.test(sql), "no name-based exclusion");
});

test("READ: an unassigned employee still appears - the join is LEFT", () => {
  const sql = renderedRead({});
  assert.ok(
    /LEFT JOIN work_shift ON work_shift\.work_shift_id = new_employee\.default_work_shift_id/.test(
      sql
    ),
    "an INNER JOIN here would empty the Unassigned filter"
  );
});

/* ============================================================= the filters */

test("READ: no filters means no filter predicates beyond the population", () => {
  const sql = renderedRead({});
  // Matched against a bound value specifically: the JOIN clauses contain
  // `department.department_id = new_employee.department_id` and friends, so a
  // bare `department_id = ` would match the join and never fail.
  assert.ok(!/new_employee\.store_id = \d/.test(sql), sql);
  assert.ok(!/new_employee\.department_id = \d/.test(sql), sql);
  assert.ok(!/new_employee\.designation_id = \d/.test(sql), sql);
  assert.ok(!/LIKE/.test(sql));
  assert.ok(!/default_work_shift_id IS/.test(sql));
});

test("READ: outlet, department and designation each narrow on their own column", () => {
  const sql = renderedRead({ store_id: 3, department_id: 7, designation_id: 11 });

  assert.ok(/new_employee\.store_id = 3/.test(sql), sql);
  assert.ok(/new_employee\.department_id = 7/.test(sql), sql);
  assert.ok(/new_employee\.designation_id = 11/.test(sql), sql);
});

test("READ: the three id filters cannot be transposed", () => {
  // Distinct values, so a swapped parameter shows up as the wrong number
  // against the wrong column rather than as an error.
  const sql = renderedRead({ store_id: 1, department_id: 2, designation_id: 3 });

  assert.ok(!/store_id = 2/.test(sql) && !/store_id = 3/.test(sql), sql);
  assert.ok(!/department_id = 1/.test(sql) && !/department_id = 3/.test(sql), sql);
  assert.ok(!/designation_id = 1/.test(sql) && !/designation_id = 2/.test(sql), sql);
});

test("READ: search matches name or id, and is bound rather than interpolated", () => {
  const sql = renderedRead({ search: "Ada" });

  assert.ok(/new_employee\.employee_name LIKE '%Ada%'/.test(sql), sql);
  assert.ok(/CAST\(new_employee\.employee_id AS CHAR\) LIKE '%Ada%'/.test(sql), sql);
});

test("READ: a search term carrying a quote is escaped, not injected", () => {
  // `/employee/filter` interpolates its term straight into the SQL string.
  // That defect is pre-existing and is deliberately NOT copied here; this
  // pins that it stays not-copied.
  const sql = renderedRead({ search: "'; DROP TABLE new_employee; --" });

  // The payload survives as TEXT inside the LIKE literal - that is harmless,
  // and searching for a stray apostrophe should still work. What matters is
  // that the quote was escaped to \' rather than being allowed to close the
  // string literal and start a new statement.
  assert.ok(/LIKE '%\\'; DROP TABLE new_employee; --%'/.test(sql), sql);

  // And the statement is still exactly one statement: no unescaped quote
  // reopened the SQL outside a literal.
  const outsideLiterals = sql.replace(/'(?:\\.|[^'\\])*'/g, "''");
  assert.ok(!/DROP TABLE/.test(outsideLiterals), outsideLiterals);
});

test("READ: a blank or whitespace search adds no predicate", () => {
  assert.ok(!/LIKE/.test(renderedRead({ search: "" })));
  assert.ok(!/LIKE/.test(renderedRead({ search: "   " })));
});

test("READ: assignment status ALL / ASSIGNED / UNASSIGNED", () => {
  assert.ok(!/default_work_shift_id IS/.test(renderedRead({ assignment_status: "ALL" })));

  assert.ok(
    /new_employee\.default_work_shift_id IS NOT NULL/.test(
      renderedRead({ assignment_status: "ASSIGNED" })
    )
  );

  const unassigned = renderedRead({ assignment_status: "UNASSIGNED" });
  assert.ok(/new_employee\.default_work_shift_id IS NULL/.test(unassigned));
  assert.ok(!/IS NOT NULL/.test(unassigned), "UNASSIGNED must not be the ASSIGNED clause");
});

test("READ: assignment status is case-insensitive, and an unknown value means ALL", () => {
  assert.ok(
    /IS NULL/.test(renderedRead({ assignment_status: "unassigned" })),
    "the frontend may send either case"
  );
  assert.ok(
    !/default_work_shift_id IS/.test(renderedRead({ assignment_status: "NONSENSE" })),
    "an unrecognised value must widen to ALL, never narrow to nothing"
  );
});

test("READ: filters compose rather than replace one another", () => {
  const sql = renderedRead({
    store_id: 4,
    department_id: 5,
    designation_id: 6,
    search: "Grace",
    assignment_status: "UNASSIGNED",
  });

  assert.ok(/new_employee\.status = 1/.test(sql));
  assert.ok(/store_id = 4/.test(sql));
  assert.ok(/department_id = 5/.test(sql));
  assert.ok(/designation_id = 6/.test(sql));
  assert.ok(/LIKE '%Grace%'/.test(sql));
  assert.ok(/default_work_shift_id IS NULL/.test(sql));
});

/* ---------------------------------------------------------- the dropdown */

test("DROPDOWN: active work shifts only", () => {
  let captured = null;
  const repo = buildRepo({
    query: (sql, params) => {
      captured = mysql.format(sql, params).replace(/\s+/g, " ").trim();
    },
  });
  repo.getActiveWorkShifts().catch(() => {});

  assert.ok(/WHERE active = 1/.test(captured), captured);
  assert.ok(/shift_code/.test(captured) && /shift_name/.test(captured), captured);
  assert.ok(!/shift_master/.test(captured), "the legacy table is not the dropdown's source");
});

/* ------------------------------------------------------------ write side */

/**
 * A fake pooled connection that answers each query in order from `responses`
 * and records every statement it was asked to run.
 */
function fakeDb(responses) {
  const statements = [];
  const state = { committed: false, rolledBack: false, released: false, began: false };
  let call = 0;

  const connection = {
    query: (sql, params, cb) => {
      statements.push(mysql.format(sql, params).replace(/\s+/g, " ").trim());
      const next = responses[call++];
      if (next instanceof Error) return cb(next);
      cb(null, next);
    },
    beginTransaction: (cb) => {
      state.began = true;
      cb(null);
    },
    commit: (cb) => {
      state.committed = true;
      cb(null);
    },
    rollback: (cb) => {
      state.rolledBack = true;
      cb(null);
    },
    release: () => {
      state.released = true;
    },
  };

  return {
    db: { getConnection: (cb) => cb(null, connection) },
    statements,
    state,
  };
}

const ACTIVE_SHIFT = [{ work_shift_id: 9, shift_code: "GS1", shift_name: "9 TO 9", active: 1 }];

test("WRITE: the UPDATE names default_work_shift_id and nothing else", async () => {
  const { db, statements } = fakeDb([
    ACTIVE_SHIFT,
    [{ employee_id: 1 }, { employee_id: 2 }],
    { affectedRows: 2 },
  ]);

  await buildRepo(db).bulkAssignWorkShift([1, 2], 9);

  const update = statements.find((s) => /^UPDATE/.test(s));
  assert.ok(update, "an UPDATE must have been issued");
  assert.ok(/SET default_work_shift_id = 9/.test(update), update);

  // The promise of this whole phase, asserted against the statement itself.
  assert.ok(!/shift_id = /.test(update.replace(/default_work_shift_id = /g, "")), update);
  assert.ok(!/shift_code/.test(update), update);
  assert.ok(!/shift_master/.test(update), update);
});

test("WRITE: no statement anywhere on the write path touches the legacy shift", async () => {
  const { db, statements } = fakeDb([
    ACTIVE_SHIFT,
    [{ employee_id: 1 }],
    { affectedRows: 1 },
  ]);

  await buildRepo(db).bulkAssignWorkShift([1], 9);

  for (const statement of statements) {
    assert.ok(!/shift_master/.test(statement), statement);
    assert.ok(!/new_employee\.shift_id/.test(statement), statement);
    assert.ok(!/new_employee\.shift_code/.test(statement), statement);
  }
});

test("WRITE: a successful assignment commits and reports the shift and count", async () => {
  const { db, state } = fakeDb([
    ACTIVE_SHIFT,
    [{ employee_id: 1 }, { employee_id: 2 }],
    { affectedRows: 2 },
  ]);

  const result = await buildRepo(db).bulkAssignWorkShift([1, 2], 9);

  assert.strictEqual(result.code, 200);
  assert.strictEqual(result.assigned_count, 2);
  assert.strictEqual(result.shift_code, "GS1");
  assert.strictEqual(result.shift_name, "9 TO 9");
  assert.deepStrictEqual(result.rejected_employee_ids, []);
  assert.ok(state.committed && !state.rolledBack);
  assert.ok(state.released, "the pooled connection must go back to the pool");
});

test("WRITE: the work shift row is locked before it is judged", async () => {
  const { db, statements } = fakeDb([
    ACTIVE_SHIFT,
    [{ employee_id: 1 }],
    { affectedRows: 1 },
  ]);

  await buildRepo(db).bulkAssignWorkShift([1], 9);

  assert.ok(
    /FOR UPDATE/.test(statements[0]),
    "without the lock a shift deactivated mid-request still collects assignments"
  );
});

test("WRITE: an inactive work shift is rejected and nothing is written", async () => {
  const { db, statements, state } = fakeDb([
    [{ work_shift_id: 9, shift_code: "OLD1", shift_name: "Retired", active: 0 }],
  ]);

  const result = await buildRepo(db).bulkAssignWorkShift([1, 2], 9);

  assert.strictEqual(result.code, 400);
  assert.ok(/inactive/.test(result.msg), result.msg);
  assert.ok(!statements.some((s) => /^UPDATE/.test(s)), "no write may have been issued");
  assert.ok(state.rolledBack && !state.committed);
});

test("WRITE: a work shift that does not exist is a 404, not a silent no-op", async () => {
  const { db, statements, state } = fakeDb([[]]);

  const result = await buildRepo(db).bulkAssignWorkShift([1], 12345);

  assert.strictEqual(result.code, 404);
  assert.ok(!statements.some((s) => /^UPDATE/.test(s)));
  assert.ok(state.rolledBack);
});

test("WRITE: all-or-nothing - one bad employee id rejects the whole batch", async () => {
  const { db, statements, state } = fakeDb([
    ACTIVE_SHIFT,
    // Only 1 and 3 come back; 2 is missing or inactive.
    [{ employee_id: 1 }, { employee_id: 3 }],
  ]);

  const result = await buildRepo(db).bulkAssignWorkShift([1, 2, 3], 9);

  assert.strictEqual(result.code, 400);
  assert.deepStrictEqual(result.rejected_employee_ids, [2]);
  assert.ok(
    !statements.some((s) => /^UPDATE/.test(s)),
    "nobody may be assigned when somebody cannot be"
  );
  assert.ok(state.rolledBack && !state.committed);
});

test("WRITE: only active employees are considered assignable", async () => {
  const { db, statements } = fakeDb([
    ACTIVE_SHIFT,
    [{ employee_id: 1 }],
    { affectedRows: 1 },
  ]);

  await buildRepo(db).bulkAssignWorkShift([1], 9);

  const lookup = statements[1];
  assert.ok(/status = 1/.test(lookup), lookup);
});

test("WRITE: a driver failure rolls back and releases rather than leaking", async () => {
  const { db, state } = fakeDb([ACTIVE_SHIFT, new Error("connection lost")]);

  await assert.rejects(() => buildRepo(db).bulkAssignWorkShift([1], 9));

  assert.ok(state.rolledBack, "a failed transaction must roll back");
  assert.ok(state.released, "and the connection must still return to the pool");
});
