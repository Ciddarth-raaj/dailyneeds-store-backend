const mysql = require("mysql");
const config = require("../config.json");
const env = global.env;

const logger = require("../utils/logger");

class MySqlModel {
  constructor() {
    this.connection = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.connection = mysql.createPool({
        connectionLimit: 10,
        host: config.db.mysql[env].host,
        user: config.db.mysql[env].username,
        password: config.db.mysql[env].password,
        database: config.db.mysql[env].database,
        port: config.db.mysql[env].port,
        debug: false,
        supportBigNumbers: true,
        bigNumberStrings: true
      });

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
