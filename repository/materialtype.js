const logger = require("../utils/logger");

class MaterialTypeRepository {
  constructor(db) {
    this.db = db;
  }

  get(offset, limit) {
    return new Promise((resolve, reject) => {
      this.db.query(`SELECT * FROM pack_material_type LIMIT ${offset}, ${limit}`, (err, docs) => {
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
  getType() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT material_type FROM pack_material_type WHERE material_type IS NOT NULL", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.MATERIAL",
            code: "REPOSITORY.MATERIAL.GET-TYPE",
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
  getSize() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT material_size FROM pack_material_type WHERE material_size IS NOT NULL", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.MATERIAL",
            code: "REPOSITORY.MATERIAL.GET-SIZE",
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
  getMaterialById(type_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM pack_material_type where type_id = ?",
        [type_id],
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
        "UPDATE pack_material_type SET status = ? WHERE material_id = ?",
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
  updatePackMaterialTypeDetails(data, type_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE pack_material_type SET ? WHERE type_id = ?`,
        [data, type_id],
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
  getTypeCount() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT count(type_id) AS typecount FROM pack_material_type`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.MATERIAL",
              code: "REPOSITORY.MATERIAL.GET-TYPE-COUNT",
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
        "INSERT INTO pack_material_type (material_type, description) VALUES (?, ?)",
        [
          material.material_type,
          material.description,
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
  return new MaterialTypeRepository(db);
};
