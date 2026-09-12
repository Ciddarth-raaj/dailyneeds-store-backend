/**
 * M2 — what the salary repository may and may not do.
 *
 *   node --test repository/employee_salary.test.js
 *
 * Two kinds of assertion. The SQL-shape ones are read off the source, because
 * what matters about them is that the statement cannot be written a different
 * way - "no salary delete" is a rule about code that does not exist. The
 * behavioural ones run the methods against a fake connection that records the
 * SQL and the bound parameters, which is how the immutability scoping and the
 * resolver's ordering are proved without a database.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const buildRepo = require("./employee_salary");
const { SALARY_COLUMNS } = require("./employee_salary");

const source = fs.readFileSync(require.resolve("./employee_salary"), "utf8");

/**
 * The source with its COMMENTS REMOVED.
 *
 * The prose in that file explains the rules it keeps, so it naturally
 * contains the words "DELETE", "TRUNCATE" and "SELECT *". Asserting against
 * the raw text would fail on the documentation rather than on the code, and -
 * worse - would pass the day somebody deleted the comment. The assertions
 * below are about what the file DOES.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

/** A connection that records every query and answers with canned rows. */
function makeDb(rows = []) {
  const calls = [];
  return {
    calls,
    query(sql, params, cb) {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      cb(null, rows);
    },
  };
}

describe("no salary delete", () => {
  it("the repository issues no DELETE or TRUNCATE anywhere", () => {
    // The rule this file exists to keep. A salary history that can be deleted
    // is not a history, and the audit value of the table comes entirely from
    // rows that cannot quietly disappear.
    assert.ok(!/\bDELETE\s+FROM\b/i.test(code), "no DELETE");
    assert.ok(!/\bTRUNCATE\b/i.test(code), "no TRUNCATE");
    assert.ok(!/\bDROP\b/i.test(code), "no DROP");
  });

  it("exposes no method that sounds like one", () => {
    const repo = buildRepo(makeDb());
    for (const name of ["delete", "deleteSalary", "remove", "removeSalary", "destroy", "purge"]) {
      assert.equal(typeof repo[name], "undefined", `${name} must not exist`);
    }
  });
});

describe("no SELECT *", () => {
  it("every column is named", () => {
    assert.ok(!/SELECT\s+\*/i.test(code), "a star select is how a later column leaks to a screen");
  });

  it("the column list covers the whole approved schema", () => {
    for (const column of [
      "monthly_gross",
      "basic",
      "conveyance",
      "hra",
      "special_allowance",
      "manual_override",
      "override_reason",
      "employee_pf",
      "employer_epf",
      "employer_eps",
      "edli",
      "pf_admin_charge",
      "employee_esi",
      "employer_esi",
      "monthly_ctc",
      "effective_from",
      "status",
      "source",
      "statutory_snapshot",
      "changed_by",
      "changed_at",
      "updated_at",
    ]) {
      assert.ok(SALARY_COLUMNS.includes(column), `${column} is selectable`);
    }
  });
});

describe("the statutory context read", () => {
  it("reads six statutory columns and a name — not the employee's documents", async () => {
    const db = makeDb([{ employee_id: 1 }]);
    await buildRepo(db).getStatutoryContext(1);
    const sql = db.calls[0].sql;

    for (const wanted of [
      "pf_applicable",
      "esi_applicable",
      "previous_pf_member",
      // The EPS half of the Form 11 question, read as its own column: the
      // pension split turns on this one and never on the EPF one above it.
      "previous_eps_member",
      "dob",
      "date_of_joining",
    ]) {
      assert.ok(sql.includes(wanted), `${wanted} is read`);
    }
    // Calculating somebody's provident fund is not a reason to read their
    // identity documents, their bank account or the legacy salary string.
    for (const forbidden of [
      "aadhaar",
      "pan_no",
      "account_no",
      "ifsc",
      "bank_name",
      "`salary`",
    ]) {
      assert.ok(!sql.toLowerCase().includes(forbidden.toLowerCase()), `${forbidden} is not read`);
    }
  });

  it("parses date_of_joining through the SHARED rule, not a second one", async () => {
    // `utils/joining_date.js` is the one rule for reading that VARCHAR, and
    // the C1b lifecycle backfill used it. Parsing it a second way here would
    // let M2 and the lifecycle disagree about when somebody joined, which
    // would move the opening salary's effective date.
    const { JOINED_ON } = require("../utils/joining_date");
    assert.ok(code.includes("JOINED_ON"), "the shared expression is used");
    const db = makeDb([{}]);
    await buildRepo(db).getStatutoryContext(1);
    const normalize = (s) => s.replace(/\s+/g, " ").trim();
    assert.ok(
      db.calls[0].sql.includes(normalize(JOINED_ON("ne"))),
      "the emitted SQL carries the shared expression verbatim"
    );
  });
});

