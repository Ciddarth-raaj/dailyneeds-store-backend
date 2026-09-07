/**
 * Old backend -> new backend legacy-token transition (safety correction
 * pass, item 6 steps 1-9; regression category 14G).
 *
 * This is the safest isolated equivalent of a staging run available here:
 * no database exists in this environment, so the OLD backend's actual
 * source files are checked out from origin/main-autodeploy at test time and
 * executed to mint a token, and that token is then presented to the NEW
 * auth middleware inside a real Express app.
 *
 * Skipped, not faked, if git cannot produce the old source.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-old-backend-"));

// One keypair shared by old and new, exactly as production will be on deploy day.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
fs.mkdirSync(path.join(tmp, "keys/jwt"), { recursive: true });
fs.writeFileSync(path.join(tmp, "keys/jwt/private.key"), privateKey);
fs.writeFileSync(path.join(tmp, "keys/jwt/public.key"), publicKey);
process.env.JWT_PRIVATE_KEY_PATH = path.join(tmp, "keys/jwt/private.key");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({ legacy: path.join(tmp, "keys/jwt/public.key") });
process.env.JWT_ACTIVE_KID = "legacy";
process.env.JWT_LEGACY_KID = "legacy";
process.env.JWT_TOKEN_CUTOFF = "0";

/**
 * The commit the OLD backend is read from.
 *
 * This used to be `origin/main-autodeploy`, which was correct only while
 * Stage 0A was unreleased. Deployment A merged Stage 0A into that branch on
 * 07-09-2026, so the ref started yielding the NEW code: the fixture below
 * then built a "old" usecase that calls findByUsername, the stub repository
 * here does not have it, the before hook threw and all five subtests were
 * cancelled rather than failed.
 *
 * `9d92884` is the last pre-Stage-0A production commit - the code that
 * issued the tokens still in employees' browsers - so it is pinned, not
 * tracked. It must never follow a branch again.
 */
const OLD_BACKEND_COMMIT = "9d92884";

let oldAvailable = true;
let oldReason = "";
try {
  for (const f of ["services/jwt.js", "usecase/user.js", "utils/ip.js", "utils/logger.js"]) {
    const src = execFileSync("git", ["show", `${OLD_BACKEND_COMMIT}:${f}`], { cwd: root, encoding: "utf8" });
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    fs.writeFileSync(path.join(tmp, f), src);
  }
  // Guard against the same drift returning by another route: the old usecase
  // must be the pre-Stage-0A shape (repo.login(...)), never the new one
  // (repo.findByUsername(...)). A mismatch is a broken fixture, not a
  // finding about the code under test, so say so loudly.
  const oldUser = fs.readFileSync(path.join(tmp, "usecase/user.js"), "utf8");
  if (oldUser.includes("findByUsername")) {
    throw new Error(
      `${OLD_BACKEND_COMMIT} is not a pre-Stage-0A commit: usecase/user.js already calls findByUsername`
    );
  }
  // the old jwt.js has a hardcoded global-logout cutoff; neutralise it for a fresh keypair
  const j = path.join(tmp, "services/jwt.js");
  fs.writeFileSync(j, fs.readFileSync(j, "utf8").replace(/const TOKEN_CUTOFF = \d+;/, "const TOKEN_CUTOFF = 0;"));
  // old modules require their own node_modules (jsonwebtoken, winston): link ours
  fs.symlinkSync(path.join(root, "node_modules"), path.join(tmp, "node_modules"), "dir");
} catch (err) {
  oldAvailable = false;
  oldReason = err && err.message ? err.message.split("\n")[0] : String(err);
}

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const F = require("../test_support/auth_fixtures");
const newAuth = require("./auth");

/**
 * The production directory the test models:
 *   employee A: user_id 7,  employee_id 42
 *   user B:     user_id 42, employee_id 9001   (B.user_id == A.employee_id)
 *   break-glass: user_id 9001, employee_id NULL (user_id == B.employee_id)
 */
const rows = {
  A: F.employeeRow({ user_id: 7, username: "A", employee_id: 42, designation_id: 4, store_id: 2, password: F.legacyHash("a-pass-1") }),
  B: F.employeeRow({ user_id: 42, username: "B", employee_id: 9001, designation_id: 5, store_id: 3, password: F.legacyHash("b-pass-1") }),
  breakglass: F.systemRow({ user_id: 9001, username: "breakglass" }),
};

