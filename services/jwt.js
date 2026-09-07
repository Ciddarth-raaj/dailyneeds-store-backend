const jwt = require("jsonwebtoken");
const fs = require("fs");
const logger = require("../utils/logger");
const defaults = require("../config/auth").jwt;

/**
 * JWT signing and verification — Stage 0A.
 *
 * Verification pins RS256. The `algorithms` option (plural) is what
 * jsonwebtoken actually honours; the singular spelling this file used before
 * was silently ignored. The header's `alg` is checked explicitly as well, so
 * a token claiming HS256 is refused before any key is consulted.
 *
 * `kid` is attacker-controlled: it comes from the unverified header. It is
 * resolved only by exact lookup in a frozen map built once at startup from
 * configuration. It is never used to build a path, fetch a key, or run
 * anything. An unknown kid is rejected.
 *
 * Rotation is by overlap: several verification keys, one signing key. A
 * token with no kid (issued before this release) verifies with the legacy
 * key until `requireKid` is switched on.
 */

const ALGORITHM = "RS256";

const readPem = (p) => fs.readFileSync(p, "utf8");

/**
 * @param {object} options
 * @param {string} [options.privateKey]      PEM, takes precedence over path
 * @param {string} [options.privateKeyPath]
 * @param {Object<string,string>} [options.publicKeys]     kid -> PEM
 * @param {Object<string,string>} [options.publicKeyPaths] kid -> path
 * @param {string} options.activeKid
 * @param {string} options.legacyKid
 * @param {boolean} [options.requireKid]
 * @param {number} [options.tokenCutoff]
 */
function createJwtService(options) {
  const privateKey =
    options.privateKey !== undefined ? options.privateKey : readPem(options.privateKeyPath);

  // Fixed allow-list. Object.create(null) so no prototype names ("constructor",
  // "__proto__") can ever match a kid.
  const keys = Object.create(null);
  const pems = options.publicKeys || {};
  for (const kid of Object.keys(pems)) keys[kid] = pems[kid];
  const paths = options.publicKeyPaths || {};
  for (const kid of Object.keys(paths)) keys[kid] = readPem(paths[kid]);
  Object.freeze(keys);

  const activeKid = options.activeKid;
  const legacyKid = options.legacyKid;
  const requireKid = Boolean(options.requireKid);
  const tokenCutoff = options.tokenCutoff || 0;

  if (!keys[activeKid]) {
    throw new Error(`JWT active kid "${activeKid}" has no verification key configured`);
  }

  const lookupKey = (kid) => {
    if (typeof kid !== "string" || kid.length === 0 || kid.length > 64) return null;
    return Object.prototype.hasOwnProperty.call(keys, kid) ? keys[kid] : null;
  };

  const sign = (payload, expiresIn, extra = {}) =>
    new Promise((resolve, reject) => {
      jwt.sign(
        payload,
        privateKey,
        { expiresIn, algorithm: ALGORITHM, keyid: activeKid, ...extra },
        (err, token) => (err ? reject(err) : resolve(token))
      );
    });

  const verify = (token) =>
    new Promise((resolve, reject) => {
      const decodedHeader = jwt.decode(token, { complete: true });
      if (!decodedHeader || !decodedHeader.header) {
        return reject(new Error("Malformed token"));
      }
      const { alg, kid } = decodedHeader.header;
      if (alg !== ALGORITHM) {
        return reject(new Error("Unsupported token algorithm"));
      }

      let key;
      if (kid === undefined || kid === null) {
        if (requireKid) return reject(new Error("Token has no kid"));
        key = lookupKey(legacyKid);
      } else {
        key = lookupKey(kid);
      }
      if (!key) return reject(new Error("Unknown token kid"));

      jwt.verify(token, key, { algorithms: [ALGORITHM] }, (err, decoded) => {
        if (err) return reject(err);
        if (tokenCutoff && decoded.iat < tokenCutoff) {
          return reject(new Error("Token expired due to global logout"));
        }
        resolve(decoded);
      });
    });

  const decode = (token) => jwt.decode(token, { complete: true });

  return {
    sign,
    verify,
    decode,
    activeKid,
    kids: Object.keys(keys),
    ALGORITHM,
  };
}

let instance = null;
const getDefault = () => {
  if (!instance) {
    if (defaults.usingTrackedKeyFallback) {
      logger.Log({
        level: logger.LEVEL.WARN,
        component: "SERVICE.JWT",
        code: "SERVICE.JWT.TRACKED-KEY-FALLBACK",
        description:
          "JWT keys are being read from the repository checkout. Set JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEYS to external paths.",
        category: "",
        ref: {},
      });
    }
    instance = createJwtService({
      privateKeyPath: defaults.privateKeyPath,
      publicKeyPaths: defaults.publicKeys,
      activeKid: defaults.activeKid,
      legacyKid: defaults.legacyKid,
      requireKid: defaults.requireKid,
      tokenCutoff: defaults.tokenCutoff,
    });
  }
  return instance;
};

/**
 * Backward-compatible surface: the rest of the app calls
 * `jwt.sign(payload, expiresIn)` and `jwt.verify(token)` as statics.
 */
module.exports = class JWT {
  static sign(payload, expiresIn, extra) {
    return getDefault().sign(payload, expiresIn, extra);
  }
  static verify(token) {
    return getDefault().verify(token);
  }
  static decode(token) {
    return getDefault().decode(token);
  }
  static get activeKid() {
    return getDefault().activeKid;
  }
  static get kids() {
    return getDefault().kids;
  }
};
module.exports.createJwtService = createJwtService;
module.exports.ALGORITHM = ALGORITHM;
