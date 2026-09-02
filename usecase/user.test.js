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
    async updateIpPolicy(userId, allowedIps, allowOutsideAccess) {
      updates.push({ userId, allowedIps, allowOutsideAccess });
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
  allow_outside_access: 1,
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
    const row = {
      ...USER_ROW,
      allowed_ips: "203.0.113.10, 198.51.100.0/24",
      allow_outside_access: 0,
    };
    const { userRepo, employeeRepo } = makeRepos(row);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const result = await usecase.login("u", "p", "198.51.100.5");
    assert.equal(result.code, 200);
  });

  it("refuses correct credentials from an outside address", async () => {
    const row = {
      ...USER_ROW,
      allowed_ips: "203.0.113.10",
      allow_outside_access: 0,
    };
    const { userRepo, employeeRepo } = makeRepos(row);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const result = await usecase.login("u", "p", "49.207.1.1");
    assert.equal(result.code, 403);
    assert.equal(result.error, "IP_NOT_ALLOWED");
    assert.equal(result.token, undefined);
  });

  it("lets a user with outside access on sign in from anywhere, list or not", async () => {
    const row = {
      ...USER_ROW,
      allowed_ips: "203.0.113.10",
      allow_outside_access: 1,
    };
    const { userRepo, employeeRepo } = makeRepos(row);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const result = await usecase.login("u", "p", "49.207.1.1");
    assert.equal(result.code, 200);
  });

  it("still reports bad credentials as 204", async () => {
    const { userRepo, employeeRepo } = makeRepos(null);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const result = await usecase.login("u", "wrong", "203.0.113.10");
    assert.equal(result.code, 204);
  });
});

describe("updateIpPolicy", () => {
  const build = () => {
    const updates = [];
    const { userRepo, employeeRepo } = makeRepos(USER_ROW, updates);
    return { usecase: buildUserUsecase(userRepo, null, employeeRepo), updates };
  };

  it("stores a normalized list when blocking outside access", async () => {
    const { usecase, updates } = build();

    const result = await usecase.updateIpPolicy(
      7,
      " 203.0.113.10 ,\n10.0.0.0/8 ",
      false
    );
    assert.equal(result.code, 200);
    assert.equal(result.allow_outside_access, false);
    assert.deepEqual(updates, [
      {
        userId: 7,
        allowedIps: "203.0.113.10, 10.0.0.0/8",
        allowOutsideAccess: false,
      },
    ]);
  });

  it("keeps the list when outside access is turned back on", async () => {
    const { usecase, updates } = build();

    await usecase.updateIpPolicy(7, "203.0.113.10", true);
    assert.deepEqual(updates, [
      { userId: 7, allowedIps: "203.0.113.10", allowOutsideAccess: true },
    ]);
  });

  it("stores no list when outside access is on and none was given", async () => {
    const { usecase, updates } = build();

    await usecase.updateIpPolicy(7, "", true);
    assert.deepEqual(updates, [
      { userId: 7, allowedIps: null, allowOutsideAccess: true },
    ]);
  });

  it("refuses to block outside access with no addresses to fall back on", async () => {
    const { usecase, updates } = build();

    await assert.rejects(
      () => usecase.updateIpPolicy(7, "", false),
      (err) =>
        err.name === "ValidationError" &&
        /at least one allowed IP/.test(err.message)
    );
    assert.deepEqual(updates, []);
  });

  it("rejects an unparseable entry rather than locking the user out", async () => {
    const { usecase, updates } = build();

    await assert.rejects(
      () => usecase.updateIpPolicy(7, "203.0.113.10, office-wifi", false),
      (err) => err.name === "ValidationError" && /office-wifi/.test(err.message)
    );
    assert.deepEqual(updates, []);
  });

  it("reads a tinyint flag from the request the same as a boolean", async () => {
    const { usecase, updates } = build();

    await usecase.updateIpPolicy(7, "203.0.113.10", 0);
    assert.equal(updates[0].allowOutsideAccess, false);
  });
});

describe("getIpPolicy", () => {
  it("normalizes the stored row", async () => {
    const row = {
      ...USER_ROW,
      allowed_ips: "203.0.113.10",
      allow_outside_access: 0,
    };
    const { userRepo, employeeRepo } = makeRepos(row);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const policy = await usecase.getIpPolicy(7);
    assert.deepEqual(policy, {
      allowed_ips: ["203.0.113.10"],
      allow_outside_access: false,
    });
  });

  it("treats a missing row as unrestricted", async () => {
    const { userRepo, employeeRepo } = makeRepos(null);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const policy = await usecase.getIpPolicy(7);
    assert.deepEqual(policy, { allowed_ips: [], allow_outside_access: true });
  });
});

describe("getIpRestrictions", () => {
  it("returns the allow-list as an array with a restricted flag", async () => {
    const row = {
      ...USER_ROW,
      allowed_ips: "203.0.113.10,198.51.100.1",
      allow_outside_access: 0,
    };
    const { userRepo, employeeRepo } = makeRepos(row);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const [entry] = await usecase.getIpRestrictions();
    assert.deepEqual(entry.allowed_ips, ["203.0.113.10", "198.51.100.1"]);
    assert.equal(entry.allow_outside_access, false);
    assert.equal(entry.is_restricted, true);
  });

  it("marks a user who may work outside as unrestricted, list or not", async () => {
    const row = {
      ...USER_ROW,
      allowed_ips: "203.0.113.10",
      allow_outside_access: 1,
    };
    const { userRepo, employeeRepo } = makeRepos(row);
    const usecase = buildUserUsecase(userRepo, null, employeeRepo);

    const [entry] = await usecase.getIpRestrictions();
    assert.deepEqual(entry.allowed_ips, ["203.0.113.10"]);
    assert.equal(entry.is_restricted, false);
  });
});
