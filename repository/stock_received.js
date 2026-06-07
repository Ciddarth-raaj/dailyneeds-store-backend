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
    MMD_PUR_PRICE: row.MMD_PUR_PRICE ?? row.mmd_pur_price,
    MMD_MRP: row.MMD_MRP ?? row.MMD_MAX_RATE ?? row.mmd_max_rate ?? row.mmd_mrp,
    MMD_SALE_RATE: row.MMD_SALE_RATE ?? row.mmd_sale_rate,
    MMH_MRC_DT: row.MMH_MRC_DT ?? row.mmh_mrc_dt,
    MMH_MRC_REFNO: row.MMH_MRC_REFNO ?? row.mmh_mrc_refno,
  };
}

function subtractCalendarDays(dateInput, daysBuffer) {
  const buf = Math.max(0, Math.floor(Number(daysBuffer)) || 0);
  if (dateInput == null || dateInput === "") {
    return null;
  }
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  d.setDate(d.getDate() - buf);
  return d;
}

/** MMH_MRC_DT >= (offer created_at - days_buffer calendar days) */
function memoDateGteOfferCreatedMinusBuffer(mmhMrcDt, offerCreatedAt, daysBuffer) {
  if (mmhMrcDt == null || mmhMrcDt === "" || offerCreatedAt == null || offerCreatedAt === "") {
    return false;
  }
  const threshold = subtractCalendarDays(offerCreatedAt, daysBuffer);
  if (threshold == null) {
    return false;
  }
  const m = new Date(mmhMrcDt);
  if (Number.isNaN(m.getTime())) {
    return false;
  }
  return m >= threshold;
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
    de_name: row.de_name != null ? row.de_name : null,
    de_display_name: row.de_display_name != null ? row.de_display_name : null,
    image_link: link,
  };
}

function stockReceivedIsOffer(row) {
  return row && (row.is_offer === 1 || row.is_offer === true);
}

