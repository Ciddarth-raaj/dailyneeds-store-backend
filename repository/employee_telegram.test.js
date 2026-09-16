/**
 * THE ATOMIC FINALISATION, at the repository level.
 *
 *   node --test repository/employee_telegram.test.js
 *
 * The usecase tests prove the OUTCOMES over an in-memory store. This proves
 * the TRANSACTION MECHANICS the real driver will run: what is claimed first,
 * what is locked, what is rolled back, and that the connection always goes
 * back to the pool. A fake connection records every statement in order, so
 * the assertions are about the SQL actually issued rather than about a
 * paraphrase of it.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRepo = require("./employee_telegram");

/**
 * A pooled connection that answers each statement from a script.
 *
 * `answers` is a list of [matcher, result-or-error]. `result` may be an Error,
 * which is thrown as the driver would.
 */
function fakePool({ answers = [], failConnect = null } = {}) {
  const log = [];
  const state = { committed: false, rolledBack: false, released: false, began: false };

  const connection = {
    query(sql, params, cb) {
      const flat = String(sql).replace(/\s+/g, " ").trim();
      log.push({ sql: flat, params });
      const hit = answers.find(([matcher]) =>
        typeof matcher === "string" ? flat.includes(matcher) : matcher.test(flat)
      );
      const result = hit ? hit[1] : { affectedRows: 1 };
      if (result instanceof Error) return cb(result);
      return cb(null, result);
    },
    beginTransaction(cb) {
      state.began = true;
      log.push({ sql: "BEGIN" });
      cb(null);
    },
    commit(cb) {
      state.committed = true;
      log.push({ sql: "COMMIT" });
      cb(null);
    },
    rollback(cb) {
      state.rolledBack = true;
      log.push({ sql: "ROLLBACK" });
      cb();
    },
    release() {
      state.released = true;
      log.push({ sql: "RELEASE" });
    },
  };

  return {
    state,
    log,
    getConnection(cb) {
      if (failConnect) return cb(failConnect);
      cb(null, connection);
    },
    // The non-transactional path (`run`) queries the pool directly.
    query(sql, params, cb) {
      return connection.query(sql, params, cb);
    },
  };
}

const ARGS = {
  tokenHash: "a".repeat(64),
  employeeId: 7,
  telegramUserId: 4242,
  chatId: 555,
  username: "asha_t",
  verifiedMobile: "9876543210",
  verifiedOutcome: "VERIFIED",
};

const sqlOf = (pool) => pool.log.map((l) => l.sql);

