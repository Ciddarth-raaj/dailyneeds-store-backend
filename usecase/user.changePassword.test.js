const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildUserUsecase = require("./user");

/**
 * A stand-in for the user repository that records what it was asked to do.
 *
 * `correct` is the password the fake account actually has, so
 * `verifyPassword` can answer the way the real SQL comparison would.
 */
const makeRepo = (correct) => {
  const calls = { verified: [], updated: [] };
  return {
    calls,
    verifyPassword: async (userId, password) => {
      calls.verified.push({ userId, password });
      return password === correct ? [{ user_id: userId }] : [];
    },
    updatePassword: async (userId, password) => {
      calls.updated.push({ userId, password });
      return { affectedRows: 1 };
    },
  };
};

const usecaseFor = (repo) => buildUserUsecase(repo, {}, {});

describe("changePassword", () => {
  it("replaces the password when the current one is right", async () => {
    const repo = makeRepo("old-secret");
    const result = await usecaseFor(repo).changePassword(7, "old-secret", "new-secret");

    assert.equal(result.code, 200);
    assert.deepEqual(repo.calls.updated, [{ userId: 7, password: "new-secret" }]);
  });

  it("refuses a wrong current password without writing anything", async () => {
    const repo = makeRepo("old-secret");
    const result = await usecaseFor(repo).changePassword(7, "guessed", "new-secret");

    assert.equal(result.code, 400);
    assert.equal(result.error, "INCORRECT_PASSWORD");
    assert.deepEqual(repo.calls.updated, []);
  });

  // Length and sameness are checked before the current password is looked up,
  // so a rejected new password never even touches the database.
  it("refuses a new password shorter than the minimum", async () => {
    const repo = makeRepo("old-secret");
    await assert.rejects(
      () => usecaseFor(repo).changePassword(7, "old-secret", "short"),
      (err) => err.name === "ValidationError"
    );
    assert.deepEqual(repo.calls.verified, []);
    assert.deepEqual(repo.calls.updated, []);
  });

  it("refuses a new password identical to the current one", async () => {
    const repo = makeRepo("old-secret");
    await assert.rejects(
      () => usecaseFor(repo).changePassword(7, "old-secret", "old-secret"),
      (err) => err.name === "ValidationError"
    );
    assert.deepEqual(repo.calls.updated, []);
  });

  it("treats a missing password as an empty one rather than crashing", async () => {
    const repo = makeRepo("old-secret");
    await assert.rejects(
      () => usecaseFor(repo).changePassword(7, undefined, undefined),
      (err) => err.name === "ValidationError"
    );
  });
});