describe("the current-salary query", () => {
  it("asks only for APPROVED rows effective on or before the date, latest first", async () => {
    const db = makeDb([]);
    await buildRepo(db).getCurrentSalary(42, "2026-06-01");
    const { sql, params } = db.calls[0];

    assert.match(sql, /`status` = \?/);
    assert.match(sql, /`effective_from` <= \?/);
    assert.match(sql, /ORDER BY s\.`effective_from` DESC, s\.`salary_id` DESC/);
    assert.match(sql, /LIMIT 1/);
    assert.deepEqual(params, [42, "APPROVED", "2026-06-01"]);
  });

  it("binds every value rather than interpolating it", () => {
    // No template-literal interpolation of a caller's value anywhere near a
    // WHERE clause: the only interpolations in this file are the column list
    // and the shared joining-date expression, both of them constants.
    assert.ok(!/\$\{(employeeId|salaryId|asOfDate|effectiveFrom|reason)\}/.test(code));
  });
});

describe("immutability is enforced in the SQL, not only in the service", () => {
  it("an amendment is scoped to PENDING", async () => {
    const db = makeDb({ affectedRows: 0 });
    await buildRepo(db).updatePending(1, { basic: 1 });
    const { sql, params } = db.calls[0];
    assert.match(sql, /WHERE `salary_id` = \? AND `status` = \?/);
    assert.equal(params[params.length - 1], "PENDING");
  });

  it("M4 — AN AMENDMENT STAMPS WHO MADE IT, IN THE SAME STATEMENT", async () => {
    // This is the only path that changes a pending proposal, so the audit is
    // written by the statement that makes the change rather than by its
    // caller. There is no code path that amends without recording the amender.
    const db = makeDb({ affectedRows: 1 });
    await buildRepo(db).updatePending(7, { basic: 1 }, 41);
    const { sql, params } = db.calls[0];
    assert.ok(sql.includes("`changed_by` = ?"));
    assert.ok(sql.includes("`changed_at` = CURRENT_TIMESTAMP"), "the clock is the database's");
    assert.deepEqual(params, [{ basic: 1 }, 41, 7, "PENDING"]);
  });

  it("M4 — THE CALLER CANNOT DICTATE ITS OWN AMENDMENT AUDIT", async () => {
    // A patch carrying these two columns would let a request name somebody
    // else as the amender, or backdate the amendment. They are stripped before
    // the patch is bound, and the statement's own clause is what is written.
    const db = makeDb({ affectedRows: 1 });
    await buildRepo(db).updatePending(
      7,
      { basic: 1, changed_by: 999, changed_at: "1999-01-01 00:00:00" },
      41
    );
    assert.deepEqual(db.calls[0].params[0], { basic: 1 });
    assert.equal(db.calls[0].params[1], 41);
  });

  it("M4 — A DECISION NEVER OVERWRITES THE AMENDMENT AUDIT", async () => {
    // Approving a proposal is not amending it. Both statements name the
    // columns they set, and `changed_by`/`changed_at` are not among them, so a
    // proposal approved without ever being amended keeps its NULLs.
    const db = makeDb({ affectedRows: 1 });
    const repo = buildRepo(db);
    await repo.approve(1, 7);
    await repo.reject(2, 7, "Budget");
    for (const call of db.calls) {
      assert.ok(!call.sql.includes("`changed_by`"), "approval and rejection leave it alone");
      assert.ok(!call.sql.includes("`changed_at`"));
    }
  });

  it("an approval is scoped to PENDING", async () => {
    const db = makeDb({ affectedRows: 0 });
    await buildRepo(db).approve(1, 7);
    const { sql, params } = db.calls[0];
    assert.match(sql, /AND `status` = \?/);
    assert.equal(params[params.length - 1], "PENDING");
    assert.ok(sql.includes("`approved_at` = CURRENT_TIMESTAMP"), "the clock is the database's");
  });

  it("a rejection is scoped to PENDING and stores its reason", async () => {
    const db = makeDb({ affectedRows: 0 });
    await buildRepo(db).reject(1, 7, "Wrong grade");
    const { sql, params } = db.calls[0];
    assert.match(sql, /AND `status` = \?/);
    assert.ok(params.includes("Wrong grade"));
    assert.equal(params[params.length - 1], "PENDING");
  });

  it("nothing updates a row without naming its status", () => {
    // Every UPDATE in this file carries `AND \`status\` = ?`. An UPDATE that
    // did not would be able to rewrite approved history.
    // Backticks inside a template literal are written escaped, so the raw
    // source spells the same SQL two ways. Dropping the backslashes first
    // makes one pattern match both.
    const flat = code.replace(/\\`/g, "`");
    const chunks = flat.split(/UPDATE\s+`employee_salary`/).slice(1);
    assert.equal(chunks.length, 3, "there are exactly three update paths");
    assert.ok(chunks[0].includes("`changed_at` = CURRENT_TIMESTAMP"), "and only the first amends");
    for (const chunk of chunks) {
      // Far enough to cover the WHERE clause of any of the three.
      const stmt = chunk.slice(0, 400);
      assert.ok(/status` = \?/.test(stmt), `an UPDATE without a status guard: ${stmt.slice(0, 80)}`);
    }
  });
});

describe("the live-salary test excludes rejected rows", () => {
  it("asks for a row whose status is not REJECTED", async () => {
    const db = makeDb([]);
    await buildRepo(db).hasLiveSalary(42);
    const { sql, params } = db.calls[0];
    assert.match(sql, /`status` <> \?/);
    assert.deepEqual(params, [42, "REJECTED"]);
  });
});

/* ============================================================= M4 ======== */

describe("M4 — the revision reason is a column like any other", () => {
  it("is selectable, so history can show WHY", () => {
    assert.ok(SALARY_COLUMNS.includes("revision_reason"));
  });

  it("is kept apart from the two other reason columns", () => {
    // Three questions asked of three people at three moments: why the pay is
    // changing, why the breakup departs from the automatic one, and why an
    // approver refused. A row that collapsed any two of them could answer
    // neither later.
    for (const column of ["revision_reason", "override_reason", "rejection_reason"]) {
      assert.ok(SALARY_COLUMNS.includes(column), `${column} is its own column`);
    }
  });
});

describe("M4 — WHO did it, resolved in the query", () => {
  it("history joins the FOUR actor names", async () => {
    const db = makeDb([]);
    await buildRepo(db).getHistory(42);
    const sql = db.calls[0].sql;
    for (const alias of [
      "created_by_name",
      "changed_by_name",
      "approved_by_name",
      "rejected_by_name",
    ]) {
      assert.ok(sql.includes(alias), `${alias} comes back with the row`);
    }
    // LEFT joins: a missing or renamed actor must not drop the revision from
    // somebody's salary history.
    assert.equal((sql.match(/LEFT JOIN `new_employee`/g) || []).length, 4);
  });

  it("RESOLVES THE AMENDER SERVER-SIDE, so no screen reads employees one by one", async () => {
    // The whole reason the join is here: a history of twenty revisions would
    // otherwise be twenty-odd employee reads from the browser to render one
    // table. `changed_by_name` arrives with the row, like the other three.
    const db = makeDb([]);
    await buildRepo(db).getHistory(42);
    const sql = db.calls[0].sql;
    assert.ok(sql.includes("hb.`employee_name` AS `changed_by_name`"));
    assert.ok(sql.includes("hb.`employee_id` = s.`changed_by`"));
    assert.equal(db.calls.length, 1, "one query, not one per actor");
  });

  it("KEEPS THE IDS BESIDE THE NAMES", async () => {
    // A name is for reading; the id is what the record actually asserts. An
    // employee renamed in 2031 must not change what a 2026 approval says.
    const db = makeDb([]);
    await buildRepo(db).getHistory(42);
    for (const id of ["created_by", "changed_by", "approved_by", "rejected_by"]) {
      assert.ok(db.calls[0].sql.includes("s.`" + id + "`"), `${id} is still selected`);
    }
  });

  it("reads the actor's NAME and nothing else about them", async () => {
    const db = makeDb([]);
    await buildRepo(db).getHistory(42);
    const sql = db.calls[0].sql;
    for (const forbidden of ["cb.`pan_no`", "cb.`account_no`", "cb.`salary`", "cb.`aadhaar"]) {
      assert.ok(!sql.includes(forbidden), "reading who approved is not reading their record");
    }
  });
});

describe("M4 review fix — ONE PENDING PROPOSAL PER EMPLOYEE", () => {
  it("asks for the PENDING row directly, rather than filtering a history", async () => {
    // An indexed read on (`employee_id`, `status`) answers a yes/no question.
    // Reading the whole history and filtering in JavaScript would pull every
    // revision an employee has ever had across the wire on every create.
    const db = makeDb([]);
    await buildRepo(db).getPendingForEmployee(42);
    const { sql, params } = db.calls[0];
    assert.match(sql, /`status` = \?/);
    assert.deepEqual(params, [42, "PENDING"]);
    assert.match(sql, /LIMIT 1/);
  });

  it("is deterministic even if a database somehow holds two", async () => {
    const db = makeDb([]);
    await buildRepo(db).getPendingForEmployee(42);
    assert.match(db.calls[0].sql, /ORDER BY s\.`effective_from` ASC, s\.`salary_id` ASC/);
  });

  it("answers null when there is none, and the row when there is", async () => {
    assert.equal(await buildRepo(makeDb([])).getPendingForEmployee(42), null);
    const found = await buildRepo(makeDb([{ salary_id: 9 }])).getPendingForEmployee(42);
    assert.equal(found.salary_id, 9);
  });

  it("`hasPending` is the same read, as a yes or a no", async () => {
    assert.equal(await buildRepo(makeDb([])).hasPending(42), false);
    assert.equal(await buildRepo(makeDb([{ salary_id: 9 }])).hasPending(42), true);
  });

  it("READS PENDING ONLY — an approved or rejected row is not a block", async () => {
    // Rejected proposals never block a new one and approved history is
    // permanent, so neither may be selected here. PENDING is in the SQL rather
    // than filtered afterwards.
    const db = makeDb([]);
    await buildRepo(db).getPendingForEmployee(42);
    assert.ok(!/<>/.test(db.calls[0].sql), "not `status <> REJECTED` - that is a different rule");
    assert.equal(db.calls[0].params[1], "PENDING");
  });
});

describe("M4 — the pending approval queue", () => {
  const FILTERS = {
    employee_id: null,
    store_id: null,
    effective_from: null,
    effective_to: null,
    as_of: "2026-09-11",
    limit: 500,
  };

  it("SELECTS PENDING IN THE SQL — not filtered afterwards", async () => {
    // An approval queue that could be made to show an approved revision is one
    // query-string away from offering a second decision on something already
    // decided.
    const db = makeDb([]);
    await buildRepo(db).getPendingQueue(FILTERS);
    const { sql, params } = db.calls[0];
    assert.ok(sql.includes("s.`status` = ?"));
    assert.ok(params.includes("PENDING"), "and PENDING is bound, never interpolated");
  });

  it("resolves the current approved salary by EXACTLY the resolver's rule", async () => {
    // Latest APPROVED row effective on or before the as-of date, newest first
    // - the same three clauses `getCurrentSalary` uses, so the queue and the
    // Employee Master cannot disagree about what somebody is on today.
    const db = makeDb([]);
    await buildRepo(db).getPendingQueue(FILTERS);
    const sql = db.calls[0].sql;
    const sub = sql.slice(sql.indexOf("LEFT JOIN `employee_salary` cur"));
    assert.ok(sub.includes("c.`status` = ?"));
    assert.ok(sub.includes("c.`effective_from` <= ?"));
    assert.ok(sub.includes("ORDER BY c.`effective_from` DESC, c.`salary_id` DESC LIMIT 1"));
    assert.equal(db.calls[0].params[0], "APPROVED", "the join's parameters come first");
    assert.equal(db.calls[0].params[1], FILTERS.as_of);
  });

  it("names the current figure `current_monthly_gross`, never `salary`", async () => {
    // `middlewares/sensitive.js#filterResponse` strips keys called `salary` at
    // any depth: that alias would make the figure vanish for anybody without
    // the B3 key, with no error and no 403 to see.
    const db = makeDb([]);
    await buildRepo(db).getPendingQueue(FILTERS);
    const sql = db.calls[0].sql;
    assert.ok(sql.includes("AS `current_monthly_gross`"));
    assert.ok(!/AS `salary`/.test(sql));
  });

  it("reads FOUR employee facts — not the identity documents", async () => {
    const db = makeDb([]);
    await buildRepo(db).getPendingQueue(FILTERS);
    const sql = db.calls[0].sql;
    for (const wanted of ["ne.`employee_name`", "ne.`store_id`", "ne.`designation_id`"]) {
      assert.ok(sql.includes(wanted), `${wanted} is read`);
    }
    for (const forbidden of [
      "ne.`pan_no`",
      "ne.`aadhaar",
      "ne.`account_no`",
      "ne.`ifsc`",
      "ne.`bank_name`",
      "ne.`uan`",
      "ne.`salary`",
    ]) {
      assert.ok(!sql.includes(forbidden), `deciding a revision is no reason to read ${forbidden}`);
    }
  });

  it("EVERY FILTER IS PARAMETERISED, and an absent one adds no clause", async () => {
    const bare = makeDb([]);
    await buildRepo(bare).getPendingQueue(FILTERS);
    assert.ok(!bare.calls[0].sql.includes("s.`employee_id` = ?"));
    assert.ok(!bare.calls[0].sql.includes("ne.`store_id` = ?"));

    const filtered = makeDb([]);
    await buildRepo(filtered).getPendingQueue({
      ...FILTERS,
      employee_id: 42,
      store_id: 9,
      effective_from: "2026-10-01",
      effective_to: "2026-12-31",
    });
    const { sql, params } = filtered.calls[0];
    assert.ok(sql.includes("s.`employee_id` = ?"));
    assert.ok(sql.includes("ne.`store_id` = ?"));
    assert.ok(sql.includes("s.`effective_from` >= ?"));
    assert.ok(sql.includes("s.`effective_from` <= ?"));
    for (const value of [42, 9, "2026-10-01", "2026-12-31"]) {
      assert.ok(params.includes(value), `${value} is bound, not interpolated`);
    }
  });

  it("is bounded, and the bound is bound too", async () => {
    const db = makeDb([]);
    await buildRepo(db).getPendingQueue({ ...FILTERS, limit: 500 });
    assert.ok(db.calls[0].sql.trim().endsWith("LIMIT ?"));
    assert.equal(db.calls[0].params[db.calls[0].params.length - 1], 500);
  });

  it("ORDERS BY EFFECTIVE DATE, OLDEST FIRST — a worklist, not a feed", async () => {
    // The proposal that takes effect soonest is the one that needs deciding
    // first; a newest-first queue buries it.
    const db = makeDb([]);
    await buildRepo(db).getPendingQueue(FILTERS);
    assert.ok(
      db.calls[0].sql.includes("ORDER BY s.`effective_from` ASC, s.`salary_id` ASC"),
      "oldest effective date first, deterministically"
    );
  });

  it("is ONE query, not one per row", async () => {
    // The whole reason this method exists: the alternative is listing the
    // employees and reading each one's history.
    const db = makeDb([]);
    await buildRepo(db).getPendingQueue(FILTERS);
    assert.equal(db.calls.length, 1);
  });
});
