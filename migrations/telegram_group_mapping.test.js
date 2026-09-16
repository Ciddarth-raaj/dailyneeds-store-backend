/**
 * The Phase 3A mapping migration: one new table, and nothing else touched.
 *
 *   node --test migrations/telegram_group_mapping.test.js
 *
 * Proven against the SQL text - there is no database here - exactly as
 * `telegram_group_registry.test.js` proves the registry's.
 *
 * THE PROPERTIES THAT MATTER MOST:
 *
 *   `target_id` IS NOT NULL and ALL_EMPLOYEES uses 0, because MySQL treats
 *   NULLs as distinct in a UNIQUE index - a nullable target would let "All
 *   Employees" be added to one group any number of times
 *
 *   the UNIQUE KEY over (group, type, target), because the usecase's
 *   duplicate check is only a good error message
 *
 *   that `target_id` carries NO foreign key, because a mapping whose target
 *   was deleted must SURVIVE and be shown with a warning rather than
 *   silently vanish
 *
 *   that the down migration removes only what the up migration created
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  MAPPING_TYPES,
  ALL_EMPLOYEES_TARGET_ID,
} = require("../constants/telegram_group_mapping");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260916140000-telegram-group-mapping";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

const upSql = read(`${NAME}-up.sql`);
const upBody = stripComments(upSql);
const upStatements = statements(upSql);
const downStatements = statements(read(`${NAME}-down.sql`));
const createTable = upStatements.find((s) => /^CREATE TABLE/i.test(s));

describe("the migration runner file", () => {
  it("is dated 20260916 and reads its own two SQL files", () => {
    const js = fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8");
    assert.match(js, new RegExp(`${NAME}-up\\.sql`));
    assert.match(js, new RegExp(`${NAME}-down\\.sql`));
    assert.match(NAME, /^20260916/);
  });

  it("does not collide with another migration's timestamp", () => {
    // db-migrate orders by filename. Two migrations sharing a full timestamp
    // is an ambiguity nobody wants to debug later, and one already exists on
    // this date.
    const all = fs
      .readdirSync(path.join(__dirname, "mysql/migrations"))
      .filter((f) => f.endsWith(".js"));
    const stamp = NAME.split("-")[0];
    const sameStamp = all.filter((f) => f.startsWith(stamp));
    assert.deepEqual(sameStamp, [`${NAME}.js`], `another migration shares ${stamp}`);
  });
});

describe("the table", () => {
  it("is created, and it is the only table created", () => {
    assert.ok(createTable, "a CREATE TABLE is expected");
    assert.match(createTable, /CREATE TABLE IF NOT EXISTS `telegram_group_mapping`/);
    assert.equal(upStatements.filter((s) => /^CREATE TABLE/i.test(s)).length, 1);
  });

  it("holds exactly the approved columns", () => {
    for (const column of [
      "telegram_group_mapping_id",
      "telegram_group_id",
      "mapping_type",
      "target_id",
      "created_by",
      "created_at",
    ]) {
      assert.match(createTable, new RegExp("`" + column + "`"), `missing ${column}`);
    }
  });

  it("offers exactly the four mapping types, and no fifth", () => {
    const enumMatch = createTable.match(/`mapping_type` ENUM\(([^)]+)\)/);
    assert.ok(enumMatch, "mapping_type must be an ENUM, not free text");
    const values = enumMatch[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
    assert.deepEqual(values, MAPPING_TYPES);
    // The ones deliberately NOT implemented. A rule engine or hand-picked
    // employees would each need a reviewer to re-verify who is in a group.
    for (const forbidden of ["SELECTED_EMPLOYEES", "MANUAL", "ROLE", "USER", "STORE_MANAGER"]) {
      assert.ok(!values.includes(forbidden), `${forbidden} must not be a mapping type`);
    }
  });

  it("makes target_id NOT NULL - the sentinel's whole reason", () => {
    assert.match(createTable, /`target_id` INT NOT NULL/);
    assert.ok(
      !/`target_id` INT NULL/.test(createTable),
      "a nullable target would allow duplicate ALL_EMPLOYEES rows"
    );
  });

  it("documents the 0 sentinel the code uses", () => {
    assert.equal(ALL_EMPLOYEES_TARGET_ID, 0);
    assert.match(upBody, /0 for ALL_EMPLOYEES/);
  });

  it("makes (group, type, target) unique, so a mapping cannot be added twice", () => {
    assert.match(
      createTable,
      /UNIQUE KEY `uq_tgm_group_type_target` \(`telegram_group_id`, `mapping_type`, `target_id`\)/
    );
  });

  it("cascades from the registry group, so a deleted group leaves no orphans", () => {
    assert.match(
      createTable,
      /CONSTRAINT `fk_tgm_group` FOREIGN KEY \(`telegram_group_id`\) REFERENCES `telegram_group_registry` \(`telegram_group_id`\) ON DELETE CASCADE/
    );
  });

  it("gives target_id NO foreign key to any master", () => {
    // The point of the whole inactive/missing-target design: a mapping whose
    // outlet was deleted must still be there to be shown with a warning.
    for (const master of ["outlets", "designation", "department", "new_employee"]) {
      assert.ok(
        !new RegExp("FOREIGN KEY \\(`target_id`\\)[^,]*" + master).test(createTable),
        `target_id must not reference ${master}`
      );
    }
    assert.equal(
      (createTable.match(/FOREIGN KEY/g) || []).length,
      1,
      "exactly one FK - the group"
    );
  });
});

describe("what the migration must NOT do", () => {
  it("creates no permission and touches no grant", () => {
    assert.ok(!/all_permissions/i.test(upBody), "Phase 3A mints no permission key");
    assert.ok(!/designation_permissions|permission_key/i.test(upBody));
  });

  it("alters, drops or renames nothing that already exists", () => {
    for (const statement of upStatements) {
      assert.ok(
        !/^(ALTER|DROP|RENAME|TRUNCATE|UPDATE|DELETE|INSERT)\b/i.test(statement),
        `additive only, but found: ${statement.slice(0, 60)}`
      );
    }
  });

  it("does not touch the employee or registry tables", () => {
    assert.ok(!/ALTER TABLE `new_employee`/i.test(upBody));
    assert.ok(!/ALTER TABLE `telegram_group_registry`/i.test(upBody));
  });
});

describe("the down migration", () => {
  it("drops the one table this task created, and only that", () => {
    assert.deepEqual(downStatements, ["DROP TABLE IF EXISTS `telegram_group_mapping`"]);
  });

  it("revokes no permission and drops no master", () => {
    const down = downStatements.join(" ");
    assert.ok(!/all_permissions|DELETE FROM/i.test(down));
    for (const master of ["outlets", "designation", "department", "new_employee", "telegram_group_registry"]) {
      assert.ok(!new RegExp(master).test(down), `down must not touch ${master}`);
    }
  });
});
