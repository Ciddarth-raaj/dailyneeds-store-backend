const {
  getConnectionAsync,
  insertRowsInBatches,
} = require("../utils/batchInsert");

const TABLE = "item_markupdown";

const INSERT_SQL = `INSERT INTO \`${TABLE}\` (
  item_code,
  mpfd_class_type,
  mpfd_id,
  mpfd_markup_down,
  mpfd_price_parameter,
  mpfd_value,
  mpfd_amt_perc,
  mpfd_roundoff_type,
  mpfd_roundoff_value,
  mpfd_status,
  mpfd_mrp_price_param,
  mpfd_mrp_value,
  mpfd_mrp_amt_perc
) VALUES ?
ON DUPLICATE KEY UPDATE
  mpfd_class_type = VALUES(mpfd_class_type),
  mpfd_id = VALUES(mpfd_id),
  mpfd_markup_down = VALUES(mpfd_markup_down),
  mpfd_price_parameter = VALUES(mpfd_price_parameter),
  mpfd_value = VALUES(mpfd_value),
  mpfd_amt_perc = VALUES(mpfd_amt_perc),
  mpfd_roundoff_type = VALUES(mpfd_roundoff_type),
  mpfd_roundoff_value = VALUES(mpfd_roundoff_value),
  mpfd_status = VALUES(mpfd_status),
  mpfd_mrp_price_param = VALUES(mpfd_mrp_price_param),
  mpfd_mrp_value = VALUES(mpfd_mrp_value),
  mpfd_mrp_amt_perc = VALUES(mpfd_mrp_amt_perc),
  updated_at = CURRENT_TIMESTAMP`;

function rowToTuple(r) {
  return [
    r.item_code,
    r.mpfd_class_type,
    r.mpfd_id,
    r.mpfd_markup_down,
    r.mpfd_price_parameter,
    r.mpfd_value,
    r.mpfd_amt_perc,
    r.mpfd_roundoff_type,
    r.mpfd_roundoff_value,
    r.mpfd_status,
    r.mpfd_mrp_price_param,
    r.mpfd_mrp_value,
    r.mpfd_mrp_amt_perc,
  ];
}

class ItemMarkupdownRepository {
  constructor(db) {
    this.db = db;
  }

  resolveValidItemCodes(itemCodes) {
    return new Promise((resolve, reject) => {
      const validItemCodes = new Set();
      if (!Array.isArray(itemCodes) || itemCodes.length === 0) {
        resolve(validItemCodes);
        return;
      }

      const ph = itemCodes.map(() => "?").join(", ");
      this.db.query(
        `SELECT product_id FROM product_table WHERE product_id IN (${ph})`,
        itemCodes,
        (err, rows) => {
          if (err) {
            reject(err);
            return;
          }
          for (const row of rows || []) {
            validItemCodes.add(row.product_id);
          }
          resolve(validItemCodes);
        }
      );
    });
  }

  listByItemCodes(itemCodes) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(itemCodes) || itemCodes.length === 0) {
        resolve([]);
        return;
      }

      const ph = itemCodes.map(() => "?").join(", ");
      this.db.query(
        `SELECT
          item_code,
          mpfd_class_type,
          mpfd_id,
          mpfd_markup_down,
          mpfd_price_parameter,
          mpfd_value,
          mpfd_amt_perc,
          mpfd_roundoff_type,
          mpfd_roundoff_value,
          mpfd_status,
          mpfd_mrp_price_param,
          mpfd_mrp_value,
          mpfd_mrp_amt_perc
        FROM \`${TABLE}\`
        WHERE item_code IN (${ph})`,
        itemCodes,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  truncateAndBulkInsert(rows) {
    return new Promise((resolve, reject) => {
      this.db.query(`TRUNCATE TABLE \`${TABLE}\``, async (errTrunc) => {
        if (errTrunc) {
          reject(errTrunc);
          return;
        }
        if (!Array.isArray(rows) || rows.length === 0) {
          resolve({ code: 200, inserted: 0 });
          return;
        }

        let connection;
        try {
          connection = await getConnectionAsync(this.db);
          const tuples = rows.map(rowToTuple);
          await insertRowsInBatches(connection, INSERT_SQL, tuples);
          connection.release();
          resolve({ code: 200, inserted: rows.length });
        } catch (err) {
          if (connection) connection.release();
          reject(err);
        }
      });
    });
  }
}

module.exports = (db) => {
  return new ItemMarkupdownRepository(db);
};
