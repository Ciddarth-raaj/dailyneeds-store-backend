/**
 * PHASE 3B VERIFIES, INVITES AND APPROVES. IT REMOVES NOBODY.
 *
 *   node --test usecase/telegram_phase3b_boundary.test.js
 *
 * Asserted against the source, because this is a fact about a set of files
 * rather than about any one function.
 *
 * WHY IT IS A TEST. Phase 3B is the first phase whose actions are visible to
 * real people in real groups, and the line it must not cross is removal:
 * approving somebody who should be in a group is recoverable, removing
 * somebody because a rule changed is not, and reconciliation has not been
 * designed yet. A future edit that adds `banChatMember` to any of these
 * files fails here rather than in a group chat.
 *
 * It also pins that the single-poller topology survived: Phase 3B adds a
 * HANDLER to the existing dispatcher, not a second reader of the update
 * stream.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const PHASE_3B_FILES = [
  "constants/telegram_membership.js",
  "utils/telegram_membership.js",
  "repository/employee_telegram_group_join.js",
  "usecase/telegram_group_readiness.js",
  "usecase/employee_telegram_membership.js",
  "usecase/employee_telegram_join_request.js",
];

/** Everything that takes somebody OUT of a group, or acts against them. */
const REMOVAL_METHODS = [
  "banChatMember",
  "unbanChatMember",
  "kickChatMember",
  "restrictChatMember",
  "promoteChatMember",
  "leaveChat",
  "deleteChatPhoto",
  "setChatPermissions",
];

