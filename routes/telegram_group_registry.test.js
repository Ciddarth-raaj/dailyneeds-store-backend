/**
 * The Telegram Group Registry API: which key guards each endpoint, and that
 * a refused body never reaches the usecase.
 *
 *   node --test routes/telegram_group_registry.test.js
 *
 * READS AND WRITES ARE SEPARATE KEYS. Opening the registry is
 * `view_telegram_groups`; adding, editing and deleting are
 * `manage_telegram_groups`. The model screen, Remarks Master, gates nothing
 * on the server at all and relies on the menu hiding itself - that is
 * presentation, not a check, and it is deliberately not copied here.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildRoutes = require("./telegram_group_registry");
const { PERMISSIONS: P, TELEGRAM_GROUP_CATEGORIES } = require("../constants/telegram_group_registry");

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
  actorFor: async () => ({ employeeId: 7 }),
};

function guardsFor(usecase = {}) {
  const out = [];
  for (const layer of buildRoutes(usecase, tagging).getRouter().stack) {
    if (!layer.route) continue;
    const method = Object.keys(layer.route.methods)[0].toUpperCase();
    out.push({
      method,
      path: layer.route.path,
      guard: layer.route.stack.map((s) => s.handle.__guard).find(Boolean) || null,
      handler: layer.route.stack[layer.route.stack.length - 1].handle,
    });
  }
  return out;
}

/** A minimal Express `res` that records what the handler answered. */
function fakeRes() {
  const res = { statusCode: 200, body: null, ended: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}

describe("the endpoints", () => {
  const guards = guardsFor();

  it("is the five CRUD endpoints and nothing else", () => {
    assert.deepEqual(
      guards.map((g) => `${g.method} ${g.path}`).sort(),
      [
        "DELETE /:telegram_group_id(\\d+)",
        "GET /",
        "GET /:telegram_group_id(\\d+)",
        "POST /",
        "PUT /:telegram_group_id(\\d+)",
      ]
    );
  });

  it("READS require view_telegram_groups", () => {
    assert.equal(P.VIEW_TELEGRAM_GROUPS, "view_telegram_groups");
    for (const g of guards.filter((g) => g.method === "GET")) {
      assert.deepEqual(g.guard, { mode: "any", keys: ["view_telegram_groups"] }, `${g.method} ${g.path}`);
    }
  });

  it("WRITES require manage_telegram_groups, not the read key", () => {
    assert.equal(P.MANAGE_TELEGRAM_GROUPS, "manage_telegram_groups");
    const writes = guards.filter((g) => g.method !== "GET");
    assert.equal(writes.length, 3, "add, edit and delete");
    for (const g of writes) {
      assert.deepEqual(g.guard, { mode: "any", keys: ["manage_telegram_groups"] }, `${g.method} ${g.path}`);
      assert.ok(!g.guard.keys.includes(P.VIEW_TELEGRAM_GROUPS), "reading is not permission to write");
    }
  });

  it("every endpoint is guarded - none is left open", () => {
    for (const g of guards) assert.notEqual(g.guard, null, `${g.method} ${g.path} is unguarded`);
  });

  it("the id parameter accepts digits only, so /telegram-groups/anything cannot reach a handler", () => {
    for (const g of guards.filter((g) => g.path !== "/")) {
      assert.match(g.path, /\(\\d\+\)$/);
    }
  });
});

describe("the list endpoint", () => {
  it("answers with the rows and the allowed categories", async () => {
    const rows = [{ telegram_group_id: 1, group_name: "Attendance Alerts" }];
    const guards = guardsFor({ getAll: async () => rows });
    const list = guards.find((g) => g.method === "GET" && g.path === "/");
    const res = fakeRes();
    await list.handler({ query: {} }, res);
    assert.equal(res.body.code, 200);
    assert.deepEqual(res.body.data, rows);
    assert.deepEqual(res.body.categories, TELEGRAM_GROUP_CATEGORIES);
  });

  it("passes the search and category filters through to the usecase", async () => {
    let seen = null;
    const guards = guardsFor({
      getAll: async (filters) => {
        seen = filters;
        return [];
      },
    });
    const list = guards.find((g) => g.method === "GET" && g.path === "/");
    await list.handler({ query: { search: "fridge", category: "Maintenance" } }, fakeRes());
    assert.deepEqual(seen, { search: "fridge", category: "Maintenance" });
  });

  it("a category the usecase refuses comes back as a 422 validation message, not a 500", async () => {
    const guards = guardsFor({
      getAll: async () => {
        const err = new Error("Category must be one of: Attendance, Maintenance, HR, Other");
        err.name = "ValidationError";
        throw err;
      },
    });
    const list = guards.find((g) => g.method === "GET" && g.path === "/");
    const res = fakeRes();
    await list.handler({ query: { category: "Payroll" } }, res);
    assert.equal(res.body.code, 422);
    assert.match(res.body.msg, /Category must be one of/);
  });
});

describe("the write endpoints", () => {
  it("a body missing a required field never reaches the usecase", async () => {
    let called = false;
    const guards = guardsFor({
      create: async () => {
        called = true;
        return { code: 200 };
      },
    });
    const create = guards.find((g) => g.method === "POST");
    const res = fakeRes();
    await create.handler({ body: { group_name: "Only a name" } }, res);
    assert.equal(called, false, "Joi refused the shape before any rule ran");
    assert.equal(res.body.code, 422);
  });

  it("a valid body is handed to the usecase together with the actor", async () => {
    let seen = null;
    const guards = guardsFor({
      create: async (body, actor) => {
        seen = { body, actor };
        return { code: 200, telegram_group_id: 5 };
      },
    });
    const create = guards.find((g) => g.method === "POST");
    const res = fakeRes();
    const body = {
      group_name: "Attendance Alerts",
      chat_id: "-1001234567890",
      category: "Attendance",
      used_for: "Daily missing-punch alerts",
      bot_is_admin: true,
    };
    await create.handler({ body }, res);
    assert.deepEqual(seen.body, body);
    assert.deepEqual(seen.actor, { employeeId: 7 });
    assert.equal(res.body.telegram_group_id, 5);
  });

  it("the Chat ID reaches the usecase unfiltered, so its own message is what the user sees", async () => {
    // Joi deliberately does NOT carry a pattern for chat_id: a pattern
    // failure would flatten "that is a user id, not a group" into a generic
    // "does not match", which is the one sentence worth keeping.
    const guards = guardsFor({
      create: async () => {
        const err = new Error("A positive Telegram ID belongs to an individual user, not a group.");
        err.name = "ValidationError";
        throw err;
      },
    });
    const create = guards.find((g) => g.method === "POST");
    const res = fakeRes();
    await create.handler(
      {
        body: {
          group_name: "Wrong",
          chat_id: "1234567890",
          category: "Other",
          used_for: "x",
          bot_is_admin: false,
        },
      },
      res
    );
    assert.equal(res.body.code, 422);
    assert.match(res.body.msg, /individual user/);
  });

  it("an edit sends only the fields it was given, so a partial update stays partial", async () => {
    let seen = null;
    const guards = guardsFor({
      update: async (id, body) => {
        seen = { id, body };
        return { code: 200, affectedRows: 1 };
      },
    });
    const update = guards.find((g) => g.method === "PUT");
    await update.handler({ params: { telegram_group_id: "12" }, body: { group_name: "Renamed" } }, fakeRes());
    assert.deepEqual(seen, { id: 12, body: { group_name: "Renamed" } });
  });

  it("a delete of a missing row answers 404, not 200", async () => {
    const guards = guardsFor({
      delete: async () => {
        const err = new Error("Telegram group not found");
        err.name = "NotFoundError";
        err.httpCode = 404;
        throw err;
      },
    });
    const del = guards.find((g) => g.method === "DELETE");
    const res = fakeRes();
    await del.handler({ params: { telegram_group_id: "404" } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 404);
    assert.match(res.body.msg, /not found/i);
  });
});
