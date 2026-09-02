const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildIpRestriction = require("./ip_restriction");

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

/** Minimal stand-in for the user usecase, counting DB reads. */
const makeUsecase = (byUser) => {
  const calls = [];
  return {
    calls,
    async getAllowedIps(userId) {
      calls.push(userId);
      return byUser[userId] || [];
    },
  };
};

const run = async (middleware, req) => {
  const res = makeRes();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
};

describe("ip restriction middleware", () => {
  it("passes through unauthenticated requests", async () => {
    const usecase = makeUsecase({});
    const middleware = buildIpRestriction(usecase);

    const { nextCalled } = await run(middleware, { ip: "203.0.113.99" });

    assert.equal(nextCalled, true);
    assert.deepEqual(usecase.calls, []);
  });

  it("allows a user with no allow-list", async () => {
    const middleware = buildIpRestriction(makeUsecase({ 7: [] }));

    const { nextCalled } = await run(middleware, {
      decoded: { id: 7 },
      ip: "203.0.113.99",
    });

    assert.equal(nextCalled, true);
  });

  it("allows a restricted user on an allowed address", async () => {
    const middleware = buildIpRestriction(
      makeUsecase({ 7: ["203.0.113.0/24"] })
    );

    const { nextCalled } = await run(middleware, {
      decoded: { id: 7 },
      ip: "203.0.113.42",
    });

    assert.equal(nextCalled, true);
  });

  it("blocks a restricted user off-network with 403", async () => {
    const middleware = buildIpRestriction(makeUsecase({ 7: ["203.0.113.10"] }));

    const { res, nextCalled } = await run(middleware, {
      decoded: { id: 7 },
      ip: "49.207.1.1",
      path: "/product",
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "IP_NOT_ALLOWED");
    assert.equal(res.body.ip, "49.207.1.1");
  });

  it("blocks when the client IP cannot be resolved", async () => {
    const middleware = buildIpRestriction(makeUsecase({ 7: ["203.0.113.10"] }));

    const { res, nextCalled } = await run(middleware, {
      decoded: { id: 7 },
      headers: {},
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it("caches the allow-list instead of reading it per request", async () => {
    const usecase = makeUsecase({ 7: ["203.0.113.10"] });
    const middleware = buildIpRestriction(usecase);
    const req = { decoded: { id: 7 }, ip: "203.0.113.10" };

    await run(middleware, req);
    await run(middleware, req);
    await run(middleware, req);

    assert.deepEqual(usecase.calls, [7]);
  });

  it("re-reads after invalidate so an edit takes effect at once", async () => {
    const byUser = { 7: [] };
    const usecase = makeUsecase(byUser);
    const middleware = buildIpRestriction(usecase);
    const req = { decoded: { id: 7 }, ip: "49.207.1.1" };

    assert.equal((await run(middleware, req)).nextCalled, true);

    byUser[7] = ["203.0.113.10"];
    middleware.invalidate(7);

    const { res, nextCalled } = await run(middleware, req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it("does not fall open when the lookup fails", async () => {
    const middleware = buildIpRestriction({
      async getAllowedIps() {
        throw new Error("db down");
      },
    });

    const { res, nextCalled } = await run(middleware, {
      decoded: { id: 7 },
      ip: "203.0.113.10",
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 500);
  });
});