describe("14G — old backend token, new backend middleware", { skip: !oldAvailable && `old source unavailable: ${oldReason}` }, () => {
  let oldToken, server, port;

  before(async () => {
    // Step 1-3: run the OLD usecase/user.js login against a repository that
    // answers the way production SQL did, and keep the token it issues.
    const oldUsecase = require(path.join(tmp, "usecase/user.js"))(
      {
        // old repo: SELECT ... WHERE username=? AND password=SHA1(?) AND statuses
        async login(username, password) {
          const r = rows[username];
          return r && r.password === F.legacyHash(password) ? [{ ...r }] : [];
        },
      },
      {},
      { async getNameById() { return [{ employee_name: "Employee A", designation_name: "Cashier", employee_image: null }]; } }
    );
    const login = await oldUsecase.login("A", "a-pass-1", "203.0.113.5");
    assert.equal(login.code, 200);
    oldToken = login.token;

    // Step 4: the NEW backend, with the usecase wired so the legacy DB check runs.
    const usecase = { getSessionState: (id) => F.fakeUserRepo(rows).getSessionState(id) };
    const mw = newAuth.create({ userUsecase: usecase, config: F.config() });
    const permissions = require("./permissions")({
      getPermissionById: async (designationId) => (designationId === 4 ? [{ permission_key: "view_items" }] : designationId === 5 ? [{ permission_key: "view_payroll" }] : []),
    });
    const app = express();
    app.set("trust proxy", "loopback");
    app.use(mw);
    app.get("/whoami", async (req, res) => {
      res.json({
        auth: req.auth,
        decoded: req.decoded,
        can_view_items: await permissions.has(req, "view_items"),
        can_view_payroll: await permissions.has(req, "view_payroll"),
      });
    });
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", () => { port = server.address().port; r(); }); });
  });
  after(() => server && server.close());

  const whoami = async (token) => {
    const res = await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { "x-access-token": token } });
    return { status: res.status, body: await res.json() };
  };

  it("the old token has the production shape: id + employee_id, no sub, no kid, no auth_ver", () => {
    const decoded = require("jsonwebtoken").decode(oldToken, { complete: true });
    assert.equal(decoded.header.kid, undefined);
    assert.equal(decoded.payload.sub, undefined);
    assert.equal(decoded.payload.auth_ver, undefined);
    assert.equal(decoded.payload.id, 7);
    assert.equal(decoded.payload.employee_id, 42);
  });

  it("5/6. the old token still resolves to employee A on the new backend, with A's designation, store and permissions", async () => {
    const { status, body } = await whoami(oldToken);
    assert.equal(status, 200);
    assert.equal(body.auth.userId, 7);
    assert.equal(body.auth.employeeId, 42);
    assert.equal(body.auth.authVersion, 1);
    assert.equal(body.decoded.designation_id, 4);
    assert.equal(body.decoded.store_id, 2);
    assert.equal(body.can_view_items, true, "A's designation permissions");
    assert.equal(body.can_view_payroll, false, "not B's");
  });

  it("7/8. A.employee_id equals B.user_id, and the legacy session does NOT become user B", async () => {
    const { body } = await whoami(oldToken);
    assert.equal(rows.A.employee_id, rows.B.user_id, "fixture precondition: the namespaces overlap");
    assert.notEqual(body.auth.userId, rows.B.user_id);
    assert.notEqual(body.auth.employeeId, rows.B.employee_id);
    assert.equal(body.can_view_payroll, false, "B's permission set is not granted");
  });

  it("9. the same legacy token cannot resolve to the system / break-glass account, and no legacy token can", async () => {
    const { body } = await whoami(oldToken);
    assert.equal(body.auth.isSystemAccount, false);
    assert.notEqual(body.auth.userId, rows.breakglass.user_id);
    // an old-shaped token minted for the system account's user_id is refused outright
    const jwt = require("jsonwebtoken");
    // The auth middleware answers a refusal the way this codebase always
    // has: HTTP 200 with { code: 403 } in the body (util/api.js keys off the
    // body). The proof of refusal is that the probe route never ran: there
    // is no `auth` in the response, only the denial.
    const denied = (r) => r.body && r.body.code === 403 && r.body.auth === undefined;
    const forged = jwt.sign({ id: 9001, employee_id: 42, user_type: 2 }, privateKey, { algorithm: "RS256", expiresIn: "1h" });
    assert.ok(denied(await whoami(forged)), "legacy-shaped token naming the system user_id must be refused");
    const forged2 = jwt.sign({ id: 9001, user_type: 2 }, privateKey, { algorithm: "RS256", expiresIn: "1h" });
    assert.ok(denied(await whoami(forged2)), "legacy-shaped token without employee_id must be refused");
    const forged3 = jwt.sign({ id: 9001, employee_id: 42, user_type: 2, sys: true }, privateKey, { algorithm: "RS256", expiresIn: "1h" });
    assert.ok(denied(await whoami(forged3)), "legacy-shaped token smuggling sys:true must be refused");
  });

  it("a fresh v2 login on the new backend for B is user 42 with employee 9001 - the overlap does not leak either way", async () => {
    const usecase = require("../usecase/user")(F.fakeUserRepo(rows), null, null, { config: F.config() });
    const login = await usecase.login("B", "b-pass-1", "203.0.113.5");
    assert.equal(login.code, 200);
    const { body } = await whoami(login.token);
    assert.equal(body.auth.userId, 42);
    assert.equal(body.auth.employeeId, 9001);
    assert.equal(body.auth.authVersion, 2);
    assert.equal(body.can_view_payroll, true);
    assert.equal(body.can_view_items, false);
  });
});
