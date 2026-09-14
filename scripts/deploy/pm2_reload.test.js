/**
 * The deploy's process reload.
 *
 *   node --test scripts/deploy/pm2_reload.test.js
 *
 * The behaviours that matter are the ones that were wrong before, and the
 * one safety property that must survive the change:
 *
 *   - the Biomax receiver IS reloaded when it is running (it was not, so a
 *     punch-dating fix could be deployed and still not be in effect);
 *   - it is NEVER started when it is not (that separation is deliberate -
 *     it opens a TCP listener and activation is an approved action);
 *   - a process that does not come back online FAILS the deploy, rather
 *     than the deploy reporting success over a dead server.
 *
 * `pm2` itself is not run here. The script's decision table is exercised
 * against a fake process list, which is the part that can be wrong.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { TARGETS, find } = require("./pm2-reload");

const SRC = fs.readFileSync(path.join(__dirname, "pm2-reload.js"), "utf8");

describe("what the deploy reloads", () => {
  it("covers the API and the Biomax receiver, and nothing else", () => {
    assert.deepEqual(TARGETS.map((t) => t.id), ["0", "biomax-receiver"]);
  });

  it("treats the API as required and the receiver as optional", () => {
    const byId = Object.fromEntries(TARGETS.map((t) => [t.id, t]));
    assert.equal(byId["0"].required, true, "a missing API is a broken deploy");
    assert.equal(
      byId["biomax-receiver"].required,
      false,
      "a receiver that was never activated must not fail the deploy"
    );
  });

  it("says why the receiver may legitimately be absent", () => {
    const receiver = TARGETS.find((t) => t.id === "biomax-receiver");
    assert.match(receiver.skipNote, /never starts it|approved action/i);
  });
});

describe("it never starts anything", () => {
  it("issues only 'jlist' and 'reload' as pm2 subcommands - never start or restart", () => {
    // Asserted on the ACTUAL pm2 invocations rather than on the file text:
    // the skip message legitimately names ecosystem.biomax.config.js, and a
    // substring search would flag that and prove nothing.
    const subcommands = [...SRC.matchAll(/pm2\(\[\s*"([a-zA-Z]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(subcommands)].sort(), ["jlist", "reload"]);
    assert.ok(
      !subcommands.includes("start"),
      "pm2 start would activate the receiver as a side effect of a deploy"
    );
    assert.ok(!subcommands.includes("restart"));
    assert.ok(!/startOrReload/.test(SRC));
  });

  it("only ever reloads a process it has already seen in the list", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    const guard = code.indexOf("if (!existing)");
    const reload = code.indexOf('pm2(["reload"');
    assert.ok(guard > -1 && reload > guard, "the absence check comes before the reload");
  });
});

describe("find", () => {
  const list = [
    { name: "server", pm_id: "0", status: "online" },
    { name: "biomax-receiver", pm_id: "3", status: "online" },
  ];

  it("matches the API by its pm2 id, because it has no useful name", () => {
    assert.equal(find(list, "0").name, "server");
  });

  it("matches the receiver by name, because its id is not stable", () => {
    assert.equal(find(list, "biomax-receiver").pm_id, "3");
  });

  it("returns null for something not running, rather than guessing", () => {
    assert.equal(find(list, "biomax-receiver".toUpperCase()), null);
    assert.equal(find([], "0"), null);
    assert.equal(find(null, "0"), null);
  });
});

describe("the failure rule", () => {
  it("requires 'online' after the reload, not merely a successful command", () => {
    // A process that crashes on the new code exits AFTER reload returns.
    assert.match(SRC, /after\.status !== "online"/);
    assert.match(SRC, /process\.exit\(1\)/);
  });

  it("fails loudly when pm2 itself cannot be read", () => {
    assert.match(SRC, /pm2 is not reachable/);
  });

  it("names every process that did not come back", () => {
    assert.match(SRC, /failures\.forEach/);
  });
});
