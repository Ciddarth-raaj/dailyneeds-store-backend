/**
 * The outlet directory — GET /outlet/directory.
 *
 *   node --test middlewares/outlet_directory.test.js
 *
 * B2 put `view_stores` in front of `GET /outlet`, which is right: that route
 * is `SELECT * FROM outlets` and carries an address, phone numbers, a Telegram
 * chat id, a GoFrugal id, opening cash and the branch IP policy. But every
 * outlet DROPDOWN in the app was reading it, so a permission for administering
 * stores became a prerequisite for filtering by one - and Accounts Executive,
 * which holds `view_purchases` and is meant to work across all branches, got
 * an empty selector on /purchase.
 *
 * Same answer as the employee directory: return less, do not hand the
 * permission back. What these tests defend is that "less" stays less - the
 * response is asserted key by key, so a future `SELECT *` regression or an
 * added join cannot slip an address through unnoticed.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-outlet-dir-"));
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
fs.writeFileSync(path.join(dir, "priv.key"), privateKey);
fs.writeFileSync(path.join(dir, "pub.key"), publicKey);
process.env.JWT_PRIVATE_KEY_PATH = path.join(dir, "priv.key");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({ legacy: path.join(dir, "pub.key") });
process.env.JWT_ACTIVE_KID = "legacy";
process.env.JWT_LEGACY_KID = "legacy";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");
const auth = require("./auth");
const buildPermissions = require("./permissions");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");

const USER_ID = 7;
const EMPLOYEE_ID = 1003;

/** Production designation ids, so the intent of each case is readable. */
const ACCOUNTS_EXECUTIVE = 15; // holds view_purchases, NOT view_stores
const STORE_ADMIN = 3; // holds view_stores
const OUTLET_STAFF = 4; // holds nothing

const GRANTS = {
  [ACCOUNTS_EXECUTIVE]: ["view_purchases"],
  [STORE_ADMIN]: [P.VIEW_STORES],
  [OUTLET_STAFF]: [],
};

/**
 * The outlets table as rows. Every column `SELECT *` would return is present,
 * so a leak has something to leak.
 */
const OUTLETS = [
  {
    outlet_id: 2, outlet_name: "Branch Two", outlet_nickname: "Two", outlet_code: "DN2",
    outlet_address: "12 Main Road", outlet_phone: "044-1111", phone: "9000000001",
    telegram_chat_id: "-100123", telegram_username: "dn2bot", gofrugal_id: 22,
    opening_cash: 5000, is_active: 1, allowed_ips: "10.0.0.1", ip_restriction_enabled: 1,
  },
  {
    outlet_id: 1, outlet_name: "Aaa Branch One", outlet_nickname: "One", outlet_code: "DN1",
    outlet_address: "9 Test Road", outlet_phone: "044-2222", phone: "9000000002",
    telegram_chat_id: "-100456", telegram_username: "dn1bot", gofrugal_id: 11,
    opening_cash: 4000, is_active: 1, allowed_ips: "10.0.0.2", ip_restriction_enabled: 1,
  },
  {
    outlet_id: 5, outlet_name: "Closed Branch", outlet_nickname: "Closed", outlet_code: "DN5",
    outlet_address: "1 Old Street", outlet_phone: "044-3333", phone: "9000000003",
    telegram_chat_id: "-100789", telegram_username: "dn5bot", gofrugal_id: 55,
    opening_cash: 0, is_active: 0, allowed_ips: null, ip_restriction_enabled: 0,
  },
];

/** Applies exactly what each repository query's SQL does. */
const outletUsecase = {
  async getDirectory() {
    return OUTLETS.map((o) => ({ outlet_id: o.outlet_id, outlet_name: o.outlet_name })).sort((a, b) =>
      a.outlet_name.localeCompare(b.outlet_name)
    );
  },
  async get() {
    // `SELECT *` minus the IP fields the usecase strips.
    return OUTLETS.map(({ allowed_ips, ip_restriction_enabled, ...rest }) => rest);
  },
};

const sessionState = {
  user_id: USER_ID, employee_id: EMPLOYEE_ID, status: 1, token_valid_from: null,
  must_change_password: 0, is_system_account: 0, employee_status: 1,
};

let server, port;

before(async () => {
  const permissions = buildPermissions({
    getPermissionById: async (designationId) =>
      (GRANTS[designationId] || []).map((permission_key) => ({ permission_key, is_active: 1 })),
  });

  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionState } }));
  delete require.cache[require.resolve("../routes/outlet")];
  const routes = require("../routes/outlet")(outletUsecase, permissions, (req, res, next) => next());
  app.use("/outlet", routes.getRouter());

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = ({ designationId = ACCOUNTS_EXECUTIVE, userType = 1 } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2, sub: String(USER_ID), id: USER_ID, employee_id: EMPLOYEE_ID,
      user_type: userType, designation_id: designationId, store_id: 2,
    },
    "1d"
  );

const call = async (p, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    headers: token ? { "x-access-token": await token } : {},
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    body = undefined;
  }
  return { status: res.status, body, text };
};

