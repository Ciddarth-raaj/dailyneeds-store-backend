const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const jsonwebtoken = require("jsonwebtoken");
const { createJwtService } = require("./jwt");
const { keypair } = require("../test_support/auth_fixtures");

const A = keypair();
const B = keypair();

const svc = (over = {}) =>
  createJwtService({
    privateKey: A.privateKey,
    publicKeys: { "key-2026-01": A.publicKey },
    activeKid: "key-2026-01",
    legacyKid: "key-2026-01",
    requireKid: false,
    tokenCutoff: 0,
    ...over,
  });

describe("jwt — algorithm pinning (A9)", () => {
  it("30. a valid RS256 token verifies and carries the active kid", async () => {
    const s = svc();
    const token = await s.sign({ id: 1 }, "1h", { subject: "1" });
    const header = jsonwebtoken.decode(token, { complete: true }).header;
    assert.equal(header.alg, "RS256");
    assert.equal(header.kid, "key-2026-01");
    const decoded = await s.verify(token);
    assert.equal(decoded.sub, "1");
    assert.equal(decoded.id, 1);
  });

  it("31. an HS256 token is rejected", async () => {
    const s = svc();
    const forged = jsonwebtoken.sign({ id: 1 }, "some-shared-secret", { algorithm: "HS256", keyid: "key-2026-01" });
    await assert.rejects(() => s.verify(forged), /Unsupported token algorithm/);
  });

  it("32. an unsupported algorithm is rejected", async () => {
    const s = svc();
    const forged = jsonwebtoken.sign({ id: 1 }, A.privateKey, { algorithm: "RS512", keyid: "key-2026-01" });
    await assert.rejects(() => s.verify(forged), /Unsupported token algorithm/);
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "key-2026-01" })).toString("base64url") +
      "." + Buffer.from(JSON.stringify({ id: 1 })).toString("base64url") + ".";
    await assert.rejects(() => s.verify(none));
  });

  it("33. algorithm confusion: HS256 signed with the RSA public key as the HMAC secret is rejected", async () => {
    const s = svc();
    const confused = jsonwebtoken.sign({ id: 1, user_type: 2 }, A.publicKey, { algorithm: "HS256", keyid: "key-2026-01" });
    await assert.rejects(() => s.verify(confused));
  });

  it("a token signed by a different RSA key is rejected", async () => {
    const s = svc();
    const other = jsonwebtoken.sign({ id: 1 }, B.privateKey, { algorithm: "RS256", keyid: "key-2026-01" });
    await assert.rejects(() => s.verify(other));
  });
});

describe("jwt — kid allow-list (A11)", () => {
  const mk = (kid) => jsonwebtoken.sign({ id: 1 }, A.privateKey, { algorithm: "RS256", ...(kid === undefined ? {} : { keyid: kid }) });

  it("34. a known kid succeeds", async () => {
    const decoded = await svc().verify(mk("key-2026-01"));
    assert.equal(decoded.id, 1);
  });

  it("35. an unknown kid is rejected", async () => {
    await assert.rejects(() => svc().verify(mk("key-2099-99")), /Unknown token kid/);
  });

  it("empty kid is rejected", async () => {
    await assert.rejects(() => svc().verify(mk("")), /Unknown token kid/);
  });

  it("36. traversal-shaped kid is rejected", async () => {
    for (const kid of ["../../etc/passwd", "../keys/jwt/public.key", "..\\..\\x", "key-2026-01/../key-2026-01"]) {
      await assert.rejects(() => svc().verify(mk(kid)), /Unknown token kid/, kid);
    }
  });

  it("37. URL- and path-like kids are rejected", async () => {
    for (const kid of ["https://evil.example/key.pem", "file:///etc/x", "/etc/dnds/jwt/legacy.pub", "C:\\keys\\a.pem"]) {
      await assert.rejects(() => svc().verify(mk(kid)), /Unknown token kid/, kid);
    }
  });

  it("prototype names are not keys", async () => {
    for (const kid of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      await assert.rejects(() => svc().verify(mk(kid)), /Unknown token kid/, kid);
    }
  });

  it("a token with no kid verifies with the legacy key while requireKid is off", async () => {
    const decoded = await svc().verify(mk(undefined));
    assert.equal(decoded.id, 1);
  });

  it("a token with no kid is rejected when requireKid is on", async () => {
    await assert.rejects(() => svc({ requireKid: true }).verify(mk(undefined)), /no kid/);
  });

  it("refuses to start with an active kid that has no key", () => {
    assert.throws(() => svc({ activeKid: "missing" }), /no verification key/);
  });
});

describe("jwt — rotation with overlap (A12)", () => {
  it("38. old and new keys both verify during the overlap", async () => {
    const oldSigner = svc();
    const oldToken = await oldSigner.sign({ id: 1 }, "1h");

    // step: new signing key added, old kept for verification
    const overlap = createJwtService({
      privateKey: B.privateKey,
      publicKeys: { "key-2026-01": A.publicKey, "key-2026-02": B.publicKey },
      activeKid: "key-2026-02",
      legacyKid: "key-2026-01",
    });
    const newToken = await overlap.sign({ id: 2 }, "1h");

    assert.equal((await overlap.verify(oldToken)).id, 1);
    assert.equal((await overlap.verify(newToken)).id, 2);
  });

  it("39. new tokens carry the active kid", async () => {
    const overlap = createJwtService({
      privateKey: B.privateKey,
      publicKeys: { "key-2026-01": A.publicKey, "key-2026-02": B.publicKey },
      activeKid: "key-2026-02",
      legacyKid: "key-2026-01",
    });
    const t = await overlap.sign({ id: 2 }, "1h");
    assert.equal(jsonwebtoken.decode(t, { complete: true }).header.kid, "key-2026-02");
  });

  it("40. the old key fails once removed after the overlap", async () => {
    const oldToken = await svc().sign({ id: 1 }, "1h");
    const after = createJwtService({
      privateKey: B.privateKey,
      publicKeys: { "key-2026-02": B.publicKey },
      activeKid: "key-2026-02",
      legacyKid: "key-2026-02",
      requireKid: true,
    });
    await assert.rejects(() => after.verify(oldToken), /Unknown token kid/);
  });

  it("the global cutoff still rejects tokens issued before it", async () => {
    const s = svc({ tokenCutoff: Math.floor(Date.now() / 1000) + 3600 });
    const t = await s.sign({ id: 1 }, "1h");
    await assert.rejects(() => s.verify(t), /global logout/);
  });
});
