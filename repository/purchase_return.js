const logger = require("../utils/logger");

const PUR_RETURN_DT_CUTOFF = "2026-02-01 00:00:00";
// const PUR_RETURN_DT_CUTOFF = "2023-02-01 00:00:00";

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

function resolveRemark(extra) {
  if (!extra) return null;
  const hasRemark = extra.remark != null && String(extra.remark).trim() !== "";
  const noRemarkId = extra.remark_id == null || extra.remark_id === undefined;
  if (hasRemark && noRemarkId) return extra.remark;
  if (extra.remark_label != null) return extra.remark_label;
  return extra.remark;
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
         WHERE mprh_locaid = 2 AND mprh_pr_dt >= ?
         ORDER BY mprh_pr_refno DESC`,
        [PUR_RETURN_DT_CUTOFF],
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

  /** Headers with distributor name in one query (Gofrugal). */
  getHeadersFromGofrugalWithDistributor() {
    return new Promise((resolve, reject) => {
      this.dbGofrugal.query(
        `SELECT h.mprh_pr_no, h.mprh_pr_refno, h.mprh_pr_dt, h.mprh_basic_amount, h.mprh_net_amount, h.mprh_locaid, h.mprh_dist_code,
                d.MDM_DIST_NAME AS distributor_name
         FROM medishopdb_med_pur_return_hdr h
         LEFT JOIN medishopdb_MED_DISTRIBUTOR_MAST d ON d.MDM_DIST_CODE = h.mprh_dist_code
         WHERE h.mprh_locaid = 2 AND h.mprh_pr_dt >= ?
         ORDER BY h.mprh_pr_refno DESC`,
        [PUR_RETURN_DT_CUTOFF],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.HEADERS_WITH_DIST",
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

  getHeadersFromGofrugalByDistCode(distributor_id) {
    return new Promise((resolve, reject) => {
      this.dbGofrugal.query(
        `SELECT mprh_pr_no, mprh_pr_refno, mprh_pr_dt, mprh_basic_amount, mprh_net_amount, mprh_locaid, mprh_dist_code
         FROM medishopdb_med_pur_return_hdr
         WHERE mprh_locaid = 2 AND mprh_pr_dt >= ? AND mprh_dist_code = ?
         ORDER BY mprh_pr_refno DESC`,
        [PUR_RETURN_DT_CUTOFF, distributor_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.HEADERS_BY_DIST",
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

  /** Headers by dist code with distributor name in one query (Gofrugal). */
  getHeadersFromGofrugalByDistCodeWithDistributor(distributor_id) {
    return new Promise((resolve, reject) => {
      this.dbGofrugal.query(
        `SELECT h.mprh_pr_no, h.mprh_pr_refno, h.mprh_pr_dt, h.mprh_basic_amount, h.mprh_net_amount, h.mprh_locaid, h.mprh_dist_code,
                d.MDM_DIST_NAME AS distributor_name
         FROM medishopdb_med_pur_return_hdr h
         LEFT JOIN medishopdb_MED_DISTRIBUTOR_MAST d ON d.MDM_DIST_CODE = h.mprh_dist_code
         WHERE h.mprh_locaid = 2 AND h.mprh_pr_dt >= ? AND h.mprh_dist_code = ?
         ORDER BY h.mprh_pr_refno DESC`,
        [PUR_RETURN_DT_CUTOFF, distributor_id],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.HEADERS_BY_DIST_WITH_DIST",
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
        `SELECT pre.mprh_pr_no, pre.no_of_boxes, pre.status, pre.created_by, pre.purchase_acknowledgement_id, pre.remark_id, pre.remark, pre.created_at, pre.updated_at,
         ne.employee_name AS created_by_name,
         rm.label AS remark_label
         FROM purchase_return_extra pre
         LEFT JOIN new_employee ne ON ne.employee_id = pre.created_by
         LEFT JOIN remarks_master rm ON rm.remark_id = pre.remark_id`,
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

  /** Products with images in one query (main DB). Returns map of product_id -> { ...product, images, image_url }. */
  getProductsWithImagesByProductIds(productIds) {
    if (!productIds || productIds.length === 0) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      const placeholders = productIds.map(() => "?").join(",");
      this.db.query(
        `SELECT pt.product_id, pt.gf_item_name, pt.de_display_name,
                pi.image_id, pi.image_url, pi.priority, pi.created_at AS img_created_at, pi.updated_at AS img_updated_at
         FROM product_table pt
         LEFT JOIN product_images pi ON pi.product_id = pt.product_id
         WHERE pt.product_id IN (${placeholders})
         ORDER BY pt.product_id, pi.priority ASC, pi.image_id ASC`,
        productIds,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PURCHASE_RETURN",
              code: "REPOSITORY.PURCHASE_RETURN.PRODUCTS_WITH_IMAGES",
              description: err.toString(),
              category: "",
              ref: {}
            });
            return reject(err);
          }
          const byProduct = {};
          (rows || []).forEach((r) => {
            const key = String(r.product_id);
            if (!byProduct[key]) {
              byProduct[key] = {
                product_id: r.product_id,
                gf_item_name: r.gf_item_name,
                de_display_name: r.de_display_name,
                images: [],
                image_url: null
              };
            }
            if (r.image_id != null) {
              byProduct[key].images.push({
                image_id: r.image_id,
                image_url: r.image_url,
                priority: r.priority,
                created_at: r.img_created_at,
                updated_at: r.img_updated_at
              });
            }
          });
          Object.keys(byProduct).forEach((k) => {
            const p = byProduct[k];
            p.image_url = p.images.length > 0 ? p.images[0].image_url : null;
          });
          resolve(byProduct);
        }
      );
    });
  }

  getAll() {
    return new Promise((resolve, reject) => {
      Promise.all([
        this.getHeadersFromGofrugalWithDistributor(),
        this.getItemsFromGofrugal(),
        this.getExtrasFromMain()
      ])
        .then(([headers, items, extrasMap]) => {
          const itemCodes = [...new Set(items.map((i) => i.MPR_ITEM_CODE).filter(Boolean))];
          return this.getProductsWithImagesByProductIds(itemCodes).then((productsMap) => {
            const itemsByPrNo = {};
            items.forEach((item) => {
              const prNo = String(item.MPR_PR_NO);
              if (!itemsByPrNo[prNo]) itemsByPrNo[prNo] = [];
              const product = productsMap[String(item.MPR_ITEM_CODE)] || null;
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
              return {
                mprh_pr_no: h.mprh_pr_no,
                mprh_pr_refno: h.mprh_pr_refno,
                mprh_pr_dt: h.mprh_pr_dt,
                mprh_basic_amount: h.mprh_basic_amount,
                mprh_net_amount: h.mprh_net_amount,
                mprh_locaid: h.mprh_locaid,
                mprh_dist_code: h.mprh_dist_code,
                distributor_name: h.distributor_name ?? null,
                no_of_boxes: extra ? extra.no_of_boxes : null,
                status: extra ? extra.status : null,
                created_by: extra ? extra.created_by : null,
                created_by_name: extra ? extra.created_by_name : null,
                purchase_acknowledgement_id: extra ? extra.purchase_acknowledgement_id : null,
                remark_id: extra ? extra.remark_id : null,
                remark: resolveRemark(extra),
                created_at: extra ? extra.created_at : null,
                updated_at: extra ? extra.updated_at : null,
                items: aggregateItemsByProductCode(itemsByPrNo[prNo] || [])
              };
            });
            result.sort((a, b) => {
              const refA = a.mprh_pr_refno != null ? String(a.mprh_pr_refno) : "";
              const refB = b.mprh_pr_refno != null ? String(b.mprh_pr_refno) : "";
              return refB.localeCompare(refA, undefined, { numeric: true });
            });
            resolve(result);
          });
        })
        .catch(reject);
    });
  }

  getAllByDistributorIdOpenStatus(distributor_id, purchase_acknowledgement_id = null) {
    return new Promise((resolve, reject) => {
      Promise.all([
        this.getHeadersFromGofrugalByDistCodeWithDistributor(distributor_id),
        this.getItemsFromGofrugal(),
        this.getExtrasFromMain()
      ])
        .then(([headers, items, extrasMap]) => {
          const openHeaders = headers.filter((h) => {
            const extra = extrasMap[String(h.mprh_pr_no)];
            const isOpen = !extra || extra.status === "open";
            const matchesAck = purchase_acknowledgement_id != null && extra && Number(extra.purchase_acknowledgement_id) === purchase_acknowledgement_id;
            return isOpen || matchesAck;
          });
          if (openHeaders.length === 0) return resolve([]);
          const prNoSet = new Set(openHeaders.map((h) => String(h.mprh_pr_no)));
          const itemCodes = [...new Set(items.filter((i) => prNoSet.has(String(i.MPR_PR_NO))).map((i) => i.MPR_ITEM_CODE).filter(Boolean))];
          return this.getProductsWithImagesByProductIds(itemCodes).then((productsMap) => {
            const itemsByPrNo = {};
            items.forEach((item) => {
              const prNo = String(item.MPR_PR_NO);
              if (!prNoSet.has(prNo)) return;
              if (!itemsByPrNo[prNo]) itemsByPrNo[prNo] = [];
              const product = productsMap[String(item.MPR_ITEM_CODE)] || null;
              itemsByPrNo[prNo].push({
                MPR_PR_NO: item.MPR_PR_NO,
                MPR_MRC_NO: item.MPR_MRC_NO,
                MPR_ITEM_CODE: item.MPR_ITEM_CODE,
                MPR_ITEM_QTY: item.MPR_ITEM_QTY,
                MPR_ITEM_AMOUNT: item.MPR_ITEM_AMOUNT,
                product
              });
            });
            const result = openHeaders.map((h) => {
              const prNo = String(h.mprh_pr_no);
              const extra = extrasMap[prNo] || null;
              return {
                mprh_pr_no: h.mprh_pr_no,
                mprh_pr_refno: h.mprh_pr_refno,
                mprh_pr_dt: h.mprh_pr_dt,
                mprh_basic_amount: h.mprh_basic_amount,
                mprh_net_amount: h.mprh_net_amount,
                mprh_locaid: h.mprh_locaid,
                mprh_dist_code: h.mprh_dist_code,
                distributor_name: h.distributor_name ?? null,
                no_of_boxes: extra ? extra.no_of_boxes : null,
                status: extra ? extra.status : null,
                created_by: extra ? extra.created_by : null,
                created_by_name: extra ? extra.created_by_name : null,
                purchase_acknowledgement_id: extra ? extra.purchase_acknowledgement_id : null,
                remark_id: extra ? extra.remark_id : null,
                remark: resolveRemark(extra),
                created_at: extra ? extra.created_at : null,
                updated_at: extra ? extra.updated_at : null,
                items: aggregateItemsByProductCode(itemsByPrNo[prNo] || [])
              };
            });
            result.sort((a, b) => {
              const refA = a.mprh_pr_refno != null ? String(a.mprh_pr_refno) : "";
              const refB = b.mprh_pr_refno != null ? String(b.mprh_pr_refno) : "";
              return refB.localeCompare(refA, undefined, { numeric: true });
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
         FROM medishopdb_med_pur_return_hdr WHERE mprh_pr_no = ? AND mprh_pr_dt >= ?`,
        [prNo, PUR_RETURN_DT_CUTOFF],
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
                      purchase_acknowledgement_id: extra ? extra.purchase_acknowledgement_id : null,
                      remark_id: extra ? extra.remark_id : null,
                      remark: resolveRemark(extra),
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
        `INSERT INTO purchase_return_extra (mprh_pr_no, no_of_boxes, status, created_by, purchase_acknowledgement_id, remark_id, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [data.mprh_pr_no, data.no_of_boxes ?? 0, data.status ?? "open", data.created_by ?? null, data.purchase_acknowledgement_id ?? null, data.remark_id ?? null, data.remark ?? null],
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
      if (data.purchase_acknowledgement_id !== undefined) {
        sets.push("purchase_acknowledgement_id = ?");
        values.push(data.purchase_acknowledgement_id);
      }
      if (data.remark_id !== undefined) {
        sets.push("remark_id = ?");
        values.push(data.remark_id);
      }
      if (data.remark !== undefined) {
        sets.push("remark = ?");
        values.push(data.remark);
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
        `SELECT pre.mprh_pr_no, pre.no_of_boxes, pre.status, pre.created_by, pre.purchase_acknowledgement_id, pre.remark_id, pre.remark, pre.created_at, pre.updated_at,
         ne.employee_name AS created_by_name,
         rm.label AS remark_label
         FROM purchase_return_extra pre
         LEFT JOIN new_employee ne ON ne.employee_id = pre.created_by
         LEFT JOIN remarks_master rm ON rm.remark_id = pre.remark_id
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
