/**
 * PHASE 1A: THE GST REGISTRATION IS CONFIGURATION, NOT A CONSTANT.
 *
 *   node --test services/gst_own_gstin_config.test.js
 *
 * ============================== WHAT THIS FIXES ===========================
 *
 * `services/gst_authentication.js` carried the company's GST portal username
 * and GSTIN as two string literals, exported them, and sent them in every OTP
 * request. That put a company identifier in git history permanently, and made
 * changing the registration a code change.
 *
 * They now come from `gst_own_gstin`, populated at boot from the environment.
 *
 * ============================== WHAT MUST STAY TRUE =======================
 *
 * Half of this file is about the thing that became possible only once the
 * GSTIN was configuration: A TAXPAYER JWT OUTLIVING THE REGISTRATION IT WAS
 * MINTED FOR. Change the environment variable, restart, and the stored token
 * is a credential for somebody else. It must never be presented.
 *
 * NO REAL GSTIN OR USERNAME APPEARS HERE. Every value below is obviously
 * synthetic and valid-shaped: 29ABCDE1234F1Z5 / 27ZZZZZ9999Z1Z9 are not real
 * registrations, and the last test asserts the production identifiers are
 * absent from this file and from the source it tests.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  readTaxpayerRegistration,
  maskGstin,
} = require("../config/gst_taxpayer");
const { GstOwnGstinBootstrap } = require("./gst_own_gstin_bootstrap");
const GSTAuthentication = require("./gst_authentication");

/* ------------------------------------------------------- synthetic values */

const FAKE_GSTIN_A = "29ABCDE1234F1Z5";
const FAKE_GSTIN_B = "27ZZZZZ9999Z1Z9";
const FAKE_USER_A = "TESTUSER1";
const FAKE_USER_B = "TESTUSER2";

const envFor = (gstin, username, extra = {}) => ({
  GST_OWN_GSTIN: gstin,
  GST_PORTAL_USERNAME: username,
  ...extra,
});

/* ------------------------------------------------- an in-memory registry  */

function fakeGstOwnGstinRepo(seed = []) {
  let nextId = 1;
  const rows = seed.map((r) => ({ own_gstin_id: nextId++, ...r }));
  return {
    rows,
    async getActive() {
      return rows.find((r) => r.is_active) || null;
    },
    async getByGstin(g) {
      return rows.find((r) => r.gstin === String(g).toUpperCase()) || null;
    },
    async upsertFromConfig({ gstin, portalUsername, legalName = null }) {
      const normalized = String(gstin).toUpperCase();
      let row = rows.find((r) => r.gstin === normalized);
      let created = false;
      if (row) {
        row.portal_username = portalUsername;
        row.legal_name = legalName;
        row.is_active = true;
        row.is_default = true;
      } else {
        row = {
          own_gstin_id: nextId++,
          gstin: normalized,
          portal_username: portalUsername,
          legal_name: legalName,
          is_active: true,
          is_default: true,
        };
        rows.push(row);
        created = true;
      }
      for (const other of rows) {
        if (other !== row) {
          other.is_active = false;
          other.is_default = false;
        }
      }
      return { ...row, created };
    },
  };
}

/** A session row that behaves like the singleton table. */
function fakeSessionRepo(initial = {}) {
  const state = {
    id: 1,
    own_gstin_id: null,
    taxpayer_access_token: null,
    token_expires_at_ms: null,
    last_otp_verified_at_ms: null,
    session_expires_at_ms: null,
    ...initial,
  };
  return {
    state,
    async getSingleton() {
      return { ...state };
    },
    async updateAfterOtpVerify(p) {
      state.own_gstin_id = p.ownGstinId ?? null;
      state.taxpayer_access_token = p.taxpayerAccessToken;
      state.token_expires_at_ms = p.tokenExpiresAtMs;
      state.last_otp_verified_at_ms = p.lastOtpVerifiedAtMs;
      state.session_expires_at_ms = p.sessionExpiresAtMs;
      return { code: 200 };
    },
    async updateAfterTokenRefresh(t, e) {
      state.taxpayer_access_token = t;
      state.token_expires_at_ms = e;
      return { code: 200 };
    },
    async clearTaxpayerJwtOnly() {
      state.taxpayer_access_token = null;
      state.token_expires_at_ms = null;
      return { code: 200 };
    },
    async clearFullSession() {
      state.own_gstin_id = null;
      state.taxpayer_access_token = null;
      state.token_expires_at_ms = null;
      state.last_otp_verified_at_ms = null;
      state.session_expires_at_ms = null;
      return { code: 200 };
    },
  };
}

