const logger = require("../utils/logger");

class EbMasterListRepository {
  constructor(db) {
    this.db = db;
  }

  create(machine) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO eb_master_list (machine_number, nickname, store_id, is_active, created_at, updated_at) 
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [
          machine.machine_number,
          machine.nickname || null,
          machine.store_id,
          machine.is_active !== undefined ? machine.is_active : true,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EB_MASTER_LIST",
              code: "REPOSITORY.EB_MASTER_LIST.CREATE",
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

  getAll(filters, limit, offset) {
    return new Promise((resolve, reject) => {
      let query = `SELECT eml.*, 
                   outlets.outlet_name as store_name
                   FROM eb_master_list eml
                   LEFT JOIN outlets ON outlets.outlet_id = eml.store_id
                   WHERE 1=1`;
      const params = [];

      if (filters.store_id) {
        query += ` AND eml.store_id = ?`;
        params.push(filters.store_id);
      }

      if (filters.is_active !== undefined) {
        query += ` AND eml.is_active = ?`;
        params.push(filters.is_active);
      }

      if (filters.search) {
        query += ` AND (eml.machine_number LIKE ? OR eml.nickname LIKE ?)`;
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm);
      }

      query += ` ORDER BY eml.created_at DESC LIMIT ${offset}, ${limit}`;

      this.db.query(query, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.EB_MASTER_LIST",
            code: "REPOSITORY.EB_MASTER_LIST.GETALL",
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

  getById(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT eml.*, 
                 outlets.outlet_name as store_name
                 FROM eb_master_list eml
                 LEFT JOIN outlets ON outlets.outlet_id = eml.store_id
                 WHERE eml.eb_machine_id = ?`,
        [id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EB_MASTER_LIST",
              code: "REPOSITORY.EB_MASTER_LIST.GETBYID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs.length > 0 ? docs[0] : null);
        }
      );
    });
  }

  update(id, machine) {
    return new Promise((resolve, reject) => {
      const updateFields = [];
      const params = [];

      if (machine.machine_number !== undefined) {
        updateFields.push(`machine_number = ?`);
        params.push(machine.machine_number);
      }

      if (machine.nickname !== undefined) {
        updateFields.push(`nickname = ?`);
        params.push(machine.nickname);
      }

      if (machine.store_id !== undefined) {
        updateFields.push(`store_id = ?`);
        params.push(machine.store_id);
      }

      if (machine.is_active !== undefined) {
        updateFields.push(`is_active = ?`);
        params.push(machine.is_active);
      }

      updateFields.push(`updated_at = NOW()`);
      params.push(id);

      const query = `UPDATE eb_master_list SET ${updateFields.join(
        ", "
      )} WHERE eb_machine_id = ?`;

      this.db.query(query, params, (err, res) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.EB_MASTER_LIST",
            code: "REPOSITORY.EB_MASTER_LIST.UPDATE",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve({ code: 200, affectedRows: res.affectedRows });
      });
    });
  }

  delete(id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM eb_master_list WHERE eb_machine_id = ?`,
        [id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EB_MASTER_LIST",
              code: "REPOSITORY.EB_MASTER_LIST.DELETE",
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

  getCount(filters) {
    return new Promise((resolve, reject) => {
      let query = `SELECT COUNT(*) AS count FROM eb_master_list WHERE 1=1`;
      const params = [];

      if (filters.store_id) {
        query += ` AND store_id = ?`;
        params.push(filters.store_id);
      }

      if (filters.is_active !== undefined) {
        query += ` AND is_active = ?`;
        params.push(filters.is_active);
      }

      if (filters.search) {
        query += ` AND (machine_number LIKE ? OR nickname LIKE ?)`;
        const searchTerm = `%${filters.search}%`;
        params.push(searchTerm, searchTerm);
      }

      this.db.query(query, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.EB_MASTER_LIST",
            code: "REPOSITORY.EB_MASTER_LIST.GETCOUNT",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs[0].count);
      });
    });
  }
}

module.exports = (db) => {
  return new EbMasterListRepository(db);
};
