/**
 * PHASE 3A DECIDES WHO SHOULD BELONG. IT TOUCHES NOBODY'S MEMBERSHIP.
 *
 *   node --test usecase/telegram_group_mapping_boundary.test.js
 *
 * This is the boundary the whole phase is built around, and it is not
 * expressible as a unit test of any one function - it is a fact about a set
 * of files, so it is asserted against their source.
 *
 * WHY IT IS A TEST AND NOT A PROMISE. Configuration is reversible: a wrong
 * mapping row is fixed by deleting it, and nobody's phone buzzes. The moment
 * one of these files can call `banChatMember`, a wrong row removes a real
 * person from a real group, and the review that trusted "3A is configuration
 * only" was reviewing something else. The separation is the safety, so the
 * separation is what gets pinned.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Every file this phase added or changed on the backend. */
const PHASE_3A_FILES = [
  "constants/telegram_group_mapping.js",
  "utils/telegram_group_mapping.js",
  "repository/telegram_group_mapping.js",
  "usecase/telegram_group_mapping.js",
];

/**
 * Telegram methods that CHANGE something for a real person. Reading is not
 * on this list; Phase 3A does not read from Telegram either, but it is the
 * writes that are irreversible.
 */
const MEMBERSHIP_METHODS = [
  "sendMessage",
  "sendDocument",
  "createChatInviteLink",
  "exportChatInviteLink",
  "approveChatJoinRequest",
  "declineChatJoinRequest",
  "banChatMember",
  "unbanChatMember",
  "kickChatMember",
  "restrictChatMember",
  "promoteChatMember",
  "createChatSubscriptionInviteLink",
  "leaveChat",
  "deleteMessage",
];

