const mysql = require("mysql");
const config = require("../config.json");
const env = global.env;

const logger = require("../utils/logger");

class MySqlGofrugalModel {
  constructor() {
    this.connection = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const dbConfig = config.db.mysql_gofrugal[env];
      this.connection = mysql.createPool({
        connectionLimit: 10,
        host: dbConfig.host,
        user: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.database,
        port: dbConfig.port,
        debug: false,
        supportBigNumbers: true,
        bigNumberStrings: true
      });

      this.connection.getConnection((err, connection) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.FATAL,
            component: "DRIVER",
            code: "DRIVER.GOFRUGAL.CONNECTION.ERROR",
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
            description: "Gofrugal sync DB Connection Established",
            category: "",
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
  return new MySqlGofrugalModel();
};