describe("finalizeVerification", () => {
  it("CLAIMS THE PENDING ROW FIRST, inside the transaction", async () => {
    const pool = fakePool();
    await buildRepo(pool).finalizeVerification(ARGS);

    const sql = sqlOf(pool);
    assert.equal(sql[0], "BEGIN", "nothing happens outside the transaction");
    assert.match(sql[1], /UPDATE employee_telegram_link_tokens/);
    assert.match(sql[1], /pending_outcome IS NULL/, "the claim is part of the WHERE");
  });

  it("stops when the claim finds nothing - somebody else already finished it", async () => {
    const pool = fakePool({
      answers: [["UPDATE employee_telegram_link_tokens", { affectedRows: 0 }]],
    });

    const result = await buildRepo(pool).finalizeVerification(ARGS);

    assert.deepEqual(result, { outcome: "ALREADY_FINALISED", identityCreated: false });
    assert.ok(pool.state.rolledBack, "and it rolls back rather than leaving a transaction open");
    assert.ok(!sqlOf(pool).some((s) => /INSERT INTO employee_telegram_identity/.test(s)));
  });

  it("LOCKS the Telegram account's row while it decides", async () => {
    const pool = fakePool();
    await buildRepo(pool).finalizeVerification(ARGS);

    const select = sqlOf(pool).find((s) => /SELECT .* FROM employee_telegram_identity/.test(s));
    assert.ok(select, "it re-reads the identity inside the transaction");
    assert.match(select, /FOR UPDATE/, "a concurrent finalisation waits rather than races");
  });

  it("RETIRES THE OLD IDENTITY AND INSERTS THE NEW ONE IN THAT ORDER, in one transaction", async () => {
    const pool = fakePool();
    const result = await buildRepo(pool).finalizeVerification(ARGS);

    const sql = sqlOf(pool);
    const disconnect = sql.findIndex((s) => /SET disconnected_at = NOW\(\)/.test(s));
    const insert = sql.findIndex((s) => /INSERT INTO employee_telegram_identity/.test(s));
    const commit = sql.indexOf("COMMIT");

    assert.ok(disconnect !== -1 && insert !== -1);
    assert.ok(disconnect < insert, "the replacement is retired before its successor is written");
    assert.ok(insert < commit, "and BOTH are inside the same transaction");
    assert.deepEqual(result, { outcome: "VERIFIED", identityCreated: true });
    assert.ok(pool.state.committed);
  });

  it("writes NOTHING when the account is already this employee's", async () => {
    const pool = fakePool({
      answers: [[/SELECT .* FOR UPDATE/, [{ employee_telegram_id: 1, employee_id: 7 }]]],
    });

    const result = await buildRepo(pool).finalizeVerification(ARGS);

    assert.deepEqual(result, { outcome: "VERIFIED", identityCreated: false });
    assert.ok(!sqlOf(pool).some((s) => /INSERT INTO employee_telegram_identity/.test(s)));
    assert.ok(pool.state.committed, "the claim still stands - the work is done");
  });

  it("ROLLS BACK when the account belongs to another employee", async () => {
    const pool = fakePool({
      answers: [[/SELECT .* FOR UPDATE/, [{ employee_telegram_id: 1, employee_id: 99 }]]],
    });

    const result = await buildRepo(pool).finalizeVerification(ARGS);

    assert.deepEqual(result, { outcome: "DUPLICATE_IDENTITY", identityCreated: false });
    assert.ok(pool.state.rolledBack);
    assert.ok(!pool.state.committed);
    assert.ok(
      !sqlOf(pool).some((s) => /SET disconnected_at = NOW\(\)/.test(s)),
      "and it never touched anybody's existing identity"
    );
  });

  it("A DUPLICATE-KEY INSERT IS A DUPLICATE, and the old identity survives", async () => {
    const duplicate = Object.assign(new Error("ER_DUP_ENTRY: Duplicate entry"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
    });
    const pool = fakePool({ answers: [["INSERT INTO employee_telegram_identity", duplicate]] });

    const result = await buildRepo(pool).finalizeVerification(ARGS);

    assert.deepEqual(result, { outcome: "DUPLICATE_IDENTITY", identityCreated: false });
    assert.ok(pool.state.rolledBack, "the reconnect disconnect goes back with it");
    assert.ok(!pool.state.committed);
  });

  it("recognises a duplicate by errno as well as by code", async () => {
    const duplicate = Object.assign(new Error("Duplicate entry"), { errno: 1062 });
    const pool = fakePool({ answers: [["INSERT INTO employee_telegram_identity", duplicate]] });

    const result = await buildRepo(pool).finalizeVerification(ARGS);
    assert.equal(result.outcome, "DUPLICATE_IDENTITY");
  });

  it("ANY OTHER DATABASE ERROR THROWS - it is not an outcome", async () => {
    // Reporting a lock timeout as "already connected to another employee"
    // would send an employee to HR about a problem that does not exist, and
    // would hide a real fault.
    const failure = Object.assign(new Error("ER_LOCK_WAIT_TIMEOUT"), {
      code: "ER_LOCK_WAIT_TIMEOUT",
      errno: 1205,
    });
    const pool = fakePool({ answers: [["INSERT INTO employee_telegram_identity", failure]] });

    await assert.rejects(
      () => buildRepo(pool).finalizeVerification(ARGS),
      (err) => err.code === "ER_LOCK_WAIT_TIMEOUT"
    );
    assert.ok(pool.state.rolledBack, "the previous identity is restored by the rollback");
    assert.ok(!pool.state.committed);
  });

  it("RELEASES THE CONNECTION on every path", async () => {
    // Success.
    const ok = fakePool();
    await buildRepo(ok).finalizeVerification(ARGS);
    assert.ok(ok.state.released);

    // Business outcome.
    const dup = fakePool({
      answers: [[/SELECT .* FOR UPDATE/, [{ employee_id: 99 }]]],
    });
    await buildRepo(dup).finalizeVerification(ARGS);
    assert.ok(dup.state.released);

    // Failure.
    const bad = fakePool({
      answers: [["INSERT INTO employee_telegram_identity", new Error("boom")]],
    });
    await assert.rejects(() => buildRepo(bad).finalizeVerification(ARGS));
    assert.ok(bad.state.released, "a leaked connection would exhaust the pool");
  });

  it("never puts a token, a hash or a mobile number into a log ref", async () => {
    const pool = fakePool({
      answers: [["INSERT INTO employee_telegram_identity", new Error("boom")]],
    });
    const entries = [];
    const repo = buildRepo(pool);
    // The repository logs through utils/logger; capture by monkeypatching the
    // module the instance already holds a reference to.
    const logger = require("../utils/logger");
    const original = logger.Log;
    logger.Log = (entry) => entries.push(entry);
    try {
      await assert.rejects(() => repo.finalizeVerification(ARGS));
    } finally {
      logger.Log = original;
    }

    const dumped = JSON.stringify(entries);
    for (const secret of [ARGS.tokenHash, ARGS.verifiedMobile, "asha_t"]) {
      assert.ok(!dumped.includes(secret), `${secret} must never be logged`);
    }
    assert.ok(dumped.includes("7") && dumped.includes("4242"), "identifiers are fine");
  });
});

