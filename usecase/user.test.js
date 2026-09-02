const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildUserUsecase = require("./user");

const makeRepos = (row, updates = []) => ({
  userRepo: {
    async login() {
      return row === null ? [] : [row];
    },
    async getAllowedIps() {
      return row && row.allowed_ips;
    },
    async updateAllowedIps(userId, allowedIps) {
      updates.push({ userId, allowedIps });
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

const USER_ROW = {
  user_id: 7,
  employee_id: 3,
  user_type: 1,
  store_id: 2,
  designation_id: 4,
  allowed_ips: null,
};

describe("login IP gate", () => {
  it("signs in an unrestricted user from anywhere", async () => {
    const { userRepo, employeeRepo } = makeRepos(USER_ROW);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const result = await usecase.login("u", "p", "49.207.1.1");
    assert.equal(result.code, 200);
    assert.ok(result.token);
  });

  it("signs in a restricted user from an allowed address", async () => {
    const row = { ...USER_ROW, allowed_ips: "203.0.113.10, 198.51.100.0/24" };
    const { userRepo, employeeRepo } = makeRepos(row);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const result = await usecase.login("u", "p", "198.51.100.5");
    assert.equal(result.code, 200);
  });

  it("refuses correct credentials from an outside address", async () => {
    const row = { ...USER_ROW, allowed_ips: "203.0.113.10" };
    const { userRepo, employeeRepo } = makeRepos(row);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const result = await usecase.login("u", "p", "49.207.1.1");
    assert.equal(result.code, 403);
    assert.equal(result.error, "IP_NOT_ALLOWED");
    assert.equal(result.token, undefined);
  });

  it("still reports bad credentials as 204", async () => {
    const { userRepo, employeeRepo } = makeRepos(null);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const result = await usecase.login("u", "wrong", "203.0.113.10");
    assert.equal(result.code, 204);
  });
});

describe("updateAllowedIps", () => {
  it("stores a normalized list", async () => {
    const updates = [];
    const { userRepo, employeeRepo } = makeRepos(USER_ROW, updates);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const result = await usecase.updateAllowedIps(7, " 203.0.113.10 ,\n10.0.0.0/8 ");
    assert.equal(result.code, 200);
    assert.deepEqual(updates, [
      { userId: 7, allowedIps: "203.0.113.10, 10.0.0.0/8" },
    ]);
  });

  it("clears the restriction when the list is empty", async () => {
    const updates = [];
    const { userRepo, employeeRepo } = makeRepos(USER_ROW, updates);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    await usecase.updateAllowedIps(7, "");
    assert.deepEqual(updates, [{ userId: 7, allowedIps: null }]);
  });

  it("rejects an unparseable entry rather than locking the user out", async () => {
    const updates = [];
    const { userRepo, employeeRepo } = makeRepos(USER_ROW, updates);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    await assert.rejects(
      () => usecase.updateAllowedIps(7, "203.0.113.10, office-wifi"),
      (err) => err.name === "ValidationError" && /office-wifi/.test(err.message)
    );
    assert.deepEqual(updates, []);
  });
});

describe("getIpRestrictions", () => {
  it("returns the allow-list as an array with a restricted flag", async () => {
    const row = { ...USER_ROW, allowed_ips: "203.0.113.10,198.51.100.1" };
    const { userRepo, employeeRepo } = makeRepos(row);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const [entry] = await usecase.getIpRestrictions();
    assert.deepEqual(entry.allowed_ips, ["203.0.113.10", "198.51.100.1"]);
    assert.equal(entry.is_restricted, true);
  });
});