/** GSTAuthentication with its HTTP calls captured rather than sent. */
function authFor(sessionRepo, registration) {
  const auth = new GSTAuthentication({
    baseUrl: "https://example.invalid",
    apiKey: "test-key",
    gstApiVersion: "1.0.0",
    getSandboxAccessToken: async () => "sandbox-jwt",
    sessionRepo,
    registrationProvider: () => registration,
  });
  return auth;
}

/* ============================================================ the tests == */

describe("no hardcoded taxpayer identity remains", () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, "gst_authentication.js"),
    "utf8",
  );

  it("exports no hardcoded GSTIN or username", () => {
    assert.equal(GSTAuthentication.SANDBOX_GST_TAXPAYER_GSTIN, undefined);
    assert.equal(GSTAuthentication.SANDBOX_GST_TAXPAYER_USERNAME, undefined);
  });

  it("the hardcoded getters are gone", () => {
    const auth = authFor(fakeSessionRepo(), null);
    assert.equal(typeof auth.getHardcodedGstin, "undefined");
    assert.equal(typeof auth.getHardcodedUsername, "undefined");
  });

  it("the source contains no 15-character GSTIN literal", () => {
    // Any quoted 15-char GSTIN-shaped string would be a committed identifier.
    const literals = SRC.match(
      /["'][0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]["']/g,
    );
    assert.equal(literals, null, `GSTIN-shaped literal in source: ${literals}`);
  });

  it("the source no longer names the old constants", () => {
    assert.ok(!SRC.includes("SANDBOX_GST_TAXPAYER_GSTIN"));
    assert.ok(!SRC.includes("SANDBOX_GST_TAXPAYER_USERNAME"));
  });
});

describe("environment validation", () => {
  it("accepts a well-formed registration, trimmed and uppercased", () => {
    const r = readTaxpayerRegistration(
      envFor(`  ${FAKE_GSTIN_A.toLowerCase()}  `, `  ${FAKE_USER_A}  `),
    );
    assert.equal(r.ok, true);
    assert.equal(r.gstin, FAKE_GSTIN_A);
    assert.equal(r.portalUsername, FAKE_USER_A);
  });

  it("missing variables are reported by name, not by value", () => {
    const r = readTaxpayerRegistration({});
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ["GST_OWN_GSTIN", "GST_PORTAL_USERNAME"]);
    assert.match(r.reason, /GST_OWN_GSTIN/);
  });

  it("an empty or whitespace username is missing, not valid", () => {
    assert.equal(
      readTaxpayerRegistration(envFor(FAKE_GSTIN_A, "   ")).ok,
      false,
    );
    assert.equal(readTaxpayerRegistration(envFor(FAKE_GSTIN_A, "")).ok, false);
  });

  for (const bad of [
    "29ABCDE1234F1Z", // 14 chars
    "29ABCDE1234F1Z55", // 16 chars
    "2XABCDE1234F1Z5", // state code not digits
    "29ABCD01234F1Z5", // PAN letters contain a digit
    "29ABCDE1234F1X5", // the fixed 'Z' is wrong
    "29ABCDE1234F1Z!", // non-alphanumeric
  ]) {
    it(`rejects malformed GSTIN (${bad.length} chars)`, () => {
      const r = readTaxpayerRegistration(envFor(bad, FAKE_USER_A));
      assert.equal(r.ok, false, `${bad} should be rejected`);
      assert.match(r.reason, /15-character GSTIN/);
      assert.ok(
        !r.reason.includes(bad),
        "the rejected value must not be echoed",
      );
    });
  }

  it("masking never reveals the middle of a GSTIN", () => {
    const masked = maskGstin(FAKE_GSTIN_A);
    assert.equal(masked.length, 15);
    assert.ok(!masked.includes("ABCDE"));
    assert.ok(masked.startsWith("29"));
  });
});