function numericRecdQty(q) {
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
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
            d.MMD_PUR_PRICE,
            d.MMD_MAX_RATE AS MMD_MRP,
            d.MMD_SALE_RATE,
            h.MMH_MRC_DT,
            h.MMH_MRC_REFNO
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

  _lineMatchesProductOfferAndMemoDate(r, offerCreatedAtMap, daysBuffer) {
    const productId = normalizeItemCode(r.MMD_ITEM_CODE);
    if (productId == null) {
      return false;
    }
    const offerCreated = offerCreatedAtMap.get(productId);
    if (offerCreated == null) {
      return false;
    }
    return memoDateGteOfferCreatedMinusBuffer(r.MMH_MRC_DT, offerCreated, daysBuffer);
  }

  /**
   * Rows from Gofrugal MED_MRC_DTL (+ HDR) with optional join to stock_received.
   * List includes only lines whose product exists in product_offers and MMH_MRC_DT >= (offer created_at - daysBuffer).
   * @param {{ pendingOnly: boolean, daysBuffer?: number }} opts
   */
  async listGofrugalDtlWithSync(opts) {
    const { pendingOnly, daysBuffer = 0 } = opts;
    const [rawDtl, offerCreatedAtMap] = await Promise.all([
      this._queryGofrugalDtlWithHdr(),
      this._fetchProductOffersCreatedAtMap(),
    ]);
    const dtlRows = rawDtl.map(dtlRow);
    const filteredRows = dtlRows.filter((r) =>
      this._lineMatchesProductOfferAndMemoDate(r, offerCreatedAtMap, daysBuffer)
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
          MMD_PUR_PRICE: r.MMD_PUR_PRICE ?? null,
          MMD_MRP: r.MMD_MRP ?? null,
          MMD_SALE_RATE: r.MMD_SALE_RATE ?? null,
          MMH_MRC_DT: r.MMH_MRC_DT ?? null,
          MMH_MRC_REFNO: r.MMH_MRC_REFNO ?? null,
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

  /**
   * Delta applied to product_offers.stock_input (only rows that exist for product_id are updated).
   */
  _adjustOfferStockInputConn(conn, productId, delta, callback) {
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) {
      return setImmediate(() => callback(null));
    }
    conn.query(
      `UPDATE \`${PRODUCT_OFFERS}\` SET stock_input = stock_input + ? WHERE product_id = ?`,
      [d, productId],
      callback
    );
  }

  _fetchUpsertResult(mmd_mrc_no, mmd_mrc_sl_no, resolve, reject) {
    this.db.query(
      `SELECT * FROM \`${TABLE}\` WHERE mmd_mrc_no = ? AND mmd_mrc_sl_no = ?`,
      [mmd_mrc_no, mmd_mrc_sl_no],
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

  upsert(row) {
    return new Promise((resolve, reject) => {
      const isOffer = row.is_offer ? 1 : 0;
      const mrc = row.mmd_mrc_no;
      const sl = row.mmd_mrc_sl_no;
      const newQty = numericRecdQty(row.recd_qty);

      this.db.getConnection((errConn, conn) => {
        if (errConn) {
          return reject(errConn);
        }
        const rollback = (e) => {
          conn.rollback(() => {
            conn.release();
            reject(e);
          });
        };

        conn.beginTransaction((errTx) => {
          if (errTx) {
            conn.release();
            return reject(errTx);
          }

          conn.query(
            `SELECT * FROM \`${TABLE}\` WHERE mmd_mrc_no = ? AND mmd_mrc_sl_no = ? FOR UPDATE`,
            [mrc, sl],
            (errSel, oldRows) => {
              if (errSel) {
                return rollback(errSel);
              }
              const old = oldRows && oldRows[0] ? oldRows[0] : null;

              conn.query(
                `INSERT INTO \`${TABLE}\` (mmd_mrc_no, mmd_mrc_sl_no, product_id, recd_qty, is_offer)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                   product_id = VALUES(product_id),
                   recd_qty = VALUES(recd_qty),
                   is_offer = VALUES(is_offer),
                   updated_at = CURRENT_TIMESTAMP`,
                [mrc, sl, row.product_id, row.recd_qty, isOffer],
                (errIns) => {
                  if (errIns) {
                    logger.Log({
                      level: logger.LEVEL.ERROR,
                      component: "REPOSITORY.STOCK_RECEIVED",
                      code: "REPOSITORY.STOCK_RECEIVED.UPSERT",
                      description: errIns.toString(),
                      category: "",
                      ref: { mmd_mrc_no: mrc, mmd_mrc_sl_no: sl },
                    });
                    return rollback(errIns);
                  }

                  const afterSubtractOld = () => {
                    if (isOffer && newQty !== 0) {
                      this._adjustOfferStockInputConn(conn, row.product_id, newQty, (errAdd) => {
                        if (errAdd) {
                          return rollback(errAdd);
                        }
                        conn.commit((errC) => {
                          if (errC) {
                            return rollback(errC);
                          }
                          conn.release();
                          this._fetchUpsertResult(mrc, sl, resolve, reject);
                        });
                      });
                    } else {
                      conn.commit((errC) => {
                        if (errC) {
                          return rollback(errC);
                        }
                        conn.release();
                        this._fetchUpsertResult(mrc, sl, resolve, reject);
                      });
                    }
                  };

                  if (old && stockReceivedIsOffer(old)) {
                    const oldQty = numericRecdQty(old.recd_qty);
                    if (oldQty !== 0) {
                      this._adjustOfferStockInputConn(conn, old.product_id, -oldQty, (errSub) => {
                        if (errSub) {
                          return rollback(errSub);
                        }
                        afterSubtractOld();
                      });
                      return;
                    }
                  }
                  afterSubtractOld();
                }
              );
            }
          );
        });
      });
    });
  }

  deleteById(stock_received_id) {
    return new Promise((resolve, reject) => {
      this.db.getConnection((errConn, conn) => {
        if (errConn) {
          return reject(errConn);
        }
        const rollback = (e) => {
          conn.rollback(() => {
            conn.release();
            reject(e);
          });
        };

        conn.beginTransaction((errTx) => {
          if (errTx) {
            conn.release();
            return reject(errTx);
          }

          conn.query(
            `SELECT * FROM \`${TABLE}\` WHERE stock_received_id = ? FOR UPDATE`,
            [stock_received_id],
            (errSel, rows) => {
              if (errSel) {
                return rollback(errSel);
              }
              const row = rows && rows[0] ? rows[0] : null;
              if (!row) {
                return conn.rollback(() => {
                  conn.release();
                  resolve({ affectedRows: 0 });
                });
              }

              conn.query(
                `DELETE FROM \`${TABLE}\` WHERE stock_received_id = ?`,
                [stock_received_id],
                (errDel, res) => {
                  if (errDel) {
                    logger.Log({
                      level: logger.LEVEL.ERROR,
                      component: "REPOSITORY.STOCK_RECEIVED",
                      code: "REPOSITORY.STOCK_RECEIVED.DELETE",
                      description: errDel.toString(),
                      category: "",
                      ref: { stock_received_id },
                    });
                    return rollback(errDel);
                  }

                  const finishCommit = () => {
                    conn.commit((errC) => {
                      if (errC) {
                        return rollback(errC);
                      }
                      conn.release();
                      resolve({ affectedRows: res.affectedRows });
                    });
                  };

                  if (stockReceivedIsOffer(row)) {
                    const q = numericRecdQty(row.recd_qty);
                    if (q !== 0) {
                      this._adjustOfferStockInputConn(conn, row.product_id, -q, (errAdj) => {
                        if (errAdj) {
                          return rollback(errAdj);
                        }
                        finishCommit();
                      });
                      return;
                    }
                  }
                  finishCommit();
                }
              );
            }
          );
        });
      });
    });
  }
}

module.exports = (mainDb, gofrugalDb) => {
  return new StockReceivedRepository(mainDb, gofrugalDb);
};
