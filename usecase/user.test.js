const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildUserUsecase = require("./user");

const makeRepos = (row, updates = []) => ({
  userRepo: {
    async login() {
      return row === null ? [] : [row];
    },
    async getIpPolicy() {
      return row;
    },
    async updateIpPolicy(userId, allowedIps, ipPolicy) {
      updates.push({ userId, allowedIps, ipPolicy });
    },
    async getIpRestrictions() {
      return [row];
    },
  },
  employeeRepo: {
    async getNameById() {
      return [{ employee_name: "Test User", designation_name: "Cashier" }];
    },
  },
});

const build = (row, updates = []) => {
  const { userRepo, employeeRepo } = makeRepos(row, updates);
  return buildUserUsecase(userRepo, null, employeeRepo);
};

/** An ordinary employee following an unrestricted branch — the default state. */
const EMPLOYEE = {
  user_id: 7,
  employee_id: 3,
  user_type: 1,
  store_id: 2,
  designation_id: 4,
  ip_policy: "branch",
  allowed_ips: null,
  branch_enabled: 0,
  branch_ips: null,
};

const BRANCH_ON = { branch_enabled: 1, branch_ips: "203.0.113.0/24" };
const ADMIN = { ...EMPLOYEE, user_type: 2, ip_policy: "unrestricted" };

describe("login IP gate", () => {
  it("signs in an employee of an unrestricted branch from anywhere", async () => {
    const result = await build(EMPLOYEE).login("u", "p", "49.207.1.1");
    assert.equal(result.code, 200);
    assert.ok(result.token);
  });

  it("signs in an employee of a restricted branch from the branch", async () => {
    const result = await build({ ...EMPLOYEE, ...BRANCH_ON }).login("u", "p", "203.0.113.44");
    assert.equal(result.code, 200);
  });

  it("refuses an employee of a restricted branch from outside it", async () => {
    const result = await build({ ...EMPLOYEE, ...BRANCH_ON }).login("u", "p", "49.207.1.1");
    assert.equal(result.code, 403);
    assert.equal(result.error, "IP_NOT_ALLOWED");
    assert.equal(result.token, undefined);
  });

  it("lets an admin of a restricted branch sign in from outside it", async () => {
    const result = await build({ ...ADMIN, ...BRANCH_ON }).login("u", "p", "49.207.1.1");
    assert.equal(result.code, 200);
  });

  it("lets an admin left on the branch policy sign in from outside it too", async () => {
    const result = await build({ ...ADMIN, ...BRANCH_ON, ip_policy: "branch" }).login("u", "p", "49.207.1.1");
    assert.equal(result.code, 200);
  });

  it("signs in a custom user from a personal address", async () => {
    const row = { ...EMPLOYEE, ...BRANCH_ON, ip_policy: "custom", allowed_ips: "198.51.100.5" };
    const result = await build(row).login("u", "p", "198.51.100.5");
    assert.equal(result.code, 200);
  });

  it("signs in a custom user from the branch as well (union)", async () => {
    const row = { ...EMPLOYEE, ...BRANCH_ON, ip_policy: "custom", allowed_ips: "198.51.100.5" };
    const result = await build(row).login("u", "p", "203.0.113.44");
    assert.equal(result.code, 200);
  });

  it("refuses a custom user from neither list", async () => {
    const row = { ...EMPLOYEE, ...BRANCH_ON, ip_policy: "custom", allowed_ips: "198.51.100.5" };
    const result = await build(row).login("u", "p", "49.207.1.1");
    assert.equal(result.code, 403);
  });

  it("signs in an unrestricted user from anywhere despite the branch", async () => {
    const row = { ...EMPLOYEE, ...BRANCH_ON, ip_policy: "unrestricted" };
    const result = await build(row).login("u", "p", "49.207.1.1");
    assert.equal(result.code, 200);
  });

  it("still reports bad credentials as 204", async () => {
    const result = await build(null).login("u", "wrong", "203.0.113.10");
    assert.equal(result.code, 204);
  });
});

