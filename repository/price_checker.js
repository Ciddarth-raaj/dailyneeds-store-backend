const { insertRowsInBatches, DEFAULT_INSERT_BATCH_SIZE } = require("../utils/batchInsert");

const ITEMS_TABLE = "price_checker_items";
const META_TABLE = "price_checker_meta";
const ENRICH_BATCH_SIZE = DEFAULT_INSERT_BATCH_SIZE;

const ENRICH_SNAPSHOT_SET = `
  pci.de_name = pt.de_name,
  pci.de_display_name = pt.de_display_name,
  pci.de_preparation_type = pt.de_preparation_type,
  pci.distributor_id = pdm.cid,
  pci.de_distributor = pdm.mdm_dist_name,
  pci.buyer_id = pd_map.buyer_id,
  pci.buyer_name = ne.employee_name`;

const ENRICH_SNAPSHOT_JOINS = `
LEFT JOIN product_table pt ON pci.product_id = pt.product_id
LEFT JOIN product_distributor_master pdm ON pt.distributor_id = pdm.cid
LEFT JOIN product_distributor pd_map ON pd_map.cid = pdm.cid
LEFT JOIN new_employee ne ON ne.employee_id = pd_map.buyer_id`;

const LIST_ITEMS_SQL = `SELECT
  id,
  outlet_id,
  outlet_name,
  product_id,
  item_name,
  batch_no,
  purchase_price,
  landing_cost,
  old_mrp,
  new_mrp,
  old_selling_price,
  new_selling_price,
  de_name,
  de_display_name,
  de_distributor,
  de_preparation_type,
  distributor_id,
  buyer_id,
  buyer_name
FROM \`${ITEMS_TABLE}\``;

const GET_META_SQL = `SELECT
  uploaded_at,
  uploaded_by,
  total_rows,
  issue_product_count
FROM \`${META_TABLE}\`
WHERE id = 1
LIMIT 1`;

function queryAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function getConnectionAsync(db) {
  return new Promise((resolve, reject) => {
    db.getConnection((err, connection) => {
      if (err) reject(err);
      else resolve(connection);
    });
  });
}

function beginTransactionAsync(connection) {
  return new Promise((resolve, reject) => {
    connection.beginTransaction((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function commitAsync(connection) {
  return new Promise((resolve, reject) => {
    connection.commit((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function rollbackAsync(connection) {
  return new Promise((resolve) => {
    connection.rollback(() => resolve());
  });
}

function releaseConnection(connection) {
  if (connection) {
    connection.release();
  }
}

async function enrichSnapshotsInBatches(connection, totalRows, onProgress) {
  if (!totalRows) {
    return 0;
  }

  let lastId = 0;
  let enriched = 0;

  while (true) {
    const idRows = await queryAsync(
      connection,
      `SELECT id FROM \`${ITEMS_TABLE}\` WHERE id > ? ORDER BY id ASC LIMIT ?`,
      [lastId, ENRICH_BATCH_SIZE]
    );

    if (!idRows.length) {
      break;
    }

    const ids = idRows.map((row) => row.id);
    lastId = ids[ids.length - 1];
    const placeholders = ids.map(() => "?").join(", ");

    await queryAsync(
      connection,
      `UPDATE \`${ITEMS_TABLE}\` pci
       ${ENRICH_SNAPSHOT_JOINS}
       SET ${ENRICH_SNAPSHOT_SET}
       WHERE pci.id IN (${placeholders})`,
      ids
    );

    enriched += ids.length;

    if (typeof onProgress === "function") {
      onProgress({
        stage: "enriching",
        processed_rows: enriched,
        total_rows: totalRows,
        message: "Enriching product metadata",
      });
    }
  }

  return enriched;
}

class PriceCheckerRepository {
  constructor(db) {
    this.db = db;
  }

  listItems() {
    return queryAsync(this.db, LIST_ITEMS_SQL);
  }

  getMeta() {
    return queryAsync(this.db, GET_META_SQL).then((rows) => rows?.[0] ?? null);
  }

  async replaceAll(rows, meta, onProgress) {
    const totalRows = rows?.length ?? 0;
    const connection = await getConnectionAsync(this.db);

    try {
      if (typeof onProgress === "function") {
        onProgress({
          stage: "preparing",
          processed_rows: 0,
          total_rows: totalRows,
          message: "Preparing upload",
        });
      }

      await beginTransactionAsync(connection);
      await queryAsync(connection, `TRUNCATE TABLE \`${ITEMS_TABLE}\``);

      if (Array.isArray(rows) && rows.length > 0) {
        if (typeof onProgress === "function") {
          onProgress({
            stage: "inserting",
            processed_rows: 0,
            total_rows: totalRows,
            message: "Inserting rows",
          });
        }

        const insertSql = `INSERT INTO \`${ITEMS_TABLE}\` (
          outlet_id,
          outlet_name,
          product_id,
          item_name,
          batch_no,
          purchase_price,
          landing_cost,
          old_mrp,
          new_mrp,
          old_selling_price,
          new_selling_price
        ) VALUES ?`;

        await insertRowsInBatches(
          connection,
          insertSql,
          rows,
          undefined,
          (inserted, total) => {
            if (typeof onProgress === "function") {
              onProgress({
                stage: "inserting",
                processed_rows: inserted,
                total_rows: total,
                message: "Inserting rows",
              });
            }
          }
        );
      }

      if (typeof onProgress === "function") {
        onProgress({
          stage: "enriching",
          processed_rows: 0,
          total_rows: totalRows,
          message: "Enriching product metadata",
        });
      }

      await enrichSnapshotsInBatches(connection, totalRows, onProgress);

      if (typeof onProgress === "function") {
        onProgress({
          stage: "saving",
          processed_rows: totalRows,
          total_rows: totalRows,
          message: "Saving upload metadata",
        });
      }

      await queryAsync(
        connection,
        `INSERT INTO \`${META_TABLE}\` (id, uploaded_at, uploaded_by, total_rows, issue_product_count)
         VALUES (1, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           uploaded_at = VALUES(uploaded_at),
           uploaded_by = VALUES(uploaded_by),
           total_rows = VALUES(total_rows),
           issue_product_count = VALUES(issue_product_count)`,
        [
          meta.uploaded_at,
          meta.uploaded_by ?? null,
          meta.total_rows ?? 0,
          meta.issue_product_count ?? 0,
        ]
      );

      await commitAsync(connection);
      return { code: 200, inserted: rows?.length ?? 0 };
    } catch (err) {
      await rollbackAsync(connection);
      throw err;
    } finally {
      releaseConnection(connection);
    }
  }
}

module.exports = (db) => new PriceCheckerRepository(db);