describe("the mapping code cannot act on Telegram", () => {
  for (const file of PHASE_3A_FILES) {
    it(`${file} calls no Telegram membership method`, () => {
      const source = strip(read(file));
      for (const method of MEMBERSHIP_METHODS) {
        assert.ok(
          !new RegExp(`\\.\\s*${method}\\s*\\(`).test(source),
          `${file} must not call ${method}`
        );
      }
    });
  }

  it("none of them even imports the Telegram service", () => {
    // The strongest form of the guarantee: there is no object to call a
    // membership method ON, so one cannot be added in a one-line change.
    for (const file of PHASE_3A_FILES) {
      const source = strip(read(file));
      assert.ok(
        !/require\(["'][^"']*services\/telegram["']\)/.test(source),
        `${file} must not import services/telegram`
      );
    }
  });

  it("the server constructs the mapping usecase WITHOUT a Telegram service", () => {
    const server = strip(read("server.js"));
    const construction = server.match(
      /telegramGroupMappingUsecase = require\("\.\/usecase\/telegram_group_mapping"\)\(([\s\S]*?)\);/
    );
    assert.ok(construction, "the mapping usecase must still be wired in server.js");
    assert.ok(
      !/telegram\s*:/.test(construction[1]) && !/services\/telegram/.test(construction[1]),
      "no Telegram service may be passed to the mapping usecase"
    );
  });

  it("no mapping file schedules anything", () => {
    for (const file of PHASE_3A_FILES) {
      const source = strip(read(file));
      assert.ok(!/setInterval|setTimeout|cron\.schedule/.test(source), `${file} schedules nothing`);
      assert.ok(!/reconcile/i.test(source), `${file} reconciles no membership`);
    }
  });

  it("the mapping repository writes ONLY to its own table", () => {
    const source = strip(read("repository/telegram_group_mapping.js"));
    const writes = source.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+[`\w$${}]+/gi) || [];
    for (const write of writes) {
      assert.ok(
        /telegram_group_mapping|\$\{TABLE\}|TABLE/.test(write),
        `Phase 3A must not write outside its table: ${write}`
      );
    }
    // In particular it never writes to the employee master or the registry.
    assert.ok(!/UPDATE\s+new_employee|DELETE FROM\s+new_employee/i.test(source));
    assert.ok(!/UPDATE\s+telegram_group_registry/i.test(source));
    assert.ok(!/employee_telegram_identity\s+SET|INSERT INTO employee_telegram_identity/i.test(source));
  });
});

describe("the 3-second poller is untouched by this phase", () => {
  it("no mapping file mentions the poll, the dispatcher or getUpdates", () => {
    for (const file of PHASE_3A_FILES) {
      const source = strip(read(file));
      assert.ok(!/getUpdates|pollTelegramUpdates|dispatcher/i.test(source), `${file} must stay out of the poller`);
    }
  });

  it("the poll schedule is still the deployed one", () => {
    // Phase 3A must build on top of that work without rewriting it.
    const server = strip(read("server.js"));
    assert.match(server, /TELEGRAM_LINK_POLL_CRON = "\*\/3 \* \* \* \* \*"/);
  });
});

describe("no new permission was minted", () => {
  it("the routes gate mappings on the registry's own two keys", () => {
    const routes = strip(read("routes/telegram_group_registry.js"));
    const mappingRoutes = routes.match(/r\.(get|post|delete)\(\s*"\/:telegram_group_id[^"]*(mappings|matched-employees)[^"]*"[\s\S]{0,140}?require\(([^)]+)\)/g) || [];
    assert.ok(mappingRoutes.length >= 4, `expected the four mapping routes, found ${mappingRoutes.length}`);
    for (const route of mappingRoutes) {
      assert.ok(
        /P\.VIEW_TELEGRAM_GROUPS|P\.MANAGE_TELEGRAM_GROUPS/.test(route),
        `a mapping route is gated on something other than the registry keys: ${route.slice(0, 80)}`
      );
    }
  });

  it("invents no third permission key anywhere in the phase", () => {
    for (const file of [...PHASE_3A_FILES, "routes/telegram_group_registry.js"]) {
      const source = strip(read(file));
      assert.ok(
        !/telegram_group_mappings?["']?\s*:|view_telegram_group_mapping|manage_telegram_group_mapping/.test(source),
        `${file} must not define a mapping-specific permission`
      );
    }
  });

  it("the migration grants nothing", () => {
    const sql = read("migrations/mysql/migrations/sqls/20260916140000-telegram-group-mapping-up.sql");
    assert.ok(!/all_permissions|INSERT INTO/i.test(sql.replace(/--[^\n]*/g, "")));
  });
});

describe("the employee snapshot asks for nothing sensitive", () => {
  it("selects named columns, never SELECT *", () => {
    const source = strip(read("repository/telegram_group_mapping.js"));
    assert.ok(!/SELECT\s+\*/i.test(source), "SELECT * on new_employee would pull salary and Aadhaar");
  });

  it("names no sensitive column at all", () => {
    const source = strip(read("repository/telegram_group_mapping.js"));
    for (const column of [
      "salary",
      "aadhaar",
      "pan_no",
      "account_no",
      "ifsc",
      "bank_name",
      "esi_number",
      "pf_number",
      "primary_contact_number",
      "alternate_contact_number",
      "permanent_address",
      "residential_address",
      "employee_image",
      "telegram_username",
      "telegram_user_id",
      "private_chat_id",
      "token_hash",
    ]) {
      assert.ok(
        !new RegExp(column, "i").test(source),
        `the mapping repository must never select ${column}`
      );
    }
  });

  it("the Telegram read returns employee ids and nothing else", () => {
    const source = strip(read("repository/telegram_group_mapping.js"));
    const query = source.match(/CONNECTED_EMPLOYEE_IDS[\s\S]{0,320}?\[ids\]/);
    assert.ok(query, "the bulk identity read must still exist");
    assert.match(query[0], /SELECT employee_id/);
    assert.ok(!/telegram_user_id|private_chat_id|telegram_username/.test(query[0]));
  });
});

describe("employment eligibility uses the shared dated rule", () => {
  it("the matcher imports employedOn, and never eligibleOn", () => {
    const source = strip(read("utils/telegram_group_mapping.js"));
    assert.match(source, /require\("\.\/attendance_eligibility"\)/);
    assert.match(source, /employedOn/);
    assert.ok(
      !/eligibleOn/.test(source),
      "eligibleOn adds the attendance test and would drop exempt employees"
    );
    assert.ok(
      !/attendance_required/.test(source),
      "attendance is not an employment question"
    );
  });

  it("nothing in the phase decides employment from `status`", () => {
    const matcher = strip(read("utils/telegram_group_mapping.js"));
    assert.ok(
      !/status\s*===?\s*1|status\s*=\s*1/.test(matcher),
      "`status` is not maintained on resignation - the dated rule is the authority"
    );
    const repo = strip(read("repository/telegram_group_mapping.js"));
    assert.ok(
      !/WHERE[^`]*status\s*=\s*1/i.test(repo),
      "the snapshot must not pre-filter on status"
    );
  });

  it("the business date comes from the shared IST helper", () => {
    const source = strip(read("usecase/telegram_group_mapping.js"));
    assert.match(source, /istDateOf/);
    assert.ok(!/getFullYear\(\)|getMonth\(\)|getDate\(\)/.test(source), "no host-local date arithmetic");
  });
});