describe("the employee read behind eligibility", () => {
  it("asks for the DATED employment facts, not just status", async () => {
    const pool = fakePool({ answers: [[/SELECT employee_id/, [{ employee_id: 7 }]]] });
    await buildRepo(pool).getEmployeeForVerification(7);

    const sql = sqlOf(pool)[0];
    assert.match(sql, /date_of_joining/, "a future joiner must be excludable");
    assert.match(sql, /resignation_date/, "and a leaver whose status was never changed");
    assert.match(sql, /DATE_FORMAT/, "as YYYY-MM-DD, which the shared rule compares");
  });
});

describe("createLinkToken", () => {
  // (employeeId, tokenHash, expiresAt, issuedByUserId, supersededOutcome) -
  // in that order. Getting it wrong puts the hash where the employee id
  // belongs, which the log-safety test below notices.
  const TOKEN_HASH = "h".repeat(64);
  const ISSUE = [7, TOKEN_HASH, new Date("2027-01-01T00:00:00Z"), 3, "SUPERSEDED"];

  it("LOCKS THE EMPLOYEE, then supersedes, then inserts - all in one transaction", async () => {
    // Two issuers used to interleave between the supersede and the insert and
    // leave two live QR codes. The lock is what makes the pair indivisible.
    const pool = fakePool();
    await buildRepo(pool).createLinkToken(...ISSUE);

    const sql = sqlOf(pool);
    const begin = sql.indexOf("BEGIN");
    const lock = sql.findIndex((s) => /SELECT employee_id FROM new_employee/.test(s));
    const supersede = sql.findIndex((s) => /UPDATE employee_telegram_link_tokens/.test(s));
    const insert = sql.findIndex((s) => /INSERT INTO employee_telegram_link_tokens/.test(s));
    const commit = sql.indexOf("COMMIT");

    assert.ok(lock !== -1, "the employee row is locked");
    assert.match(sql[lock], /FOR UPDATE/);
    assert.ok(begin < lock, "the lock is taken inside the transaction");
    assert.ok(lock < supersede, "and BEFORE anything is superseded");
    assert.ok(supersede < insert, "the old token dies before the new one is written");
    assert.ok(insert < commit, "and both commit together");
  });

  it("LOCKS THE EMPLOYEE, NOT THE TOKEN ROWS", () => {
    // An employee with no outstanding token has no token rows to lock, and
    // that is precisely the case that raced.
    const source = require("fs").readFileSync(__dirname + "/employee_telegram.js", "utf8");
    const fn = source.slice(source.indexOf("async createLinkToken"), source.indexOf("async consumeLinkToken"));
    assert.match(fn, /SELECT employee_id FROM new_employee WHERE employee_id = \? FOR UPDATE/);
    assert.ok(
      !/FROM employee_telegram_link_tokens[\s\S]*?FOR UPDATE/.test(fn),
      "locking the token rows would not serialize an employee who has none"
    );
  });

  it("supersedes the outstanding token AND any pending session it opened", async () => {
    const pool = fakePool();
    await buildRepo(pool).createLinkToken(...ISSUE);

    const supersede = sqlOf(pool).find((s) => /UPDATE employee_telegram_link_tokens/.test(s));
    assert.match(supersede, /consumed_at = COALESCE\(consumed_at, NOW\(\)\)/, "kept, not deleted");
    assert.match(supersede, /pending_expires_at = NULL/, "a half-done session cannot be finished");
    assert.match(supersede, /WHERE employee_id = \?/);
  });

  it("ROLLS BACK and throws when the insert fails - no half-issued state", async () => {
    const pool = fakePool({
      answers: [["INSERT INTO employee_telegram_link_tokens", new Error("ER_LOCK_WAIT_TIMEOUT")]],
    });

    await assert.rejects(() => buildRepo(pool).createLinkToken(...ISSUE));
    assert.ok(pool.state.rolledBack, "the supersede goes back with it");
    assert.ok(!pool.state.committed, "so the employee keeps the QR they already had");
    assert.ok(pool.state.released);
  });

  it("releases the connection on success and on failure", async () => {
    const ok = fakePool();
    await buildRepo(ok).createLinkToken(...ISSUE);
    assert.ok(ok.state.released);

    const bad = fakePool({ answers: [["SELECT employee_id FROM new_employee", new Error("boom")]] });
    await assert.rejects(() => buildRepo(bad).createLinkToken(...ISSUE));
    assert.ok(bad.state.released);
  });

  it("never logs the token hash", async () => {
    const pool = fakePool({
      answers: [["INSERT INTO employee_telegram_link_tokens", new Error("boom")]],
    });
    const logger = require("../utils/logger");
    const entries = [];
    const original = logger.Log;
    logger.Log = (entry) => entries.push(entry);
    try {
      await assert.rejects(() => buildRepo(pool).createLinkToken(...ISSUE));
    } finally {
      logger.Log = original;
    }
    const dumped = JSON.stringify(entries);
    assert.ok(!dumped.includes(TOKEN_HASH), "the hash must never reach a log");
    assert.ok(dumped.includes("7"), "the employee id is fine, and is what identifies the failure");
  });
});

