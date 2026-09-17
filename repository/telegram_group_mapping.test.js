/**
 * The mapping repository's SQL, and the one thing it must not get wrong.
 *
 *   node --test repository/telegram_group_mapping.test.js
 *
 * THE ACTIVE-COLUMN SPELLINGS. `outlets` says `is_active`; `designation` and
 * `department` say `status`. Getting that wrong does not fail - it silently
 * decides every target is inactive and decorates every correct mapping with
 * a warning, which reads as a data problem rather than a code one. It is
 * pinned here AND checked against `repository/report_template.js`, which
 * discovered the same thing independently, so the two cannot drift apart.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildRepo = require("./telegram_group_mapping");
const { MAPPING_TARGET_SOURCE } = require("../constants/telegram_group_mapping");

const ROOT = path.join(__dirname, "..");

/** A db double that records the SQL it is handed and replays fixed rows. */
const makeDb = (rowsFor = () => []) => {
  const queries = [];
  return {
    queries,
    query(sql, params, cb) {
      queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      cb(null, rowsFor(sql, params));
    },
  };
};

describe("the master column map", () => {
  it("spells each active column the way its table does", () => {
    assert.equal(MAPPING_TARGET_SOURCE.OUTLET.active, "is_active");
    assert.equal(MAPPING_TARGET_SOURCE.DESIGNATION.active, "status");
    assert.equal(MAPPING_TARGET_SOURCE.DEPARTMENT.active, "status");
  });

  it("agrees with report_template.js, which pins the same three", () => {
    // Two copies of a fact that is easy to get wrong; this fails if either
    // is changed alone.
    const source = fs.readFileSync(path.join(ROOT, "repository/report_template.js"), "utf8");
    const map = source.match(/const SOURCES = \{[\s\S]*?\};/);
    assert.ok(map, "report_template must still declare its SOURCES map");
    assert.match(map[0], /outlet:\s*\{ table: "outlets", id: "outlet_id", active: "is_active" \}/);
    assert.match(map[0], /department:\s*\{ table: "department", id: "department_id", active: "status" \}/);
    assert.match(map[0], /designation:\s*\{ table: "designation", id: "designation_id", active: "status" \}/);
  });
});

describe("resolveTargets", () => {
  it("reads one master per type present, and none for a type with no ids", async () => {
    const db = makeDb(() => []);
    await buildRepo(db).resolveTargets({ OUTLET: [1, 2], DESIGNATION: [], DEPARTMENT: undefined });
    assert.equal(db.queries.length, 1, "only the type actually used is queried");
    assert.match(db.queries[0].sql, /FROM outlets/);
  });

  it("asks for at most three queries, whatever the mapping count", async () => {
    const db = makeDb(() => []);
    await buildRepo(db).resolveTargets({
      OUTLET: [1, 2, 3, 4, 5],
      DESIGNATION: [6, 7, 8],
      DEPARTMENT: [9],
    });
    assert.equal(db.queries.length, 3, "one per master, not one per target");
  });

  it("deduplicates and drops non-positive ids before binding them", async () => {
    const db = makeDb(() => []);
    await buildRepo(db).resolveTargets({ OUTLET: [5, 5, 0, -2, "x", 7] });
    assert.deepEqual(db.queries[0].params, [[5, 7]]);
  });

  it("treats a NULL active column as ACTIVE", async () => {
    // Several master rows predate the column; calling those inactive would
    // warn on long-standing correct mappings.
    const db = makeDb(() => [{ id: 5, name: "ECR", active: null }]);
    const found = (await buildRepo(db).resolveTargets({ OUTLET: [5] })).get("OUTLET");
    assert.equal(found.get(5).active, true);
  });

  it("distinguishes present-but-inactive from absent", async () => {
    const db = makeDb(() => [{ id: 5, name: "ECR", active: 0 }]);
    const found = (await buildRepo(db).resolveTargets({ OUTLET: [5, 6] })).get("OUTLET");
    assert.equal(found.get(5).active, false, "5 exists and is retired");
    assert.equal(found.has(6), false, "6 does not exist at all");
  });
});

describe("the employee snapshot", () => {
  it("is ONE query and selects only safe columns", async () => {
    const db = makeDb(() => []);
    await buildRepo(db).getEmployeeSnapshot();
    assert.equal(db.queries.length, 1);
    const sql = db.queries[0].sql;
    assert.ok(!/SELECT \*/i.test(sql));
    for (const column of ["salary", "aadhaar", "pan_no", "account_no", "primary_contact_number"]) {
      assert.ok(!new RegExp(column, "i").test(sql), `must not select ${column}`);
    }
  });

  it("does not pre-filter on status", async () => {
    // Employment is decided by the dated rule in JS, over the whole
    // population. A `status = 1` filter here would quietly reintroduce the
    // bug the dated rule exists to fix.
    const db = makeDb(() => []);
    await buildRepo(db).getEmployeeSnapshot();
    assert.ok(!/WHERE/i.test(db.queries[0].sql), "no WHERE - the rule is dated, not status-based");
  });

  it("orders deterministically, so two identical requests agree", async () => {
    const db = makeDb(() => []);
    await buildRepo(db).getEmployeeSnapshot();
    assert.match(db.queries[0].sql, /ORDER BY ne\.employee_name ASC, ne\.employee_id ASC/);
  });
});

