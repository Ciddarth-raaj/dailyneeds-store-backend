const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildRepo = require("./user");

/**
 * The SQL contract of repository/user.js (A4): every statement that can
 * change a credential, a status, a flag or a policy excludes system
 * accounts, and no statement can create one or set the flag. Tested by
 * capturing the SQL the repository hands to the driver.
 */
const capture = () => {
  const queries = [];
  const db = {
    query(sql, params, cb) {
      queries.push({ sql: sql.replace(/\s+/g, " "), params });
      cb(null, { affectedRows: 1, insertId: 1 });
    },
  };
  return { db, queries };
};

const GUARD = "`is_system_account` = 0";

describe("repository/user SQL guards (A4)", () => {
  it("29. every mutation that could touch a credential or policy excludes system accounts", async () => {
    const { db, queries } = capture();
    const repo = buildRepo(db);
    await repo.setModernPassword(1, "$scrypt$x", { clearMustChange: true });
    await repo.migrateLegacyPassword(1, "$scrypt$x");
    await repo.unlock(1);
    await repo.setMustChangePassword(1, "r");
    await repo.updateStatus({ status: 0, employee_id: 5 });
    await repo.updateIpPolicy(1, null, "branch");
    for (const q of queries) {
      assert.ok(q.sql.includes(GUARD), `missing system-account guard: ${q.sql}`);
    }
    assert.equal(queries.length, 6);
  });

  it("28. account creation never sets is_system_account and never writes SHA-1", async () => {
    const { db, queries } = capture();
    const repo = buildRepo(db);
    await repo.createLogin("u", "1", 1003, "$scrypt$x", { mustChange: true, flagReason: "x" });
    await repo.createLoginIfNeeded("u", "1", 1003, null, { mustChange: true });
    for (const q of queries) {
      assert.equal(q.sql.includes("is_system_account"), false, q.sql);
      assert.equal(q.sql.includes("SHA1("), false, q.sql);
      assert.ok(q.sql.includes("'scrypt'"), q.sql);
    }
  });

  it("no statement compares a password in SQL any more", async () => {
    const { db, queries } = capture();
    const repo = buildRepo(db);
    await repo.findByUsername("u");
    await repo.getCredentialRow(1);
    for (const q of queries) {
      assert.equal(/SHA1\(/i.test(q.sql), false, q.sql);
      assert.equal(/password\s*=\s*\?/i.test(q.sql), false, q.sql);
    }
  });

  it("findByUsername keeps the LEFT JOIN real: no status predicate on new_employee in SQL", async () => {
    const { db, queries } = capture();
    await buildRepo(db).findByUsername("u");
    const sql = queries[0].sql;
    assert.ok(/LEFT JOIN new_employee/.test(sql));
    assert.equal(/WHERE[^;]*ne\.status/.test(sql), false, "employee status must be judged in the usecase, not the join");
  });

  it("rotation-due detection is scoped to system accounts", async () => {
    const { db, queries } = capture();
    await require("./auth_log")(db).findSystemAccountsDueRotation(90);
    assert.ok(queries[0].sql.includes("`is_system_account` = 1"));
  });
});