describe("getSummaryForEmployees", () => {
  const IDS = [7, 8, 9];

  it("READS THE WHOLE LIST IN TWO QUERIES, whatever the headcount", async () => {
    const pool = fakePool({ answers: [[/SELECT/, []]] });
    const many = Array.from({ length: 600 }, (_, i) => i + 1);

    await buildRepo(pool).getSummaryForEmployees(many);

    const selects = sqlOf(pool).filter((s) => /^SELECT/.test(s));
    assert.equal(selects.length, 2, "600 employees cost exactly what 2 cost");
  });

  it("asks nothing at all for an empty list", async () => {
    const pool = fakePool();
    const out = await buildRepo(pool).getSummaryForEmployees([]);
    assert.equal(out.size, 0);
    assert.deepEqual(sqlOf(pool), []);
  });

  it("ignores junk ids rather than sending them to MySQL", async () => {
    const pool = fakePool({ answers: [[/SELECT/, []]] });
    const out = await buildRepo(pool).getSummaryForEmployees([7, "8", null, undefined, -1, 0, "x", 9.5]);
    assert.deepEqual([...out.keys()], [7, 8]);
  });

  it("SELECTS NO IDENTIFIER - no user id, chat id, mobile, token or hash", async () => {
    const pool = fakePool({ answers: [[/SELECT/, []]] });
    await buildRepo(pool).getSummaryForEmployees(IDS);

    for (const sql of sqlOf(pool).filter((s) => /^SELECT/.test(s))) {
      // The SELECT list only. `token_hash` legitimately appears in ORDER BY -
      // it is the stable discriminator of last resort for two otherwise
      // identical rows, and sorting by it does not read it out.
      const selectList = /SELECT ([\s\S]*?) FROM /.exec(sql);
      assert.ok(selectList, `a select list: ${sql}`);
      for (const forbidden of [
        "telegram_user_id",
        "private_chat_id",
        "verified_mobile",
        "token_hash",
        "telegram_username",
        "pending_chat_id",
      ]) {
        assert.ok(!selectList[1].includes(forbidden), `${forbidden} must not be selected: ${sql}`);
      }
    }
  });

  it("only counts an ACTIVE identity", async () => {
    const pool = fakePool({
      answers: [
        [/FROM employee_telegram_identity/, [{ employee_id: 7 }]],
        [/FROM employee_telegram_link_tokens/, []],
      ],
    });

    const out = await buildRepo(pool).getSummaryForEmployees(IDS);

    const identitySql = sqlOf(pool).find((s) => /FROM employee_telegram_identity/.test(s));
    assert.match(identitySql, /disconnected_at IS NULL/, "a retired row is not a connection");
    assert.equal(out.get(7).hasActiveIdentity, true);
    assert.equal(out.get(8).hasActiveIdentity, false);
  });

  it("takes the NEWEST SECOND per employee, and lets MySQL decide live-ness", async () => {
    const pool = fakePool({
      answers: [
        [/FROM employee_telegram_identity/, []],
        [
          /FROM employee_telegram_link_tokens/,
          [{ employee_id: 8, pending_outcome: null, is_live: 1, is_unconsumed: 0 }],
        ],
      ],
    });

    const out = await buildRepo(pool).getSummaryForEmployees(IDS);

    const tokenSql = sqlOf(pool).find((s) => /JOIN/.test(s));
    assert.match(tokenSql, /MAX\(created_at\)/, "the newest second, decided in SQL");
    assert.match(tokenSql, /pending_expires_at > NOW\(\)/, "live-ness against MySQL's own clock");
    assert.match(tokenSql, /consumed_at IS NULL\) AS is_unconsumed/, "and the lifecycle facts with it");
    assert.match(tokenSql, /ORDER BY t\.employee_id, t\.token_hash ASC/, "ordered stably, never selected");
    assert.equal(out.get(8).hasActiveIdentity, false);
    assert.equal(out.get(8).rows.length, 1);
    assert.equal(out.get(8).rows[0].pending_outcome, null);
    assert.equal(Number(out.get(8).rows[0].is_live), 1);
  });

  it("HANDS OVER EVERY ROW OF THE TIE - the lifecycle decides, not this query", async () => {
    // `created_at` is a TIMESTAMP, so two issuances in the same second tie.
    // The repository deliberately does NOT pick a winner: the rule lives in
    // `utils/employee_telegram_status.js` and is shared with the
    // single-employee read, so both paths break the tie identically.
    const pool = fakePool({
      answers: [
        [/FROM employee_telegram_identity/, []],
        [
          /FROM employee_telegram_link_tokens/,
          [
            { employee_id: 9, pending_outcome: "SUPERSEDED", is_live: 0 },
            { employee_id: 9, pending_outcome: null, is_live: 1 },
          ],
        ],
      ],
    });

    const out = await buildRepo(pool).getSummaryForEmployees(IDS);
    assert.equal(out.get(9).rows.length, 2, "both candidates are handed over");
  });

  it("gives every requested employee an entry, so a missing row is not a missing answer", async () => {
    const pool = fakePool({ answers: [[/SELECT/, []]] });
    const out = await buildRepo(pool).getSummaryForEmployees(IDS);
    assert.deepEqual([...out.keys()], IDS);
    for (const id of IDS) {
      assert.deepEqual(out.get(id), { hasActiveIdentity: false, rows: [] });
    }
  });
});
