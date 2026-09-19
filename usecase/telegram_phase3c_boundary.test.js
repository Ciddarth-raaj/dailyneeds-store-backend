/**
 * WHAT PHASE 3C MUST NOT HAVE DISTURBED. Phase 3C.
 *
 *   node --test usecase/telegram_phase3c_boundary.test.js
 *
 * Phase 3C is the first phase that can REMOVE a person from a real group.
 * These are the guarantees that make that safe to ship: the poller is
 * untouched, the dashboard still asks Telegram nothing, Phase 3B's readiness
 * is unchanged, removal is gated twice over, and the one deliberate change
 * to Phase 3B's behaviour is the one that was approved.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const strip = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

describe("the poller is exactly as Phase 3B left it", () => {
  const server = strip(read("server.js"));

  it("ONE offset owner, and it is not the worker", () => {
    const callers = ["usecase/passwordReset.js", "usecase/telegram_membership_reconcile.js",
      "usecase/telegram_membership_worker.js"]
      .filter((file) => /\.getUpdates\s*\(/.test(strip(read(file))));
    assert.deepEqual(callers, ["usecase/passwordReset.js"]);
  });

  it("still three-second, and the worker is a SEPARATE job on its own schedule", () => {
    assert.match(server, /TELEGRAM_LINK_POLL_CRON = "\*\/3 \* \* \* \* \*"/);
    assert.match(server, /TELEGRAM_MEMBERSHIP_WORKER_CRON = "\*\/30 \* \* \* \* \*"/);
    assert.match(server, /register\(\s*"telegram_membership_worker"/);
    assert.match(server, /register\(\s*"telegram_membership_sweep", "0 \* \* \* \*"/);
  });

  it("the worker does not touch the poller's usecase", () => {
    const worker = strip(read("usecase/telegram_membership_worker.js"));
    assert.ok(!/passwordReset|pollTelegramUpdates|getUpdates|offset/i.test(worker));
  });

  it("chat_member is still NOT subscribed", () => {
    const service = strip(read("services/telegram.js"));
    // `callback_query` joined the list for the shift-request buttons. It is
    // named here rather than left to a loose regex so that the NEXT update
    // type to be switched on has to come past this test too.
    assert.match(
      service,
      /ALLOWED_UPDATES = \["message", "chat_join_request", "callback_query"\]/
    );
    assert.ok(!/"chat_member"/.test(service), "chat_member is still not subscribed");
  });
});

describe("the dashboard still makes zero Telegram calls", () => {
  const summary = strip(read("usecase/employee_status_summary.js"));

  it("no Telegram service, no membership probe, no reconciliation", () => {
    assert.ok(!/services\/telegram/.test(summary));
    assert.ok(!/getChatMember|getChat\(|banChatMember|createChatInviteLink/.test(summary));
    assert.ok(!/telegram_membership_reconcile|reconcileEmployee/.test(summary));
  });

  it("and reads the cache, as it always did", () => {
    assert.match(summary, /verification/i);
  });
});

describe("Phase 3B's readiness is untouched", () => {
  it("groupReadiness still asks for can_invite_users and knows nothing of removal", () => {
    const utils = strip(read("utils/telegram_membership.js"));
    assert.match(utils, /can_invite_users/);
    assert.ok(!/can_restrict_members|canRestrictMembers/.test(utils));
    assert.ok(!/banChatMember|REMOVAL_READINESS/.test(utils));
  });

  it("removal readiness is a separate file, and ignores is_active", () => {
    const removal = strip(read("utils/telegram_removal_readiness.js"));
    assert.match(removal, /can_restrict_members/);
    assert.ok(!/is_active/.test(removal));
  });
});

describe("removal is gated, capped and reachable from ONE place", () => {
  it("only the reconciler calls the removal primitives", () => {
    const callers = fs
      .readdirSync(path.join(__dirname, ".."))
      .filter((dir) => ["usecase", "repository", "routes", "services", "utils"].includes(dir))
      .flatMap((dir) =>
        fs
          .readdirSync(path.join(__dirname, "..", dir))
          .filter((file) => file.endsWith(".js") && !file.endsWith(".test.js"))
          .map((file) => `${dir}/${file}`)
      )
      .filter((file) => /\.(banChatMember|unbanChatMember)\s*\(/.test(strip(read(file))));
    assert.deepEqual(callers, ["usecase/telegram_membership_reconcile.js"]);
  });

  it("and it refuses to act at all unless removals are switched ON", () => {
    const reconcile = strip(read("usecase/telegram_membership_reconcile.js"));
    assert.match(reconcile, /if \(!this\.config\.removalsEnabled\)/);
    const removeAt = reconcile.indexOf("banChatMember");
    const gateAt = reconcile.indexOf("this.config.removalsEnabled");
    assert.ok(gateAt !== -1 && gateAt < removeAt, "the gate must come before the removal");
  });

  it("BOTH switches default to OFF", () => {
    const server = strip(read("server.js"));
    assert.match(server, /TELEGRAM_MEMBERSHIP_WORKER \|\| ""\)\.toLowerCase\(\) === "on"/);
    assert.match(server, /TELEGRAM_MEMBERSHIP_REMOVALS \|\| ""\)\.toLowerCase\(\) === "on"/);
  });

  it("a ban is always followed by the unban that undoes it", () => {
    const service = strip(read("services/telegram.js"));
    assert.match(service, /only_if_banned: true/);
    const reconcile = strip(read("usecase/telegram_membership_reconcile.js"));

    // EVERY ban is followed by its unban - checked per call site rather than
    // by position in the file, because there is now also an unban with NO
    // ban before it: the recovery path for somebody left banned by a
    // half-finished removal, which must not issue a second ban.
    const ban = reconcile.indexOf("this.telegram.banChatMember");
    assert.notEqual(ban, -1);
    const after = reconcile.slice(ban);
    assert.match(
      after.slice(0, 400),
      /this\.telegram\.unbanChatMember/,
      "removed, not banished - the unban follows immediately"
    );
    const bans = (reconcile.match(/this\.telegram\.banChatMember/g) || []).length;
    const unbans = (reconcile.match(/this\.telegram\.unbanChatMember/g) || []).length;
    assert.ok(unbans >= bans, "there can never be more bans than unbans");
  });

  it("the KICKED recovery path lifts a ban without issuing one", () => {
    const reconcile = strip(read("usecase/telegram_membership_reconcile.js"));
    const kicked = reconcile.indexOf("TELEGRAM_MEMBER_STATUS.KICKED");
    assert.notEqual(kicked, -1, "kicked must be told apart from ordinary absence");
    const block = reconcile.slice(kicked, reconcile.indexOf("if (!isTelegramMember(member))", kicked));
    assert.match(block, /unbanChatMember/);
    assert.ok(!/banChatMember\(/.test(block.replace(/unbanChatMember\(/g, "")), "no second ban");
  });
});

describe("the one deliberate change to Phase 3B behaviour", () => {
  it("requiredGroups unions ACTIVE MANUAL claims, and nothing else changed", () => {
    const membership = strip(read("usecase/employee_telegram_membership.js"));
    assert.match(membership, /getManualActiveGroups/);
    // Still the Phase 3A matcher and still the dated employment predicate.
    assert.match(membership, /matchesDimension/);
    assert.match(membership, /employedOn/);
    // And it still performs no removal of any kind.
    assert.ok(!/banChatMember|unbanChatMember|reconcile/i.test(membership));
  });

  it("a manual grant therefore rides the SAME join-request security", () => {
    const join = strip(read("usecase/employee_telegram_join_request.js"));
    assert.match(join, /isGroupRequired/);
    assert.ok(!/claimRepo|CLAIM_SOURCE/.test(join), "the approval path needs no new concept");
  });
});

describe("granting a group is never an employee-record right", () => {
  it("no membership write is gated by employee_edit", () => {
    const routes = strip(read("routes/telegram_group_registry.js"));
    const membershipBlock = routes.slice(routes.indexOf("_membershipRoutes"));
    assert.ok(!/EMPLOYEE_EDIT|EMPLOYEE_CREATE/.test(membershipBlock));
    assert.match(membershipBlock, /MANAGE_TELEGRAM_GROUPS/);
  });

  it("the employee router exposes managed membership READ-ONLY", () => {
    const routes = strip(read("routes/employee_telegram.js"));
    const block = routes.slice(routes.indexOf("_managedMembershipRoute"));
    assert.match(block, /r\.get\(/);
    assert.ok(!/r\.post\(|r\.delete\(|grantManual|revokeManual/.test(block));
  });
});

describe("no identifier leaves the system through the new surfaces", () => {
  const FILES = [
    "repository/telegram_membership_claim.js",
    "repository/telegram_membership_job.js",
    "usecase/telegram_membership_admin.js",
  ];

  it("no telegram_user_id, chat_id or invite hash is stored or returned", () => {
    for (const file of FILES) {
      const source = strip(read(file));
      assert.ok(!/telegram_user_id|private_chat_id|invite_link_hash|verified_mobile/.test(source), file);
    }
  });

  it("the audit table has no free-text column to leak into", () => {
    const sql = read(
      "migrations/mysql/migrations/sqls/20260917130000-telegram-membership-event-up.sql"
    );
    assert.ok(!/JSON|TEXT|detail_text/.test(sql.replace(/--[^\n]*/g, "")));
    assert.match(sql, /`detail_code` VARCHAR\(48\)/);
  });
});
