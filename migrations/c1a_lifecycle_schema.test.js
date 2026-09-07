/**
 * Stage 0C / C1a — the lifecycle schema migration is additive, and reversible.
 *
 * The behaviour of the constraints is proved against a real MySQL (see the
 * C1a report); what this file protects is the property that makes C1a safe to
 * deploy at all: it adds things and changes nothing. A migration that grew an
 * UPDATE against `new_employee`, or lost its down, would still apply cleanly
 * and would still be a one-way door.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SQLS = path.join(__dirname, "mysql", "migrations", "sqls");
const NAME = "20260907140000-c1a-employee-lifecycle-schema";

const up = fs.readFileSync(path.join(SQLS, `${NAME}-up.sql`), "utf8");
const down = fs.readFileSync(path.join(SQLS, `${NAME}-down.sql`), "utf8");
const js = fs.readFileSync(
  path.join(__dirname, "mysql", "migrations", `${NAME}.js`),
  "utf8"
);

/** SQL with comments removed, so a word in a comment is not read as code. */
const code = (sql) =>
  sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

describe("C1a migration is wired up", () => {
  it("the js reads its own up and down files", () => {
    assert.ok(js.includes(`${NAME}-up.sql`));
    assert.ok(js.includes(`${NAME}-down.sql`));
  });

  it("both SQL files exist and are non-empty", () => {
    assert.ok(up.length > 0);
    assert.ok(down.length > 0);
  });
});

describe("C1a is additive only", () => {
  const upCode = code(up);

  it("writes no rows anywhere", () => {
    // Statement-initial only: `ON UPDATE CURRENT_TIMESTAMP`, `ON DELETE
    // RESTRICT` and `CREATE OR REPLACE VIEW` are DDL clauses, not writes, and
    // a bare word search flags all three.
    for (const verb of ["INSERT", "UPDATE", "DELETE", "REPLACE", "TRUNCATE"]) {
      assert.ok(
        !new RegExp(`(^|;)\\s*${verb}\\b`, "im").test(upCode),
        `a statement starting with ${verb} must not appear in the up migration`
      );
    }
  });

  it("does not alter new_employee in any way", () => {
    assert.ok(
      !/ALTER\s+TABLE\s+`?new_employee`?/i.test(upCode),
      "new_employee must not be altered"
    );
    assert.ok(!/DROP\s+TABLE[^;]*new_employee/i.test(upCode));
  });

  it("touches `resignation` only by ADDing", () => {
    const alters = upCode.match(/ALTER TABLE `resignation`[\s\S]*?;/gi) || [];
    assert.equal(alters.length, 1, "exactly one ALTER on resignation");
    assert.ok(!/\bDROP\b/i.test(alters[0]), "nothing may be dropped");
    assert.ok(!/\bCHANGE\b|\bMODIFY\b|\bRENAME\b/i.test(alters[0]), "nothing renamed or retyped");
  });

  it("creates exactly the four objects the design calls for", () => {
    assert.ok(/CREATE TABLE IF NOT EXISTS `employee_employment_period`/i.test(upCode));
    assert.ok(/CREATE TABLE IF NOT EXISTS `employee_lifecycle_event`/i.test(upCode));
    assert.ok(/CREATE OR REPLACE VIEW `v_employee_current_period`/i.test(upCode));
    const creates = upCode.match(/CREATE (TABLE|OR REPLACE VIEW)/gi) || [];
    assert.equal(creates.length, 3, "two tables and one view, nothing else");
  });
});

describe("C1a declares the invariants in the database", () => {
  const upCode = code(up);

  it("one open period per employee, via the generated marker", () => {
    assert.match(upCode, /`open_marker`\s+INT GENERATED ALWAYS AS/i);
    assert.match(upCode, /UNIQUE KEY `uq_one_open_period` \(`open_marker`\)/i);
  });

  it("period_no is unique per employee", () => {
    assert.match(upCode, /UNIQUE KEY `uq_period_seq` \(`employee_id`, `period_no`\)/i);
  });

  it("an open period cannot carry an end date", () => {
    assert.match(upCode, /CHECK \(`period_state` <> 'open' OR `ended_on` IS NULL\)/i);
  });

  it("known dates must be ordered, and unknown dates are allowed", () => {
    assert.match(
      upCode,
      /CHECK \(`ended_on` IS NULL OR `joined_on` IS NULL OR `ended_on` >= `joined_on`\)/i
    );
    assert.match(upCode, /`joined_on`\s+DATE NULL/i);
    assert.match(upCode, /`ended_on`\s+DATE NULL/i);
  });

  it("periods and events belong to a real employee", () => {
    assert.match(upCode, /CONSTRAINT `fk_period_employee`[\s\S]*?REFERENCES `new_employee`/i);
    assert.match(upCode, /CONSTRAINT `fk_event_employee`[\s\S]*?REFERENCES `new_employee`/i);
  });

  it("employee_id can never be renumbered out from under a period", () => {
    // The business rule is that employee_id is permanent; ON UPDATE RESTRICT
    // is that rule expressed where it cannot be forgotten.
    assert.match(upCode, /fk_period_employee[\s\S]*?ON DELETE RESTRICT ON UPDATE RESTRICT/i);
  });

  it("carries every column the design specifies", () => {
    for (const col of [
      "period_id", "employee_id", "period_no", "period_state", "joined_on",
      "ended_on", "end_reason_type", "end_note", "source", "needs_review",
      "created_by", "updated_by", "created_at", "updated_at",
    ]) {
      assert.ok(new RegExp("`" + col + "`").test(upCode), `missing column ${col}`);
    }
    assert.match(upCode, /`period_state`\s+ENUM\('open','closed'\)/i);
    assert.match(upCode, /`source`\s+ENUM\('backfill','local'\)/i);
  });
});

describe("C1a can be rolled back", () => {
  const downCode = code(down);

  it("drops the view and both tables", () => {
    assert.match(downCode, /DROP VIEW IF EXISTS `v_employee_current_period`/i);
    assert.match(downCode, /DROP TABLE IF EXISTS `employee_lifecycle_event`/i);
    assert.match(downCode, /DROP TABLE IF EXISTS `employee_employment_period`/i);
  });

  it("removes the four resignation columns it added, and only those", () => {
    for (const col of ["employee_id", "period_id", "voided_at", "voided_by"]) {
      assert.ok(new RegExp("DROP COLUMN `" + col + "`", "i").test(downCode), col);
    }
    for (const col of ["employee_name", "reason", "resignation_date", "resignation_id"]) {
      assert.ok(
        !new RegExp("DROP COLUMN `" + col + "`", "i").test(downCode),
        `${col} is pre-existing and must survive a rollback`
      );
    }
  });

  it("drops the foreign keys before the columns they sit on", () => {
    const fkAt = downCode.search(/DROP FOREIGN KEY `fk_resignation_employee`/i);
    const colAt = downCode.search(/DROP COLUMN `employee_id`/i);
    assert.ok(fkAt >= 0 && colAt >= 0 && fkAt < colAt);
  });

  it("drops the child table before the one it references", () => {
    const eventAt = downCode.search(/DROP TABLE IF EXISTS `employee_lifecycle_event`/i);
    const periodAt = downCode.search(/DROP TABLE IF EXISTS `employee_employment_period`/i);
    assert.ok(eventAt < periodAt, "events reference periods");
  });

  it("never touches new_employee on the way out either", () => {
    assert.ok(!/new_employee/i.test(downCode));
  });
});
