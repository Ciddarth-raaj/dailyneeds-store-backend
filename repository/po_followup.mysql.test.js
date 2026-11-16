/**
 * PO follow-ups against a real MySQL.
 *
 *   PO_TEST_MYSQL=mysql://user:pass@localhost/scratch_db node --test repository/po_followup.mysql.test.js
 *
 * SKIPPED unless PO_TEST_MYSQL names a SCRATCH database: the suite drops and
 * recreates po_followups and new_employee there.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.PO_TEST_MYSQL;

describe("po_followup repository", { skip: !URL && "PO_TEST_MYSQL not set" }, () => {
  let pool;
  let repo;
  const q = (sql, p = []) => new Promise((res, rej) => pool.query(sql, p, (e, r) => (e ? rej(e) : res(r))));

  before(async () => {
    pool = require("mysql").createPool(`${URL}?multipleStatements=true&dateStrings=true`);
    await q("DROP TABLE IF EXISTS po_followups; DROP TABLE IF EXISTS new_employee; DROP TABLE IF EXISTS all_permissions; DROP TABLE IF EXISTS permissions");
    await q("CREATE TABLE new_employee (employee_id INT PRIMARY KEY, employee_name VARCHAR(80)); CREATE TABLE all_permissions (permission_key VARCHAR(100)); CREATE TABLE permissions (designation_id INT, permission_key VARCHAR(100))");
    await q("INSERT INTO new_employee VALUES (7, 'Prashanth')");
    await q(fs.readFileSync(path.join(__dirname, "../migrations/mysql/migrations/sqls/20261216140000-po-followup-up.sql"), "utf8"));
    repo = require("./po_followup")(pool);
  });
  after(() => pool && pool.end());

  it("adds, reads back, and finds the latest per PO with a count", async () => {
    const base = { po_ref: "711", supplier_id: "9", supplier_name: "Aadhi", store_id: "wh", created_by: 7 };
    const a = await repo.add({ ...base, po_slug: "p1", channel: "CALL", remark: "No answer" });
    assert.equal(a.created_by_name, "Prashanth");
    assert.equal(a.promised_delivery_date, null);
    await repo.add({ ...base, po_slug: "p1", channel: "WHATSAPP", remark: "Truck Friday", promised_delivery_date: "2026-11-21", next_follow_up_date: "2026-11-19" });
    await repo.add({ ...base, po_slug: "p0", channel: "VISIT", remark: "Old PO" });

    const latest = await repo.latestFor(["p1", "p0", "none"]);
    const p1 = latest.find((r) => r.po_slug === "p1");
    assert.equal(latest.length, 2);
    assert.equal(p1.remark, "Truck Friday");
    assert.equal(Number(p1.remark_count), 2);
    assert.equal(p1.promised_delivery_date, "2026-11-21");
    assert.equal(p1.next_follow_up_date, "2026-11-19");

    assert.deepEqual((await repo.forPo("p1")).map((r) => r.remark), ["Truck Friday", "No answer"]);
    assert.deepEqual((await repo.forSupplier("9", "p1")).map((r) => r.remark), ["Old PO"]);
    assert.deepEqual(await repo.latestFor([]), []);
  });
});
