const logger = require("../utils/logger");

const TABLE = "stock_received";
const GOFRUGAL_DTL = "medishopdb_MED_MRC_DTL";
const GOFRUGAL_HDR = "medishopdb_MED_MRC_HDR";
const GOFRUGAL_DIST = "medishopdb_MED_DISTRIBUTOR_MAST";
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

function normalizeCalendarDate(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    const d = String(value.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

function grnHeaderRow(row) {
  const countRaw = row.product_count ?? row.PRODUCT_COUNT ?? 0;
  const count = Number(countRaw);
  const distCode = row.mmh_dist_code ?? row.MMH_DIST_CODE;
  const distName =
    row.supplier_name ?? row.MDM_DIST_NAME ?? row.mdm_dist_name ?? null;
  const amtRaw = row.mmh_mrc_amt ?? row.MMH_MRC_AMT;
  const amt = amtRaw != null && amtRaw !== "" ? Number(amtRaw) : null;
  const mrcDt = normalizeCalendarDate(row.mmh_mrc_dt ?? row.MMH_MRC_DT);
  const supplierName =
    distName != null && String(distName).trim() !== ""
      ? distName
      : distCode != null && distCode !== ""
        ? String(distCode)
        : null;
  return {
    mmh_mrc_no: row.mmh_mrc_no ?? row.MMH_MRC_NO,
    mmh_mrc_refno: row.mmh_mrc_refno ?? row.MMH_MRC_REFNO,
    mmh_mrc_dt: mrcDt,
    mmh_dist_code:
      distCode != null && distCode !== "" ? String(distCode) : null,
    supplier_name: supplierName,
    mmh_mrc_amt: Number.isFinite(amt) ? amt : null,
    product_count: Number.isFinite(count) ? count : 0,
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
    pareto: row.de_bill_count_level != null ? row.de_bill_count_level : null,
    purchase_uom: row.purchase_uom != null ? row.purchase_uom : null,
    store_uom: row.store_uom != null ? row.store_uom : null,
  };
}

function stockReceivedIsOffer(row) {
  return row && (row.is_offer === 1 || row.is_offer === true);
}

function numericRecdQty(q) {
  const n = Number(q);
  return Number.isFinite(n) ? n : 0;
}

function parseOptionalNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function computeGrnDiscount(mrpRaw, saleRateRaw) {
  const mrp = parseOptionalNumber(mrpRaw);
  const saleRate = parseOptionalNumber(saleRateRaw);
  if (mrp == null || saleRate == null) {
    return { discount_amount: null, discount_pct: null };
  }
  const discount_amount = mrp - saleRate;
  const discount_pct = mrp !== 0 ? 100 - (saleRate / mrp) * 100 : null;
  const roundedPct =
    discount_pct != null && Number.isFinite(discount_pct)
      ? Math.round(discount_pct * 100) / 100
      : null;
  return {
    discount_amount: Number.isFinite(discount_amount) ? discount_amount : null,
    discount_pct: roundedPct,
  };
}

function grnDetailItemRow(row, productMap) {
  const productId = normalizeItemCode(
    row.MMD_ITEM_CODE ?? row.mmd_item_code ?? row.product_id
  );
  const mrpRaw =
    row.MMD_MAX_RATE ?? row.mmd_max_rate ?? row.mrp ?? row.MMD_MRP ?? row.mmd_mrp;
  const saleRateRaw = row.MMD_SALE_RATE ?? row.mmd_sale_rate;
  const { discount_amount, discount_pct } = computeGrnDiscount(mrpRaw, saleRateRaw);
  const product =
    productId != null ? productMap.get(productId) || null : null;

  return {
    mmd_mrc_sl_no: row.MMD_MRC_SL_NO ?? row.mmd_mrc_sl_no,
    product_id: productId,
    mmd_recd_qty: parseOptionalNumber(row.MMD_RECD_QTY ?? row.mmd_recd_qty),
    mmd_free_qty: parseOptionalNumber(row.MMD_FREE_QTY ?? row.mmd_free_qty),
    mrp: parseOptionalNumber(mrpRaw),
    mmd_pur_rate: parseOptionalNumber(row.MMD_PUR_RATE ?? row.mmd_pur_rate),
    mmd_pur_tax_per: parseOptionalNumber(
      row.MMD_PUR_TAX_PER ?? row.mmd_pur_tax_per
    ),
    mmd_pur_tax_amt: parseOptionalNumber(
      row.MMD_PUR_TAX_AMT ?? row.mmd_pur_tax_amt
    ),
    mmd_pur_price: parseOptionalNumber(row.MMD_PUR_PRICE ?? row.mmd_pur_price),
    mmd_sale_rate: parseOptionalNumber(saleRateRaw),
    mmd_pur_amount: parseOptionalNumber(
      row.MMD_PUR_AMOUNT ?? row.mmd_pur_amount
    ),
    mmd_disc_per: parseOptionalNumber(row.MMD_DISC_PER ?? row.mmd_disc_per),
    mmd_disc_amt: parseOptionalNumber(row.MMD_DISC_AMT ?? row.mmd_disc_amt),
    mmd_ppur_rate: parseOptionalNumber(
      row.MMD_PPUR_RATE ?? row.mmd_ppur_rate
    ),
    mmd_pmrp: parseOptionalNumber(row.MMD_PMRP ?? row.mmd_pmrp),
    mmd_prev_pur_price: parseOptionalNumber(
      row.MMD_PREV_PUR_PRICE ?? row.mmd_prev_pur_price
    ),
    discount_amount,
    discount_pct,
    product,
  };
}

class StockReceivedRepository {
  constructor(mainDb, gofrugalDb) {
    this.db = mainDb;
    this.gofrugalDb = gofrugalDb;
  }

  listGrnHeaders(filters = {}) {
    const fromDate =
      filters.from_date != null && String(filters.from_date).trim() !== ""
        ? String(filters.from_date).trim()
        : null;
    const toDate =
      filters.to_date != null && String(filters.to_date).trim() !== ""
        ? String(filters.to_date).trim()
        : null;

    return new Promise((resolve, reject) => {
      if (!this.gofrugalDb) {
        return reject(new Error("Gofrugal DB connection is not configured"));
      }

      const conditions = [];
      const params = [];
      if (fromDate) {
        conditions.push("DATE(h.MMH_MRC_DT) >= DATE(?)");
        params.push(fromDate);
      }
      if (toDate) {
        conditions.push("DATE(h.MMH_MRC_DT) <= DATE(?)");
        params.push(toDate);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      this.gofrugalDb.query(
        `SELECT
            h.MMH_MRC_NO AS mmh_mrc_no,
            h.MMH_MRC_REFNO AS mmh_mrc_refno,
            DATE_FORMAT(h.MMH_MRC_DT, '%Y-%m-%d') AS mmh_mrc_dt,
            h.MMH_DIST_CODE AS mmh_dist_code,
            h.MMH_MRC_AMT AS mmh_mrc_amt,
            MAX(dist.MDM_DIST_NAME) AS supplier_name,
            COUNT(d.MMD_MRC_SL_NO) AS product_count
         FROM \`${GOFRUGAL_HDR}\` h
         LEFT JOIN \`${GOFRUGAL_DTL}\` d ON d.MMD_MRC_NO = h.MMH_MRC_NO
         LEFT JOIN \`${GOFRUGAL_DIST}\` dist
           ON TRIM(CAST(dist.MDM_DIST_CODE AS CHAR)) = TRIM(CAST(h.MMH_DIST_CODE AS CHAR))
         ${where}
         GROUP BY h.MMH_MRC_NO, h.MMH_MRC_REFNO, h.MMH_MRC_DT, h.MMH_DIST_CODE, h.MMH_MRC_AMT
         ORDER BY h.MMH_MRC_DT DESC, h.MMH_MRC_NO DESC`,
        params,
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.LIST_GRN_HEADERS",
              description: err.toString(),
              category: "",
              ref: { from_date: fromDate, to_date: toDate },
            });
            return reject(err);
          }
          resolve((rows || []).map(grnHeaderRow));
        }
      );
    });
  }

  listGrnDetailByRefno(refno) {
    const refnoKey =
      refno != null && String(refno).trim() !== "" ? String(refno).trim() : null;
    if (!refnoKey) {
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      if (!this.gofrugalDb) {
        return reject(new Error("Gofrugal DB connection is not configured"));
      }

      this.gofrugalDb.query(
        `SELECT
            h.MMH_MRC_NO AS mmh_mrc_no,
            h.MMH_MRC_REFNO AS mmh_mrc_refno,
            DATE_FORMAT(h.MMH_MRC_DT, '%Y-%m-%d') AS mmh_mrc_dt,
            h.MMH_DIST_CODE AS mmh_dist_code,
            h.MMH_MRC_AMT AS mmh_mrc_amt,
            dist.MDM_DIST_NAME AS supplier_name
         FROM \`${GOFRUGAL_HDR}\` h
         LEFT JOIN \`${GOFRUGAL_DIST}\` dist
           ON TRIM(CAST(dist.MDM_DIST_CODE AS CHAR)) = TRIM(CAST(h.MMH_DIST_CODE AS CHAR))
         WHERE h.MMH_MRC_REFNO = ?
         LIMIT 1`,
        [refnoKey],
        async (err, headerRows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.GRN_DETAIL_HDR",
              description: err.toString(),
              category: "",
              ref: { refno: refnoKey },
            });
            return reject(err);
          }

          const headerRaw = headerRows && headerRows[0] ? headerRows[0] : null;
          if (!headerRaw) {
            return resolve(null);
          }

          const header = grnHeaderRow({
            ...headerRaw,
            product_count: 0,
          });
          const mrcNo = header.mmh_mrc_no;
          if (mrcNo == null) {
            return resolve(null);
          }

          this.gofrugalDb.query(
            `SELECT
                d.MMD_MRC_SL_NO,
                d.MMD_ITEM_CODE,
                d.MMD_RECD_QTY,
                d.MMD_FREE_QTY,
                d.MMD_MAX_RATE,
                d.MMD_PUR_RATE,
                d.MMD_PUR_TAX_PER,
                d.MMD_PUR_TAX_AMT,
                d.MMD_PUR_PRICE,
                d.MMD_SALE_RATE,
                d.MMD_PUR_AMOUNT,
                d.MMD_DISC_PER,
                d.MMD_DISC_AMT,
                d.MMD_PPUR_RATE,
                d.MMD_PMRP,
                d.MMD_PREV_PUR_PRICE
             FROM \`${GOFRUGAL_DTL}\` d
             WHERE d.MMD_MRC_NO = ?
             ORDER BY d.MMD_MRC_SL_NO ASC`,
            [mrcNo],
            async (errDtl, dtlRows) => {
              if (errDtl) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.STOCK_RECEIVED",
                  code: "REPOSITORY.STOCK_RECEIVED.GRN_DETAIL_DTL",
                  description: errDtl.toString(),
                  category: "",
                  ref: { refno: refnoKey, mmh_mrc_no: mrcNo },
                });
                return reject(errDtl);
              }

              try {
                const rawItems = dtlRows || [];
                const productIds = rawItems
                  .map((row) => normalizeItemCode(row.MMD_ITEM_CODE ?? row.mmd_item_code))
                  .filter((id) => id != null);
                const productMap = await this._fetchProductsMap(productIds);
                const items = rawItems.map((row) =>
                  grnDetailItemRow(row, productMap)
                );
                resolve({ header, items });
              } catch (lookupErr) {
                logger.Log({
                  level: logger.LEVEL.ERROR,
                  component: "REPOSITORY.STOCK_RECEIVED",
                  code: "REPOSITORY.STOCK_RECEIVED.GRN_DETAIL_ENRICH",
                  description: lookupErr.toString(),
                  category: "",
                  ref: { refno: refnoKey, mmh_mrc_no: mrcNo },
                });
                reject(lookupErr);
              }
            }
          );
        }
      );
    });
  }

  /**
   * All GRN detail item rows (with header fields attached) for GRNs whose
   * MRC date falls in [fromDate, toDate], in one query -- used by the Issue
   * GRN page so it doesn't fire one /grn/detail request per GRN in the
   * range.
   */
  listGrnDetailItemsByDateRange(fromDate, toDate) {
    return new Promise((resolve, reject) => {
      if (!this.gofrugalDb) {
        return reject(new Error("Gofrugal DB connection is not configured"));
      }

      const conditions = [];
      const params = [];
      if (fromDate) {
        conditions.push("DATE(h.MMH_MRC_DT) >= DATE(?)");
        params.push(fromDate);
      }
      if (toDate) {
        conditions.push("DATE(h.MMH_MRC_DT) <= DATE(?)");
        params.push(toDate);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

      this.gofrugalDb.query(
        `SELECT
            h.MMH_MRC_REFNO AS mmh_mrc_refno,
            DATE_FORMAT(h.MMH_MRC_DT, '%Y-%m-%d') AS mmh_mrc_dt,
            dist.MDM_DIST_NAME AS supplier_name,
            d.MMD_MRC_SL_NO,
            d.MMD_ITEM_CODE,
            d.MMD_RECD_QTY,
            d.MMD_FREE_QTY,
            d.MMD_MAX_RATE,
            d.MMD_PUR_RATE,
            d.MMD_PUR_TAX_PER,
            d.MMD_PUR_TAX_AMT,
            d.MMD_PUR_PRICE,
            d.MMD_SALE_RATE,
            d.MMD_PUR_AMOUNT
         FROM \`${GOFRUGAL_HDR}\` h
         JOIN \`${GOFRUGAL_DTL}\` d ON d.MMD_MRC_NO = h.MMH_MRC_NO
         LEFT JOIN \`${GOFRUGAL_DIST}\` dist
           ON TRIM(CAST(dist.MDM_DIST_CODE AS CHAR)) = TRIM(CAST(h.MMH_DIST_CODE AS CHAR))
         ${where}
         ORDER BY h.MMH_MRC_DT DESC, h.MMH_MRC_NO DESC, d.MMD_MRC_SL_NO ASC`,
        params,
        async (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.GRN_ISSUES_RANGE",
              description: err.toString(),
              category: "",
              ref: { from_date: fromDate, to_date: toDate },
            });
            return reject(err);
          }

          try {
            const rawItems = rows || [];
            const productIds = rawItems
              .map((row) => normalizeItemCode(row.MMD_ITEM_CODE))
              .filter((id) => id != null);
            const productMap = await this._fetchProductsMap(productIds);
            const items = rawItems.map((row) => ({
              mmh_mrc_refno: row.mmh_mrc_refno,
              mmh_mrc_dt: row.mmh_mrc_dt,
              supplier_name: row.supplier_name,
              ...grnDetailItemRow(row, productMap),
            }));
            resolve(items);
          } catch (lookupErr) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.GRN_ISSUES_RANGE_ENRICH",
              description: lookupErr.toString(),
              category: "",
              ref: { from_date: fromDate, to_date: toDate },
            });
            reject(lookupErr);
          }
        }
      );
    });
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

  /**
   * Latest MRP (MMD_MAX_RATE) and net cost (MMD_PUR_PRICE) for the given
   * product ids, taken from each product's most recent GRN line by actual
   * GRN date (MMH_MRC_DT) — not MMD_MRC_NO insertion order, since GRNs can
   * be entered out of chronological order (e.g. backdated). MMD_MRC_NO is
   * used only as a tiebreak.
   *
   * Scoped to `productIds` and chunked, rather than scanning the entire
   * GRN detail history table (which can span years of receipts) — this
   * was previously the page's main slowdown.
   * Returns a Map keyed by product_id.
   */
  listLatestGrnPricingByProduct(productIds) {
    return new Promise((resolve, reject) => {
      if (!this.gofrugalDb) {
        return reject(new Error("Gofrugal DB connection is not configured"));
      }
      const unique = [...new Set((productIds || []).filter((id) => id != null))];
      if (!unique.length) {
        resolve(new Map());
        return;
      }
      const chunks = chunkArray(unique, 200);
      const map = new Map();
      let pending = chunks.length;
      let settled = false;
      chunks.forEach((ids) => {
        const ph = ids.map(() => "?").join(", ");
        this.gofrugalDb.query(
          `SELECT
              d.MMD_ITEM_CODE,
              d.MMD_MRC_NO,
              d.MMD_PUR_PRICE,
              d.MMD_MAX_RATE AS MMD_MRP,
              h.MMH_MRC_DT
           FROM \`${GOFRUGAL_DTL}\` d
           LEFT JOIN \`${GOFRUGAL_HDR}\` h ON h.MMH_MRC_NO = d.MMD_MRC_NO
           WHERE d.MMD_ITEM_CODE IN (${ph})
           ORDER BY h.MMH_MRC_DT DESC, d.MMD_MRC_NO DESC`,
          ids,
          (err, rows) => {
            if (settled) return;
            if (err) {
              settled = true;
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.STOCK_RECEIVED",
                code: "REPOSITORY.STOCK_RECEIVED.LATEST_GRN_PRICING",
                description: err.toString(),
                category: "",
                ref: {},
              });
              return reject(err);
            }
            (rows || []).forEach((row) => {
              const productId = normalizeItemCode(row.MMD_ITEM_CODE);
              if (productId == null || map.has(productId)) {
                return;
              }
              map.set(productId, {
                mrp: parseOptionalNumber(row.MMD_MRP),
                net_cost: parseOptionalNumber(row.MMD_PUR_PRICE),
              });
            });
            pending -= 1;
            if (pending === 0) {
              resolve(map);
            }
          }
        );
      });
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
            pt.de_bill_count_level,
            pt.purchase_uom,
            pt.store_uom,
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

  listIgnoredGrnIssueKeys() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT mmh_mrc_refno, mmd_mrc_sl_no FROM grn_issue_ignores`,
        [],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.LIST_IGNORED_GRN_ISSUES",
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

  ignoreGrnIssueItems(items, ignoredBy) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(items) || items.length === 0) {
        return resolve({ ignored: 0 });
      }

      const values = items.map((item) => [
        String(item.refno),
        String(item.sl_no),
        item.product_id != null ? item.product_id : null,
        ignoredBy != null ? ignoredBy : null,
      ]);

      this.db.query(
        `INSERT INTO grn_issue_ignores
            (mmh_mrc_refno, mmd_mrc_sl_no, product_id, ignored_by)
         VALUES ?
         ON DUPLICATE KEY UPDATE
            product_id = VALUES(product_id),
            ignored_by = VALUES(ignored_by)`,
        [values],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_RECEIVED",
              code: "REPOSITORY.STOCK_RECEIVED.IGNORE_GRN_ISSUES",
              description: err.toString(),
              category: "",
              ref: { items },
            });
            return reject(err);
          }
          resolve({ ignored: items.length });
        }
      );
    });
  }
}

module.exports = (mainDb, gofrugalDb) => {
  return new StockReceivedRepository(mainDb, gofrugalDb);
};