describe("bootstrap", () => {
  it("creates the registration from the environment", async () => {
    const repo = fakeGstOwnGstinRepo();
    const b = new GstOwnGstinBootstrap({
      gstOwnGstinRepo: repo,
      env: envFor(FAKE_GSTIN_A, FAKE_USER_A),
    });
    const res = await b.run();
    assert.equal(res.configured, true);
    assert.equal(res.created, true);
    assert.equal(b.getRegistration().gstin, FAKE_GSTIN_A);
  });

  it("IS IDEMPOTENT: a second run keeps the same own_gstin_id", async () => {
    const repo = fakeGstOwnGstinRepo();
    const env = envFor(FAKE_GSTIN_A, FAKE_USER_A);
    const first = new GstOwnGstinBootstrap({ gstOwnGstinRepo: repo, env });
    await first.run();
    const idBefore = first.getRegistration().own_gstin_id;

    const second = new GstOwnGstinBootstrap({ gstOwnGstinRepo: repo, env });
    const res = await second.run();

    assert.equal(res.created, false, "a restart must not create a second row");
    assert.equal(second.getRegistration().own_gstin_id, idBefore);
    assert.equal(repo.rows.length, 1);
  });

  it("updates an existing registration's username in place", async () => {
    const repo = fakeGstOwnGstinRepo();
    await new GstOwnGstinBootstrap({
      gstOwnGstinRepo: repo,
      env: envFor(FAKE_GSTIN_A, FAKE_USER_A),
    }).run();

    const b = new GstOwnGstinBootstrap({
      gstOwnGstinRepo: repo,
      env: envFor(FAKE_GSTIN_A, FAKE_USER_B),
    });
    await b.run();

    assert.equal(repo.rows.length, 1);
    assert.equal(b.getRegistration().portal_username, FAKE_USER_B);
  });

  it("a changed GSTIN becomes a NEW row and deactivates the old one", async () => {
    const repo = fakeGstOwnGstinRepo();
    const a = new GstOwnGstinBootstrap({
      gstOwnGstinRepo: repo,
      env: envFor(FAKE_GSTIN_A, FAKE_USER_A),
    });
    await a.run();
    const idA = a.getRegistration().own_gstin_id;

    const b = new GstOwnGstinBootstrap({
      gstOwnGstinRepo: repo,
      env: envFor(FAKE_GSTIN_B, FAKE_USER_B),
    });
    await b.run();

    assert.notEqual(b.getRegistration().own_gstin_id, idA);
    assert.equal(
      repo.rows.find((r) => r.own_gstin_id === idA).is_active,
      false,
    );
  });

  it("MISSING CONFIGURATION DOES NOT THROW - the server must still boot", async () => {
    const repo = fakeGstOwnGstinRepo();
    const b = new GstOwnGstinBootstrap({ gstOwnGstinRepo: repo, env: {} });
    const res = await b.run(); // must not reject
    assert.equal(res.configured, false);
    assert.equal(b.getRegistration(), null);
    assert.match(b.getUnconfiguredReason(), /GST_OWN_GSTIN/);
  });

  it("a database failure does not throw into boot either", async () => {
    const repo = {
      async getActive() {
        throw new Error("db down");
      },
      async upsertFromConfig() {
        throw new Error("db down");
      },
    };
    const b = new GstOwnGstinBootstrap({
      gstOwnGstinRepo: repo,
      env: envFor(FAKE_GSTIN_A, FAKE_USER_A),
    });
    const res = await b.run();
    assert.equal(res.configured, false);
  });

  it("falls back to the stored registration when the env is unset", async () => {
    const repo = fakeGstOwnGstinRepo([
      {
        gstin: FAKE_GSTIN_A,
        portal_username: FAKE_USER_A,
        is_active: true,
        is_default: true,
      },
    ]);
    const b = new GstOwnGstinBootstrap({ gstOwnGstinRepo: repo, env: {} });
    const res = await b.run();
    assert.equal(res.configured, true);
    assert.equal(b.getRegistration().gstin, FAKE_GSTIN_A);
  });
});

