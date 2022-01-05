const logger = require("../utils/logger");

class MaterialSizeRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM pack_material_size", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.MATERIALSIZE",
            code: "REPOSITORY.MATERIALSIZE.GET",
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
  updateStatus(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE pack_material_size SET status = ? WHERE material_id = ?",
        [file.status, file.material_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.MATERIALSIZE",
              code: "REPOSITORY.MATERIALSIZE.UPDATE-STATUS",
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
  create(material) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO pack_material_size (material_size, weight, cost, description) VALUES (?, ?, ?, ?)",
        [
          material.material_size,
          material.weight,
          material.cost,
          material.description,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.MATERIALSIZE",
              code: "REPOSITORY.MATERIALSIZE.CREATE",
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
  return new MaterialSizeRepository(db);
};
