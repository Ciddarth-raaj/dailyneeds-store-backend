/**
 * THE VERIFICATION ROW ITSELF - the SQL, the duplicate, and the instant.
 *
 *   node --test repository/grn_verifications.test.js
 *
 * The route tests above this layer run on a fake repository, so they cannot
 * see the three things that actually decide whether the audit record is
 * trustworthy. Those live here, against a fake mysql driver with the same
 * callback shape as the real pool:
 *
 *   THE INSERT IS PLAIN.   Not `INSERT IGNORE`. INSERT IGNORE turns a bad
 *                          column, a truncation or a NOT NULL violation into
 *                          a warning with affectedRows 0 - which this code
 *                          would then have reported as a successful
 *                          duplicate approval. Only ER_DUP_ENTRY (errno
 *                          1062), the unique key doing its job, counts as a
 *                          duplicate; everything else is rejected.
 *   THE TIME IS AN INSTANT. Read back with UNIX_TIMESTAMP and handed out as
 *                          ISO-8601 UTC. drivers/mysql.js sets no session
 *                          time zone, so a DATE_FORMAT string would be a
 *                          wall clock in an unstated zone and the same row
 *                          could mean two different moments on two servers.
 *   NOBODY IS NOT A VERIFIER. A missing employee id never reaches the NOT
 *                          NULL column.
 *
 * And one file check: the migration that creates the table declares
 * `verified_by INT NOT NULL`, which is the schema the code above assumes.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildRepo = require("./stock_received");

const MIGRATION_SQL = path.join(
  __dirname,
  "..",
  "migrations",
  "mysql",
  "migrations",
  "sqls",
  "20261019120000-grn-verifications-up.sql"
);

/** A mysql pool stand-in: records queries, answers with what it was given. */
function fakeDb(handlers = {}) {
  const queries = [];
  return {
    queries,
    query(sql, params, cb) {
      queries.push({ sql, params });
      const handler = Object.entries(handlers).find(([key]) =>
        sql.includes(key)
      );
      if (!handler) return cb(null, []);
      const answer = handler[1];
      const out = typeof answer === "function" ? answer(params) : answer;
      if (out instanceof Error) return cb(out);
      return cb(null, out);
    },
  };
}

const dupError = () => {
  const err = new Error(
    "ER_DUP_ENTRY: Duplicate entry 'GRN-1' for key 'uq_grn_verifications_refno'"
  );
  err.code = "ER_DUP_ENTRY";
  err.errno = 1062;
  return err;
};

describe("insertGrnVerification", () => {
  it("issues a PLAIN insert, never INSERT IGNORE and never ON DUPLICATE KEY UPDATE", async () => {
    const db = fakeDb({ "INSERT INTO": { affectedRows: 1, insertId: 3 } });
    const repo = buildRepo(db, null);

    const out = await repo.insertGrnVerification("GRN-1", 42);

    assert.deepEqual(out, { created: true });
    const insert = db.queries.find((q) => q.sql.includes("INSERT"));
    assert.ok(insert, "an insert was issued");
    assert.equal(insert.sql.includes("INSERT IGNORE"), false);
    assert.equal(insert.sql.includes("ON DUPLICATE KEY"), false);
    // refno and the employee id, and nothing else: the column default writes
    // the time.
    assert.deepEqual(insert.params, ["GRN-1", 42]);
  });

  it("treats ER_DUP_ENTRY as already verified rather than an error", async () => {
    const db = fakeDb({ "INSERT INTO": dupError() });
    const repo = buildRepo(db, null);

    assert.deepEqual(await repo.insertGrnVerification("GRN-1", 42), {
      created: false,
    });
  });

  it("recognises the duplicate by errno 1062 even without the code", async () => {
    const bare = new Error("Duplicate entry");
    bare.errno = 1062;
    const repo = buildRepo(fakeDb({ "INSERT INTO": bare }), null);

    assert.deepEqual(await repo.insertGrnVerification("GRN-1", 42), {
      created: false,
    });
  });

  it("PROPAGATES every other database error", async () => {
    const cases = [
      ["ER_NO_SUCH_TABLE", 1146],
      ["ER_BAD_NULL_ERROR", 1048],
      ["ER_DATA_TOO_LONG", 1406],
      ["PROTOCOL_CONNECTION_LOST", undefined],
    ];

    for (const [code, errno] of cases) {
      const err = new Error(`${code}: something is genuinely wrong`);
      err.code = code;
      if (errno !== undefined) err.errno = errno;
      const repo = buildRepo(fakeDb({ "INSERT INTO": err }), null);

      await assert.rejects(
        () => repo.insertGrnVerification("GRN-1", 42),
        (thrown) => thrown === err,
        `${code} must travel up, not pass for a duplicate`
      );
    }
  });

  it("refuses to write a verification that names nobody", async () => {
    const db = fakeDb({ "INSERT INTO": { affectedRows: 1 } });
    const repo = buildRepo(db, null);

    await assert.rejects(
      () => repo.insertGrnVerification("GRN-1", null),
      /verified_by is required/
    );
    await assert.rejects(
      () => repo.insertGrnVerification("GRN-1", ""),
      /verified_by is required/
    );
    await assert.rejects(
      () => repo.insertGrnVerification("   ", 42),
      /refno is required/
    );
    assert.equal(db.queries.length, 0, "nothing was sent to the database");
  });
});

