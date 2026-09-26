/**
 * appendItems releases its connection exactly once.
 *
 *   node --test repository/stock_holding_report.release.test.js
 *
 * The post-commit item count runs on the POOL after the connection went
 * back. When that count failed, the catch rolled back and released the
 * connection a second time - by then possibly another request's connection
 * (and, under the DB admission layer, would have looked like a second
 * permit). docs/api-db-backpressure.md.
 */
const { it } = require("node:test");
const assert = require("node:assert/strict");
const repoFactory = require("./stock_holding_report");

it("a failure AFTER commit (the item count) does not roll back or release the connection a second time", async () => {
  const conn = {
    released: 0,
    rolledBack: 0,
    query(sql, params, cb) {
      if (typeof params === "function") cb = params;
      setImmediate(() => cb(null, { affectedRows: 1 }));
    },
    beginTransaction: (cb) => cb(null),
    commit: (cb) => cb(null),
    rollback(cb) {
      conn.rolledBack += 1;
      cb();
    },
    release() {
      conn.released += 1;
    },
  };
  const pool = {
    getConnection: (cb) => cb(null, conn),
    query(sql, params, cb) {
      if (typeof params === "function") cb = params;
      // the count after commit: the database drops out
      setImmediate(() => cb(Object.assign(new Error("gone"), { code: "PROTOCOL_CONNECTION_LOST" })));
    },
  };
  const repo = repoFactory(pool);
  await assert.rejects(repo.appendItems(7, [{ item_code: "A", qty: 1 }]), /gone/);
  assert.equal(conn.released, 1, "released once");
  assert.equal(conn.rolledBack, 0, "a committed transaction is not 'rolled back' after the fact");
});

it("a failure BEFORE commit still rolls back and releases once", async () => {
  const conn = {
    released: 0,
    rolledBack: 0,
    query(sql, params, cb) {
      if (typeof params === "function") cb = params;
      setImmediate(() => cb(Object.assign(new Error("insert failed"), { code: "ER_DATA_TOO_LONG" })));
    },
    beginTransaction: (cb) => cb(null),
    commit: (cb) => cb(null),
    rollback(cb) {
      conn.rolledBack += 1;
      cb();
    },
    release() {
      conn.released += 1;
    },
  };
  const repo = repoFactory({ getConnection: (cb) => cb(null, conn), query: () => {} });
  await assert.rejects(repo.appendItems(7, [{ item_code: "A", qty: 1 }]), /insert failed/);
  assert.equal(conn.released, 1);
  assert.equal(conn.rolledBack, 1);
});
