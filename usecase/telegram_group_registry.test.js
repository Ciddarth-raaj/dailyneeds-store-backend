/**
 * Telegram Group Registry - the usecase, over a fake repository with the
 * exact shape the real one returns.
 *
 *   node --test usecase/telegram_group_registry.test.js
 *
 * What is defended here is every rule the screen relies on and the UI alone
 * cannot guarantee, because the UI is not what stops a request:
 *
 *   Chat ID     `-100…` accepted as a Supergroup; any other negative id
 *               accepted as a Basic Group; POSITIVE, ZERO, letters, spaces,
 *               decimals and mixed strings all refused
 *   duplicates  refused on create, and on edit AGAINST OTHER ROWS ONLY - a
 *               record keeping its own Chat ID must save
 *   category    required, the four values accepted, anything else refused
 *               even though the UI only offers four
 *   outlet      nullable, and validated when given
 *   warnings    the Basic Group warning and the bot-not-admin flag are
 *               ADVISORY: both rows save, and both carry their warning
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const build = require("../usecase/telegram_group_registry");
const {
  TELEGRAM_GROUP_CATEGORIES,
  MESSAGES,
  GROUP_TYPE,
} = require("../constants/telegram_group_registry");

const SUPERGROUP = "-1001234567890";
const BASIC = "-4800060153";

/** A registry row exactly as `repository#getById` hands one back. */
const row = (overrides = {}) => ({
  telegram_group_id: 1,
  group_name: "Attendance Alerts",
  chat_id: SUPERGROUP,
  category: "Attendance",
  used_for: "Daily missing-punch alerts",
  outlet_id: null,
  outlet_name: null,
  outlet_code: null,
  bot_is_admin: true,
  created_by: null,
  created_at: "2026-09-15 10:00:00",
  updated_by: null,
  updated_at: "2026-09-15 10:00:00",
  ...overrides,
});

function fakeRepo(rows = [], { outletIds = [1, 2] } = {}) {
  const store = { rows: rows.map((r) => ({ ...r })), writes: [], deletes: [] };
  let nextId = 100;
  return {
    store,
    getAll: async ({ search, category } = {}) =>
      store.rows.filter((r) => {
        if (category && r.category !== category) return false;
        if (search) {
          const hay = `${r.group_name} ${r.chat_id} ${r.used_for}`.toLowerCase();
          if (!hay.includes(String(search).toLowerCase())) return false;
        }
        return true;
      }),
    getById: async (id) => store.rows.find((r) => r.telegram_group_id === id) || null,
    getByChatId: async (chatId, excludeId = null) =>
      store.rows.find(
        (r) => r.chat_id === String(chatId) && (excludeId == null || r.telegram_group_id !== excludeId)
      ) || null,
    outletExists: async (id) => outletIds.includes(Number(id)),
    create: async (r) => {
      const id = nextId;
      nextId += 1;
      store.rows.push({ ...row(), ...r, telegram_group_id: id, bot_is_admin: Boolean(r.bot_is_admin) });
      store.writes.push({ op: "create", ...r });
      return { code: 200, telegram_group_id: id };
    },
    update: async (id, fields, updated_by) => {
      const target = store.rows.find((r) => r.telegram_group_id === id);
      if (target) Object.assign(target, fields);
      store.writes.push({ op: "update", id, fields, updated_by });
      return { code: 200, affectedRows: target ? 1 : 0 };
    },
    delete: async (id) => {
      store.deletes.push(id);
      store.rows = store.rows.filter((r) => r.telegram_group_id !== id);
      return { code: 200, affectedRows: 1 };
    },
  };
}

const valid = (overrides = {}) => ({
  group_name: "Attendance Alerts",
  chat_id: SUPERGROUP,
  category: "Attendance",
  used_for: "Daily missing-punch alerts",
  bot_is_admin: true,
  ...overrides,
});