describe("OTP uses the configured registration", () => {
  let sent;
  const captureAxios = () => {
    sent = [];
    const axios = require("axios");
    const original = axios.post;
    axios.post = async (url, body) => {
      sent.push({ url, body });
      return { status: 200, data: { code: 200, data: { access_token: "t" } } };
    };
    return () => {
      axios.post = original;
    };
  };

  beforeEach(() => {
    sent = [];
  });

  it("OTP REQUEST sends the configured username and GSTIN", async () => {
    const restore = captureAxios();
    try {
      const reg = {
        own_gstin_id: 7,
        gstin: FAKE_GSTIN_A,
        portal_username: FAKE_USER_A,
      };
      await authFor(fakeSessionRepo(), reg).requestTaxpayerOtp();
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].body, {
        username: FAKE_USER_A,
        gstin: FAKE_GSTIN_A,
      });
    } finally {
      restore();
    }
  });

  it("OTP VERIFY sends the configured username and GSTIN", async () => {
    const restore = captureAxios();
    try {
      const reg = {
        own_gstin_id: 7,
        gstin: FAKE_GSTIN_B,
        portal_username: FAKE_USER_B,
      };
      await authFor(fakeSessionRepo(), reg).verifyTaxpayerOtp("123456");
      assert.equal(sent.length, 1);
      assert.deepEqual(sent[0].body, {
        username: FAKE_USER_B,
        gstin: FAKE_GSTIN_B,
      });
    } finally {
      restore();
    }
  });

  it("OTP VERIFY binds the stored session to that registration", async () => {
    const restore = captureAxios();
    try {
      const repo = fakeSessionRepo();
      const reg = {
        own_gstin_id: 42,
        gstin: FAKE_GSTIN_A,
        portal_username: FAKE_USER_A,
      };
      await authFor(repo, reg).verifyTaxpayerOtp("123456");
      assert.equal(repo.state.own_gstin_id, 42);
      assert.ok(repo.state.taxpayer_access_token);
    } finally {
      restore();
    }
  });

  it("FAILS CLOSED with no registration - and sends nothing", async () => {
    const restore = captureAxios();
    try {
      const auth = authFor(fakeSessionRepo(), null);
      await assert.rejects(
        () => auth.requestTaxpayerOtp(),
        (err) => {
          assert.equal(err.gstOtpPayload.code, 503);
          assert.equal(err.gstOtpPayload.gst_registration_configured, false);
          return true;
        },
      );
      await assert.rejects(() => auth.verifyTaxpayerOtp("123456"));
      assert.equal(sent.length, 0, "no request may reach Sandbox unconfigured");
    } finally {
      restore();
    }
  });
});