describe("the connected-identity read", () => {
  it("is one query for many employees, and asks only for employee_id", async () => {
    const db = makeDb(() => [{ employee_id: 2 }]);
    const connected = await buildRepo(db).getConnectedEmployeeIds([1, 2, 3]);
    assert.equal(db.queries.length, 1);
    assert.match(db.queries[0].sql, /SELECT employee_id FROM employee_telegram_identity/);
    assert.match(db.queries[0].sql, /disconnected_at IS NULL/);
    assert.deepEqual([...connected], [2]);
  });

  it("makes no query at all for an empty population", async () => {
    const db = makeDb(() => []);
    const connected = await buildRepo(db).getConnectedEmployeeIds([]);
    assert.equal(db.queries.length, 0);
    assert.equal(connected.size, 0);
  });

  it("a disconnected identity is excluded by the query, not by JS", async () => {
    const db = makeDb(() => []);
    await buildRepo(db).getConnectedEmployeeIds([1]);
    assert.match(db.queries[0].sql, /WHERE disconnected_at IS NULL/);
  });
});

describe("mapping reads and writes", () => {
  it("scopes getByIdForGroup by group in the WHERE", async () => {
    const db = makeDb(() => []);
    await buildRepo(db).getByIdForGroup(10, 1);
    assert.match(db.queries[0].sql, /WHERE telegram_group_id = \? AND telegram_group_mapping_id = \?/);
    assert.deepEqual(db.queries[0].params, [10, 1]);
  });

  it("scopes the delete by group in the same statement", async () => {
    const db = makeDb(() => ({ affectedRows: 1 }));
    await buildRepo(db).delete(10, 1);
    assert.match(db.queries[0].sql, /DELETE FROM telegram_group_mapping WHERE telegram_group_id = \? AND telegram_group_mapping_id = \?/);
  });

  it("lists a group's mappings in a stable order", async () => {
    const db = makeDb(() => []);
    await buildRepo(db).getByGroup(10);
    assert.match(db.queries[0].sql, /ORDER BY telegram_group_mapping_id ASC/);
  });

  it("writes exactly the columns the multi-level table expects", async () => {
    const db = makeDb(() => ({ insertId: 7 }));
    await buildRepo(db).create({
      telegram_group_id: 10,
      rule: { rule_outlet_id: 5, rule_department_id: 0, rule_designation_id: 3 },
      created_by: 42,
    });
    assert.match(
      db.queries[0].sql,
      /INSERT INTO telegram_group_mapping \(telegram_group_id, rule_outlet_id, rule_department_id, rule_designation_id, created_by\)/
    );
    assert.deepEqual(db.queries[0].params, [10, 5, 0, 3, 42]);
  });

  it("writes 0 - never NULL - for a dimension left unrestricted", async () => {
    // The sentinel IS the duplicate guard: MySQL treats NULLs as distinct in
    // a UNIQUE index, so a NULL here would let one rule be added repeatedly.
    const db = makeDb(() => ({ insertId: 7 }));
    await buildRepo(db).create({ telegram_group_id: 10, rule: {}, created_by: null });
    assert.deepEqual(db.queries[0].params, [10, 0, 0, 0, null]);
  });

  it("coerces a junk dimension to unrestricted rather than storing it", async () => {
    const db = makeDb(() => ({ insertId: 7 }));
    await buildRepo(db).create({
      telegram_group_id: 10,
      rule: { rule_outlet_id: "abc", rule_department_id: -4, rule_designation_id: 1.5 },
    });
    assert.deepEqual(db.queries[0].params, [10, 0, 0, 0, null]);
  });

  it("findDuplicateRule compares ALL THREE dimensions, not one", async () => {
    const db = makeDb(() => []);
    await buildRepo(db).findDuplicateRule(10, {
      rule_outlet_id: 5,
      rule_department_id: 0,
      rule_designation_id: 3,
    });
    assert.match(
      db.queries[0].sql,
      /WHERE telegram_group_id = \? AND rule_outlet_id = \? AND rule_department_id = \? AND rule_designation_id = \?/
    );
    assert.deepEqual(db.queries[0].params, [10, 5, 0, 3]);
  });

  it("no read still names the dropped single-dimension columns", async () => {
    const db = makeDb(() => []);
    const repo = buildRepo(db);
    await repo.getByGroup(10);
    await repo.getByIdForGroup(10, 1);
    await repo.getAllMappingsWithGroups();
    for (const query of db.queries) {
      assert.doesNotMatch(query.sql, /\bmapping_type\b/, query.sql);
      assert.doesNotMatch(query.sql, /\btarget_id\b/, query.sql);
    }
  });
});
