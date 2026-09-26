const mysql = require("mysql");
const config = require("../config.json");
const env = global.env;

const logger = require("../utils/logger");
const { guardPool, poolOptionsFromEnv } = require("../utils/db_admission");

const admissionLog = {
  error: (code, description, ref) =>
    logger.Log({ level: logger.LEVEL.ERROR, component: "DRIVER", code: `DRIVER.${code}`, description, category: "", ref: ref || {} }),
  info: (code, description, ref) =>
    logger.Log({ level: logger.LEVEL.INFO, component: "DRIVER", code: `DRIVER.${code}`, description, category: "", ref: ref || {} }),
};

class MySqlModel {
  constructor() {
    this.connection = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const rawPool = mysql.createPool({
        connectionLimit: 10,
        // See utils/db_admission.js: connect + handshake + pre-use ping are
        // bounded (mysqljs's acquireTimeout covers the handshake), and the
        // guard keeps mysqljs's own waiter queue empty; queueLimit is only
        // the backstop that makes it provably bounded.
        ...poolOptionsFromEnv(process.env).mysql,
        host: config.db.mysql[env].host,
        user: config.db.mysql[env].username,
        password: config.db.mysql[env].password,
        database: config.db.mysql[env].database,
        port: config.db.mysql[env].port,
        debug: false,
        supportBigNumbers: true,
        bigNumberStrings: true
      });
      // DB_ADMISSION=off (the rollback switch) leaves the pool exactly as it was.
      const admission = poolOptionsFromEnv(process.env);
      this.connection = admission.enabled
        ? guardPool(rawPool, { name: "main", log: admissionLog, ...admission.guard })
        : rawPool;

      this.connection.getConnection((err, connection) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.FATAL,
            component: "DRIVER",
            code: "DRIVER.CONNECTION.ERROR",
            description: err.toString(),
            category: "",
            ref: {}
          });

          reject(err);
          return;
        }

        if (connection) {
          logger.Log({
            level: logger.LEVEL.INFO,
            component: "DRIVER",
            code: "",
            description: "DB Connection Established",
            catego3ry: "",
            ref: {}
          });

          connection.release();
          resolve(this);
        }
      });
    });
  }

  close() {
    if (this.connection !== null) {
      this.connection.end();
    }
  }
}

module.exports = () => {
  return new MySqlModel();
};