describe("a taxpayer token belongs to the registration it was minted for", () => {
  const now = Date.now();
  const liveSession = (ownGstinId) => ({
    own_gstin_id: ownGstinId,
    taxpayer_access_token: "stored-jwt",
    token_expires_at_ms: now + 60 * 60 * 1000,
    last_otp_verified_at_ms: now - 60 * 1000,
    session_expires_at_ms: now + 20 * 24 * 60 * 60 * 1000,
  });

  it("SAME GSTIN: a valid stored session is reused, no OTP", async () => {
    const repo = fakeSessionRepo(liveSession(5));
    const auth = authFor(repo, {
      own_gstin_id: 5,
      gstin: FAKE_GSTIN_A,
      portal_username: FAKE_USER_A,
    });
    const block = await auth.ensureTaxpayerTokenUsableForGstApis();
    assert.equal(block, null, "an in-window bound session must be usable");
    assert.equal(repo.state.taxpayer_access_token, "stored-jwt");
  });

  it("DIFFERENT GSTIN: the token is refused and the session cleared", async () => {
    const repo = fakeSessionRepo(liveSession(5));
    const auth = authFor(repo, {
      own_gstin_id: 6, // the environment changed
      gstin: FAKE_GSTIN_B,
      portal_username: FAKE_USER_B,
    });
    const block = await auth.ensureTaxpayerTokenUsableForGstApis();

    assert.ok(block, "a cross-GSTIN token must never be usable");
    assert.equal(block.requires_gst_taxpayer_otp, true);
    assert.equal(block.gstin_binding_mismatch, true);
    assert.equal(
      repo.state.taxpayer_access_token,
      null,
      "token must be cleared",
    );
    assert.equal(repo.state.own_gstin_id, null);
  });

  it("UNBOUND (the production row at deploy): refused, OTP required once", async () => {
    const repo = fakeSessionRepo(liveSession(null));
    const auth = authFor(repo, {
      own_gstin_id: 1,
      gstin: FAKE_GSTIN_A,
      portal_username: FAKE_USER_A,
    });
    const block = await auth.ensureTaxpayerTokenUsableForGstApis();

    assert.ok(block);
    assert.equal(block.requires_gst_taxpayer_otp, true);
    assert.equal(repo.state.taxpayer_access_token, null);
  });

  it("after re-verifying, the same session is usable again", async () => {
    const axios = require("axios");
    const original = axios.post;
    axios.post = async () => ({
      status: 200,
      data: { code: 200, data: { access_token: "fresh-jwt" } },
    });
    try {
      const repo = fakeSessionRepo(liveSession(null));
      const reg = {
        own_gstin_id: 1,
        gstin: FAKE_GSTIN_A,
        portal_username: FAKE_USER_A,
      };
      const auth = authFor(repo, reg);

      await auth.ensureTaxpayerTokenUsableForGstApis(); // refused, cleared
      await auth.verifyTaxpayerOtp("123456"); // one OTP
      const block = await auth.ensureTaxpayerTokenUsableForGstApis();

      assert.equal(block, null, "the rebound session must now be usable");
      assert.equal(repo.state.own_gstin_id, 1);
    } finally {
      axios.post = original;
    }
  });

  it("no registration: taxpayer APIs refuse with 503, not a crash", async () => {
    const auth = authFor(fakeSessionRepo(liveSession(1)), null);
    const block = await auth.ensureTaxpayerTokenUsableForGstApis();
    assert.equal(block.code, 503);
    assert.equal(block.gst_registration_configured, false);
  });

  it("GSTR-2A obtains its token through the same guarded path", async () => {
    // getTaxpayerAccessTokenForGstApis is what services/sandbox.js calls for
    // GSTR-2A. It must refuse a cross-GSTIN token exactly as the check does.
    const repo = fakeSessionRepo(liveSession(5));
    const auth = authFor(repo, {
      own_gstin_id: 9,
      gstin: FAKE_GSTIN_B,
      portal_username: FAKE_USER_B,
    });
    await assert.rejects(
      () => auth.getTaxpayerAccessTokenForGstApis(),
      (err) => {
        assert.ok(
          err.gstOtpPayload,
          "must carry the 428 payload the route maps",
        );
        assert.equal(err.gstOtpPayload.gstin_binding_mismatch, true);
        return true;
      },
    );

    // ...and admits the matching one.
    const ok = fakeSessionRepo(liveSession(5));
    const good = authFor(ok, {
      own_gstin_id: 5,
      gstin: FAKE_GSTIN_A,
      portal_username: FAKE_USER_A,
    });
    assert.equal(await good.getTaxpayerAccessTokenForGstApis(), "stored-jwt");
  });
});

describe("no production identity in this branch", () => {
  it("this test file uses only obviously synthetic values", () => {
    const self = fs.readFileSync(__filename, "utf8");
    // The synthetic GSTINs are the ONLY GSTIN-shaped literals here.
    const found = [
      ...new Set(
        self.match(/[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/g) || [],
      ),
    ];
    assert.deepEqual(found.sort(), [FAKE_GSTIN_A, FAKE_GSTIN_B].sort());
  });
});
