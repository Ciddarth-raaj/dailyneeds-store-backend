const logger = require("../utils/logger");
const {
  getConnectionAsync,
  insertRowsInBatches,
} = require("../utils/batchInsert");

const HDR_TABLE = "offer_hdr";
const PRODUCTS_TABLE = "offer_products";
const ISSUE_TABLE = "offer_issue";

const HDR_COLUMNS = [
  "moh_offer_id",
  "moh_offer_name",
  "moh_offer_family_id",
  "moh_offer_typeid",
  "moh_offer_status",
  "moh_offer_get_confirm",
  "moh_offer_tier_id",
  "moh_offer_period",
  "moh_offer_happy_days",
  "moh_offer_happy_hours",
  "moh_offer_first_n_customers",
  "moh_offer_st_date",
  "moh_offer_end_date",
  "moh_offer_hq_id",
  "moh_offer_nth_bill",
  "ts",
  "tsid",
  "retail_outlet_id",
  "moh_vertical_id",
  "moh_offer_cust_type",
  "timestamp",
  "moh_allow_span",
  "moh_offer_on_nextbill",
  "moh_loyalty_card_must",
  "hq_timestamp_id",
  "moh_offer_on_eachitem",
  "moh_first_time_offer",
  "moh_offer_basedon_mrp",
  "moh_happy_hours_basedon",
  "moh_offer_on_itemuom",
  "moh_batch_offer",
  "moh_override_duplicate",
  "moh_block_return",
  "moh_cust_specific_offer",
  "moh_loyalty_point",
  "moh_offer_st_day",
  "moh_offer_end_day",
  "moh_offer_sales_period",
  "moh_offer_sales_st_dt",
  "moh_offer_sales_end_dt",
  "moh_allow_max_qty",
];

const PRODUCT_COLUMNS = [
  "mosp_offer_id",
  "mosp_sub_id",
  "mosp_category_id",
  "mosp_item_code",
  "ts",
  "tsid",
  "retail_outlet_id",
  "timestamp",
  "hq_timestamp_id",
];

const ISSUE_COLUMNS = [
  "moi_offer_id",
  "moi_offer_sl_no",
  "moi_offer_on",
  "moi_offer_satisfied",
  "moi_offer_type",
  "moi_item_code",
  "moi_offer_value",
  "moi_offer_extra_condition",
  "moi_offer_extra_condition_qty",
  "ts",
  "tsid",
  "retail_outlet_id",
  "timestamp",
  "hq_timestamp_id",
  "moi_conv_type",
  "moi_conv_factor",
  "moi_batch_no",
];

const HDR_UPDATE_ASSIGNMENTS = HDR_COLUMNS.filter(
  (c) => c !== "moh_offer_id" && c !== "retail_outlet_id"
)
  .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
  .join(", ");

const PRODUCT_UPDATE_ASSIGNMENTS = PRODUCT_COLUMNS.filter(
  (c) =>
    c !== "mosp_offer_id" &&
    c !== "mosp_sub_id" &&
    c !== "mosp_item_code" &&
    c !== "retail_outlet_id"
)
  .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
  .join(", ");

const ISSUE_UPDATE_ASSIGNMENTS = ISSUE_COLUMNS.filter(
  (c) =>
    c !== "moi_offer_id" &&
    c !== "moi_offer_sl_no" &&
    c !== "retail_outlet_id"
)
  .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
  .join(", ");

