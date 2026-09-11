/**
 * The DigiSME import migration: the smallest safe change to biomax_punch,
 * two staging tables, one key, and a down that destroys no punch.
 *
 *   node --test migrations/digisme_attendance_import.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../constants/hr_permissions");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260913120000-digisme-attendance-import";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const strip = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) => strip(sql).split(";").map((s) => s.trim().replace(/\s+/g, " ")).filter(Boolean);

describe("up", () => {
  const raw = read(`${NAME}-up.sql`);
  const code = strip(raw);
  const stmts = statements(raw);

  it("exists with its js wrapper and down file", () => {
    assert.ok(fs.existsSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`)));
    assert.ok(fs.readFileSync(path.join(__dirname, "mysql/migrations", `${NAME}.js`), "utf8").includes(`${NAME}-up.sql`));
    assert.ok(fs.existsSync(path.join(dir, `${NAME}-down.sql`)));
  });

  it("makes dev_id and raw_json nullable with MODIFY that keeps type and values, guarded on IS_NULLABLE", () => {
    assert.match(code, /MODIFY COLUMN `dev_id` VARCHAR\(32\) NULL/);
    assert.match(code, /MODIFY COLUMN `raw_json` TEXT NULL/);
    assert.equal((code.match(/IS_NULLABLE/g) || []).length, 2);
    assert.ok(!/DROP COLUMN|CHANGE COLUMN|DROP TABLE|TRUNCATE|DELETE FROM `biomax_punch`|UPDATE `biomax_punch`/.test(code));
  });

  it("appends DIGISME_IMPORT to ingest_source keeping LIVE and HISTORICAL_PULL in place, guarded", () => {
    assert.match(code, /MODIFY COLUMN `ingest_source` ENUM\(''LIVE'',''HISTORICAL_PULL'',''DIGISME_IMPORT''\) NOT NULL DEFAULT ''LIVE''/);
    assert.match(code, /NOT LIKE '%DIGISME_IMPORT%'/);
  });

  it("adds a STORED generated dedup key that is NULL for device rows, with a UNIQUE index; the device key is untouched", () => {
    assert.match(code, /`import_dedup_key` VARCHAR\(96\) GENERATED ALWAYS AS \(CASE WHEN `dev_id` IS NULL THEN CONCAT\(`ingest_source`, ''\|'', `user_id`, ''\|'', `io_time_raw`\) ELSE NULL END\) STORED/);
    assert.match(code, /ADD UNIQUE KEY `uq_biomax_punch_import_dedup` \(`import_dedup_key`\)/);
    assert.ok(!/uq_biomax_punch_retransmit/.test(code), "the (dev_id, user_id, io_time_raw) key is not touched");
    assert.match(code, /ADD COLUMN `import_batch_id` BIGINT UNSIGNED NULL/);
  });

  it("every ALTER is on biomax_punch, guarded through information_schema + PREPARE", () => {
    const alters = code.match(/ALTER TABLE `?\w+`?/g) || [];
    assert.equal(alters.length, 5);
    for (const a of alters) assert.match(a, /biomax_punch/);
    assert.equal((code.match(/information_schema\.COLUMNS/g) || []).length, 5);
    assert.equal((code.match(/PREPARE s FROM @sql/g) || []).length, 5);
  });

  it("creates the batch and item staging tables with the audit and provenance columns", () => {
    const creates = stmts.filter((s) => /^CREATE TABLE IF NOT EXISTS/.test(s));
    assert.equal(creates.length, 2);
    const batch = creates.find((s) => s.includes("`biomax_attendance_import_batch`"));
    for (const c of ["source_type", "original_filename", "file_sha256", "sheet_name", "uploaded_by", "created_at", "previewed_at", "committed_at", "status", "excel_row_count", "employee_code_count", "candidate_count", "valid_count", "bad_count", "unmatched_count", "reimport_duplicate_count", "cross_source_collision_count", "imported_count", "date_from", "date_to"]) {
      assert.ok(batch.includes(`\`${c}\``), c);
    }
    assert.match(batch, /`status` ENUM\('PREVIEWED','COMMITTING','COMMITTED','COMMITTED_WITH_ERRORS','FAILED'\)/);
    const item = creates.find((s) => s.includes("`biomax_attendance_import_item`"));
    for (const c of ["excel_row", "column_name", "raw_employee_code", "raw_clock_date", "raw_clock_time", "io_time_raw", "employee_id", "classification", "message", "biomax_punch_id", "collided_punch_id"]) {
      assert.ok(item.includes(`\`${c}\``), c);
    }
    assert.match(item, /`classification` ENUM\('VALID','UNMATCHED_EMPLOYEE','BAD_ROW','REIMPORT_DUPLICATE','CROSS_SOURCE_COLLISION'\)/);
    assert.match(item, /`outcome` ENUM\('IMPORTED','IMPORTED_UNMATCHED','IMPORTED_WITH_COLLISION','SKIPPED_REIMPORT_DUPLICATE','SKIPPED_BAD_ROW','FAILED'\) NULL/);
    assert.match(item, /FOREIGN KEY \(`import_batch_id`\) REFERENCES `biomax_attendance_import_batch`/);
  });

  it("declares manage_attendance_import, guarded, granted to nobody; writes nothing else", () => {
    assert.equal(P.MANAGE_ATTENDANCE_IMPORT, "manage_attendance_import");
    const writes = stmts.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s));
    assert.equal(writes.length, 1);
    assert.match(writes[0], /^INSERT INTO `all_permissions`.*manage_attendance_import.*WHERE NOT EXISTS/);
  });

  it("calculates nothing", () => {
    assert.ok(!/\b(in_out|direction|hours|late|overtime|payroll|salary)\b/i.test(code));
  });
});

describe("down", () => {
  const down = strip(read(`${NAME}-down.sql`));
  const stmts = statements(read(`${NAME}-down.sql`));

  it("drops only the two staging tables and the two added columns, and never a punch", () => {
    const drops = stmts.filter((s) => /^DROP TABLE/.test(s)).map((s) => s.match(/`(\w+)`/)[1]);
    assert.deepEqual(drops, ["biomax_attendance_import_item", "biomax_attendance_import_batch"]);
    assert.match(down, /DROP COLUMN `import_dedup_key`/);
    assert.match(down, /DROP COLUMN `import_batch_id`/);
    assert.ok(!/DELETE FROM `biomax_punch`|TRUNCATE|DROP TABLE IF EXISTS `biomax_punch`/.test(down));
    assert.ok(!/NOT NULL/.test(down), "does not try to re-impose NOT NULL on dev_id / raw_json");
  });

  it("removes exactly the key up declared", () => {
    assert.ok(stmts.some((s) => /^DELETE FROM `all_permissions` WHERE `permission_key` = 'manage_attendance_import'/.test(s)));
    assert.ok(stmts.some((s) => /^DELETE FROM `permissions` WHERE `permission_key` = 'manage_attendance_import'/.test(s)));
  });
});