/* ============================================== the directory works ===== */
describe("Accounts Executive can list every outlet", () => {
  it("without holding view_stores", async () => {
    const r = await call("/outlet/directory", tokenFor({ designationId: ACCOUNTS_EXECUTIVE }));
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 3, "every outlet, not just their own");
    assert.deepEqual(
      r.body.map((o) => o.outlet_id).sort((a, b) => a - b),
      [1, 2, 5]
    );
  });

  it("and that designation genuinely does not hold view_stores", async () => {
    // If this ever starts passing for the wrong reason - because somebody
    // granted the key - the test above would no longer prove anything.
    assert.ok(!GRANTS[ACCOUNTS_EXECUTIVE].includes(P.VIEW_STORES));
    const full = await call("/outlet", tokenFor({ designationId: ACCOUNTS_EXECUTIVE }));
    assert.equal(full.status, 403);
    assert.equal(full.body.msg, "You do not have permission to perform this action");
  });

  it("closed outlets are listed too, because old purchases belong to them", async () => {
    const r = await call("/outlet/directory", tokenFor());
    assert.ok(r.body.some((o) => o.outlet_id === 5), "a filter that cannot name a closed branch cannot find its data");
  });

  it("sorted by name, so the dropdown is usable", async () => {
    const r = await call("/outlet/directory", tokenFor());
    assert.deepEqual(r.body.map((o) => o.outlet_name), ["Aaa Branch One", "Branch Two", "Closed Branch"]);
  });
});

/* ================================================ and returns less ====== */
describe("the directory returns an id and a name, and nothing else", () => {
  it("exactly two keys per row - asserted by key, not by spot check", async () => {
    const r = await call("/outlet/directory", tokenFor());
    for (const row of r.body) {
      assert.deepEqual(Object.keys(row).sort(), ["outlet_id", "outlet_name"]);
    }
  });

  it("no administration field reaches the caller", async () => {
    const r = await call("/outlet/directory", tokenFor());
    for (const leak of [
      "outlet_address", "outlet_phone", "phone", "telegram_chat_id", "telegram_username",
      "gofrugal_id", "opening_cash", "allowed_ips", "ip_restriction_enabled", "outlet_code",
    ]) {
      assert.ok(!new RegExp(`"${leak}"`).test(r.text), `${leak} must not be in the directory`);
    }
    // and no value of one, either
    for (const value of ["12 Main Road", "044-1111", "-100123", "dn2bot", "10.0.0.1"]) {
      assert.ok(!r.text.includes(value), `the value ${value} must not appear`);
    }
  });

  it("the repository query names its columns rather than selecting everything", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "repository/outlet.js"), "utf8");
    const fn = src.slice(src.indexOf("getDirectory()"), src.indexOf("updateStatus(file)"));
    assert.match(fn, /SELECT outlet_id, outlet_name FROM outlets/);
    assert.ok(!/SELECT \*/.test(fn), "a SELECT * here would leak the whole record");
  });
});

/* =========================================== nothing else is widened ==== */
describe("store administration is not widened", () => {
  it("GET /outlet still requires view_stores", async () => {
    assert.equal((await call("/outlet", tokenFor({ designationId: OUTLET_STAFF }))).status, 403);
    assert.equal((await call("/outlet", tokenFor({ designationId: ACCOUNTS_EXECUTIVE }))).status, 403);
    assert.equal((await call("/outlet", tokenFor({ designationId: STORE_ADMIN }))).status, 200);
  });

  it("the other outlet reads still require view_stores", async () => {
    for (const p of ["/outlet/outlet_id?outlet_id=2", "/outlet/id?outlet_id=2"]) {
      assert.equal((await call(p, tokenFor({ designationId: ACCOUNTS_EXECUTIVE }))).status, 403, p);
    }
  });

  it("the directory is READ ONLY - it is a GET and the router declares no write for it", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "routes/outlet.js"), "utf8");
    assert.match(src, /router\.get\("\/directory"/);
    assert.ok(!/router\.(post|put|delete)\("\/directory"/.test(src));
    // Every write on this router is still gated on a permission. Not on one
    // specific key: /ip-restriction uses `manage_ip_restrictions`, which is
    // narrower than add_stores and correct.
    const writes = src.match(/router\.(post|put|delete)\([^)]*/g) || [];
    assert.ok(writes.length >= 3, "there are writes on this router to check");
    for (const w of writes) {
      assert.match(
        w,
        /needs\(|this\.permissions\.require/,
        `an outlet write with no permission gate: ${w}`
      );
    }
  });

  it("admin (user_type 2) behaviour is unchanged - it reaches both", async () => {
    const admin = tokenFor({ designationId: OUTLET_STAFF, userType: 2 });
    assert.equal((await call("/outlet", admin)).status, 200, "the full record, via the bypass");
    assert.equal((await call("/outlet/directory", admin)).status, 200);
  });
});

/* ============================================ still authenticated ======= */
describe("the directory is authenticated", () => {
  it("an anonymous caller is refused (B1)", async () => {
    const r = await call("/outlet/directory", null);
    assert.equal(r.body.code, 403);
    assert.equal(r.body.msg, "Access Denied", "authentication, not authorisation");
  });

  it("and it is not on the unprotected list", () => {
    const { unProtectedRoutes } = require("./auth");
    for (const key of Object.keys(unProtectedRoutes)) {
      assert.ok(!/^\/outlet/.test(key), `/outlet* must not be unprotected: ${key}`);
    }
  });
});
