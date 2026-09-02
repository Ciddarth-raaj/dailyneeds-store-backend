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

const OPEN = { allowed_ips: [], allow_outside_access: true };

/** Confined to `ips`, i.e. outside access switched off. */
const restrictedTo = (ips) => ({
  allowed_ips: ips,
  allow_outside_access: false,
});

/** Minimal stand-in for the user usecase, counting DB reads. */
const makeUsecase = (byUser) => {
  const calls = [];
  return {
    calls,
    async getIpPolicy(userId) {
      calls.push(userId);
      return byUser[userId] || OPEN;
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

  it("allows a user who may work outside", async () => {
    const middleware = buildIpRestriction(makeUsecase({ 7: OPEN }));

    const { nextCalled } = await run(middleware, {
      decoded: { id: 7 },
      ip: "203.0.113.99",
    });

    assert.equal(nextCalled, true);
  });

  it("allows a restricted user on an allowed address", async () => {
    const middleware = buildIpRestriction(
      makeUsecase({ 7: restrictedTo(["203.0.113.0/24"]) })
    );

    const { nextCalled } = await run(middleware, {
      decoded: { id: 7 },
      ip: "203.0.113.42",
    });

    assert.equal(nextCalled, true);
  });

  it("blocks a restricted user off-network with 403", async () => {
    const middleware = buildIpRestriction(
      makeUsecase({ 7: restrictedTo(["203.0.113.10"]) })
    );

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
    const middleware = buildIpRestriction(
      makeUsecase({ 7: restrictedTo(["203.0.113.10"]) })
    );

    const { res, nextCalled } = await run(middleware, {
      decoded: { id: 7 },
      headers: {},
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it("caches the allow-list instead of reading it per request", async () => {
    const usecase = makeUsecase({ 7: restrictedTo(["203.0.113.10"]) });
    const middleware = buildIpRestriction(usecase);
    const req = { decoded: { id: 7 }, ip: "203.0.113.10" };

    await run(middleware, req);
    await run(middleware, req);
    await run(middleware, req);

    assert.deepEqual(usecase.calls, [7]);
  });

  it("re-reads after invalidate so an edit takes effect at once", async () => {
    const byUser = { 7: OPEN };
    const usecase = makeUsecase(byUser);
    const middleware = buildIpRestriction(usecase);
    const req = { decoded: { id: 7 }, ip: "49.207.1.1" };

    assert.equal((await run(middleware, req)).nextCalled, true);

    byUser[7] = restrictedTo(["203.0.113.10"]);
    middleware.invalidate(7);

    const { res, nextCalled } = await run(middleware, req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it("lets a user back out when the switch is turned on again", async () => {
    const byUser = { 7: restrictedTo(["203.0.113.10"]) };
    const middleware = buildIpRestriction(makeUsecase(byUser));
    const req = { decoded: { id: 7 }, ip: "49.207.1.1" };

    assert.equal((await run(middleware, req)).nextCalled, false);

    // The addresses stay on the row; only the switch moved.
    byUser[7] = { allowed_ips: ["203.0.113.10"], allow_outside_access: true };
    middleware.invalidate(7);

    assert.equal((await run(middleware, req)).nextCalled, true);
  });

  it("blocks a restricted user whose list was emptied behind our back", async () => {
    const middleware = buildIpRestriction(makeUsecase({ 7: restrictedTo([]) }));

    const { res, nextCalled } = await run(middleware, {
      decoded: { id: 7 },
      ip: "203.0.113.10",
    });

    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
  });

  it("does not fall open when the lookup fails", async () => {
    const middleware = buildIpRestriction({
      async getIpPolicy() {
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
