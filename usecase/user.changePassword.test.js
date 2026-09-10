const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildUserUsecase = require("./user");
const F = require("../test_support/auth_fixtures");

/**
 * Self-service password change, carried over from before Stage 0A onto
 * the new repository surface. The rules are unchanged in spirit — prove
 * the current password, refuse a too-short or unchanged new one — with
 * the policy floor now 8 and the stored result always a modern hash.
 */
const CURRENT = "old-secret-1";

const build = () => {
  const rows = { u: F.employeeRow({ username: "u", password: F.legacyHash(CURRENT), password_algo: "sha1" }) };
  const repo = F.fakeUserRepo(rows);
  return { rows, repo, usecase: buildUserUsecase(repo, {}, {}, { config: F.config() }) };
};

describe("changePassword", () => {
  it("replaces the password when the current one is right, storing a modern hash", async () => {
    const { rows, repo, usecase } = build();
    const result = await usecase.changePassword(7, CURRENT, "new-secret-9");
    assert.equal(result.code, 200);
    assert.ok(repo.calls.some((c) => c[0] === "setModernPassword" && c[1] === 7));
    assert.equal(rows.u.password_algo, "scrypt");
    assert.equal(rows.u.password, null);
  });

  it("refuses a wrong current password without writing anything", async () => {
    const { repo, usecase } = build();
    const result = await usecase.changePassword(7, "guessed", "new-secret-9");
    assert.equal(result.code, 400);
    assert.equal(result.error, "INCORRECT_PASSWORD");
    assert.equal(repo.calls.some((c) => c[0] === "setModernPassword"), false);
  });

  it("refuses a new password shorter than the minimum before touching the credential", async () => {
    const { repo, usecase } = build();
    await assert.rejects(() => usecase.changePassword(7, CURRENT, "short"), (err) => err.name === "ValidationError");
    assert.equal(repo.calls.some((c) => c[0] === "setModernPassword"), false);
  });

  it("refuses a new password identical to the current one", async () => {
    const { repo, usecase } = build();
    await assert.rejects(() => usecase.changePassword(7, CURRENT, CURRENT), (err) => err.name === "ValidationError");
    assert.equal(repo.calls.some((c) => c[0] === "setModernPassword"), false);
  });

  it("treats a missing password as an empty one rather than crashing", async () => {
    const { usecase } = build();
    await assert.rejects(() => usecase.changePassword(7, undefined, undefined), (err) => err.name === "ValidationError");
  });

  it("is refused for an unknown account", async () => {
    const { usecase } = build();
    await assert.rejects(() => usecase.changePassword(404, CURRENT, "new-secret-9"), (err) => err.status === 404);
  });
});
