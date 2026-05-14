const logger = require("../utils/logger");

const TABLE = "sandbox_gst_taxpayer_session";
const SINGLETON_ID = 1;

function mapRow(row) {
  if (!row) {
    return {
      id: SINGLETON_ID,
      taxpayer_access_token: null,
      token_expires_at_ms: null,
      last_otp_verified_at_ms: null,
      session_expires_at_ms: null,
    };
  }
  return {
    id: row.id,
    taxpayer_access_token: row.taxpayer_access_token,
    token_expires_at_ms:
      row.token_expires_at_ms != null ? Number(row.token_expires_at_ms) : null,
    last_otp_verified_at_ms:
      row.last_otp_verified_at_ms != null
        ? Number(row.last_otp_verified_at_ms)
        : null,
    session_expires_at_ms:
      row.session_expires_at_ms != null
        ? Number(row.session_expires_at_ms)
        : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

class SandboxGstTaxpayerSessionRepository {
  constructor(db) {
    this.db = db;
  }

  getSingleton() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT id, taxpayer_access_token, token_expires_at_ms, last_otp_verified_at_ms, session_expires_at_ms, created_at, updated_at
         FROM ${TABLE} WHERE id = ? LIMIT 1`,
        [SINGLETON_ID],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION",
              code: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION.GET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          const row = rows && rows[0];
          resolve(mapRow(row));
        }
      );
    });
  }

  updateAfterOtpVerify({
    taxpayerAccessToken,
    tokenExpiresAtMs,
    lastOtpVerifiedAtMs,
    sessionExpiresAtMs,
  }) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE ${TABLE}
         SET taxpayer_access_token = ?,
             token_expires_at_ms = ?,
             last_otp_verified_at_ms = ?,
             session_expires_at_ms = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          taxpayerAccessToken,
          tokenExpiresAtMs,
          lastOtpVerifiedAtMs,
          sessionExpiresAtMs,
          SINGLETON_ID,
        ],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION",
              code: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION.SAVE_OTP",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200 });
        }
      );
    });
  }

  updateAfterTokenRefresh(taxpayerAccessToken, tokenExpiresAtMs) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE ${TABLE}
         SET taxpayer_access_token = ?,
             token_expires_at_ms = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [taxpayerAccessToken, tokenExpiresAtMs, SINGLETON_ID],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION",
              code: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION.SAVE_REFRESH",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200 });
        }
      );
    });
  }

  clearTaxpayerJwtOnly() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE ${TABLE}
         SET taxpayer_access_token = NULL, token_expires_at_ms = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [SINGLETON_ID],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION",
              code: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION.CLEAR_JWT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200 });
        }
      );
    });
  }

  clearFullSession() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE ${TABLE}
         SET taxpayer_access_token = NULL,
             token_expires_at_ms = NULL,
             last_otp_verified_at_ms = NULL,
             session_expires_at_ms = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [SINGLETON_ID],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION",
              code: "REPOSITORY.SANDBOX_GST_TAXPAYER_SESSION.CLEAR_FULL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve({ code: 200 });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new SandboxGstTaxpayerSessionRepository(db);
};
