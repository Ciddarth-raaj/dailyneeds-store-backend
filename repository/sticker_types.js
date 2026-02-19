const logger = require("../utils/logger");

class StickerTypesRepository {
  constructor(db) {
    this.db = db;
  }

  create(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO sticker_types (label) VALUES (?)`,
        [data.label],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STICKER_TYPES",
              code: "REPOSITORY.STICKER_TYPES.CREATE",
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

  getById(stickerId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM sticker_types WHERE sticker_id = ?`,
        [stickerId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STICKER_TYPES",
              code: "REPOSITORY.STICKER_TYPES.GET_BY_ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs[0] || null);
        }
      );
    });
  }

  getAll(filters = {}) {
    return new Promise((resolve, reject) => {
      let query = `SELECT * FROM sticker_types`;
      const conditions = [];
      const params = [];

      if (filters.label) {
        conditions.push("label LIKE ?");
        params.push(`%${filters.label}%`);
      }
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY created_at DESC";
      if (filters.limit) {
        query += " LIMIT ?";
        params.push(filters.limit);
      }
      if (filters.offset) {
        query += " OFFSET ?";
        params.push(filters.offset);
      }

      this.db.query(query, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.STICKER_TYPES",
            code: "REPOSITORY.STICKER_TYPES.GET_ALL",
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

  update(stickerId, data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE sticker_types SET label = ? WHERE sticker_id = ?`,
        [data.label, stickerId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STICKER_TYPES",
              code: "REPOSITORY.STICKER_TYPES.UPDATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  delete(stickerId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM sticker_types WHERE sticker_id = ?`,
        [stickerId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STICKER_TYPES",
              code: "REPOSITORY.STICKER_TYPES.DELETE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new StickerTypesRepository(db);
};
