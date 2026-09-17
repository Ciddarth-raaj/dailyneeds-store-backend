/**
 * The Phase 3A mapping API: which key guards each endpoint, and where the
 * employee branch scope comes from.
 *
 *   node --test routes/telegram_group_mapping.test.js
 *
 * TWO THINGS ARE BEING PROVEN.
 *
 * The four new endpoints reuse the REGISTRY'S OWN KEYS - reads on
 * `view_telegram_groups`, writes on `manage_telegram_groups` - so nobody has
 * to be granted a third thing before a screen behind a gate works.
 *
 * And `matched-employees`, the one endpoint that names people, takes its
 * scope from the SERVER'S live resolver and never from the request. There is
 * no branch parameter on the route to send, and if the resolver is not wired
 * the route returns no names rather than all of them.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./telegram_group_registry");
const { PERMISSIONS: P } = require("../constants/telegram_group_registry");
const { MAPPING_TYPES } = require("../constants/telegram_group_mapping");

const tagging = {
  require: (...keys) => {
    const mw = (req, res, next) => next();
    mw.__guard = { mode: "any", keys };
    return mw;
  },
  requireAll: (...keys) => {
    const mw = (req, res, next) => next();
    mw.__guard = { mode: "all", keys };
    return mw;
  },
  actorFor: async () => ({ employee_id: 7 }),
};

const mappingUsecase = () => {
  const calls = [];
  return {
    calls,
    getMappings: async (id, opts) => {
      calls.push({ fn: "getMappings", id, opts });
      return { group: {}, mappings: [], total_matched: 0 };
    },
    addMapping: async (id, body, actor) => {
      calls.push({ fn: "addMapping", id, body, actor });
      return { code: 200 };
    },
    deleteMapping: async (id, mappingId) => {
      calls.push({ fn: "deleteMapping", id, mappingId });
      return { code: 200 };
    },
    getMatchedEmployees: async (id, opts) => {
      calls.push({ fn: "getMatchedEmployees", id, opts });
      return { employees: [], total_matched: 0, counts_scope: "ALL" };
    },
  };
};

function routesFor(mapping, branch, membershipAdmin = null) {
  const out = [];
  for (const layer of buildRoutes({}, tagging, null, mapping, branch, membershipAdmin)
    .getRouter()
    .stack) {
    if (!layer.route) continue;
    out.push({
      method: Object.keys(layer.route.methods)[0].toUpperCase(),
      path: layer.route.path,
      guard: layer.route.stack.map((s) => s.handle.__guard).find(Boolean) || null,
      handler: layer.route.stack[layer.route.stack.length - 1].handle,
    });
  }
  return out;
}

const find = (routes, method, fragment) =>
  routes.find((r) => r.method === method && r.path.includes(fragment));

function fakeRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.end = () => ((res.ended = true), res);
  return res;
}

const ALL_BRANCHES = { kind: "ALL_BRANCHES", store_ids: null };

describe("the four mapping endpoints", () => {
  const routes = routesFor(mappingUsecase(), { resolve: async () => ALL_BRANCHES });

  it("exist, under the group they belong to", () => {
    assert.ok(find(routes, "GET", "/mappings"));
    assert.ok(find(routes, "POST", "/mappings"));
    assert.ok(find(routes, "DELETE", "/mappings/"));
    assert.ok(find(routes, "GET", "matched-employees"));
  });

  it("READS use view_telegram_groups", () => {
    for (const route of [find(routes, "GET", "/mappings"), find(routes, "GET", "matched-employees")]) {
      assert.deepEqual(route.guard, { mode: "any", keys: [P.VIEW_TELEGRAM_GROUPS] });
    }
  });

  it("WRITES use manage_telegram_groups", () => {
    for (const route of [find(routes, "POST", "/mappings"), find(routes, "DELETE", "/mappings/")]) {
      assert.deepEqual(route.guard, { mode: "any", keys: [P.MANAGE_TELEGRAM_GROUPS] });
    }
  });

  it("mint no third permission key", () => {
    for (const route of routes) {
      for (const key of route.guard ? route.guard.keys : []) {
        assert.ok(
          key === P.VIEW_TELEGRAM_GROUPS || key === P.MANAGE_TELEGRAM_GROUPS,
          `unexpected permission key on a Telegram route: ${key}`
        );
      }
    }
  });

  it("are not registered at all when the mapping usecase is absent", () => {
    // The registry keeps working; the new screen simply is not there.
    const withoutMapping = routesFor(null, null);
    assert.equal(withoutMapping.filter((r) => /mappings|matched/.test(r.path)).length, 0);
    assert.equal(withoutMapping.length, 6, "the original six CRUD endpoints survive");
  });
});

describe("the mapping list", () => {
  it("passes the group id through and returns the vocabulary with it", async () => {
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, { resolve: async () => ALL_BRANCHES });
    const res = fakeRes();
    await find(routes, "GET", "/mappings").handler(
      { params: { telegram_group_id: "10" }, query: {} },
      res
    );
    assert.equal(res.body.code, 200);
    assert.deepEqual(res.body.mapping_types, MAPPING_TYPES);
    assert.equal(mapping.calls[0].fn, "getMappings");
    assert.equal(mapping.calls[0].id, 10);
  });

  it("answers 404 as a not-found, not a 500", async () => {
    const mapping = mappingUsecase();
    mapping.getMappings = async () => {
      const err = new Error("Telegram group not found");
      err.httpCode = 404;
      throw err;
    };
    const routes = routesFor(mapping, { resolve: async () => ALL_BRANCHES });
    const res = fakeRes();
    await find(routes, "GET", "/mappings").handler({ params: { telegram_group_id: "77" }, query: {} }, res);
    assert.equal(res.statusCode, 404);
  });
});

describe("adding a mapping", () => {
  it("hands the body and the actor to the usecase", async () => {
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, { resolve: async () => ALL_BRANCHES });
    const res = fakeRes();
    await find(routes, "POST", "/mappings").handler(
      { params: { telegram_group_id: "10" }, body: { mapping_type: "OUTLET", target_id: 5 } },
      res
    );
    const call = mapping.calls[0];
    assert.equal(call.fn, "addMapping");
    assert.deepEqual(call.body, { mapping_type: "OUTLET", target_id: 5 });
    assert.deepEqual(call.actor, { employee_id: 7 });
  });

  it("refuses an unknown body field before the usecase sees it", async () => {
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, { resolve: async () => ALL_BRANCHES });
    const res = fakeRes();
    await find(routes, "POST", "/mappings").handler(
      { params: { telegram_group_id: "10" }, body: { mapping_type: "OUTLET", employee_ids: [1, 2] } },
      res
    );
    assert.equal(mapping.calls.length, 0, "a hand-picked employee list must not reach the usecase");
  });
});

describe("deleting a mapping", () => {
  it("passes BOTH ids, so a mapping can only be deleted through its own group", async () => {
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, { resolve: async () => ALL_BRANCHES });
    const res = fakeRes();
    await find(routes, "DELETE", "/mappings/").handler(
      { params: { telegram_group_id: "10", telegram_group_mapping_id: "3" } },
      res
    );
    assert.deepEqual(mapping.calls[0], { fn: "deleteMapping", id: 10, mappingId: 3 });
  });
});

describe("the mapping list is scoped too", () => {
  it("resolves the caller's scope and hands it to the usecase", async () => {
    // The counts on the mapping rows are employee-derived, so this endpoint
    // needs the scope exactly as matched-employees does.
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, {
      resolve: async () => ({ kind: "OWN_BRANCHES", store_ids: [8] }),
    });
    await find(routes, "GET", "/mappings").handler(
      { params: { telegram_group_id: "10" }, query: {} },
      fakeRes()
    );
    assert.deepEqual(mapping.calls[0].opts.scope, { kind: "OWN_BRANCHES", store_ids: [8] });
  });

  it("FAILS CLOSED when no resolver is wired", async () => {
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, null);
    await find(routes, "GET", "/mappings").handler(
      { params: { telegram_group_id: "10" }, query: {} },
      fakeRes()
    );
    assert.equal(mapping.calls[0].opts.scope.kind, "NONE");
  });

  it("both reads resolve the scope the same way", async () => {
    const seen = [];
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, {
      resolve: async () => {
        seen.push(1);
        return { kind: "OWN_BRANCHES", store_ids: [8] };
      },
    });
    await find(routes, "GET", "/mappings").handler({ params: { telegram_group_id: "10" }, query: {} }, fakeRes());
    await find(routes, "GET", "matched-employees").handler({ params: { telegram_group_id: "10" }, query: {} }, fakeRes());
    assert.equal(seen.length, 2, "one shared resolution path, used by both");
    assert.deepEqual(mapping.calls[0].opts.scope, mapping.calls[1].opts.scope);
  });
});

describe("matched employees: where the scope comes from", () => {
  it("is resolved by the server's own resolver", async () => {
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, { resolve: async () => ({ kind: "OWN_BRANCHES", store_ids: [8] }) });
    const res = fakeRes();
    await find(routes, "GET", "matched-employees").handler(
      { params: { telegram_group_id: "10" }, query: {} },
      res
    );
    assert.deepEqual(mapping.calls[0].opts.scope, { kind: "OWN_BRANCHES", store_ids: [8] });
  });

  it("REFUSES a request that tries to name a branch, rather than honouring it", async () => {
    // There is no branch parameter on this route, and the Joi schema allows
    // only `mapping_id`. A client asking for a scope therefore gets a
    // validation refusal and the usecase is never reached - a stronger
    // outcome than silently ignoring the field, because the caller is told
    // their request was not understood instead of quietly getting a
    // different answer from the one they asked for.
    for (const query of [
      { store_id: 5 },
      { store_ids: [1, 2, 3] },
      { scope: "ALL_BRANCHES" },
      { mapping_id: "3", store_id: 5 },
    ]) {
      const mapping = mappingUsecase();
      const routes = routesFor(mapping, {
        resolve: async () => ({ kind: "OWN_BRANCHES", store_ids: [8] }),
      });
      const res = fakeRes();
      await find(routes, "GET", "matched-employees").handler(
        { params: { telegram_group_id: "10" }, query, decoded: { store_id: 99, user_type: 2 } },
        res
      );
      assert.equal(mapping.calls.length, 0, `${JSON.stringify(query)} must not reach the usecase`);
      assert.equal(res.statusCode, 400);
    }
  });

  it("does NOT take the scope from the JWT's store_id", async () => {
    const seen = [];
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, {
      resolve: async (req) => {
        seen.push(req);
        return { kind: "OWN_BRANCHES", store_ids: [8] };
      },
    });
    await find(routes, "GET", "matched-employees").handler(
      { params: { telegram_group_id: "10" }, query: {}, decoded: { store_id: 42 } },
      fakeRes()
    );
    // The route hands the whole request to the resolver, which reads the
    // caller's CURRENT branch from the database; a stale claim is not the
    // source. The scope handed on is the resolver's answer, not `decoded`.
    assert.equal(seen.length, 1);
    assert.deepEqual(mapping.calls[0].opts.scope.store_ids, [8]);
    assert.notDeepEqual(mapping.calls[0].opts.scope.store_ids, [42]);
  });

  it("FAILS CLOSED when no resolver is wired", async () => {
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, null);
    await find(routes, "GET", "matched-employees").handler(
      { params: { telegram_group_id: "10" }, query: {} },
      fakeRes()
    );
    assert.equal(mapping.calls[0].opts.scope.kind, "NONE", "no resolver must mean no names");
  });

  it("passes an optional mapping_id through for the per-rule view", async () => {
    const mapping = mappingUsecase();
    const routes = routesFor(mapping, { resolve: async () => ALL_BRANCHES });
    await find(routes, "GET", "matched-employees").handler(
      { params: { telegram_group_id: "10" }, query: { mapping_id: "3" } },
      fakeRes()
    );
    assert.equal(mapping.calls[0].opts.mapping_id, "3");
  });
});

describe("membership endpoints are Phase 3C's, and only Phase 3C's", () => {
  it("PHASE 3A ALONE exposes no join, invite, member, sync, ban or kick route", () => {
    // Unchanged in substance: mapping configuration decides who SHOULD
    // belong and performs no membership action. Without Phase 3C's admin
    // usecase wired, this router still cannot touch anybody's membership.
    const routes = routesFor(mappingUsecase(), { resolve: async () => ALL_BRANCHES });
    for (const route of routes) {
      assert.ok(
        !/join|invite|member|sync|reconcile|ban|kick/i.test(route.path.replace(/employees/g, "")),
        `Phase 3A must expose no membership route, found ${route.method} ${route.path}`
      );
    }
  });

  it("with Phase 3C wired, the membership routes are exactly three, all MANAGE-gated", () => {
    const routes = routesFor(mappingUsecase(), { resolve: async () => ALL_BRANCHES }, {
      listForGroup: async () => ({ code: 200, data: [] }),
      grantManual: async () => ({ code: 200 }),
      revokeManual: async () => ({ code: 200 }),
      queueHealth: async () => ({ code: 200 }),
      requeue: async () => ({ code: 200 }),
    });
    const membership = routes.filter((route) => /\/membership/.test(route.path));
    const signatures = membership.map((route) => `${route.method} ${route.path}`).sort();
    assert.deepEqual(signatures, [
      "DELETE /:telegram_group_id(\\d+)/membership/:employee_id(\\d+)",
      "GET /:telegram_group_id(\\d+)/membership",
      "GET /membership/queue",
      "POST /:telegram_group_id(\\d+)/membership",
      "POST /membership/queue/:telegram_membership_job_id(\\d+)/requeue",
    ].sort());

    // GRANTING A GROUP IS GRANTING ACCESS. Every write here is
    // `manage_telegram_groups` - the key that already decides what a group
    // is for - and never an employee-record key.
    for (const route of membership) {
      const expected =
        route.method === "GET" && /\/membership$/.test(route.path)
          ? P.VIEW_TELEGRAM_GROUPS
          : P.MANAGE_TELEGRAM_GROUPS;
      assert.deepEqual(route.guard, { mode: "any", keys: [expected] }, route.path);
      assert.ok(!route.guard.keys.includes(P.EMPLOYEE_EDIT), route.path);
    }
  });
});