describe("no Phase 3B file can remove anybody", () => {
  for (const file of PHASE_3B_FILES) {
    it(`${file} calls no removal method`, () => {
      const source = strip(read(file));
      for (const method of REMOVAL_METHODS) {
        assert.ok(
          !new RegExp(`\\.\\s*${method}\\s*\\(`).test(source),
          `${file} must not call ${method}`
        );
      }
    });
  }

  it("the service DEFINES no ban or kick of its own beyond what already existed", () => {
    // `kickChatMember` exists on the vendored client; Phase 3B must not have
    // added a wrapper that makes it reachable from our code.
    const service = strip(read("services/telegram.js"));
    for (const method of ["banChatMember", "unbanChatMember", "restrictChatMember"]) {
      assert.ok(!new RegExp(`async ${method}\\s*\\(`).test(service), `no ${method} wrapper`);
    }
  });

  it("nothing reconciles, sweeps or syncs membership", () => {
    for (const file of PHASE_3B_FILES) {
      const source = strip(read(file));
      assert.ok(!/reconcile/i.test(source), `${file} reconciles nothing`);
      assert.ok(!/removeFromGroup|syncMembership/i.test(source));
    }
  });

  it("no Phase 3B file schedules anything", () => {
    for (const file of PHASE_3B_FILES) {
      const source = strip(read(file));
      assert.ok(!/setInterval|cron\.schedule/.test(source), `${file} schedules nothing`);
    }
  });

  it("the join-attempt repository writes ONLY to its own table", () => {
    const source = strip(read("repository/employee_telegram_group_join.js"));
    const writes = source.match(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+[`\w${}]+/gi) || [];
    for (const write of writes) {
      assert.ok(
        /employee_telegram_group_join_attempt|\$\{TABLE\}|TABLE/.test(write),
        `Phase 3B must not write outside its table: ${write}`
      );
    }
    assert.ok(!/UPDATE\s+employee_telegram_identity/i.test(source));
    assert.ok(!/UPDATE\s+new_employee/i.test(source));
  });
});

describe("the single-poller topology survived", () => {
  const server = strip(read("server.js"));

  it("still ONE getUpdates caller in the whole repository", () => {
    const skip = new Set(["node_modules", ".git", "migrations", "docs", "keys"]);
    const files = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          walk(full);
        } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
          files.push(path.relative(ROOT, full).replace(/\\/g, "/"));
        }
      }
    })(ROOT);

    const callers = files.filter(
      (f) => f !== "services/telegram.js" && /\.getUpdates\s*\(/.test(strip(read(f)))
    );
    assert.deepEqual(callers, ["usecase/passwordReset.js"]);
  });

  it("still ONE scheduled poller, on the 3-second cadence", () => {
    assert.equal((server.match(/pollTelegramUpdates\s*\(/g) || []).length, 1);
    assert.match(server, /TELEGRAM_LINK_POLL_CRON = "\*\/3 \* \* \* \* \*"/);
  });

  it("registers a HANDLER on the existing dispatcher, not a second one", () => {
    assert.equal(
      (server.match(/require\("\.\/usecase\/telegram_update_dispatcher"\)/g) || []).length,
      1,
      "one dispatcher"
    );
    assert.match(server, /name: "employee_telegram_join_request"/);
    assert.match(server, /updateTypes: \["chat_join_request"\]/);
  });

  it("sets up NO webhook", () => {
    assert.ok(!/setWebhook/i.test(server));
    for (const file of PHASE_3B_FILES) {
      assert.ok(!/setWebhook/i.test(strip(read(file))));
    }
  });

  it("does NOT subscribe to chat_member", () => {
    // Membership is verified on demand with getChatMember rather than by
    // asking Telegram to stream every member change in every group forever.
    const service = strip(read("services/telegram.js"));
    const allowed = service.match(/const ALLOWED_UPDATES = \[([^\]]*)\]/);
    assert.ok(allowed);
    assert.ok(!/chat_member/.test(allowed[1]), `allowed_updates is ${allowed[1]}`);
    assert.match(allowed[1], /message/);
    assert.match(allowed[1], /chat_join_request/);
  });

  it("the existing handlers are still registered alongside it", () => {
    assert.match(server, /name: "telegram_group_detection"/);
    assert.match(server, /name: "employee_telegram_link"/);
    assert.match(server, /onTelegramUpdate: \(update\) => this\.telegramUpdateDispatcher\.dispatch\(update\)/);
  });
});

describe("the raw Bot API call is contained", () => {
  it("lives only in the Telegram service", () => {
    // A usecase building its own HTTP request would be a second place the
    // bot token is handled, and the first place somebody logs it.
    const skip = new Set(["node_modules", ".git", "migrations", "docs", "keys"]);
    const offenders = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          walk(full);
        } else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
          const rel = path.relative(ROOT, full).replace(/\\/g, "/");
          if (rel === "services/telegram.js") continue;
          if (/api\.telegram\.org/.test(strip(read(rel)))) offenders.push(rel);
        }
      }
    })(ROOT);
    assert.deepEqual(offenders, []);
  });

  it("reuses the client's own authenticated axios rather than rebuilding one", () => {
    const service = strip(read("services/telegram.js"));
    assert.match(service, /client\.axios\.post/);
    // The token is never interpolated into a URL by us.
    assert.ok(!/api\.telegram\.org\/bot\$\{/.test(service));
  });

  it("never logs the token, an invite URL or a Telegram user id", () => {
    for (const file of [...PHASE_3B_FILES, "services/telegram.js"]) {
      const source = read(file);
      const logs = source.match(/description: `[^`]*`/g) || [];
      for (const line of logs) {
        assert.ok(!/TELEGRAM_BOT_TOKEN|accessToken/.test(line), `${file}: ${line}`);
        assert.ok(!/inviteUrl|invite_link|inviteLink/.test(line), `${file}: ${line}`);
        assert.ok(!/telegram_user_id|fromId|telegramUserId/.test(line), `${file}: ${line}`);
      }
    }
  });
});

describe("the matcher is Phase 3A's", () => {
  it("membership imports it rather than writing a second one", () => {
    const source = strip(read("usecase/employee_telegram_membership.js"));
    assert.match(source, /require\("\.\.\/utils\/telegram_group_mapping"\)/);
    assert.match(source, /matchesDimension/);
    assert.match(source, /require\("\.\.\/utils\/attendance_eligibility"\)/);
    assert.match(source, /employedOn/);
  });

  it("uses employedOn and NEVER eligibleOn or a status flag", () => {
    const source = strip(read("usecase/employee_telegram_membership.js"));
    assert.ok(!/eligibleOn/.test(source), "attendance exemption is irrelevant to group membership");
    assert.ok(!/status\s*===?\s*1/.test(source), "`status` is not maintained on resignation");
  });

  it("infers nothing from a group's name, category or used_for", () => {
    const source = strip(read("usecase/employee_telegram_membership.js"));
    assert.ok(!/group_name\s*===|group_name\.(match|includes|test)/.test(source));
    assert.ok(!/category\s*===\s*["']/.test(source));
    assert.ok(!/used_for\.(match|includes|test)/.test(source));
  });
});
