/**
 * Shared fixtures for the Stage 0A authentication tests.
 *
 * Everything here is in-memory: a fake user repository with the same
 * method surface as repository/user.js, a fake audit log that records
 * events, a real JWT service on a throwaway RSA keypair, and cheap scrypt
 * parameters so a test file does not spend seconds hashing.
 */
const crypto = require("crypto");
const { createJwtService } = require("../services/jwt");
const passwordService = require("../services/password");

const CHEAP = { ln: 12, r: 8, p: 1, keyLength: 64, saltLength: 16 };

const hashCheap = (pw) => passwordService.hash(pw, CHEAP);

const keypair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return { publicKey, privateKey };
};

const makeJwt = (overrides = {}) => {
  const k = keypair();
  return {
    keys: k,
    service: createJwtService({
      privateKey: k.privateKey,
      publicKeys: { legacy: k.publicKey },
      activeKid: "legacy",
      legacyKid: "legacy",
      requireKid: false,
      tokenCutoff: 0,
      ...overrides,
    }),
  };
};

/** A config object with every Stage 0A flag explicit, defaulting to Deployment A. */
const makeConfig = (over = {}) => ({
  jwt: { tokenLifetime: "1d" },
  password: {
    hashOnLogin: false,
    rejectLegacy: false,
    enforcePasswordChange: false,
    policy: { minLength: 8, maxLength: 128, breakGlassMinLength: 20 },
    ...(over.password || {}),
  },
  login: {
    allowQueryString: true,
    requireHttps: false,
    lockout: {
      enabled: false,
      threshold: 5,
      minutes: 15,
      ipThreshold: 60,
      ipWindowMinutes: 15,
      ipBlockMinutes: 5,
      ...((over.login && over.login.lockout) || {}),
    },
    tokenValidFromEnabled: false,
    tokenValidFromCacheMs: 0,
    ...(over.login ? { ...over.login, lockout: undefined } : {}),
    ...(over.login && over.login.lockout === undefined ? {} : {}),
  },
  resetToken: { bytes: 32, lifetimeMinutes: 30, maxAttemptsPerIp: 10, attemptWindowMinutes: 15 },
  provisioning: { secure: false },
  breakGlass: { rotationDays: 90, alertChatId: null },
});

// makeConfig above merges awkwardly for nested lockout; provide a clean deep merge instead.
function config(over = {}) {
  const base = makeConfig();
  const out = JSON.parse(JSON.stringify(base));
  const merge = (dst, src) => {
    for (const k of Object.keys(src)) {
      if (src[k] && typeof src[k] === "object" && !Array.isArray(src[k])) {
        dst[k] = merge(dst[k] || {}, src[k]);
      } else dst[k] = src[k];
    }
    return dst;
  };
  return merge(out, over);
}

/** The row shape findByUsername returns. */
const employeeRow = (over = {}) => ({
  user_id: 7,
  username: "1003",
  employee_id: 1003,
  user_type: 1,
  status: 1,
  password: null,
  password_hash: null,
  password_algo: "sha1",
  must_change_password: 0,
  password_flag_reason: null,
  failed_login_count: 0,
  locked_until: null,
  token_valid_from: null,
  is_system_account: 0,
  ip_policy: "branch",
  allowed_ips: null,
  branch_enabled: 0,
  branch_ips: null,
  employee_status: 1,
  store_id: 2,
  department_id: 1,
  designation_id: 4,
  employee_name: "Test User",
  employee_image: null,
  primary_contact_number: "9000000000",
  designation_name: "Cashier",
  ...over,
});

const systemRow = (over = {}) => ({
  ...employeeRow(),
  user_id: 99,
  username: "breakglass",
  employee_id: null,
  user_type: 2,
  is_system_account: 1,
  // A system account only ever holds a modern hash - never SHA-1 (A2).
  password: null,
  password_algo: "scrypt",
  ip_policy: "unrestricted",
  employee_status: null,
  store_id: null,
  designation_id: null,
  employee_name: null,
  designation_name: null,
  primary_contact_number: null,
  ...over,
});

/**
 * In-memory user repository. `rows` is a map username -> row. Mutations are
 * applied to the row objects so a test can assert on them, and every SQL
 * guard from the real repository is mirrored here as a JS guard so the
 * usecase's behaviour is tested against the same contract.
 */
