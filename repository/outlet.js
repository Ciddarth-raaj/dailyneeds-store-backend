const logger = require("../utils/logger");

class OutletRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM outlets",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.OUTLET",
              code: "REPOSITORY.OUTLET.GET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs)
        }
      );
    });
  }
  updateStatus(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE outlets SET is_active = ? WHERE outlet_id = ?",
        [file.is_active, file.outlet_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.OUTLET",
              code: "REPOSITORY.OUTLET.UPDATE-STATUS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        });
    });
  }
  updateOutletDetails(data, outlet_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE outlets SET ? WHERE outlet_id = ?`,
        [data, outlet_id],
        (err, res) => {
          if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.OUTLET",
                code: "REPOSITORY.OUTLET.UPDATE-OUTLET-DETAILS",
                description: err.toString(),
                category: "",
                ref: {},
              });
            reject(err);
            return;
          }
          resolve({ code: 200 });
        }
      );
    });
  } 
  create(outlet) {
      return new Promise((resolve, reject) => {
          this.db.query(
            "INSERT INTO outlets (status, department_name) VALUES (?, ?)",
            [
              outlet.outlet_name,
              outlet.outlet_address,
              outlet.outlet_phone,
              outlet.phone,
              outlet.outlet_nickname,
              outlet.is_active,
            ],
            (err, res) => {
              if (err) {
                if (err.code === "ER_DUP_ENTRY") {
                  resolve({ code: 101 });
                  return;
                }
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.OUTLET",
                  code: "REPOSITORY.OUTLET.CREATE",
                  description: err.toString(),
                  category: "",
                  ref: {},
                });
                reject(err);
                return;
              }
              resolve({ code: 200, id: res.insertId });
            }
          );
        });
      }
      getOutletById(outlet_id) {
        return new Promise((resolve, reject) => {
          this.db.query("SELECT outlet_id, outlet_name FROM outlets WHERE outlet_id = ?",
            [outlet_id],
            (err, docs) => {
              if (err) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.OUTLET",
                  code: "REPOSITORY.OUTLET.GET-BY-ID",
                  description: err.toString(),
                  category: "",
                  ref: {},
                });
                reject(err);
                return;
              }
              resolve(docs);
            });
        });
      }
}

module.exports = (db) => {
  return new OutletRepository(db);
};
