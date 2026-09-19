/**
 * The Phase 3B employee endpoints: which key, and whose branch.
 *
 *   node --test routes/employee_telegram_groups.test.js
 *
 * Which groups somebody must be in, and whether they are, is information
 * ABOUT THAT EMPLOYEE - so it is read on `view_employees` behind the same
 * branch guard as every other employee status, and a join link is issued on
 * the same mutation pair Telegram onboarding already uses. A branch manager
 * must be able to do neither for another branch's employee.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildRoutes = require("./employee_telegram");
const P = require("../constants/hr_permissions");

const tagging = {
  require: (...keys) => {
    const mw = (req, res, next) => next();
    mw.__guard = { keys, mode: "any" };
    return mw;
  },
  // The mutation guard. `requireAll` is AND, and the write test below asserts
  // the MODE as well as the keys so a slide back to OR fails here.
  requireAll: (...keys) => {
    const mw = (req, res, next) => next();
    mw.__guard = { keys, mode: "all" };
    return mw;
  },
  actorFor: async () => ({ employee_id: 7 }),
};

/** A branch guard that records, and refuses whoever the test says to refuse. */
const branchScope = (refuseFor = null) => {
  const checked = [];
  return {
    checked,
    requireEmployeeInScope: () => (req, res, next) => {
      const id = Number(req.params.employee_id);
      checked.push(id);
      if (refuseFor !== null && id === refuseFor) {
        res.statusCode = 403;
        res.body = { code: 403, msg: "You do not have access to this employee" };
        return res.end();
      }
      return next();
    },
  };
};

const membership = () => {
  const calls = [];
  return {
    calls,
    getGroups: async (id, employee) => {
      calls.push({ fn: "getGroups", id, employee });
      return { connected: true, groups: [], telegram_complete: true };
    },
    createJoinLink: async (id, groupId, employee, opts) => {
      calls.push({ fn: "createJoinLink", id, groupId, employee, opts });
      return { code: 200, invite_link: "https://t.me/+x" };
    },
  };
};

const mappingRepo = { getEmployeeForMatching: async (id) => ({ employee_id: id, store_id: 5 }) };