describe("reading a verification back", () => {
  it("asks for UNIX_TIMESTAMP, not a zoneless DATE_FORMAT", async () => {
    const db = fakeDb({ "SELECT": [] });
    const repo = buildRepo(db, null);

    await repo.listGrnVerificationsByRefnos(["GRN-1"]);

    const select = db.queries[0];
    assert.ok(select.sql.includes("UNIX_TIMESTAMP(v.verified_at)"));
    assert.equal(
      select.sql.includes("DATE_FORMAT(v.verified_at"),
      false,
      "a formatted wall clock would have no zone on it"
    );
  });

  it("hands out the stored instant as ISO-8601 UTC", async () => {
    // 2026-09-17T09:00:00Z, which is 02:30 PM in Asia/Kolkata.
    const db = fakeDb({
      SELECT: [
        {
          mmh_mrc_refno: "GRN-1",
          verified_by: 42,
          verified_by_name: "Asha R",
          verified_at_epoch: 1789635600,
        },
      ],
    });
    const repo = buildRepo(db, null);

    const [row] = await repo.listGrnVerificationsByRefnos(["GRN-1"]);

    assert.deepEqual(row, {
      mmh_mrc_refno: "GRN-1",
      verified_by: 42,
      verified_by_name: "Asha R",
      verified_at: "2026-09-17T09:00:00Z",
    });
  });

  it("does not invent a time when the epoch is missing", async () => {
    const db = fakeDb({
      SELECT: [
        { mmh_mrc_refno: "GRN-1", verified_by: 42, verified_at_epoch: null },
      ],
    });
    const repo = buildRepo(db, null);

    const [row] = await repo.listGrnVerificationsByRefnos(["GRN-1"]);
    assert.equal(row.verified_at, null);
  });

  it("makes no query at all for an empty set of refnos", async () => {
    const db = fakeDb();
    const repo = buildRepo(db, null);

    assert.deepEqual(await repo.listGrnVerificationsByRefnos([]), []);
    assert.deepEqual(await repo.listGrnVerificationsByRefnos(null), []);
    assert.equal(db.queries.length, 0);
  });
});

describe("the grn_verifications schema", () => {
  const sql = fs.readFileSync(MIGRATION_SQL, "utf8");

  it("declares verified_by NOT NULL", () => {
    assert.match(sql, /verified_by\s+INT\s+NOT\s+NULL/i);
    assert.doesNotMatch(sql, /verified_by\s+INT\s+NULL/i);
  });

  it("keeps the unique key that makes the duplicate detectable", () => {
    assert.match(sql, /UNIQUE KEY\s+uq_grn_verifications_refno\s*\(mmh_mrc_refno\)/i);
  });

  it("lets the database write the timestamp", () => {
    assert.match(sql, /verified_at\s+TIMESTAMP\s+NOT NULL\s+DEFAULT CURRENT_TIMESTAMP/i);
  });
});
