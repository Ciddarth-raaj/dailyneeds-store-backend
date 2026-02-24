const logger = require("../utils/logger");

function aggregateItemsByProductCode(items) {
  if (!items || items.length === 0) return [];
  const byCode = {};
  items.forEach((row) => {
    const code = String(row.MPR_ITEM_CODE);
    if (!byCode[code]) {
      byCode[code] = {
        MPR_PR_NO: row.MPR_PR_NO,
        MPR_MRC_NO: row.MPR_MRC_NO,
        MPR_ITEM_CODE: row.MPR_ITEM_CODE,
        MPR_ITEM_QTY: Number(row.MPR_ITEM_QTY) || 0,
        MPR_ITEM_AMOUNT: parseFloat(row.MPR_ITEM_AMOUNT) || 0,
        product: row.product
      };
    } else {
      byCode[code].MPR_ITEM_QTY += Number(row.MPR_ITEM_QTY) || 0;
      byCode[code].MPR_ITEM_AMOUNT += parseFloat(row.MPR_ITEM_AMOUNT) || 0;
    }
  });
  return Object.values(byCode);
}

class PurchaseReturnRepository {
  constructor(db, dbGofrugal) {
    this.db = db;
    this.dbGofrugal = dbGofrugal;
  }

  getHeadersFromGofrugal() {
    return new Promise((resolve, reject) => {
      this.dbGofrugal.query(
        `SELECT mprh_pr_no, mprh_pr_refno, mprh_pr_dt, mprh_basic_amount, mprh_net_amount, mprh_locaid, mprh_dist_code
         FROM medishopdb_med_pur_return_hdr
         WHERE mprh_locaid = 2
         ORDER BY mprh_pr_dt DESC, mprh_pr_no`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.HEADERS",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  getItemsFromGofrugal() {
    return new Promise((resolve, reject) => {
      this.dbGofrugal.query(
        `SELECT MPR_PR_NO, MPR_MRC_NO, MPR_ITEM_CODE, MPR_ITEM_QTY, MPR_ITEM_AMOUNT
         FROM medishopdb_MED_PUR_RETURN`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.ITEMS",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve(rows || []);
        }
      );
    });
  }

  getExtrasFromMain() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT pre.mprh_pr_no, pre.no_of_boxes, pre.status, pre.created_by, pre.created_at, pre.updated_at,
         ne.employee_name AS created_by_name
         FROM purchase_return_extra pre
         LEFT JOIN new_employee ne ON ne.employee_id = pre.created_by`,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.EXTRAS",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          const map = {};
          (rows || []).forEach((r) => {
            map[String(r.mprh_pr_no)] = r;
          });
          resolve(map);
        }
      );
    });
  }

  getDistributorMastByDistCodes(distCodes) {
    if (!distCodes || distCodes.length === 0) return Promise.resolve({});
    const codes = [...new Set(distCodes.map((c) => (c != null && c !== "" ? String(c) : null)).filter(Boolean))];
    if (codes.length === 0) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      const placeholders = codes.map(() => "?").join(",");
      this.dbGofrugal.query(
        `SELECT MDM_DIST_CODE, MDM_DIST_NAME, MDM_SHORT_NAME FROM medishopdb_MED_DISTRIBUTOR_MAST WHERE MDM_DIST_CODE IN (${placeholders})`,
        codes,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.DISTRIBUTOR_MAST",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          const map = {};
          (rows || []).forEach((r) => {
            map[String(r.MDM_DIST_CODE)] = {
              MDM_DIST_CODE: r.MDM_DIST_CODE,
              MDM_DIST_NAME: r.MDM_DIST_NAME,
              MDM_SHORT_NAME: r.MDM_SHORT_NAME
            };
          });
          resolve(map);
        }
      );
    });
  }

  getProductsByProductIds(productIds) {
    if (!productIds || productIds.length === 0) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      const placeholders = productIds.map(() => "?").join(",");
      this.db.query(
        `SELECT product_id, gf_item_name, de_display_name FROM product_table WHERE product_id IN (${placeholders})`,
        productIds,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.PRODUCTS",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          const map = {};
          (rows || []).forEach((r) => {
            map[String(r.product_id)] = r;
          });
          resolve(map);
        }
      );
    });
  }

  getProductImagesByProductIds(productIds) {
    if (!productIds || productIds.length === 0) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      const placeholders = productIds.map(() => "?").join(",");
      this.db.query(
        `SELECT image_id, product_id, image_url, priority, created_at, updated_at
         FROM product_images WHERE product_id IN (${placeholders})
         ORDER BY product_id, priority ASC, image_id ASC`,
        productIds,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.PRODUCT_IMAGES",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          const byProduct = {};
          (rows || []).forEach((img) => {
            const key = String(img.product_id);
            if (!byProduct[key]) byProduct[key] = [];
            byProduct[key].push({
              image_id: img.image_id,
              image_url: img.image_url,
              priority: img.priority,
              created_at: img.created_at,
              updated_at: img.updated_at
            });
          });
          resolve(byProduct);
        }
      );
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      Promise.all([
        this.getHeadersFromGofrugal(),
        this.getItemsFromGofrugal(),
        this.getExtrasFromMain()
      ])
        .then(([headers, items, extrasMap]) => {
          const itemCodes = [...new Set(items.map((i) => i.MPR_ITEM_CODE).filter(Boolean))];
          const distCodesFromHeaders = [...new Set(headers.map((h) => h.mprh_dist_code).filter(Boolean))];
          return Promise.all([
            this.getProductsByProductIds(itemCodes),
            this.getDistributorMastByDistCodes(distCodesFromHeaders),
            this.getProductImagesByProductIds(itemCodes)
          ]).then(([productsMap, distributorMastMap, imagesByProduct]) => {
            const itemsByPrNo = {};
            items.forEach((item) => {
              const prNo = String(item.MPR_PR_NO);
              if (!itemsByPrNo[prNo]) itemsByPrNo[prNo] = [];
              const productRow = productsMap[String(item.MPR_ITEM_CODE)] || null;
              const images = productRow ? (imagesByProduct[String(productRow.product_id)] || []) : [];
              const product = productRow
                ? {
                    ...productRow,
                    images,
                    image_url: images.length > 0 ? images[0].image_url : null
                  }
                : null;
              itemsByPrNo[prNo].push({
                MPR_PR_NO: item.MPR_PR_NO,
                MPR_MRC_NO: item.MPR_MRC_NO,
                MPR_ITEM_CODE: item.MPR_ITEM_CODE,
                MPR_ITEM_QTY: item.MPR_ITEM_QTY,
                MPR_ITEM_AMOUNT: item.MPR_ITEM_AMOUNT,
                product
              });
            });
            const result = headers.map((h) => {
              const prNo = String(h.mprh_pr_no);
              const extra = extrasMap[prNo] || null;
              const headerDist = h.mprh_dist_code != null ? distributorMastMap[String(h.mprh_dist_code)] : null;
              return {
                mprh_pr_no: h.mprh_pr_no,
                mprh_pr_refno: h.mprh_pr_refno,
                mprh_pr_dt: h.mprh_pr_dt,
                mprh_basic_amount: h.mprh_basic_amount,
                mprh_net_amount: h.mprh_net_amount,
                mprh_locaid: h.mprh_locaid,
                mprh_dist_code: h.mprh_dist_code,
                distributor_name: headerDist ? headerDist.MDM_DIST_NAME : null,
                no_of_boxes: extra ? extra.no_of_boxes : null,
                status: extra ? extra.status : null,
                created_by: extra ? extra.created_by : null,
                created_by_name: extra ? extra.created_by_name : null,
                created_at: extra ? extra.created_at : null,
                updated_at: extra ? extra.updated_at : null,
                items: aggregateItemsByProductCode(itemsByPrNo[prNo] || [])
              };
            });
            resolve(result);
          });
        })
        .catch(reject);
    });
  }

  getById(mprh_pr_no) {
    return new Promise((resolve, reject) => {
      const prNo = String(mprh_pr_no);
      this.dbGofrugal.query(
        `SELECT mprh_pr_no, mprh_pr_refno, mprh_pr_dt, mprh_basic_amount, mprh_net_amount, mprh_locaid, mprh_dist_code
         FROM medishopdb_med_pur_return_hdr WHERE mprh_pr_no = ?`,
        [prNo],
        (err, headerRows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.GET_BY_ID",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          const header = headerRows && headerRows[0];
          if (!header || header.mprh_locaid != 2) return resolve(null);
          this.dbGofrugal.query(
            `SELECT MPR_PR_NO, MPR_MRC_NO, MPR_ITEM_CODE, MPR_ITEM_QTY, MPR_ITEM_AMOUNT
             FROM medishopdb_MED_PUR_RETURN WHERE MPR_PR_NO = ?`,
            [prNo],
            (err2, itemRows) => {
              if (err2) return reject(err2);
              const items = itemRows || [];
              const itemCodes = [...new Set(items.map((i) => i.MPR_ITEM_CODE).filter(Boolean))];
              Promise.all([
                this.getProductsByProductIds(itemCodes),
                this.getProductImagesByProductIds(itemCodes)
              ]).then(([productsMap, imagesByProduct]) => {
                const itemsWithProduct = items.map((item) => {
                  const productRow = productsMap[String(item.MPR_ITEM_CODE)] || null;
                  const images = productRow ? (imagesByProduct[String(productRow.product_id)] || []) : [];
                  const product = productRow
                    ? {
                        ...productRow,
                        images,
                        image_url: images.length > 0 ? images[0].image_url : null
                      }
                    : null;
                  return {
                    MPR_PR_NO: item.MPR_PR_NO,
                    MPR_MRC_NO: item.MPR_MRC_NO,
                    MPR_ITEM_CODE: item.MPR_ITEM_CODE,
                    MPR_ITEM_QTY: item.MPR_ITEM_QTY,
                    MPR_ITEM_AMOUNT: item.MPR_ITEM_AMOUNT,
                    product
                  };
                });
                const aggregatedItems = aggregateItemsByProductCode(itemsWithProduct);
                this.getExtraByPrNo(prNo).then((extra) => {
                  const distCodes = header.mprh_dist_code != null ? [header.mprh_dist_code] : [];
                  this.getDistributorMastByDistCodes(distCodes).then((distributorMastMap) => {
                    const headerDist = header.mprh_dist_code != null ? distributorMastMap[String(header.mprh_dist_code)] : null;
                    resolve({
                      mprh_pr_no: header.mprh_pr_no,
                      mprh_pr_refno: header.mprh_pr_refno,
                      mprh_pr_dt: header.mprh_pr_dt,
                      mprh_basic_amount: header.mprh_basic_amount,
                      mprh_net_amount: header.mprh_net_amount,
                      mprh_locaid: header.mprh_locaid,
                      mprh_dist_code: header.mprh_dist_code,
                      distributor_name: headerDist ? headerDist.MDM_DIST_NAME : null,
                      no_of_boxes: extra ? extra.no_of_boxes : null,
                      status: extra ? extra.status : null,
                      created_by: extra ? extra.created_by : null,
                      created_by_name: extra ? extra.created_by_name : null,
                      created_at: extra ? extra.created_at : null,
                      updated_at: extra ? extra.updated_at : null,
                      items: aggregatedItems
                    });
                  }).catch(reject);
                }).catch(reject);
              }).catch(reject);
            }
          );
        }
      );
    });
  }

  createExtra(data) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO purchase_return_extra (mprh_pr_no, no_of_boxes, status, created_by)
         VALUES (?, ?, ?, ?)`,
        [data.mprh_pr_no, data.no_of_boxes ?? 0, data.status ?? "open", data.created_by ?? null],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.CREATE_EXTRA",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  updateExtra(mprh_pr_no, data) {
    return new Promise((resolve, reject) => {
      const sets = ["updated_at = CURRENT_TIMESTAMP"];
      const values = [];
      if (data.no_of_boxes !== undefined) {
        sets.push("no_of_boxes = ?");
        values.push(data.no_of_boxes);
      }
      if (data.status !== undefined) {
        sets.push("status = ?");
        values.push(data.status);
      }
      if (values.length === 0) return resolve({ code: 200, affectedRows: 0 });
      values.push(mprh_pr_no);
      this.db.query(
        `UPDATE purchase_return_extra SET ${sets.join(", ")} WHERE mprh_pr_no = ?`,
        values,
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.UPDATE_EXTRA",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          resolve({ code: 200, affectedRows: res.affectedRows });
        }
      );
    });
  }

  getExtraByPrNo(mprh_pr_no) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT pre.mprh_pr_no, pre.no_of_boxes, pre.status, pre.created_by, pre.created_at, pre.updated_at,
         ne.employee_name AS created_by_name
         FROM purchase_return_extra pre
         LEFT JOIN new_employee ne ON ne.employee_id = pre.created_by
         WHERE pre.mprh_pr_no = ?`,
        [mprh_pr_no],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows && rows[0] ? rows[0] : null);
        }
      );
    });
  }
}

module.exports = (db, dbGofrugal) => {
  return new PurchaseReturnRepository(db, dbGofrugal);
};
