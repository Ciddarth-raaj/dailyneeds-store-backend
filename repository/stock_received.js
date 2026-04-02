const logger = require("../utils/logger");

const TABLE = "stock_received";
const GOFRUGAL_DTL = "medishopdb_MED_MRC_DTL";

function normalizeItemCode(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const n = parseInt(String(value).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/** Normalize row keys (some MySQL drivers return lowercase). */
function dtlRow(row) {
  return {
    MMD_MRC_NO: row.MMD_MRC_NO ?? row.mmd_mrc_no,
    MMD_MRC_SL_NO: row.MMD_MRC_SL_NO ?? row.mmd_mrc_sl_no,
    MMD_ITEM_CODE: row.MMD_ITEM_CODE ?? row.mmd_item_code,
    MMD_RECD_QTY: row.MMD_RECD_QTY ?? row.mmd_recd_qty,
  };
}

function stockReceivedToApi(row, productMap) {
  if (!row) {
    return null;
  }
  const { product_id, ...rest } = row;
  return {
    ...rest,
    product: productMap.get(product_id) || null,
  };
}

class StockReceivedRepository {
  constructor(mainDb, gofrugalDb) {
    this.db = mainDb;
    this.gofrugalDb = gofrugalDb;
  }

  _queryGofrugalDtl() {
    return new Promise((resolve, reject) => {
      if (!this.gofrugalDb) {
        return reject(new Error("Gofrugal DB connection is not configured"));
      }
      this.gofrugalDb.query(
        `SELECT MMD_MRC_NO, MMD_MRC_SL_NO, MMD_ITEM_CODE, MMD_RECD_QTY
         FROM \`${GOFRUGAL_DTL}\`
         ORDER BY MMD_MRC_NO DESC, MMD_MRC_SL_NO ASC`,
        [],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.GOFRUGAL_DTL",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  _fetchStockReceivedMap(pairs) {
    return new Promise((resolve, reject) => {
      if (!pairs.length) {
        resolve(new Map());
        return;
      }
      const chunks = chunkArray(pairs, 150);
      const combined = new Map();
      let pending = chunks.length;
      chunks.forEach((part) => {
        const cond = part.map(() => "(mmd_mrc_no = ? AND mmd_mrc_sl_no = ?)").join(" OR ");
        const params = part.flatMap((p) => [p.mmd_mrc_no, p.mmd_mrc_sl_no]);
        this.db.query(`SELECT * FROM \`${TABLE}\` WHERE ${cond}`, params, (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.BATCH_BY_MRC",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          (rows || []).forEach((r) => {
            combined.set(`${r.mmd_mrc_no}:${r.mmd_mrc_sl_no}`, r);
          });
          pending -= 1;
          if (pending === 0) {
            resolve(combined);
          }
        });
      });
    });
  }

  /**
   * Rows from Gofrugal MED_MRC_DTL with optional join to stock_received; `product` from product_table.
   * @param {{ pendingOnly: boolean }} opts
   */
  async listGofrugalDtlWithSync(opts) {
    const { pendingOnly } = opts;
    const rawDtl = await this._queryGofrugalDtl();
    const dtlRows = rawDtl.map(dtlRow);
    const pairs = dtlRows.map((r) => ({
      mmd_mrc_no: r.MMD_MRC_NO,
      mmd_mrc_sl_no: r.MMD_MRC_SL_NO,
    }));
    const stockMap = await this._fetchStockReceivedMap(pairs);

    const allProductIds = new Set();
    dtlRows.forEach((r) => {
      const pid = normalizeItemCode(r.MMD_ITEM_CODE);
      if (pid != null) {
        allProductIds.add(pid);
      }
    });
    stockMap.forEach((sr) => {
      if (sr && sr.product_id != null) {
        allProductIds.add(sr.product_id);
      }
    });
    const productMap = await this._fetchProductsMap([...allProductIds]);

    const data = [];
    for (const r of dtlRows) {
      const mrcNo = r.MMD_MRC_NO;
      const mrcSl = r.MMD_MRC_SL_NO;
      const key = `${mrcNo}:${mrcSl}`;
      const stockReceivedRaw = stockMap.get(key) || null;
      const productId = normalizeItemCode(r.MMD_ITEM_CODE);
      const product = productId != null ? productMap.get(productId) || null : null;

      if (pendingOnly && stockReceivedRaw) {
        continue;
      }

      data.push({
        gofrugal: {
          MMD_MRC_NO: mrcNo,
          MMD_MRC_SL_NO: mrcSl,
          MMD_ITEM_CODE: r.MMD_ITEM_CODE,
          MMD_RECD_QTY: r.MMD_RECD_QTY,
        },
        product,
        stock_received: stockReceivedToApi(stockReceivedRaw, productMap),
      });
    }

    return data;
  }

  _fetchProductsMap(productIds) {
    return new Promise((resolve, reject) => {
      const unique = [...new Set((productIds || []).filter((id) => id != null))];
      if (!unique.length) {
        resolve(new Map());
        return;
      }
      const chunks = chunkArray(unique, 200);
      const map = new Map();
      let pending = chunks.length;
      chunks.forEach((ids) => {
        const ph = ids.map(() => "?").join(", ");
        const sql = `SELECT product_table.*,
            categories.category_name,
            subcategories.subcategory_name,
            department.department_name,
            brands.brand_name
          FROM product_table
          LEFT JOIN categories ON product_table.category_id = categories.category_id
          LEFT JOIN subcategories ON subcategories.subcategory_id = product_table.subcategory_id
          LEFT JOIN department ON department.department_id = product_table.department_id
          LEFT JOIN brands ON brands.brand_id = product_table.brand_id
          WHERE product_table.product_id IN (${ph})`;
        this.db.query(sql, ids, (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.FETCH_PRODUCTS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          (rows || []).forEach((row) => {
            map.set(row.product_id, row);
          });
          pending -= 1;
          if (pending === 0) {
            resolve(map);
          }
        });
      });
    });
  }

  getById(stock_received_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM \`${TABLE}\` WHERE stock_received_id = ?`,
        [stock_received_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.GET_BY_ID",
              description: err.toString(),
              category: "",
              ref: { stock_received_id },
            });
            return reject(err);
          }
          const row = rows && rows[0] ? rows[0] : null;
          if (!row) {
            resolve(null);
            return;
          }
          this._fetchProductsMap([row.product_id])
            .then((productMap) => {
              resolve(stockReceivedToApi(row, productMap));
            })
            .catch(reject);
        }
      );
    });
  }

  productExists(product_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT 1 AS ok FROM product_table WHERE product_id = ? LIMIT 1`,
        [product_id],
        (err, rows) => {
          if (err) {
            return reject(err);
          }
          resolve(!!(rows && rows[0]));
        }
      );
    });
  }

  upsert(row) {
    return new Promise((resolve, reject) => {
      const isOffer = row.is_offer ? 1 : 0;
      this.db.query(
        `INSERT INTO \`${TABLE}\` (mmd_mrc_no, mmd_mrc_sl_no, product_id, recd_qty, is_offer)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           product_id = VALUES(product_id),
           recd_qty = VALUES(recd_qty),
           is_offer = VALUES(is_offer),
           updated_at = CURRENT_TIMESTAMP`,
        [row.mmd_mrc_no, row.mmd_mrc_sl_no, row.product_id, row.recd_qty, isOffer],
        (err) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.UPSERT",
              description: err.toString(),
              category: "",
              ref: { mmd_mrc_no: row.mmd_mrc_no, mmd_mrc_sl_no: row.mmd_mrc_sl_no },
            });
            return reject(err);
          }
          this.db.query(
            `SELECT * FROM \`${TABLE}\` WHERE mmd_mrc_no = ? AND mmd_mrc_sl_no = ?`,
            [row.mmd_mrc_no, row.mmd_mrc_sl_no],
            (err2, rows) => {
              if (err2) {
                return reject(err2);
              }
              const saved = rows && rows[0] ? rows[0] : null;
              if (!saved) {
                resolve(null);
                return;
              }
              this._fetchProductsMap([saved.product_id])
                .then((productMap) => {
                  resolve(stockReceivedToApi(saved, productMap));
                })
                .catch(reject);
            }
          );
        }
      );
    });
  }

  deleteById(stock_received_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM \`${TABLE}\` WHERE stock_received_id = ?`,
        [stock_received_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.DELETE",
              description: err.toString(),
              category: "",
              ref: { stock_received_id },
            });
            return reject(err);
          }
          resolve({ affectedRows: res.affectedRows });
        }
      );
    });
  }
}

module.exports = (mainDb, gofrugalDb) => {
  return new StockReceivedRepository(mainDb, gofrugalDb);
};
