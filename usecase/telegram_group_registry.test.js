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
  is_active: true,
  created_by: null,
  created_at: "2026-09-15 10:00:00",
  updated_by: null,
  updated_at: "2026-09-15 10:00:00",
  ...overrides,
});

function fakeRepo(rows = [], { outletIds = [1, 2] } = {}) {
  const store = { rows: rows.map((r) => ({ ...r })), writes: [], deletes: [], transactions: 0, locks: [] };
  let nextId = 100;
  return {
    store,
    getAll: async ({ search, category, outlet_id, bot_is_admin, is_active } = {}) =>
      store.rows.filter((r) => {
        if (category && r.category !== category) return false;
        if (outlet_id === "none" && r.outlet_id !== null) return false;
        if (outlet_id !== undefined && outlet_id !== "none" && Number(r.outlet_id) !== Number(outlet_id)) return false;
        if (bot_is_admin !== undefined && Boolean(r.bot_is_admin) !== bot_is_admin) return false;
        if (is_active !== undefined && Boolean(r.is_active) !== is_active) return false;
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
      store.rows.push({
        ...row(),
        ...r,
        telegram_group_id: id,
        bot_is_admin: Boolean(r.bot_is_admin),
        is_active: r.is_active === undefined ? true : Boolean(r.is_active),
      });
      store.writes.push({ op: "create", ...r });
      return { code: 200, telegram_group_id: id };
    },
    update: async (id, fields, updated_by, options = {}) => {
      const target = store.rows.find((r) => r.telegram_group_id === id);
      if (target) Object.assign(target, fields);
      store.writes.push({ op: "update", id, fields, updated_by, tx: Boolean(options.tx) });
      return { code: 200, affectedRows: target ? 1 : 0 };
    },
    /**
     * Phase 3C wraps the guarded writes - the Chat ID change and the hard
     * delete - so a mapping or claim created between the check and the write
     * cannot slip through. The double offers one for the same reason the
     * real repository does, and records that the write carried it.
     */
    withTransaction: async (fn) => {
      store.transactions += 1;
      return fn({ query: async () => ({ affectedRows: 1 }) });
    },
    /**
     * The guard locks this row before it counts anything - it is what stops
     * a new mapping or claim being inserted while the decision is being
     * made. The double records that it was asked for.
     */
    lockForUpdate: async (id, options = {}) => {
      store.locks.push({ id, tx: Boolean(options.tx) });
      return store.rows.find((r) => r.telegram_group_id === id) || null;
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

  it("REFUSES LEADING AND TRAILING WHITESPACE - it never trims a bad id into a good one", async () => {
    // The approved rule is `^-\d+$` and it applies to the value that was
    // submitted. Trimming first would turn a string the rule refuses into
    // one it accepts, so the check would be judging a value nobody sent and
    // the row would be stored under an id the user never typed.
    for (const padded of [` ${SUPERGROUP}`, `${SUPERGROUP} `, ` ${SUPERGROUP} `, `\t${SUPERGROUP}`, `${SUPERGROUP}\n`]) {
      const repo = fakeRepo();
      const err = await refusal(build(repo).create(valid({ chat_id: padded })));
      assert.equal(err && err.name, "ValidationError", `${JSON.stringify(padded)} must be refused`);
      assert.equal(err.message, MESSAGES.CHAT_ID_FORMAT);
      assert.deepEqual(repo.store.rows, [], "nothing was written");
    }
  });

  it("refuses a padded id on EDIT as well, not only on create", async () => {
    const repo = fakeRepo([row()]);
    const err = await refusal(build(repo).update(1, { chat_id: ` ${BASIC} ` }));
    assert.equal(err.name, "ValidationError");
    assert.equal(err.message, MESSAGES.CHAT_ID_FORMAT);
    assert.equal(repo.store.rows[0].chat_id, SUPERGROUP, "the row is unchanged");
  });

  it("refuses whitespace INSIDE the id", async () => {
    const err = await refusal(build(fakeRepo()).create(valid({ chat_id: "-100 1234567890" })));
    assert.equal(err.name, "ValidationError");
    assert.equal(err.message, MESSAGES.CHAT_ID_FORMAT);
  });

  it("refuses a whitespace-only id as malformed, and an absent one as missing", async () => {
    const blank = await refusal(build(fakeRepo()).create(valid({ chat_id: "   " })));
    assert.equal(blank.message, MESSAGES.CHAT_ID_FORMAT);
    const absent = await refusal(build(fakeRepo()).create(valid({ chat_id: "" })));
    assert.equal(absent.message, MESSAGES.CHAT_ID_REQUIRED);
  });

  it("STORES THE EXACT VALIDATED STRING", async () => {
    const repo = fakeRepo();
    await build(repo).create(valid({ chat_id: SUPERGROUP }));
    assert.equal(repo.store.rows[0].chat_id, SUPERGROUP);
    assert.equal(repo.store.writes[0].chat_id, SUPERGROUP);
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

  it("lists exactly the approved values and no more", async () => {
    // Display order, which is deliberately not the schema's order - the ENUM
    // appends Marketing last because appending rewrites no row, while
    // reordering existing members renumbers and rewrites every row.
    assert.deepEqual(TELEGRAM_GROUP_CATEGORIES, [
      "Attendance",
      "Maintenance",
      "HR",
      "Marketing",
      "Other",
    ]);
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

/* ========================================== status and the new filters === */

describe("Status", () => {
  it("defaults to Active when the caller does not say", async () => {
    // A group somebody is registering is one they are about to use; a
    // required field with one sensible answer is just an extra click.
    const repo = fakeRepo();
    await build(repo).create(valid());
    assert.equal(repo.store.rows[0].is_active, true);
  });

  it("accepts Active and Inactive on create", async () => {
    const repo = fakeRepo();
    await build(repo).create(valid({ chat_id: "-100111", is_active: "Active" }));
    await build(repo).create(valid({ chat_id: "-100222", is_active: "Inactive" }));
    assert.equal(repo.store.rows[0].is_active, true);
    assert.equal(repo.store.rows[1].is_active, false);
  });

  it("accepts the shapes a form sends", async () => {
    const repo = fakeRepo();
    for (const [i, yes] of [true, 1, "1", "true", "Yes", "Active"].entries()) {
      await build(repo).create(valid({ chat_id: `-10055${i}`, is_active: yes }));
    }
    assert.equal(repo.store.rows.filter((r) => r.is_active === true).length, 6);
  });

  it("refuses a value that is neither", async () => {
    const err = await refusal(build(fakeRepo()).create(valid({ is_active: "retired" })));
    assert.equal(err.name, "ValidationError");
    assert.equal(err.message, MESSAGES.STATUS_INVALID);
  });

  it("can be changed on edit, and an untouched edit leaves it alone", async () => {
    const repo = fakeRepo([row()]);
    await build(repo).update(1, { is_active: false });
    assert.equal(repo.store.rows[0].is_active, false);
    await build(repo).update(1, { group_name: "Renamed" });
    assert.equal(repo.store.rows[0].is_active, false, "a rename does not reactivate");
  });

  it("IS NOT THE BOT-ADMIN FLAG - a group is Active with a non-admin bot", async () => {
    const repo = fakeRepo();
    const result = await build(repo).create(valid({ bot_is_admin: false }));
    assert.equal(repo.store.rows[0].is_active, true);
    assert.ok(result.warnings.includes(MESSAGES.BOT_NOT_ADMIN_WARNING));
  });
});

describe("Marketing", () => {
  it("is an accepted category", async () => {
    const repo = fakeRepo();
    const result = await build(repo).create(valid({ category: "Marketing" }));
    assert.equal(result.code, 200);
    assert.equal(repo.store.rows[0].category, "Marketing");
  });

  it("is still refused when misspelt, like every other category", async () => {
    const err = await refusal(build(fakeRepo()).create(valid({ category: "Markting" })));
    assert.equal(err.name, "ValidationError");
  });
});

describe("the outlet and bot-admin filters", () => {
  const seeded = () =>
    fakeRepo([
      row({ telegram_group_id: 1, chat_id: "-100111", outlet_id: 1, bot_is_admin: true, is_active: true }),
      row({ telegram_group_id: 2, chat_id: "-100222", outlet_id: 2, bot_is_admin: false, is_active: true }),
      row({ telegram_group_id: 3, chat_id: "-100333", outlet_id: null, bot_is_admin: true, is_active: false }),
    ]);

  it("filters by outlet", async () => {
    const list = await build(seeded()).getAll({ outlet_id: 2 });
    assert.equal(list.length, 1);
    assert.equal(list[0].telegram_group_id, 2);
  });

  it("'none' finds the company-wide groups, which an outlet id cannot express", async () => {
    const list = await build(seeded()).getAll({ outlet_id: "none" });
    assert.equal(list.length, 1);
    assert.equal(list[0].outlet_id, null);
  });

  it("filters by bot admin, in both directions", async () => {
    assert.equal((await build(seeded()).getAll({ bot_is_admin: "No" })).length, 1);
    assert.equal((await build(seeded()).getAll({ bot_is_admin: "Yes" })).length, 2);
  });

  it("filters by status", async () => {
    assert.equal((await build(seeded()).getAll({ is_active: "Inactive" })).length, 1);
    assert.equal((await build(seeded()).getAll({ is_active: "Active" })).length, 2);
  });

  it("an empty filter still lists everything", async () => {
    assert.equal((await build(seeded()).getAll({ outlet_id: "", bot_is_admin: "", is_active: "" })).length, 3);
  });

  it("REFUSES a malformed filter rather than silently listing everything", async () => {
    // Quietly ignoring a filter nobody supports is how a user concludes the
    // filter works and trusts a list that was never narrowed.
    assert.equal((await refusal(build(seeded()).getAll({ bot_is_admin: "maybe" }))).name, "ValidationError");
    assert.equal((await refusal(build(seeded()).getAll({ outlet_id: "abc" }))).name, "ValidationError");
    assert.equal((await refusal(build(seeded()).getAll({ is_active: "sometimes" }))).name, "ValidationError");
  });

  it("combines with the category filter", async () => {
    const repo = seeded();
    const list = await build(repo).getAll({ bot_is_admin: "Yes", is_active: "Active" });
    assert.equal(list.length, 1);
    assert.equal(list[0].telegram_group_id, 1);
  });
});

/* ================================ Phase 3C: the Chat ID is the group ===== */

describe("changing a Chat ID while the group still manages people", () => {
  const OTHER = "-1009999999999";

  /**
   * The registry usecase with Phase 3C's two guard repositories wired.
   *
   * The doubles offer the LOCKING reads, because those are what the guard
   * calls: a plain count answers what was true a moment ago, which is the
   * wrong thing for a guard to act on.
   */
  const guarded = (repo, { mappings = 0, claims = 0, claimRows = null } = {}) =>
    build(repo, {
      mappingRepo: { countForGroupForUpdate: async () => mappings },
      claimRepo: {
        lockAllForGroup: async () =>
          claimRows ||
          Array.from({ length: claims }, () => ({ state: "ACTIVE" })),
      },
    });

  const conflictFrom = async (promise) => {
    const err = await promise.then(
      () => null,
      (caught) => caught
    );
    assert.ok(err, "the update must be refused");
    assert.equal(err.name, "ConflictError");
    assert.equal(err.httpCode, 409);
    return err;
  };

  it("LOCKS THE REGISTRY ROW before it decides anything", async () => {
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    await guarded(repo).update(1, { chat_id: OTHER });
    assert.equal(repo.store.locks.length, 1);
    assert.equal(repo.store.locks[0].tx, true, "and inside the transaction");
  });

  it("is REFUSED while a mapping still points at it", async () => {
    // Re-pointing the row leaves the employees in the old group with
    // nothing recording that they are there, and aims the cleanup that
    // would have removed them somewhere else entirely.
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    const err = await conflictFrom(
      guarded(repo, { mappings: 2 }).update(1, { chat_id: OTHER })
    );
    assert.match(err.message, /mappings/i);
    assert.match(err.message, /Chat ID/);
    assert.equal(repo.store.rows[0].chat_id, SUPERGROUP, "nothing was written");
  });

  it("is REFUSED while a live managed claim exists", async () => {
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    const err = await conflictFrom(guarded(repo, { claims: 1 }).update(1, { chat_id: OTHER }));
    assert.equal(err.detail.unresolved_claims, 1);
    assert.equal(repo.store.rows[0].chat_id, SUPERGROUP);
  });

  it("is ALLOWED once nothing depends on the row", async () => {
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    const result = await guarded(repo).update(1, { chat_id: OTHER });
    assert.equal(result.code, 200);
    assert.equal(repo.store.rows[0].chat_id, OTHER);
  });

  it("AN UNCHANGED Chat ID saves even while the group manages people", async () => {
    // Renaming a busy group, re-categorising it or switching it off are all
    // still ordinary edits. Only the identity of the group is guarded.
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    const result = await guarded(repo, { mappings: 3, claims: 4 }).update(1, {
      chat_id: SUPERGROUP,
      group_name: "Renamed",
    });
    assert.equal(result.code, 200);
    assert.equal(repo.store.rows[0].group_name, "Renamed");
  });

  it("every other field is editable on a group that manages people", async () => {
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    const result = await guarded(repo, { mappings: 3, claims: 4 }).update(1, {
      group_name: "Renamed",
      category: "Other",
      is_active: false,
    });
    assert.equal(result.code, 200);
    assert.equal(repo.store.rows[0].is_active, false);
  });

  it("THE GUARD AND THE WRITE SHARE ONE TRANSACTION", async () => {
    // Otherwise a mapping created between the two slips through the gap the
    // guard exists to close.
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    const seen = [];
    const lockingRepo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    lockingRepo.lockForUpdate = async (id, options) => {
      seen.push(["registry-row", Boolean(options && options.tx)]);
      return { telegram_group_id: id };
    };
    await build(lockingRepo, {
      mappingRepo: {
        countForGroupForUpdate: async (id, options) => {
          seen.push(["mappings", Boolean(options && options.tx)]);
          return 0;
        },
      },
      claimRepo: {
        lockAllForGroup: async (id, options) => {
          seen.push(["claims", Boolean(options && options.tx)]);
          return [];
        },
      },
    }).update(1, { chat_id: OTHER });

    // THE ORDER IS THE DESIGN. The parent row first, because InnoDB checks a
    // foreign key by taking a shared lock on it - so nothing new can be
    // inserted for this group while that exclusive lock is held. Then the
    // existing children, which an insert-lock cannot cover.
    assert.deepEqual(seen, [
      ["registry-row", true],
      ["mappings", true],
      ["claims", true],
    ]);
    Object.assign(repo.store, lockingRepo.store);
    assert.equal(repo.store.transactions, 1);
    assert.equal(repo.store.writes[0].tx, true, "the write itself carries the transaction");
  });

  it("A DEADLOCK IS RETRIED, and the retry decides on what it then sees", async () => {
    // The guard locks the parent before the children; a concurrent upsert
    // reaches them the other way round, so InnoDB can pick either as its
    // victim. That is contention, not a fault - and the retry is what turns
    // it into the right answer rather than a lucky one.
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    let attempts = 0;
    let claims = [];
    const usecase = build(repo, {
      mappingRepo: { countForGroupForUpdate: async () => 0 },
      claimRepo: {
        lockAllForGroup: async () => {
          attempts += 1;
          if (attempts === 1) {
            // The rival commits its reopen and InnoDB rolls us back.
            claims = [{ state: "ACTIVE" }];
            const deadlock = new Error("Deadlock found when trying to get lock");
            deadlock.code = "ER_LOCK_DEADLOCK";
            throw deadlock;
          }
          return claims;
        },
      },
    });

    const err = await conflictFrom(usecase.update(1, { chat_id: OTHER }));
    assert.equal(attempts, 2, "it takes the transaction again");
    assert.equal(err.detail.unresolved_claims, 1, "and the retry sees what the rival committed");
    assert.equal(repo.store.rows[0].chat_id, SUPERGROUP, "nothing was written");
  });

  it("a deadlock that never clears eventually surfaces, rather than looping", async () => {
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    let attempts = 0;
    const usecase = build(repo, {
      mappingRepo: { countForGroupForUpdate: async () => 0 },
      claimRepo: {
        lockAllForGroup: async () => {
          attempts += 1;
          const deadlock = new Error("Deadlock found when trying to get lock");
          deadlock.code = "ER_LOCK_DEADLOCK";
          throw deadlock;
        },
      },
    });

    await assert.rejects(() => usecase.update(1, { chat_id: OTHER }), /Deadlock/);
    assert.equal(attempts, 3, "bounded - three attempts, not forever");
  });

  it("a 409 is NEVER retried - it is an answer, not contention", async () => {
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    let attempts = 0;
    const usecase = build(repo, {
      mappingRepo: {
        countForGroupForUpdate: async () => {
          attempts += 1;
          return 1;
        },
      },
      claimRepo: { lockAllForGroup: async () => [] },
    });
    await conflictFrom(usecase.update(1, { chat_id: OTHER }));
    assert.equal(attempts, 1);
  });

  it("reuses the guard repositories rather than counting for itself", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "telegram_group_registry.js"),
      "utf8"
    );
    assert.match(source, /countForGroupForUpdate/);
    assert.match(source, /lockAllForGroup/);
    assert.match(source, /lockForUpdate/);
    // No SQL and no second definition of "still managing people" here.
    assert.ok(!/SELECT|FROM telegram_group_mapping/i.test(source));
  });

  it("EVERY guard read is a LOCKING read - a plain count would be a stale one", () => {
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "telegram_group_registry.js"),
      "utf8"
    );
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    assert.ok(!/countForGroup\(/.test(code), "the non-locking mapping count must not be used");
    assert.ok(!/countLiveForGroup\(/.test(code), "the non-locking claim count must not be used");
  });

  it("CLOSED claims are locked too, and counted as not live", async () => {
    // A closed claim is one upsert away from ACTIVE, so it must be inside
    // the lock - and it must not by itself block the change.
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    const result = await guarded(repo, {
      claimRows: [{ state: "CLOSED" }, { state: "CLOSED" }],
    }).update(1, { chat_id: OTHER });
    assert.equal(result.code, 200);
    assert.equal(repo.store.rows[0].chat_id, OTHER);
  });

  it("a REMOVAL_PENDING claim blocks it, exactly as an ACTIVE one does", async () => {
    const repo = fakeRepo([row({ chat_id: SUPERGROUP })]);
    const err = await conflictFrom(
      guarded(repo, { claimRows: [{ state: "REMOVAL_PENDING" }] }).update(1, { chat_id: OTHER })
    );
    assert.equal(err.detail.unresolved_claims, 1);
  });
});