describe("updateIpPolicy", () => {
  it("stores a normalized list under custom", async () => {
    const updates = [];
    const result = await build(EMPLOYEE, updates).updateIpPolicy(7, " 203.0.113.10 ,\n10.0.0.0/8 ", "custom");
    assert.equal(result.code, 200);
    assert.equal(result.ip_policy, "custom");
    assert.deepEqual(updates, [{ userId: 7, allowedIps: "203.0.113.10, 10.0.0.0/8", ipPolicy: "custom" }]);
  });

  it("keeps the list on file when a user goes back to following the branch", async () => {
    const updates = [];
    await build(EMPLOYEE, updates).updateIpPolicy(7, "203.0.113.10", "branch");
    assert.deepEqual(updates, [{ userId: 7, allowedIps: "203.0.113.10", ipPolicy: "branch" }]);
  });

  it("stores no list for an unrestricted user with none given", async () => {
    const updates = [];
    await build(EMPLOYEE, updates).updateIpPolicy(7, "", "unrestricted");
    assert.deepEqual(updates, [{ userId: 7, allowedIps: null, ipPolicy: "unrestricted" }]);
  });

  it("refuses custom with no addresses to fall back on", async () => {
    const updates = [];
    await assert.rejects(
      () => build(EMPLOYEE, updates).updateIpPolicy(7, "", "custom"),
      (err) => err.name === "ValidationError" && /at least one allowed IP/.test(err.message)
    );
    assert.deepEqual(updates, []);
  });

  it("rejects an unparseable entry rather than locking the user out", async () => {
    const updates = [];
    await assert.rejects(
      () => build(EMPLOYEE, updates).updateIpPolicy(7, "203.0.113.10, office-wifi", "custom"),
      (err) => err.name === "ValidationError" && /office-wifi/.test(err.message)
    );
    assert.deepEqual(updates, []);
  });

  it("maps the previous release's boolean: false is custom, true is branch", async () => {
    const updates = [];
    const usecase = build(EMPLOYEE, updates);
    await usecase.updateIpPolicy(7, "203.0.113.10", false);
    await usecase.updateIpPolicy(7, "203.0.113.10", true);
    assert.deepEqual(updates.map((u) => u.ipPolicy), ["custom", "branch"]);
  });

  it("rejects an unknown policy", async () => {
    const updates = [];
    await assert.rejects(
      () => build(EMPLOYEE, updates).updateIpPolicy(7, "203.0.113.10", "bogus"),
      (err) => err.name === "ValidationError" && /ip_policy/.test(err.message)
    );
    assert.deepEqual(updates, []);
  });
});

describe("getIpPolicy", () => {
  it("returns the resolved policy for the row", async () => {
    const policy = await build({ ...EMPLOYEE, ...BRANCH_ON }).getIpPolicy(7);
    assert.deepEqual(policy, { exempt: false, rules: ["203.0.113.0/24"], source: "branch" });
  });

  it("treats a missing row as exempt", async () => {
    const policy = await build(null).getIpPolicy(7);
    assert.deepEqual(policy, { exempt: true, rules: [], source: "missing" });
  });
});

describe("getIpRestrictions", () => {
  it("shapes a row for the admin screen", async () => {
    const row = { ...EMPLOYEE, ...BRANCH_ON, ip_policy: "custom", allowed_ips: "203.0.113.10,198.51.100.1" };
    const [entry] = await build(row).getIpRestrictions();
    assert.equal(entry.ip_policy, "custom");
    assert.deepEqual(entry.allowed_ips, ["203.0.113.10", "198.51.100.1"]);
    assert.equal(entry.branch_enabled, true);
    assert.deepEqual(entry.branch_ips, ["203.0.113.0/24"]);
    assert.equal(entry.effective.exempt, false);
    assert.equal(entry.is_restricted, true);
  });

  it("marks an employee of an unrestricted branch as open", async () => {
    const [entry] = await build(EMPLOYEE).getIpRestrictions();
    assert.equal(entry.ip_policy, "branch");
    assert.equal(entry.is_restricted, false);
    assert.equal(entry.effective.source, "branch-open");
  });

  it("treats a NULL policy as branch", async () => {
    const [entry] = await build({ ...EMPLOYEE, ip_policy: null }).getIpRestrictions();
    assert.equal(entry.ip_policy, "branch");
  });
});
