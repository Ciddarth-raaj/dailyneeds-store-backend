/**
 * The verification cache's SQL, and the one rule it must never break.
 *
 *   node --test repository/employee_telegram_group_verification.test.js
 *
 * "WE COULD NOT ASK" MUST NEVER OVERWRITE A REAL ANSWER. This is the last of
 * three layers protecting that - the caller avoids the branch, the usecase's
 * recorder guards it, and this refuses it outright. It is the layer that
 * still holds when a future caller forgets.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildRepo = require("./employee_telegram_group_verification");
const { GROUP_READINESS, VERIFIED_MEMBERSHIP } = require("../constants/telegram_membership");

const makeDb = (rows = []) => {
  const queries = [];
  return {
    queries,
    query(sql, params, cb) {
      queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      cb(null, rows);
    },
  };
};

const good = {
  employeeTelegramId: 900,
  employeeId: 42,
  telegramGroupId: 1,
  membership: VERIFIED_MEMBERSHIP.JOINED,
  readinessStatus: GROUP_READINESS.READY,
  verifiedAt: new Date("2026-09-16T04:00:00Z"),
};

describe("recording a verification", () => {
  it("writes a definitive answer as an upsert on (identity, group)", async () => {
    const db = makeDb();
    const result = await buildRepo(db).record(good);
    assert.equal(result.recorded, true);
    assert.equal(db.queries.length, 1);
    assert.match(db.queries[0].sql, /INSERT INTO employee_telegram_group_verification/);
    // One statement, so there is no window in which the row does not exist.
    assert.match(db.queries[0].sql, /ON DUPLICATE KEY UPDATE/);
    assert.deepEqual(db.queries[0].params.slice(0, 3), [900, 42, 1]);
  });

  it("REFUSES TELEGRAM_UNAVAILABLE, and writes nothing at all", async () => {
    const db = makeDb();
    const result = await buildRepo(db).record({
      ...good,
      readinessStatus: GROUP_READINESS.TELEGRAM_UNAVAILABLE,
    });
    assert.equal(result.recorded, false);
    assert.equal(result.reason, "NOT_DEFINITIVE");
    assert.deepEqual(db.queries, [], "no query may run for a non-answer");
  });

  it("refuses a membership value that is not a verdict", async () => {
    const db = makeDb();
    for (const membership of ["UNKNOWN", "", null, undefined, "joined"]) {
      const result = await buildRepo(db).record({ ...good, membership });
      assert.equal(result.recorded, false, String(membership));
    }
    assert.deepEqual(db.queries, []);
  });

  it("accepts NOT_JOINED - that IS a verdict", async () => {
    const db = makeDb();
    const result = await buildRepo(db).record({
      ...good,
      membership: VERIFIED_MEMBERSHIP.NOT_JOINED,
    });
    assert.equal(result.recorded, true);
  });

  it("records a definitively not-ready group", async () => {
    const db = makeDb();
    const result = await buildRepo(db).record({
      ...good,
      membership: VERIFIED_MEMBERSHIP.NOT_JOINED,
      readinessStatus: GROUP_READINESS.BOT_NOT_ADMIN,
    });
    assert.equal(result.recorded, true, "we looked, and the requirement is unmet");
  });
});

describe("reading the cache for a dashboard page", () => {
  it("is ONE query for every employee on the page", async () => {
    const db = makeDb([]);
    await buildRepo(db).getForEmployees([1, 2, 3, 4, 5]);
    assert.equal(db.queries.length, 1);
    assert.deepEqual(db.queries[0].params, [[1, 2, 3, 4, 5]]);
  });

  it("EXCLUDES verifications from a replaced identity, in the JOIN", async () => {
    // Not filtered afterwards - joined to the active identity - so no caller
    // can forget to, and a reconnect invalidates the cache automatically.
    const db = makeDb([]);
    await buildRepo(db).getForEmployees([1]);
    assert.match(db.queries[0].sql, /JOIN employee_telegram_identity i/);
    assert.match(db.queries[0].sql, /i\.disconnected_at IS NULL/);
  });

  it("selects no private identifier", async () => {
    const db = makeDb([]);
    await buildRepo(db).getForEmployees([1]);
    for (const column of ["telegram_user_id", "private_chat_id", "telegram_username", "mobile"]) {
      assert.ok(!new RegExp(column).test(db.queries[0].sql), `must not select ${column}`);
    }
  });

  it("groups by employee then group", async () => {
    const db = makeDb([
      { employee_id: 1, telegram_group_id: 10, membership: "JOINED", readiness_status: "READY", verified_at: new Date() },
      { employee_id: 1, telegram_group_id: 11, membership: "NOT_JOINED", readiness_status: "READY", verified_at: new Date() },
    ]);
    const out = await buildRepo(db).getForEmployees([1]);
    assert.equal(out.get(1).get(10).membership, "JOINED");
    assert.equal(out.get(1).get(11).membership, "NOT_JOINED");
  });

  it("makes no query at all for an empty page", async () => {
    const db = makeDb();
    const out = await buildRepo(db).getForEmployees([]);
    assert.equal(db.queries.length, 0);
    assert.equal(out.size, 0);
  });
});
