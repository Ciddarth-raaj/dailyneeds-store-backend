const logger = require("../utils/logger");

const TABLE = "stock_received";
const GOFRUGAL_DTL = "medishopdb_MED_MRC_DTL";
const GOFRUGAL_HDR = "medishopdb_MED_MRC_HDR";
const PRODUCT_OFFERS = "product_offers";

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
    MMH_DIST_BILL_DT: row.MMH_DIST_BILL_DT ?? row.mmh_dist_bill_dt,
  };
}

function billDateGteOfferCreated(billDt, offerCreatedAt) {
  if (billDt == null || billDt === "" || offerCreatedAt == null || offerCreatedAt === "") {
    return false;
  }
  const b = new Date(billDt);
  const o = new Date(offerCreatedAt);
  if (Number.isNaN(b.getTime()) || Number.isNaN(o.getTime())) {
    return false;
  }
  return b >= o;
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

/** Product payload for stock_received APIs: limited fields + first image. */
function shapeStockReceivedProduct(row) {
  if (!row) {
    return null;
  }
  const link =
    row.image_link != null && row.image_link !== "" ? row.image_link : null;
  return {
    product_id: row.product_id,
    gf_item_name: row.gf_item_name != null ? row.gf_item_name : null,
    de_name: row.de_name != null ? row.de_name : null,
    de_display_name: row.de_display_name != null ? row.de_display_name : null,
    image_link: link,
  };
}

class StockReceivedRepository {
  constructor(mainDb, gofrugalDb) {
    this.db = mainDb;
    this.gofrugalDb = gofrugalDb;
  }

  _queryGofrugalDtlWithHdr() {
    return new Promise((resolve, reject) => {
      if (!this.gofrugalDb) {
        return reject(new Error("Gofrugal DB connection is not configured"));
      }
      this.gofrugalDb.query(
        `SELECT d.MMD_MRC_NO,
            d.MMD_MRC_SL_NO,
            d.MMD_ITEM_CODE,
            d.MMD_RECD_QTY,
            h.MMH_DIST_BILL_DT
         FROM \`${GOFRUGAL_DTL}\` d
         LEFT JOIN \`${GOFRUGAL_HDR}\` h ON h.MMH_MRC_NO = d.MMD_MRC_NO
         ORDER BY d.MMD_MRC_NO DESC, d.MMD_MRC_SL_NO ASC`,
        [],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.GOFRUGAL_DTL_HDR",
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

  _fetchProductOffersCreatedAtMap() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT product_id, created_at FROM \`${PRODUCT_OFFERS}\``,
        [],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.PRODUCT_OFFERS_MAP",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          const map = new Map();
          (rows || []).forEach((row) => {
            map.set(row.product_id, row.created_at);
          });
          resolve(map);
        }
      );
    });
  }

  _lineMatchesProductOfferAndBillDate(r, offerCreatedAtMap) {
    const productId = normalizeItemCode(r.MMD_ITEM_CODE);
    if (productId == null) {
      return false;
    }
    const offerCreated = offerCreatedAtMap.get(productId);
    if (offerCreated == null) {
      return false;
    }
    return billDateGteOfferCreated(r.MMH_DIST_BILL_DT, offerCreated);
  }

  /**
   * Rows from Gofrugal MED_MRC_DTL (+ HDR bill date) with optional join to stock_received.
   * List includes only lines whose product exists in product_offers and MMH_DIST_BILL_DT >= that offer's created_at.
   * @param {{ pendingOnly: boolean }} opts
   */
  async listGofrugalDtlWithSync(opts) {
    const { pendingOnly } = opts;
    const [rawDtl, offerCreatedAtMap] = await Promise.all([
      this._queryGofrugalDtlWithHdr(),
      this._fetchProductOffersCreatedAtMap(),
    ]);
    const dtlRows = rawDtl.map(dtlRow);
    const filteredRows = dtlRows.filter((r) =>
      this._lineMatchesProductOfferAndBillDate(r, offerCreatedAtMap)
    );

    const pairs = filteredRows.map((r) => ({
      mmd_mrc_no: r.MMD_MRC_NO,
      mmd_mrc_sl_no: r.MMD_MRC_SL_NO,
    }));
    const stockMap = await this._fetchStockReceivedMap(pairs);

    const allProductIds = new Set();
    filteredRows.forEach((r) => {
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
    for (const r of filteredRows) {
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
          MMH_DIST_BILL_DT: r.MMH_DIST_BILL_DT ?? null,
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
        const sql = `SELECT pt.product_id,
            pt.gf_item_name,
            pt.de_name,
            pt.de_display_name,
            (
              SELECT pi.image_url
              FROM product_images pi
              WHERE pi.product_id = pt.product_id
              ORDER BY pi.priority ASC, pi.image_id ASC
              LIMIT 1
            ) AS image_link
          FROM product_table pt
          WHERE pt.product_id IN (${ph})`;
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
            map.set(row.product_id, shapeStockReceivedProduct(row));
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

  /**
   * Sum received qty from stock_received per product, split by is_offer.
   * @returns {Promise<Map<number, { non_offer_stock: number, offer_stock: number }>>}
   */
  getQtyAggregatesForProductIds(productIds) {
    return new Promise((resolve, reject) => {
      const unique = [...new Set((productIds || []).filter((id) => id != null))];
      if (!unique.length) {
        resolve(new Map());
        return;
      }
      const chunks = chunkArray(unique, 500);
      const combined = new Map();
      let pending = chunks.length;
      chunks.forEach((ids) => {
        const ph = ids.map(() => "?").join(", ");
        const sql = `SELECT product_id,
            COALESCE(SUM(CASE WHEN IFNULL(is_offer, 0) = 0 THEN recd_qty ELSE 0 END), 0) AS non_offer_stock,
            COALESCE(SUM(CASE WHEN is_offer = 1 THEN recd_qty ELSE 0 END), 0) AS offer_stock
          FROM \`${TABLE}\`
          WHERE product_id IN (${ph})
          GROUP BY product_id`;
        this.db.query(sql, ids, (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.QTY_AGGREGATES",
              description: err.toString(),
              category: "",
              ref: {},
            });
            return reject(err);
          }
          (rows || []).forEach((r) => {
            const no = Number(r.non_offer_stock);
            const off = Number(r.offer_stock);
            combined.set(r.product_id, {
              non_offer_stock: Number.isFinite(no) ? no : 0,
              offer_stock: Number.isFinite(off) ? off : 0,
            });
          });
          pending -= 1;
          if (pending === 0) {
            resolve(combined);
          }
        });
      });
    });
  }
}

module.exports = (mainDb, gofrugalDb) => {
  return new StockReceivedRepository(mainDb, gofrugalDb);
};