function routesFor(m, scope) {
  const out = [];
  for (const layer of buildRoutes({}, tagging, scope, m, mappingRepo).getRouter().stack) {
    if (!layer.route) continue;
    out.push({
      method: Object.keys(layer.route.methods)[0].toUpperCase(),
      path: layer.route.path,
      guard: layer.route.stack.map((s) => s.handle.__guard).find(Boolean) || null,
      stack: layer.route.stack.map((s) => s.handle),
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

/** Run a route's whole middleware chain, guard included. */
async function run(route, req) {
  const res = fakeRes();
  for (const handler of route.stack) {
    let advanced = false;
    await handler(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

describe("the two endpoints", () => {
  const routes = routesFor(membership(), branchScope());

  it("exist under the employee they belong to", () => {
    assert.ok(find(routes, "GET", "/telegram/groups"));
    assert.ok(find(routes, "POST", "join-link"));
  });

  it("READ is view_employees - the same key as every other employee status", () => {
    assert.deepEqual(find(routes, "GET", "/telegram/groups").guard, {
      keys: [P.VIEW_EMPLOYEES],
      mode: "any",
    });
  });

  it("WRITE IS STILL employee_create OR employee_edit - NOT the identity AND", () => {
    /*
     * THE IDENTITY MUTATIONS WERE TIGHTENED AND THIS ONE WAS NOT, and the
     * MODE is asserted so that is a decision rather than a leftover.
     *
     * `components/hr/TelegramRequiredGroups.jsx` draws Join Link / New Link
     * from GROUP STATE and is never passed `canManageTelegram`, so requiring
     * both keys here would leave a visible button answering 403. Joining a
     * group an employee is already mapped to is also not the decision the
     * conjunction guards, which is attaching or retiring their IDENTITY.
     *
     * Tightening it starts on the screen, not here.
     */
    assert.deepEqual(find(routes, "POST", "join-link").guard, {
      keys: [P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT],
      mode: "any",
    });
  });

  it("mints no new permission key", () => {
    for (const route of routes) {
      for (const key of route.guard ? route.guard.keys : []) {
        assert.ok(
          [P.VIEW_EMPLOYEES, P.EMPLOYEE_CREATE, P.EMPLOYEE_EDIT].includes(key),
          `unexpected key ${key}`
        );
      }
    }
  });

  it("are absent entirely when the membership usecase is not wired", () => {
    const without = routesFor(null, branchScope());
    assert.equal(without.filter((r) => /groups|join-link/.test(r.path)).length, 0);
    assert.ok(without.length >= 3, "the existing identity endpoints survive");
  });
});

describe("branch scope", () => {
  it("guards the READ with requireEmployeeInScope", async () => {
    const scope = branchScope();
    const m = membership();
    const routes = routesFor(m, scope);
    await run(find(routes, "GET", "/telegram/groups"), { params: { employee_id: "42" }, query: {} });
    assert.deepEqual(scope.checked, [42]);
    assert.equal(m.calls[0].fn, "getGroups");
  });

  it("REFUSES a read for another branch's employee, and the usecase never runs", async () => {
    const scope = branchScope(77);
    const m = membership();
    const routes = routesFor(m, scope);
    const res = await run(find(routes, "GET", "/telegram/groups"), {
      params: { employee_id: "77" },
      query: {},
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(m.calls, [], "no Telegram state may leak for an out-of-branch employee");
  });

  it("REFUSES issuing a join link for another branch's employee", async () => {
    const scope = branchScope(77);
    const m = membership();
    const routes = routesFor(m, scope);
    const res = await run(find(routes, "POST", "join-link"), {
      params: { employee_id: "77", telegram_group_id: "10" },
      body: {},
    });
    assert.equal(res.statusCode, 403);
    assert.deepEqual(m.calls, [], "no link may be created for an out-of-branch employee");
  });

  it("allows an in-scope employee through to the usecase", async () => {
    const m = membership();
    const routes = routesFor(m, branchScope(77));
    await run(find(routes, "POST", "join-link"), {
      params: { employee_id: "42", telegram_group_id: "10" },
      body: {},
    });
    assert.equal(m.calls[0].fn, "createJoinLink");
    assert.equal(m.calls[0].id, 42);
    assert.equal(m.calls[0].groupId, 10);
  });
});

describe("the join-link request body", () => {
  it("must be empty - nothing about the join comes from the browser", async () => {
    const m = membership();
    const routes = routesFor(m, branchScope());
    const res = await run(find(routes, "POST", "join-link"), {
      params: { employee_id: "42", telegram_group_id: "10" },
      body: { telegram_user_id: 999, employee_id: 1, expires_in_minutes: 99999 },
    });
    // This router reports failures as a `code` in the BODY rather than an
    // HTTP status - the existing `_fail`/`respondError` convention, shared
    // with every other endpoint here and not changed by this phase.
    assert.ok(res.body && res.body.code >= 400, `expected a refusal, got ${JSON.stringify(res.body)}`);
    assert.match(res.body.msg, /not allowed/);
    assert.deepEqual(m.calls, [], "a crafted body must not reach the usecase");
  });

  it("takes the group from the path, digits only", () => {
    const route = find(routesFor(membership(), branchScope()), "POST", "join-link");
    assert.match(route.path, /:telegram_group_id\(\\d\+\)/);
  });
});

describe("no membership-removal endpoint exists", () => {
  it("there is no leave, remove, kick or ban route", () => {
    for (const route of routesFor(membership(), branchScope())) {
      assert.ok(
        !/leave|remove|kick|ban|reconcile/i.test(route.path),
        `Phase 3B must expose no removal route, found ${route.method} ${route.path}`
      );
    }
  });
});
