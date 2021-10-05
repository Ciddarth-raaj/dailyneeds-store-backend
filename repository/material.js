const logger = require("../utils/logger");

class MaterialRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM material", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.MATERIAL",
            code: "REPOSITORY.MATERIAL.GET",
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
  getMaterialById(material_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM material where material_id = ?",
        [material_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.MATERIAL",
              code: "REPOSITORY.MATERIAL.GET-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  updateStatus(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE material SET status = ? WHERE material_id = ?",
        [file.status, file.material_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.MATERIAL",
              code: "REPOSITORY.MATERIAL.UPDATE-STATUS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  updateMaterialDetails(data, material_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE material SET ? WHERE material_id = ?`,
        [data, material_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.MATERIAL",
              code: "REPOSITORY.MATERIAL.UPDATE-MATERIAL-DETAILS",
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
  create(material) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO material (material_name, description, material_category) VALUES (?, ?, ?)",
        [
          material.material_name,
          material.description,
          material.material_category,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.MATERIAL",
              code: "REPOSITORY.MATERIAL.CREATE",
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
}

module.exports = (db) => {
  return new MaterialRepository(db);
};