function fakeUserRepo(rows) {
  const byId = () => Object.values(rows).reduce((m, r) => ((m[r.user_id] = r), m), {});
  const calls = [];
  const tokens = [];
  const repo = {
    calls,
    tokens,
    async findByUsername(username) {
      calls.push(["findByUsername", username]);
      const r = Object.values(rows).filter((x) => x.username === username);
      return r.map((x) => ({ ...x }));
    },
    async getCredentialRow(userId) {
      const r = byId()[userId];
      return r ? { ...r } : null;
    },
    async getAccount(userId) {
      const r = byId()[userId];
      return r ? { ...r } : null;
    },
    async setModernPassword(userId, hash, { clearMustChange } = {}) {
      calls.push(["setModernPassword", userId]);
      const r = byId()[userId];
      if (!r || r.is_system_account) return { affectedRows: 0 };
      r.password_hash = hash;
      r.password_algo = "scrypt";
      r.password = null;
      r.token_valid_from = new Date();
      r.failed_login_count = 0;
      r.locked_until = null;
      if (clearMustChange) {
        r.must_change_password = 0;
        r.password_flag_reason = null;
      }
      return { affectedRows: 1 };
    },
    async migrateLegacyPassword(userId, hash) {
      calls.push(["migrateLegacyPassword", userId]);
      const r = byId()[userId];
      if (!r || r.is_system_account || r.password_algo !== "sha1") return { affectedRows: 0 };
      r.password_hash = hash;
      r.password_algo = "scrypt";
      r.password = null;
      r.password_migrated_at = new Date();
      return { affectedRows: 1 };
    },
    async recordFailedLogin(userId, lockUntil) {
      calls.push(["recordFailedLogin", userId, lockUntil]);
      const r = byId()[userId];
      if (!r) return;
      r.failed_login_count = (r.failed_login_count || 0) + 1;
      r.last_failed_login_at = new Date();
      r.locked_until = lockUntil;
    },
    async recordSuccessfulLogin(userId) {
      calls.push(["recordSuccessfulLogin", userId]);
      const r = byId()[userId];
      if (!r) return;
      r.failed_login_count = 0;
      r.locked_until = null;
      r.last_login_at = new Date();
    },
    async unlock(userId) {
      calls.push(["unlock", userId]);
      const r = byId()[userId];
      if (!r || r.is_system_account) return { affectedRows: 0 };
      r.failed_login_count = 0;
      r.locked_until = null;
      return { affectedRows: 1 };
    },
    async setMustChangePassword(userId, reason) {
      const r = byId()[userId];
      if (!r || r.is_system_account) return { affectedRows: 0 };
      r.must_change_password = 1;
      r.password_flag_reason = reason;
      return { affectedRows: 1 };
    },
    async bumpTokenValidFrom(userId) {
      calls.push(["bumpTokenValidFrom", userId]);
      const r = byId()[userId];
      if (r) r.token_valid_from = new Date();
    },
    async getSessionState(userId) {
      const r = byId()[userId];
      if (!r) return null;
      return {
        user_id: r.user_id,
        status: r.status,
        token_valid_from: r.token_valid_from,
        must_change_password: r.must_change_password,
        is_system_account: r.is_system_account,
      };
    },
    async getIpPolicy(userId) {
      const r = byId()[userId];
      return r ? { ...r } : null;
    },
    async getIpRestrictions() {
      return Object.values(rows).map((r) => ({ ...r }));
    },
    async updateIpPolicy(userId, allowedIps, ipPolicy) {
      calls.push(["updateIpPolicy", userId, allowedIps, ipPolicy]);
      const r = byId()[userId];
      if (!r || r.is_system_account) return { affectedRows: 0 };
      r.allowed_ips = allowedIps;
      r.ip_policy = ipPolicy;
      return { affectedRows: 1 };
    },
    async createLogin(username, user_type, employee_id, passwordHash, opts = {}) {
      calls.push(["createLogin", username, passwordHash, opts]);
      const user_id = Object.keys(byId()).length + 100;
      rows[username] = employeeRow({
        user_id,
        username,
        employee_id,
        user_type: Number(user_type),
        password_hash: passwordHash,
        password_algo: "scrypt",
        password: null,
        must_change_password: opts.mustChange ? 1 : 0,
        password_flag_reason: opts.flagReason || null,
      });
      return { insertId: user_id };
    },
    async createLoginIfNeeded(username, user_type, employee_id, passwordHash, opts = {}) {
      if (Object.values(rows).some((r) => r.employee_id === employee_id)) return { affectedRows: 0 };
      return repo.createLogin(username, user_type, employee_id, passwordHash, opts);
    },
    async createResetToken(userId, tokenHash, purpose, expiresAt, requestedBy, requestedIp) {
      tokens.push({ reset_id: tokens.length + 1, user_id: userId, token_hash: tokenHash, purpose, expires_at: expiresAt, used_at: null, requested_by: requestedBy, requested_ip: requestedIp });
    },
    async expireResetTokens(userId) {
      for (const t of tokens) if (t.user_id === userId && !t.used_at) t.used_at = new Date();
    },
    async findResetToken(tokenHash) {
      const t = tokens.find((x) => x.token_hash === tokenHash);
      if (!t) return null;
      const u = byId()[t.user_id];
      return { ...t, is_system_account: u.is_system_account, status: u.status, username: u.username, employee_id: u.employee_id };
    },
    async consumeResetToken(resetId) {
      const t = tokens.find((x) => x.reset_id === resetId);
      if (!t || t.used_at) return false;
      t.used_at = new Date();
      return true;
    },
  };
  return repo;
}

function fakeAuthLog() {
  const events = [];
  return {
    events,
    async record(e) {
      events.push(e);
    },
    async bumpMetric(m) {
      events.push({ metric: m });
    },
    async getMetrics() {
      return [];
    },
    async listRecent() {
      return events;
    },
    async findSystemAccountsDueRotation() {
      return [];
    },
    has(event) {
      return events.some((e) => e.event === event);
    },
  };
}

function fakeTelegram() {
  const sent = [];
  return {
    sent,
    async sendMessage(chatId, msg, opts) {
      sent.push({ chatId, msg, opts });
      return { code: 200 };
    },
  };
}

module.exports = {
  CHEAP,
  hashCheap,
  keypair,
  makeJwt,
  config,
  employeeRow,
  systemRow,
  fakeUserRepo,
  fakeAuthLog,
  fakeTelegram,
  legacyHash: passwordService.legacyHash,
};