const HDR_INSERT_SQL = `INSERT INTO \`${HDR_TABLE}\` (${HDR_COLUMNS.map((c) => `\`${c}\``).join(", ")})
VALUES ?
ON DUPLICATE KEY UPDATE ${HDR_UPDATE_ASSIGNMENTS}`;

const PRODUCT_INSERT_SQL = `INSERT INTO \`${PRODUCTS_TABLE}\` (${PRODUCT_COLUMNS.map((c) => `\`${c}\``).join(", ")})
VALUES ?
ON DUPLICATE KEY UPDATE ${PRODUCT_UPDATE_ASSIGNMENTS}`;

const ISSUE_INSERT_SQL = `INSERT INTO \`${ISSUE_TABLE}\` (${ISSUE_COLUMNS.map((c) => `\`${c}\``).join(", ")})
VALUES ?
ON DUPLICATE KEY UPDATE ${ISSUE_UPDATE_ASSIGNMENTS}`;

const LOOKUP_BATCH_SIZE = 1000;

function offerHdrKey(offerId, outletId) {
  return `${offerId}:${outletId}`;
}

function offerProductLineKey(offerId, subId, outletId) {
  return `${offerId}:${subId}:${outletId}`;
}

function rowToHdrTuple(row) {
  return HDR_COLUMNS.map((col) => row[col]);
}

function rowToProductTuple(row) {
  return PRODUCT_COLUMNS.map((col) => row[col]);
}

function rowToIssueTuple(row) {
  return ISSUE_COLUMNS.map((col) => row[col]);
}

function logError(code, description, ref = {}) {
  logger.Log({
    level: logger.LEVEL.ERROR,
    component: "REPOSITORY.HQ_OFFERS",
    code,
    description,
    category: "",
    ref,
  });
}

function queryAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function queryInBatches(db, buildSql, values, batchSize = LOOKUP_BATCH_SIZE) {
  const result = [];
  for (let i = 0; i < values.length; i += batchSize) {
    const chunk = values.slice(i, i + batchSize);
    if (!chunk.length) continue;
    const rows = await queryAsync(db, buildSql(chunk), chunk.flat());
    result.push(...(rows || []));
  }
  return result;
}

class HqOffersRepository {
  constructor(db) {
    this.db = db;
  }

  async resolveValidOutletIds(outletIds) {
    const valid = new Set();
    const unique = [...new Set(outletIds.filter((id) => id != null))];
    if (!unique.length) return valid;

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "?").join(", ");
        return `SELECT outlet_id FROM outlets WHERE outlet_id IN (${ph})`;
      },
      unique
    );

    for (const row of rows) {
      valid.add(row.outlet_id);
    }
    return valid;
  }

  async resolveValidProductIds(productIds) {
    const valid = new Set();
    const unique = [...new Set(productIds.filter((id) => id != null))];
    if (!unique.length) return valid;

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "?").join(", ");
        return `SELECT product_id FROM product_table WHERE product_id IN (${ph})`;
      },
      unique
    );

    for (const row of rows) {
      valid.add(row.product_id);
    }
    return valid;
  }

  async resolveValidOfferHdrKeys(keys) {
    const valid = new Set();
    const unique = [];
    const seen = new Set();

    for (const key of keys) {
      const token = offerHdrKey(key.moh_offer_id, key.retail_outlet_id);
      if (seen.has(token)) continue;
      seen.add(token);
      unique.push(key);
    }

    if (!unique.length) return valid;

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "(?, ?)").join(", ");
        return `SELECT moh_offer_id, retail_outlet_id FROM offer_hdr WHERE (moh_offer_id, retail_outlet_id) IN (${ph})`;
      },
      unique.map((k) => [k.moh_offer_id, k.retail_outlet_id])
    );

    for (const row of rows) {
      valid.add(offerHdrKey(row.moh_offer_id, row.retail_outlet_id));
    }
    return valid;
  }

  async resolveValidOfferProductLineKeys(keys) {
    const valid = new Set();
    const unique = [];
    const seen = new Set();

    for (const key of keys) {
      const token = offerProductLineKey(
        key.mosp_offer_id,
        key.mosp_sub_id,
        key.retail_outlet_id
      );
      if (seen.has(token)) continue;
      seen.add(token);
      unique.push(key);
    }

    if (!unique.length) return valid;

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "(?, ?, ?)").join(", ");
        return `SELECT mosp_offer_id, mosp_sub_id, retail_outlet_id
          FROM offer_products
          WHERE (mosp_offer_id, mosp_sub_id, retail_outlet_id) IN (${ph})`;
      },
      unique.map((k) => [k.mosp_offer_id, k.mosp_sub_id, k.retail_outlet_id])
    );

    for (const row of rows) {
      valid.add(
        offerProductLineKey(
          row.mosp_offer_id,
          row.mosp_sub_id,
          row.retail_outlet_id
        )
      );
    }
    return valid;
  }

  insertHdr(row) {
    return new Promise((resolve, reject) => {
      const placeholders = HDR_COLUMNS.map(() => "?").join(", ");
      const sql = `INSERT INTO \`${HDR_TABLE}\` (${HDR_COLUMNS.map((c) => `\`${c}\``).join(", ")})
        VALUES (${placeholders})
        ON DUPLICATE KEY UPDATE ${HDR_UPDATE_ASSIGNMENTS}`;

      this.db.query(sql, rowToHdrTuple(row), (err, result) => {
        if (err) {
          logError("REPOSITORY.HQ_OFFERS.INSERT_HDR", err.toString());
          return reject(err);
        }
        resolve({ code: 200, affectedRows: result.affectedRows });
      });
    });
  }

  bulkInsertHdr(rows) {
    return new Promise(async (resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, inserted: 0 });
        return;
      }

      let connection;
      try {
        connection = await getConnectionAsync(this.db);
        const tuples = rows.map(rowToHdrTuple);
        await insertRowsInBatches(connection, HDR_INSERT_SQL, tuples);
        connection.release();
        resolve({ code: 200, inserted: rows.length });
      } catch (err) {
        if (connection) connection.release();
        logError("REPOSITORY.HQ_OFFERS.BULK_INSERT_HDR", err.toString());
        reject(err);
      }
    });
  }

  insertProduct(row) {
    return new Promise((resolve, reject) => {
      const placeholders = PRODUCT_COLUMNS.map(() => "?").join(", ");
      const sql = `INSERT INTO \`${PRODUCTS_TABLE}\` (${PRODUCT_COLUMNS.map((c) => `\`${c}\``).join(", ")})
        VALUES (${placeholders})
        ON DUPLICATE KEY UPDATE ${PRODUCT_UPDATE_ASSIGNMENTS}`;

      this.db.query(sql, rowToProductTuple(row), (err, result) => {
        if (err) {
          logError("REPOSITORY.HQ_OFFERS.INSERT_PRODUCT", err.toString());
          return reject(err);
        }
        resolve({ code: 200, affectedRows: result.affectedRows });
      });
    });
  }

  bulkInsertProducts(rows) {
    return new Promise(async (resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, inserted: 0 });
        return;
      }

      let connection;
      try {
        connection = await getConnectionAsync(this.db);
        const tuples = rows.map(rowToProductTuple);
        await insertRowsInBatches(connection, PRODUCT_INSERT_SQL, tuples);
        connection.release();
        resolve({ code: 200, inserted: rows.length });
      } catch (err) {
        if (connection) connection.release();
        logError("REPOSITORY.HQ_OFFERS.BULK_INSERT_PRODUCTS", err.toString());
        reject(err);
      }
    });
  }

  insertIssue(row) {
    return new Promise((resolve, reject) => {
      const placeholders = ISSUE_COLUMNS.map(() => "?").join(", ");
      const sql = `INSERT INTO \`${ISSUE_TABLE}\` (${ISSUE_COLUMNS.map((c) => `\`${c}\``).join(", ")})
        VALUES (${placeholders})
        ON DUPLICATE KEY UPDATE ${ISSUE_UPDATE_ASSIGNMENTS}`;

      this.db.query(sql, rowToIssueTuple(row), (err, result) => {
        if (err) {
          logError("REPOSITORY.HQ_OFFERS.INSERT_ISSUE", err.toString());
          return reject(err);
        }
        resolve({ code: 200, affectedRows: result.affectedRows });
      });
    });
  }

  bulkInsertIssues(rows) {
    return new Promise(async (resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, inserted: 0 });
        return;
      }

      let connection;
      try {
        connection = await getConnectionAsync(this.db);
        const tuples = rows.map(rowToIssueTuple);
        await insertRowsInBatches(connection, ISSUE_INSERT_SQL, tuples);
        connection.release();
        resolve({ code: 200, inserted: rows.length });
      } catch (err) {
        if (connection) connection.release();
        logError("REPOSITORY.HQ_OFFERS.BULK_INSERT_ISSUES", err.toString());
        reject(err);
      }
    });
  }
}

module.exports = (db) => {
  return new HqOffersRepository(db);
};
