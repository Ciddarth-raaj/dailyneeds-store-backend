const logger = require("../utils/logger");

class EbConsumptionRepository {
  constructor(db) {
    this.db = db;
  }

  create(consumptionData) {
    return new Promise((resolve, reject) => {
      const {
        consumption_id,
        date,
        branch_id,
        opening_units,
        closing_units,
        created_by,
      } = consumptionData;

      // If consumption_id is provided, include it in the insert
      const fields =
        consumption_id !== undefined
          ? "consumption_id, date, branch_id, opening_units, closing_units, created_by"
          : "date, branch_id, opening_units,closing_units, created_by";

      const placeholders =
        consumption_id !== undefined ? "?, ?, ?, ?, ?, ?" : "?, ?, ?, ?, ?";

      const values =
        consumption_id !== undefined
          ? [
              consumption_id,
              date,
              branch_id,
              opening_units,
              closing_units,
              created_by,
            ]
          : [date, branch_id, opening_units, closing_units, created_by];

      this.db.query(
        `INSERT INTO eb_consumption (${fields}) VALUES (${placeholders})`,
        values,
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EB_CONSUMPTION",
              code: "REPOSITORY.EB_CONSUMPTION.CREATE.ERROR",
              description: err.toString(),
              category: "",
              ref: { consumptionData },
            });
            reject(err);
            return;
          }
          const insertedId =
            consumption_id !== undefined ? consumption_id : result.insertId;
          resolve({ id: insertedId, ...consumptionData });
        }
      );
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ec.*, b.outlet_name, u.employee_name as created_by_name,
                eml.machine_number, eml.nickname as machine_nickname
         FROM eb_consumption ec 
         LEFT JOIN outlets b ON ec.branch_id = b.outlet_id 
         LEFT JOIN new_employee u ON ec.created_by = u.employee_id 
         LEFT JOIN eb_master_list eml ON ec.eb_machine_id = eml.eb_machine_id
         ORDER BY ec.created_at DESC`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EB_CONSUMPTION",
              code: "REPOSITORY.EB_CONSUMPTION.GET_ALL.ERROR",
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

  getByDateAndBranch(date, branchId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ec.*, b.outlet_name, u.employee_name as created_by_name,
                eml.machine_number, eml.nickname as machine_nickname
         FROM eb_consumption ec 
         LEFT JOIN outlets b ON ec.branch_id = b.outlet_id 
         LEFT JOIN new_employee u ON ec.created_by = u.employee_id 
         LEFT JOIN eb_master_list eml ON ec.eb_machine_id = eml.eb_machine_id
         WHERE ec.date = ? AND ec.branch_id = ?
         ORDER BY ec.eb_machine_id`,
        [date, branchId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EB_CONSUMPTION",
              code: "REPOSITORY.EB_CONSUMPTION.GET_BY_DATE_BRANCH.ERROR",
              description: err.toString(),
              category: "",
              ref: { date, branchId },
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }

  getById(consumptionId) {
    return new Promise((resolve, reject) => {
      // First, get the consumption record to find date and branch_id
      this.db.query(
        `SELECT ec.*, b.outlet_name, u.employee_name as created_by_name,
                eml.machine_number, eml.nickname as machine_nickname
         FROM eb_consumption ec 
         LEFT JOIN outlets b ON ec.branch_id = b.outlet_id 
         LEFT JOIN new_employee u ON ec.created_by = u.employee_id 
         LEFT JOIN eb_master_list eml ON ec.eb_machine_id = eml.eb_machine_id
         WHERE ec.consumption_id = ?`,
        [consumptionId],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EB_CONSUMPTION",
              code: "REPOSITORY.EB_CONSUMPTION.GET_BY_ID.ERROR",
              description: err.toString(),
              category: "",
              ref: { consumptionId },
            });
            reject(err);
            return;
          }

          if (docs.length === 0) {
            resolve(null);
            return;
          }

          const firstRecord = docs[0];
          const date = firstRecord.date;
          const branchId = firstRecord.branch_id;

          // Now get all machines for the same date and branch_id
          this.db.query(
            `SELECT ec.*, b.outlet_name, u.employee_name as created_by_name,
                    eml.machine_number, eml.nickname as machine_nickname
             FROM eb_consumption ec 
             LEFT JOIN outlets b ON ec.branch_id = b.outlet_id 
             LEFT JOIN new_employee u ON ec.created_by = u.employee_id 
             LEFT JOIN eb_master_list eml ON ec.eb_machine_id = eml.eb_machine_id
             WHERE ec.date = ? AND ec.branch_id = ?
             ORDER BY ec.eb_machine_id`,
            [date, branchId],
            (err2, allDocs) => {
              if (err2) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.EB_CONSUMPTION",
                  code: "REPOSITORY.EB_CONSUMPTION.GET_BY_ID.ERROR",
                  description: err2.toString(),
                  category: "",
                  ref: { consumptionId, date, branchId },
                });
                reject(err2);
                return;
              }
              resolve(allDocs);
            }
          );
        }
      );
    });
  }

  bulkCreateOrUpdate(consumptionData) {
    return new Promise((resolve, reject) => {
      const { date, branch_id, eb_machines, created_by } = consumptionData;

      if (!eb_machines || eb_machines.length === 0) {
        reject(new Error("eb_machines array is required and cannot be empty"));
        return;
      }

      // Build the INSERT ... ON DUPLICATE KEY UPDATE query
      const values = [];
      const placeholders = [];

      eb_machines.forEach((machine) => {
        placeholders.push("(?, ?, ?, ?, ?, ?)");
        values.push(
          date,
          branch_id,
          machine.eb_machine_id,
          machine.opening_units || 0,
          machine.closing_units || 0,
          created_by
        );
      });

      const query = `INSERT INTO eb_consumption (date, branch_id, eb_machine_id, opening_units, closing_units, created_by) 
                     VALUES ${placeholders.join(", ")}
                     ON DUPLICATE KEY UPDATE 
                       opening_units = VALUES(opening_units),
                       closing_units = VALUES(closing_units),
                       updated_at = CURRENT_TIMESTAMP`;

      this.db.query(query, values, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.EB_CONSUMPTION",
            code: "REPOSITORY.EB_CONSUMPTION.BULK_CREATE_UPDATE.ERROR",
            description: err.toString(),
            category: "",
            ref: { consumptionData },
          });
          reject(err);
          return;
        }

        // Get the created/updated records
        this.getByDateAndBranch(date, branch_id)
          .then((records) => {
            resolve({
              affectedRows: result.affectedRows,
              insertedId: result.insertId,
              records: records,
            });
          })
          .catch((fetchErr) => {
            // Even if fetching fails, return success for the insert/update
            resolve({
              affectedRows: result.affectedRows,
              insertedId: result.insertId,
              records: [],
            });
          });
      });
    });
  }

  update(consumptionId, consumptionData) {
    return new Promise((resolve, reject) => {
      const { date, branch_id, eb_machine_id, closing_units, opening_units } =
        consumptionData;

      const updateFields = [];
      const updateValues = [];

      if (date !== undefined) {
        updateFields.push("date = ?");
        updateValues.push(date);
      }
      if (branch_id !== undefined) {
        updateFields.push("branch_id = ?");
        updateValues.push(branch_id);
      }
      if (eb_machine_id !== undefined) {
        updateFields.push("eb_machine_id = ?");
        updateValues.push(eb_machine_id);
      }
      if (closing_units !== undefined) {
        updateFields.push("closing_units = ?");
        updateValues.push(closing_units);
      }
      if (opening_units !== undefined) {
        updateFields.push("opening_units = ?");
        updateValues.push(opening_units);
      }

      if (updateFields.length === 0) {
        resolve({ message: "No fields to update" });
        return;
      }

      updateFields.push("updated_at = CURRENT_TIMESTAMP");
      updateValues.push(consumptionId);

      this.db.query(
        `UPDATE eb_consumption SET ${updateFields.join(
          ", "
        )} WHERE consumption_id = ?`,
        updateValues,
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EB_CONSUMPTION",
              code: "REPOSITORY.EB_CONSUMPTION.UPDATE.ERROR",
              description: err.toString(),
              category: "",
              ref: { consumptionId, consumptionData },
            });
            reject(err);
            return;
          }
          resolve({ affectedRows: result.affectedRows, consumptionId });
        }
      );
    });
  }

  delete(consumptionId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM eb_consumption WHERE consumption_id = ?",
        [consumptionId],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EB_CONSUMPTION",
              code: "REPOSITORY.EB_CONSUMPTION.DELETE.ERROR",
              description: err.toString(),
              category: "",
              ref: { consumptionId },
            });
            reject(err);
            return;
          }
          resolve({ affectedRows: result.affectedRows, consumptionId });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new EbConsumptionRepository(db);
};
