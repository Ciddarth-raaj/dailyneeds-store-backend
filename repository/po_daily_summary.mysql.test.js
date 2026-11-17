/**
 *   PO_TEST_MYSQL=mysql://user:pass@localhost/scratch_db node --test repository/po_daily_summary.mysql.test.js
 *
 * SKIPPED unless PO_TEST_MYSQL names a SCRATCH database (tables are dropped).
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.PO_TEST_MYSQL;

describe("po_daily_summary repository", { skip: !URL && "PO_TEST_MYSQL not set" }, () => {
  let pool;
  let repo;
  const q = (sql, p = []) => new Promise((res, rej) => pool.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

  before(async () => {
    pool = require("mysql").createPool(`${URL}?multipleStatements=true&dateStrings=true`);
    await q(`DROP TABLE IF EXISTS po_daily_summary_sends; DROP TABLE IF EXISTS new_employee; DROP TABLE IF EXISTS permissions;
             DROP TABLE IF EXISTS all_permissions; DROP TABLE IF EXISTS employee_telegram_identity; DROP TABLE IF EXISTS \`user\``);
    await q(`CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80), designation_id INT, resignation_date DATE NULL);
             CREATE TABLE permissions (designation_id INT, permission_key VARCHAR(100), is_active INT);
             CREATE TABLE all_permissions (permission_key VARCHAR(100));
             CREATE TABLE employee_telegram_identity (employee_id INT, private_chat_id VARCHAR(64), disconnected_at DATETIME NULL);
             CREATE TABLE \`user\` (user_id INT PRIMARY KEY, employee_id INT NULL, user_type INT, status INT,
                                      is_system_account TINYINT NULL, is_service_account TINYINT NULL)`);
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261216150000-po-daily-summary-up.sql"), "utf8"));
    await q(`INSERT INTO new_employee VALUES (1,'Vinoth',10,NULL),(2,'Ravi',10,NULL),(3,'Left',10,'2026-01-01'),(4,'Other',20,NULL);
             INSERT INTO permissions VALUES (10,'receive_po_daily_summary',1),(20,'receive_po_daily_summary',0);
             INSERT INTO employee_telegram_identity VALUES (1,'111',NULL),(2,'old','2026-01-01'),(5,'555',NULL);
             INSERT INTO new_employee VALUES (5,'Admin',30,NULL),(6,'Old admin',30,NULL),(7,'Service',30,NULL),(8,'Admin left',30,'2026-01-01');
             INSERT INTO \`user\` VALUES (100,5,2,1,0,0),(101,6,2,0,0,0),(102,7,2,1,0,1),(103,NULL,2,1,0,0),(104,4,1,1,0,0),(105,8,2,1,0,0),(106,1,2,1,0,0)`);
    repo = require("./po_daily_summary")(pool);
  });
  after(() => pool && pool.end());

  it("recipients: active right, not resigned, with their active chat", async () => {
    const r = await repo.recipients("2026-11-16");
    // 1 and 2 by designation; 5 as an active administrator. Not 6 (login
    // off), 7 (service account), 8 (resigned), 4 (not an admin, no right).
    // 1 is both and is listed once.
    assert.deepEqual(r.map((x) => [x.employee_id, x.private_chat_id]), [[1, "111"], [2, null], [5, "555"]]);
    assert.equal(await repo.chatOf(1), "111");
    assert.equal(await repo.chatOf(2), null);
  });

  it("records one row per person per day; SENT replaces FAILED", async () => {
    await repo.record({ day: "2026-11-16", employee_id: 1, status: "FAILED", reason: "x", chat_id: "111" });
    assert.equal((await repo.sentOn("2026-11-16")).size, 0);
    await repo.record({ day: "2026-11-16", employee_id: 1, status: "SENT", chat_id: "111" });
    assert.deepEqual([...(await repo.sentOn("2026-11-16"))], [1]);
    const rows = await q("SELECT COUNT(*) AS n FROM po_daily_summary_sends");
    assert.equal(rows[0].n, 1);
  });
});
