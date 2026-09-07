const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const pw = require("./password");
const { CHEAP, hashCheap, legacyHash } = require("../test_support/auth_fixtures");

describe("password service — modern hashing", () => {
  it("produces a self-describing scrypt string and verifies it", async () => {
    const h = await hashCheap("correct horse battery");
    assert.match(h, /^\$scrypt\$ln=12,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    assert.equal(await pw.verifyModern(h, "correct horse battery"), true);
    assert.equal(await pw.verifyModern(h, "correct horse batteri"), false);
  });

  it("salts: the same password hashes differently twice", async () => {
    const a = await hashCheap("same");
    const b = await hashCheap("same");
    assert.notEqual(a, b);
  });

  it("verifies a hash made with different parameters (cost can be raised later)", async () => {
    const h = await pw.hash("x-y-z", { ...CHEAP, ln: 13 });
    assert.equal(await pw.verifyModern(h, "x-y-z"), true);
  });

  it("never throws on garbage stored values", async () => {
    for (const bad of [null, undefined, "", "sha1hex", "$scrypt$", "$scrypt$ln=a,r=8,p=1$x$y", "$bcrypt$..."]) {
      assert.equal(await pw.verifyModern(bad, "anything"), false);
    }
  });

  it("refuses to hash an empty password", async () => {
    await assert.rejects(() => pw.hash(""));
  });
});

describe("password service — legacy SHA-1", () => {
  it("matches what MySQL SHA1() stored, case-insensitively", () => {
    const stored = legacyHash("abc123");
    assert.equal(pw.verifyLegacy(stored, "abc123"), true);
    assert.equal(pw.verifyLegacy(stored.toUpperCase(), "abc123"), true);
    assert.equal(pw.verifyLegacy(stored, "abc124"), false);
  });
});

describe("password service — verifyUser routing", () => {
  it("modern account: modern hash only, SHA-1 column ignored even if present", async () => {
    const h = await hashCheap("newpass-1234");
    const row = { password_algo: "scrypt", password_hash: h, password: legacyHash("oldpass") };
    assert.deepEqual(await pw.verifyUser(row, "newpass-1234"), { ok: true, algo: "scrypt" });
    // the old SHA-1 password must NOT work for a migrated account
    assert.deepEqual(await pw.verifyUser(row, "oldpass"), { ok: false, algo: "scrypt" });
  });

  it("legacy account: SHA-1 only", async () => {
    const row = { password_algo: "sha1", password: legacyHash("legacy-pw"), password_hash: null };
    assert.deepEqual(await pw.verifyUser(row, "legacy-pw"), { ok: true, algo: "sha1" });
    assert.deepEqual(await pw.verifyUser(row, "wrong"), { ok: false, algo: "sha1" });
  });

  it("modern account with no hash (setup pending) cannot authenticate", async () => {
    assert.equal((await pw.verifyUser({ password_algo: "scrypt", password_hash: null }, "x")).ok, false);
  });

  it("unknown algorithm is refused", async () => {
    assert.equal((await pw.verifyUser({ password_algo: "md5", password: "x" }, "x")).ok, false);
  });

  it("dummyVerify always returns false and performs real work", async () => {
    const t = process.hrtime.bigint();
    assert.equal(await pw.dummyVerify("whatever"), false);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms > 1, `dummy verify should cost real time, took ${ms}ms`);
  });
});
