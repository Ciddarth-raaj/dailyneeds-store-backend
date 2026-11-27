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
  "sa_verification", "sa_eligibility", "sa_incentive_article", "sa_rule_set", "sa_employee_incentive", "sa_management_incentive",
  "sa_approval", "sa_payroll_posting"];
const ALL_PERMS = require("../constants/stock_audit_permissions");
const LATER = ["manage_stock_audit_roles", "approve_stock_audit_exclusions"]; // added by 20270108120200
const PERMS = Object.values(ALL_PERMS).filter((k) => !LATER.includes(k));

describe(`migration ${NAME}`, () => {
  it("is unique and its runner reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
    assert.deepEqual(all.filter((f) => f.startsWith(NAME.slice(0, 14))), [`${NAME}.js`]);
    const js = fs.readFileSync(path.join(dir, `${NAME}.js`), "utf8");
    assert.ok(js.includes(`${NAME}-up.sql`) && js.includes(`${NAME}-down.sql`));
  });
  it("creates the 15 stock audit tables, only new ones, and down drops each", () => {
    const created = [...up.matchAll(/CREATE TABLE IF NOT EXISTS `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual(created.sort(), [...TABLES].sort());
    for (const t of TABLES) assert.match(down, new RegExp("DROP TABLE IF EXISTS `" + t + "`"));
  });
  it("changes no existing table and touches no payroll data", () => {
    const code = (s) => s.replace(/COMMENT '[^']*'/g, "").replace(/ON UPDATE CURRENT_TIMESTAMP/g, "");
    assert.doesNotMatch(code(up), /\b(ALTER|UPDATE|DELETE|DROP|TRUNCATE)\b/i);
    assert.doesNotMatch(code(up) + code(down), /`(payrun_[a-z_]+|new_employee|wh_rp_staff_map|outlets|permissions)`\s*\(/i);
    assert.doesNotMatch(code(up) + code(down), /(INTO|UPDATE|FROM|TABLE)\s+`(payrun_[a-z_]+|new_employee|wh_rp_staff_map|outlets)`/i);
  });
  it("guards one award per cycle, store and article, and one award per session", () => {
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
  it("guards the chain-level management row without a NULL in its unique key", () => {
    assert.match(up, /`outlet_id`\s+INT\s+NOT NULL DEFAULT 0,[\s\S]*?UNIQUE KEY `uq_sa_management_incentive` \(`period_code`, `outlet_id`, `role`, `employee_id`\)/);
  });
  it("one payroll posting per incentive, one approval per level per round", () => {
    assert.match(up, /UNIQUE KEY `uq_sa_payroll_posting_source` \(`source_type`, `source_id`\)/);
    assert.match(up, /UNIQUE KEY `uq_sa_approval_level` \(`entity`, `entity_id`, `level`, `round`\)/);
  });
  it("adds the 20 granular permissions idempotently (fit VARCHAR(45)) and removes them on down; no broad keys", () => {
    assert.equal(PERMS.length, 20);
    assert.doesNotMatch(up, /variance_closure|review_stock_audit_variance/);
    assert.doesNotMatch(up, /'manage_stock_audit'|'approve_stock_audit_incentive'/);
    for (const k of PERMS) {
      assert.ok(k.length <= 45, k);
      assert.match(up, new RegExp(`SELECT '${k}' FROM DUAL\\s+WHERE NOT EXISTS`));
      assert.match(down, new RegExp(k));
    }
  });
});

describe("migration 20270108120100-stock-audit-allotment-sapl", () => {
  const N2 = "20270108120100-stock-audit-allotment-sapl";
  const up2 = strip(fs.readFileSync(path.join(dir, "sqls", `${N2}-up.sql`), "utf8"));
  const down2 = strip(fs.readFileSync(path.join(dir, "sqls", `${N2}-down.sql`), "utf8"));
  const T2 = ["sa_rp_user", "sa_allotment_batch", "sa_allotment_file", "sa_allotment_line", "sa_allotment", "sa_sapl_season", "sa_sapl_standing", "sa_sapl_prize_share"];
  const code = (s) => s.replace(/COMMENT '[^']*'/g, "").replace(/ON UPDATE CURRENT_TIMESTAMP/g, "");
  it("runs after the foundation and reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
    assert.ok(all.indexOf(`${N2}.js`) > all.indexOf(`${NAME}.js`));
    const js = fs.readFileSync(path.join(dir, `${N2}.js`), "utf8");
    assert.ok(js.includes(`${N2}-up.sql`) && js.includes(`${N2}-down.sql`));
  });
  it("creates the 8 new tables only; down drops each", () => {
    const created = [...up2.matchAll(/CREATE TABLE IF NOT EXISTS `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual(created.sort(), [...T2].sort());
    for (const t of T2) assert.match(down2, new RegExp("DROP TABLE IF EXISTS `" + t + "`"));
    assert.doesNotMatch(code(up2), /\b(ALTER|UPDATE|DELETE|DROP|TRUNCATE|INSERT)\b/i);
  });
  it("guards one auditor per auditable article per store cycle, and one revision number per auditor", () => {
    assert.match(up2, /UNIQUE KEY `uq_sa_allotment_auditable` \(`cycle_id`, `auditable_article_id`\)/);
    assert.match(up2, /IF\(`effective` = 'Y', `article_id`, NULL\)/);
    assert.match(up2, /UNIQUE KEY `uq_sa_allotment_file_revision` \(`cycle_id`, `rp_user_id`, `revision`\)/);
  });
  it("one season per audit period; prize shares stay drafts outside payroll", () => {
    assert.match(up2, /UNIQUE KEY `uq_sa_sapl_season_period` \(`period_code`\)/);
    assert.doesNotMatch(code(up2), /payrun|payroll_posting/i);
  });
});

describe("migration 20270108120200-stock-audit-participation-roles", () => {
  const N3 = "20270108120200-stock-audit-participation-roles";
  const up3 = strip(fs.readFileSync(path.join(dir, "sqls", `${N3}-up.sql`), "utf8"));
  const down3 = strip(fs.readFileSync(path.join(dir, "sqls", `${N3}-down.sql`), "utf8"));
  const T3 = ["sa_setting", "sa_setting_history", "sa_cycle_snapshot", "sa_cycle_employee", "sa_employee_exclusion", "sa_role_assignment"];
  const code = (x) => x.replace(/COMMENT '[^']*'/g, "").replace(/ON UPDATE CURRENT_TIMESTAMP/g, "");
  it("runs last and reads its own files", () => {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
    assert.equal(all[all.length - 1], `${N3}.js`);
    const js = fs.readFileSync(path.join(dir, `${N3}.js`), "utf8");
    assert.ok(js.includes(`${N3}-up.sql`) && js.includes(`${N3}-down.sql`));
  });
  it("creates the 6 new tables only; down drops each", () => {
    const created = [...up3.matchAll(/CREATE TABLE IF NOT EXISTS `([a-z_]+)`/g)].map((m) => m[1]);
    assert.deepEqual(created.sort(), [...T3].sort());
    for (const t of T3) assert.match(down3, new RegExp("DROP TABLE IF EXISTS `" + t + "`"));
    assert.doesNotMatch(code(up3), /\b(ALTER|UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
  it("adds the two new keys idempotently and removes them on down", () => {
    for (const k of LATER) {
      assert.ok(Object.values(ALL_PERMS).includes(k));
      assert.ok(k.length <= 45);
      assert.match(up3, new RegExp(`WHERE NOT EXISTS \\(SELECT 1 FROM \`all_permissions\` WHERE \`permission_key\` = '${k}'\\)`));
      assert.ok(down3.includes(`'${k}'`));
    }
  });
  it("database guards: one open/approved exclusion per employee per cycle; one holder per role slot; one management role per person per period", () => {
    assert.match(up3, /UNIQUE KEY `uq_sa_employee_exclusion_active` \(`cycle_id`, `active_employee_id`\)/);
    assert.match(up3, /UNIQUE KEY `uq_sa_role_assignment_slot` \(`period_code`, `active_slot`\)/);
    assert.match(up3, /UNIQUE KEY `uq_sa_role_assignment_person` \(`period_code`, `active_person`\)/);
    assert.match(up3, /`reason`\s+VARCHAR\(500\) NOT NULL/);
  });
});
