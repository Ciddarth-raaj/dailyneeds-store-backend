/**
 *   node --test utils/stock_audit_migration.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const dir = path.join(__dirname, "..", "migrations", "mysql", "migrations");
const NAME = "20270108120000-stock-audit-foundation";
const strip = (s) => s.replace(/^\s*--.*$/gm, "");
const up = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-up.sql`), "utf8"));
const down = strip(fs.readFileSync(path.join(dir, "sqls", `${NAME}-down.sql`), "utf8"));
const TABLES = ["sa_rp_session", "sa_rp_line", "sa_rp_adjustment", "sa_sync_state", "sa_sync_run", "sa_sync_issue", "sa_cycle",
  "sa_verification", "sa_incentive_article", "sa_rule_set", "sa_employee_incentive", "sa_management_kpi", "sa_variance_closure", "sa_approval"];

describe(`migration ${NAME}`, () => {
  it("is unique and its runner reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    assert.deepEqual(all.filter((f) => f.startsWith(NAME.slice(0, 14))), [`${NAME}.js`]);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });
  it("creates the 14 stock audit tables, only new ones, and down drops each", () => {
    const created = [...up.matchAll(/CREATE TABLE IF NOT EXISTS `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual(created.sort(), [...TABLES].sort());
    for (const t of TABLES) assert.match(down, new RegExp("DROP TABLE IF EXISTS `" + t + "`"));
  });
  it("changes no existing table and touches no payroll data", () => {
    const code = (s) => s.replace(/COMMENT '[^']*'/g, "").replace(/ON UPDATE CURRENT_TIMESTAMP/g, "");
    assert.doesNotMatch(code(up), /\b(ALTER|UPDATE|DELETE|DROP|TRUNCATE)\b/i);
    assert.doesNotMatch(code(up) + code(down), /payrun|payroll|new_employee|wh_rp_staff_map|outlets/i);
  });
  it("guards one credit per cycle, store and article, and one credit per session", () => {
    assert.match(up, /CREATE TABLE IF NOT EXISTS `sa_incentive_article`[\s\S]*?PRIMARY KEY \(`cycle_id`, `outlet_id`, `article_id`\)[\s\S]*?UNIQUE KEY `uq_sa_incentive_article_session` \(`session_slug`\)/);
  });
  it("keys the mirror tables by RetailPilot's own slugs (idempotent upserts)", () => {
    for (const t of ["sa_rp_session", "sa_rp_line"]) assert.match(up, new RegExp("CREATE TABLE IF NOT EXISTS `" + t + "`[\\s\\S]*?PRIMARY KEY \\(`rp_slug`\\)"));
    assert.match(up, /CREATE TABLE IF NOT EXISTS `sa_rp_adjustment`[\s\S]*?PRIMARY KEY \(`rp_ledger_slug`\)/);
  });
  it("keeps microseconds on RetailPilot timestamps", () => {
    assert.match(up, /`rp_updated_at`\s+DATETIME\(6\)\s+NOT NULL/);
    assert.match(up, /`watermark_ts`\s+DATETIME\(6\)/);
  });
  it("adds the two permissions idempotently and removes them on down", () => {
    for (const k of ["manage_stock_audit", "approve_stock_audit_incentive"]) {
      assert.match(up, new RegExp(`SELECT '${k}' FROM DUAL\\s+WHERE NOT EXISTS`));
      assert.match(down, new RegExp(k));
    }
  });
});
