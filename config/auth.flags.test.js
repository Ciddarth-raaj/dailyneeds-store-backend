/**
 * Gates 15 + 16 — every Stage 0A feature flag: read once at module load,
 * documented default when absent, safe parse of odd values, and the
 * documented Deployment A posture.
 *
 * config/auth.js is loaded in a child process per scenario so the
 * environment is exactly what the scenario says and nothing else.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const path = require("path");

const HERE = path.resolve(__dirname);

/** Load config/auth.js with exactly `env` (plus PATH) and return the flags as JSON. */
function load(env = {}) {
  const script = `
    const c = require(${JSON.stringify(path.join(HERE, "auth.js"))});
    const pick = {
      password: { hashOnLogin: c.password.hashOnLogin, rejectLegacy: c.password.rejectLegacy, enforcePasswordChange: c.password.enforcePasswordChange,
                  flagWeakOnLogin: c.password.flagWeakOnLogin, minLength: c.password.policy.minLength, breakGlassMinLength: c.password.policy.breakGlassMinLength,
                  scrypt: c.password.scrypt },
      login: { allowQueryString: c.login.allowQueryString, requireHttps: c.login.requireHttps, lockoutEnabled: c.login.lockout.enabled,
               lockoutThreshold: c.login.lockout.threshold, tokenValidFromEnabled: c.login.tokenValidFromEnabled,
               employeeStatusCheck: c.login.employeeStatusCheck, tokenValidFromCacheMs: c.login.tokenValidFromCacheMs },
      provisioning: { secure: c.provisioning.secure },
      jwt: { requireKid: c.jwt.requireKid, activeKid: c.jwt.activeKid, legacyKid: c.jwt.legacyKid, usingTrackedKeyFallback: c.jwt.usingTrackedKeyFallback,
             tokenLifetime: c.jwt.tokenLifetime, publicKids: Object.keys(c.jwt.publicKeys) },
      breakGlass: { rotationDays: c.breakGlass.rotationDays, alertChatId: c.breakGlass.alertChatId },
    };
    process.stdout.write(JSON.stringify(pick));
  `;
  const out = execFileSync(process.execPath, ["-e", script], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  return JSON.parse(out);
}

/** The Deployment A posture: what production runs with NO auth variable set. */
const DEPLOYMENT_A = {
  password: { hashOnLogin: false, rejectLegacy: false, enforcePasswordChange: false, flagWeakOnLogin: true, minLength: 8, breakGlassMinLength: 20 },
  login: { allowQueryString: true, requireHttps: false, lockoutEnabled: false, lockoutThreshold: 5, tokenValidFromEnabled: false, employeeStatusCheck: true, tokenValidFromCacheMs: 60000 },
  provisioning: { secure: false },
  jwt: { requireKid: false, activeKid: "legacy", legacyKid: "legacy", usingTrackedKeyFallback: true, tokenLifetime: "1d", publicKids: ["legacy"] },
  breakGlass: { rotationDays: 90, alertChatId: null },
};

describe("gate 16 — absent flags default to the Deployment A posture", () => {
  it("every flag has its documented default with an empty environment", () => {
    const c = load({});
    for (const [group, expected] of Object.entries(DEPLOYMENT_A)) {
      for (const [k, v] of Object.entries(expected)) {
        assert.deepEqual(c[group][k], v, `${group}.${k}`);
      }
    }
    assert.deepEqual(c.password.scrypt, { ln: 15, r: 8, p: 3, keyLength: 64, saltLength: 16 });
  });

  it("the two defaults that keep production behaviour are ON by default and the hardening ones are OFF", () => {
    const c = load({});
    assert.equal(c.login.allowQueryString, true, "old frontend bundles keep logging in");
    assert.equal(c.password.rejectLegacy, false, "SHA-1 accounts keep logging in");
    assert.equal(c.password.enforcePasswordChange, false, "nobody is confined to change-password on day one");
    assert.equal(c.login.lockoutEnabled, false);
    assert.equal(c.login.tokenValidFromEnabled, false);
    assert.equal(c.jwt.requireKid, false, "tokens issued by the old code still verify");
    assert.equal(c.login.requireHttps, false);
  });

  it("the two gate 13/14 flags are ON by default and are pure-detection (they never refuse a correct login by themselves)", () => {
    const c = load({});
    assert.equal(c.password.flagWeakOnLogin, true);
    assert.equal(c.login.employeeStatusCheck, true);
  });
});

describe("gate 15 — flags are parsed once at load and odd values are safe", () => {
  const boolFlags = [
    ["AUTH_HASH_ON_LOGIN", "password", "hashOnLogin"],
    ["AUTH_REJECT_LEGACY_SHA1", "password", "rejectLegacy"],
    ["AUTH_ENFORCE_PASSWORD_CHANGE", "password", "enforcePasswordChange"],
    ["AUTH_FLAG_WEAK_ON_LOGIN", "password", "flagWeakOnLogin"],
    ["AUTH_LEGACY_QUERY_LOGIN", "login", "allowQueryString"],
    ["AUTH_REQUIRE_HTTPS", "login", "requireHttps"],
    ["AUTH_LOCKOUT_ENABLED", "login", "lockoutEnabled"],
    ["AUTH_TOKEN_VALID_FROM_ENABLED", "login", "tokenValidFromEnabled"],
    ["AUTH_EMPLOYEE_STATUS_CHECK", "login", "employeeStatusCheck"],
    ["AUTH_SECURE_PROVISIONING", "provisioning", "secure"],
    ["JWT_REQUIRE_KID", "jwt", "requireKid"],
  ];

  for (const [name, group, key] of boolFlags) {
    it(`${name}: exactly "true" or "1" -> true; any other non-empty value -> false; empty/unset -> default`, () => {
      const dflt = DEPLOYMENT_A[group][key];
      for (const v of ["true", "1"]) assert.equal(load({ [name]: v })[group][key], true, `${name}=${JSON.stringify(v)}`);
      // Strict on purpose: "yes", "TRUE", "on", " true " are NOT true. A typo
      // can therefore only ever turn a flag OFF, never switch hardening on
      // by accident — and for the two default-ON detection flags a typo
      // turns detection off, which is why the runbook says to set flags
      // only as the literal strings true/false.
      for (const v of ["false", "0", "no", "FALSE", "yes", "TRUE", "on", " true ", "maybe"]) assert.equal(load({ [name]: v })[group][key], false, `${name}=${JSON.stringify(v)}`);
      assert.equal(load({ [name]: "" })[group][key], dflt, `${name}="" should fall back to the default`);
      assert.equal(load({})[group][key], dflt, `${name} unset should fall back to the default`);
    });
  }

  it("integer flags parse and fall back on garbage", () => {
    assert.equal(load({ AUTH_LOCKOUT_THRESHOLD: "7" }).login.lockoutThreshold, 7);
    assert.equal(load({ AUTH_LOCKOUT_THRESHOLD: "seven" }).login.lockoutThreshold, 5);
    assert.equal(load({ AUTH_PASSWORD_MIN_LENGTH: "10" }).password.minLength, 10);
    assert.equal(load({ AUTH_TOKEN_VALID_FROM_CACHE_MS: "0" }).login.tokenValidFromCacheMs, 0);
  });

  it("a flag is read at load time only: changing process.env afterwards does not change behaviour", () => {
    const script = `
      process.env.AUTH_HASH_ON_LOGIN = "false";
      const c = require(${JSON.stringify(path.join(HERE, "auth.js"))});
      const before = c.password.hashOnLogin;
      process.env.AUTH_HASH_ON_LOGIN = "true";
      process.env.AUTH_EMPLOYEE_STATUS_CHECK = "false";
      process.stdout.write(JSON.stringify({ before, after: c.password.hashOnLogin, emp: c.login.employeeStatusCheck }));
    `;
    const out = JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { PATH: process.env.PATH }, encoding: "utf8" }));
    assert.deepEqual(out, { before: false, after: false, emp: true });
  });

  it("JWT_PUBLIC_KEYS that is not a JSON object fails at startup, loudly, rather than silently trusting nothing", () => {
    assert.throws(() => load({ JWT_PUBLIC_KEYS: "not-json" }), /JWT_PUBLIC_KEYS must be a JSON object/);
    assert.throws(() => load({ JWT_PUBLIC_KEYS: "[1,2]" }), /JWT_PUBLIC_KEYS must be a JSON object/);
  });

  it("external key configuration is recognised (gate 17A shape) and the tracked-key fallback flag turns off", () => {
    const c = load({ JWT_PRIVATE_KEY_PATH: "/x/priv.key", JWT_PUBLIC_KEYS: JSON.stringify({ legacy: "/x/pub.key" }) });
    assert.equal(c.jwt.usingTrackedKeyFallback, false);
    assert.deepEqual(c.jwt.publicKids, ["legacy"]);
    assert.equal(c.jwt.activeKid, "legacy");
  });
});