/** The ValidationError a call throws, or `null` if it resolved. */
async function refusal(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

/* ==================================================== the Chat ID rules == */

describe("Chat ID", () => {
  it("accepts a -100… id and derives Supergroup", async () => {
    const repo = fakeRepo();
    const result = await build(repo).create(valid({ chat_id: SUPERGROUP }));
    assert.equal(result.code, 200);
    assert.equal(result.group_type, GROUP_TYPE.SUPERGROUP);
    assert.equal(repo.store.rows[0].chat_id, SUPERGROUP);
  });

  it("accepts another negative id and derives Basic Group", async () => {
    const repo = fakeRepo();
    const result = await build(repo).create(valid({ chat_id: BASIC }));
    assert.equal(result.code, 200);
    assert.equal(result.group_type, GROUP_TYPE.BASIC_GROUP);
  });

  it("REFUSES a positive id, and says it belongs to an individual", async () => {
    // The whole reason the rule is `^-\d+$` and not `^-?\d+$`: a positive
    // Telegram id is a person, so accepting one would point group
    // announcements at somebody's private chat.
    const err = await refusal(build(fakeRepo()).create(valid({ chat_id: "1234567890" })));
    assert.equal(err.name, "ValidationError");
    assert.equal(err.message, MESSAGES.CHAT_ID_POSITIVE);
    assert.match(err.message, /individual user/);
  });

  it("refuses an explicitly signed +id as the same mistake", async () => {
    const err = await refusal(build(fakeRepo()).create(valid({ chat_id: "+1234567890" })));
    assert.equal(err.message, MESSAGES.CHAT_ID_POSITIVE);
  });

  it("REFUSES zero", async () => {
    const err = await refusal(build(fakeRepo()).create(valid({ chat_id: "0" })));
    assert.equal(err.name, "ValidationError");
    assert.equal(err.message, MESSAGES.CHAT_ID_POSITIVE);
  });

  it("refuses -0 - it is not a real chat", async () => {
    // `-0` passes `^-\d+$` by shape, so this is checked explicitly rather
    // than assumed: it is a zero with a sign, not a group.
    const err = await refusal(build(fakeRepo()).create(valid({ chat_id: "-0" })));
    assert.equal(err.name, "ValidationError");
  });

  it("refuses letters, mixed strings, spaces and decimals", async () => {
    for (const bad of [
      "abc",
      "-100abc",
      "chat-1001234567890",
      "-100 123",
      " -100123 456",
      "-1001234.5",
      "-1.5",
      "-",
      "",
      null,
      undefined,
    ]) {
      const err = await refusal(build(fakeRepo()).create(valid({ chat_id: bad })));
      assert.equal(err && err.name, "ValidationError", `${JSON.stringify(bad)} must be refused`);
    }
  });

  it("trims surrounding whitespace rather than refusing a pasted id", async () => {
    const repo = fakeRepo();
    await build(repo).create(valid({ chat_id: `  ${SUPERGROUP}  ` }));
    assert.equal(repo.store.rows[0].chat_id, SUPERGROUP);
  });
});

/* ===================================================== uniqueness ======== */

describe("Chat ID uniqueness", () => {
  it("refuses a duplicate on create", async () => {
    const repo = fakeRepo([row()]);
    const err = await refusal(build(repo).create(valid({ group_name: "Second" })));
    assert.equal(err.name, "ValidationError");
    assert.match(err.message, new RegExp(MESSAGES.CHAT_ID_DUPLICATE));
    assert.equal(repo.store.rows.length, 1, "nothing was written");
  });

  it("EDITING A RECORD KEEPS ITS OWN CHAT ID", async () => {
    // The defect this exists to prevent: comparing against every row
    // including itself, so saving an unchanged group is refused as a clash
    // with itself and the record can never be edited again.
    const repo = fakeRepo([row()]);
    const result = await build(repo).update(1, {
      group_name: "Attendance Alerts (renamed)",
      chat_id: SUPERGROUP,
    });
    assert.equal(result.code, 200);
    assert.equal(repo.store.rows[0].group_name, "Attendance Alerts (renamed)");
  });

  it("still refuses an edit onto ANOTHER row's Chat ID", async () => {
    const repo = fakeRepo([row(), row({ telegram_group_id: 2, chat_id: BASIC, group_name: "Other" })]);
    const err = await refusal(build(repo).update(2, { chat_id: SUPERGROUP }));
    assert.equal(err.name, "ValidationError");
    assert.equal(repo.store.rows[1].chat_id, BASIC, "the row is unchanged");
  });
});

/* ======================================================= category ======== */

describe("Category", () => {
  it("is required", async () => {
    for (const missing of [undefined, null, "", "   "]) {
      const err = await refusal(build(fakeRepo()).create(valid({ category: missing })));
      assert.equal(err && err.name, "ValidationError");
      assert.match(err.message, /Category is required/);
    }
  });

  for (const category of TELEGRAM_GROUP_CATEGORIES) {
    it(`accepts ${category}`, async () => {
      const repo = fakeRepo();
      const result = await build(repo).create(valid({ category, chat_id: `-100${category.length}00000` }));
      assert.equal(result.code, 200);
      assert.equal(repo.store.rows[0].category, category);
    });
  }

  it("lists exactly the four approved values and no more", async () => {
    assert.deepEqual(TELEGRAM_GROUP_CATEGORIES, ["Attendance", "Maintenance", "HR", "Other"]);
  });

  it("REFUSES an unsupported category even though the UI only offers four", async () => {
    for (const bad of ["Payroll", "attendance-alerts", "Finance", "1", "Attendance "]) {
      if (bad.trim().toLowerCase() === "attendance") continue; // trimmed match is legitimate
      const err = await refusal(build(fakeRepo()).create(valid({ category: bad })));
      assert.equal(err && err.name, "ValidationError", `${bad} must be refused`);
      assert.match(err.message, /Category must be one of/);
    }
  });

  it("matches case-insensitively and stores the canonical spelling", async () => {
    const repo = fakeRepo();
    await build(repo).create(valid({ category: "hr" }));
    assert.equal(repo.store.rows[0].category, "HR");
  });
});

/* ===================================== outlet, bot admin and warnings ==== */

describe("Outlet", () => {
  it("is optional - a company-wide group saves with none", async () => {
    const repo = fakeRepo();
    const result = await build(repo).create(valid({ outlet_id: null }));
    assert.equal(result.code, 200);
    assert.equal(repo.store.rows[0].outlet_id, null);
  });

  it("treats an empty string from the form as no outlet", async () => {
    const repo = fakeRepo();
    await build(repo).create(valid({ outlet_id: "" }));
    assert.equal(repo.store.rows[0].outlet_id, null);
  });

  it("accepts an existing outlet", async () => {
    const repo = fakeRepo();
    await build(repo).create(valid({ outlet_id: 2 }));
    assert.equal(repo.store.rows[0].outlet_id, 2);
  });

  it("refuses an outlet that does not exist", async () => {
    const err = await refusal(build(fakeRepo()).create(valid({ outlet_id: 99 })));
    assert.equal(err.name, "ValidationError");
    assert.match(err.message, /Outlet is not valid/);
  });

  it("can be cleared on edit", async () => {
    const repo = fakeRepo([row({ outlet_id: 1 })]);
    await build(repo).update(1, { outlet_id: null });
    assert.equal(repo.store.rows[0].outlet_id, null);
  });
});

describe("Bot Is Admin", () => {
  it("is required", async () => {
    const err = await refusal(build(fakeRepo()).create(valid({ bot_is_admin: undefined })));
    assert.equal(err.name, "ValidationError");
    assert.match(err.message, /Bot Is Admin is required/);
  });

  it("accepts Yes and carries no bot warning", async () => {
    const repo = fakeRepo();
    const result = await build(repo).create(valid({ bot_is_admin: true }));
    assert.equal(repo.store.rows[0].bot_is_admin, true);
    assert.ok(!result.warnings.includes(MESSAGES.BOT_NOT_ADMIN_WARNING));
  });

  it("ACCEPTS No - the record is allowed - and flags it", async () => {
    const repo = fakeRepo();
    const result = await build(repo).create(valid({ bot_is_admin: false }));
    assert.equal(result.code, 200, "the row is saved, not refused");
    assert.equal(repo.store.rows[0].bot_is_admin, false);
    assert.ok(result.warnings.includes(MESSAGES.BOT_NOT_ADMIN_WARNING));
    assert.match(MESSAGES.BOT_NOT_ADMIN_WARNING, /Member-removal functionality will not work/);
  });

  it("accepts the shapes a form sends", async () => {
    const repo = fakeRepo();
    for (const [i, yes] of [true, 1, "1", "true", "Yes"].entries()) {
      await build(repo).create(valid({ chat_id: `-10011122${i}`, bot_is_admin: yes }));
    }
    for (const [i, no] of [false, 0, "0", "false", "No"].entries()) {
      await build(repo).create(valid({ chat_id: `-10022233${i}`, bot_is_admin: no }));
    }
    assert.equal(repo.store.rows.filter((r) => r.bot_is_admin === true).length, 5);
    assert.equal(repo.store.rows.filter((r) => r.bot_is_admin === false).length, 5);
  });

  it("refuses a value that is neither", async () => {
    const err = await refusal(build(fakeRepo()).create(valid({ bot_is_admin: "maybe" })));
    assert.equal(err.name, "ValidationError");
  });
});

describe("warnings", () => {
  it("a Basic Group SAVES and carries the conversion warning", async () => {
    const repo = fakeRepo();
    const result = await build(repo).create(valid({ chat_id: BASIC }));
    assert.equal(result.code, 200, "saving is never blocked");
    assert.ok(result.warnings.includes(MESSAGES.BASIC_GROUP_WARNING));
    assert.match(MESSAGES.BASIC_GROUP_WARNING, /converted to a Supergroup/);
  });

  it("a Supergroup with an admin bot carries no warning at all", async () => {
    const result = await build(fakeRepo()).create(valid({ chat_id: SUPERGROUP, bot_is_admin: true }));
    assert.deepEqual(result.warnings, []);
  });

  it("both warnings appear together when both apply", async () => {
    const result = await build(fakeRepo()).create(valid({ chat_id: BASIC, bot_is_admin: false }));
    assert.equal(result.warnings.length, 2);
  });

  it("every listed row carries its derived type and warnings", async () => {
    const repo = fakeRepo([
      row(),
      row({ telegram_group_id: 2, chat_id: BASIC, bot_is_admin: false }),
    ]);
    const list = await build(repo).getAll();
    assert.equal(list[0].group_type, GROUP_TYPE.SUPERGROUP);
    assert.deepEqual(list[0].warnings, []);
    assert.equal(list[1].group_type, GROUP_TYPE.BASIC_GROUP);
    assert.equal(list[1].warnings.length, 2);
  });

  it("GROUP TYPE IS NEVER WRITTEN - it is derived from the Chat ID", async () => {
    const repo = fakeRepo();
    await build(repo).create(valid({ group_type: "Supergroup", chat_id: BASIC }));
    const written = repo.store.writes[0];
    assert.equal(written.group_type, undefined, "a caller cannot set the type");
    const listed = await build(repo).getAll();
    assert.equal(listed[0].group_type, GROUP_TYPE.BASIC_GROUP, "the id decides, not the caller");
  });
});

/* ===================================================== list and delete === */

describe("list filtering", () => {
  const seeded = () =>
    fakeRepo([
      row({ telegram_group_id: 1, group_name: "Attendance Alerts", category: "Attendance", chat_id: SUPERGROUP }),
      row({ telegram_group_id: 2, group_name: "Fridge Repairs", category: "Maintenance", chat_id: "-1009999", used_for: "AC and fridge breakdowns" }),
      row({ telegram_group_id: 3, group_name: "HR Notices", category: "HR", chat_id: BASIC }),
    ]);

  it("filters by category", async () => {
    const list = await build(seeded()).getAll({ category: "Maintenance" });
    assert.equal(list.length, 1);
    assert.equal(list[0].group_name, "Fridge Repairs");
  });

  it("accepts a category filter in any case", async () => {
    const list = await build(seeded()).getAll({ category: "hr" });
    assert.equal(list.length, 1);
    assert.equal(list[0].category, "HR");
  });

  it("REFUSES an unsupported category filter rather than silently listing everything", async () => {
    const err = await refusal(build(seeded()).getAll({ category: "Payroll" }));
    assert.equal(err.name, "ValidationError");
  });

  it("searches name, chat id and used-for", async () => {
    const usecase = build(seeded());
    assert.equal((await usecase.getAll({ search: "Fridge" })).length, 1);
    assert.equal((await usecase.getAll({ search: BASIC })).length, 1);
    assert.equal((await usecase.getAll({ search: "breakdowns" })).length, 1);
  });

  it("an empty filter lists everything", async () => {
    assert.equal((await build(seeded()).getAll({ search: "", category: "" })).length, 3);
    assert.equal((await build(seeded()).getAll()).length, 3);
  });
});

describe("read, delete and missing rows", () => {
  it("getById decorates the row", async () => {
    const found = await build(fakeRepo([row({ chat_id: BASIC })])).getById(1);
    assert.equal(found.group_type, GROUP_TYPE.BASIC_GROUP);
    assert.ok(Array.isArray(found.warnings));
  });

  it("getById answers null for an unknown id", async () => {
    assert.equal(await build(fakeRepo()).getById(404), null);
  });

  it("deletes an existing row", async () => {
    const repo = fakeRepo([row()]);
    const result = await build(repo).delete(1);
    assert.equal(result.code, 200);
    assert.deepEqual(repo.store.rows, []);
  });

  it("refuses to delete or edit an id that does not exist", async () => {
    assert.equal((await refusal(build(fakeRepo()).delete(404))).httpCode, 404);
    assert.equal((await refusal(build(fakeRepo()).update(404, { group_name: "x" }))).httpCode, 404);
  });
});

describe("required text", () => {
  it("Group Name and Used For are required and bounded", async () => {
    for (const field of ["group_name", "used_for"]) {
      const missing = await refusal(build(fakeRepo()).create(valid({ [field]: "   " })));
      assert.equal(missing.name, "ValidationError");
      const tooLong = await refusal(build(fakeRepo()).create(valid({ [field]: "x".repeat(300) })));
      assert.equal(tooLong.name, "ValidationError");
    }
  });

  it("trims what it stores", async () => {
    const repo = fakeRepo();
    await build(repo).create(valid({ group_name: "  Attendance Alerts  ", used_for: "  alerts  " }));
    assert.equal(repo.store.rows[0].group_name, "Attendance Alerts");
    assert.equal(repo.store.rows[0].used_for, "alerts");
  });
});
