const logger = require("../utils/logger");
const { parseDaysValue } = require("../utils/parseDaysValue");
const {
  insertRowsInBatches,
  queryAsync,
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");

const ENRICH_SNAPSHOT_SQL = `UPDATE stock_holding_items shi
INNER JOIN product_table p ON shi.product_id = p.product_id
LEFT JOIN product_department pd_dept ON p.department_id = pd_dept.department_id
LEFT JOIN categories cat ON p.category_id = cat.category_id
LEFT JOIN subcategories sub ON p.subcategory_id = sub.category_id
LEFT JOIN outlets o ON shi.outlet_id = o.outlet_id
LEFT JOIN product_distributor_master pdm ON p.distributor_id = pdm.cid
LEFT JOIN product_distributor pd_map ON pd_map.cid = p.distributor_id
LEFT JOIN new_employee ne ON ne.employee_id = pd_map.buyer_id
LEFT JOIN (
  SELECT pi.product_id, pi.image_url
  FROM product_images pi
  INNER JOIN (
    SELECT product_id, MIN(priority) AS min_priority
    FROM product_images
    WHERE product_id IN (
      SELECT product_id FROM (
        SELECT DISTINCT product_id
        FROM stock_holding_items
        WHERE stock_holding_report_id = ?
          AND product_name IS NULL
      ) pending_products
    )
    GROUP BY product_id
  ) mp ON mp.product_id = pi.product_id AND pi.priority = mp.min_priority
  INNER JOIN (
    SELECT product_id, priority, MIN(image_id) AS min_image_id
    FROM product_images
    WHERE product_id IN (
      SELECT product_id FROM (
        SELECT DISTINCT product_id
        FROM stock_holding_items
        WHERE stock_holding_report_id = ?
          AND product_name IS NULL
      ) pending_products
    )
    GROUP BY product_id, priority
  ) mi ON mi.product_id = pi.product_id
    AND mi.priority = pi.priority
    AND pi.image_id = mi.min_image_id
) img ON img.product_id = p.product_id
SET
  shi.product_name = p.de_name,
  shi.purchase_type = p.repln_mode,
  shi.department_id = p.department_id,
  shi.category_id = p.category_id,
  shi.subcategory_id = p.subcategory_id,
  shi.department_name = pd_dept.department_name,
  shi.category_name = cat.category_name,
  shi.subcategory_name = sub.subcategory_name,
  shi.supplier_name = p.de_manufacturer_name,
  shi.distributor_id = p.distributor_id,
  shi.distributor_name = COALESCE(pdm.mdm_dist_name, p.de_distributor),
  shi.buyer_id = pd_map.buyer_id,
  shi.buyer_name = ne.employee_name,
  shi.chain_bill_count_level = p.de_bill_count_level,
  shi.holding_days = pdm.holding_days,
  shi.outlet_name = o.outlet_name,
  shi.product_image = img.image_url
WHERE shi.stock_holding_report_id = ?
  AND shi.product_name IS NULL`;

const ITEMS_SNAPSHOT_COLUMNS_SQL = `shi.stock_holding_item_id,
                shi.stock_holding_report_id,
                shi.product_id,
                shi.outlet_id,
                shi.outlet_id AS branch_id,
                shi.current_stock,
                shi.current_stock_value,
                shi.stock_duration,
                shi.status,
                shi.created_at,
                shi.updated_at,
                shi.product_name,
                shi.product_name AS de_name,
                shi.purchase_type,
                shi.department_id,
                shi.category_id,
                shi.subcategory_id,
                shi.supplier_name,
                shi.distributor_id,
                shi.department_name,
                shi.category_name,
                shi.subcategory_name,
                shi.outlet_name AS branch_name,
                shi.product_image AS image_url,
                shi.distributor_name AS distributor_master_name,
                shi.distributor_name,
                shi.buyer_id,
                shi.buyer_name,
                shi.chain_bill_count_level,
                shi.holding_days`;

const ITEMS_SNAPSHOT_SELECT_SQL = `SELECT ${ITEMS_SNAPSHOT_COLUMNS_SQL}
         FROM stock_holding_items shi
         WHERE shi.stock_holding_report_id = ?
         ORDER BY shi.stock_holding_item_id ASC`;

const LATEST_REPORT_HEADER_SQL = `SELECT shr.*,
                e.employee_name AS created_by_name
         FROM stock_holding_report shr
         LEFT JOIN new_employee e ON shr.created_by = e.employee_id
         WHERE shr.stock_holding_report_id = ?`;

const LATEST_REPORT_ID_BY_DATE_SQL = `SELECT stock_holding_report_id
         FROM stock_holding_report
         WHERE date <= DATE(?)
         ORDER BY date DESC, stock_holding_report_id DESC
         LIMIT 1`;

function enrichItemsSnapshot(dbOrConnection, stockHoldingReportId) {
  return queryAsync(dbOrConnection, ENRICH_SNAPSHOT_SQL, [
    stockHoldingReportId,
    stockHoldingReportId,
    stockHoldingReportId,
  ]);
}

function collectUniqueDistributorIds(rows) {
  const ids = [];
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const distributorId = rows[i].distributor_id;
    if (distributorId != null && distributorId !== "" && !seen.has(distributorId)) {
      seen.add(distributorId);
      ids.push(distributorId);
    }
  }
  return ids;
}

function applyLiveDistributorMeta(rows, metaMap) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const meta = metaMap.get(row.distributor_id);
    if (!meta) continue;
    if (meta.holding_days != null) row.holding_days = meta.holding_days;
    if (meta.buyer_id != null) row.buyer_id = meta.buyer_id;
    if (meta.buyer_name != null) row.buyer_name = meta.buyer_name;
  }
}

function fetchLiveDistributorMeta(db, distributorIds) {
  if (!distributorIds?.length) {
    return Promise.resolve(new Map());
  }

  const placeholders = distributorIds.map(() => "?").join(",");
  return new Promise((resolve, reject) => {
    db.query(
      `SELECT pdm.cid AS distributor_id,
              pdm.holding_days,
              pd_map.buyer_id,
              ne.employee_name AS buyer_name
       FROM product_distributor_master pdm
       LEFT JOIN product_distributor pd_map ON pd_map.cid = pdm.cid
       LEFT JOIN new_employee ne ON ne.employee_id = pd_map.buyer_id
       WHERE pdm.cid IN (${placeholders})`,
      distributorIds,
      (err, metaRows) => {
        if (err) {
          reject(err);
          return;
        }

        const metaMap = new Map();
        for (let i = 0; i < (metaRows || []).length; i++) {
          const row = metaRows[i];
          metaMap.set(row.distributor_id, row);
        }
        resolve(metaMap);
      }
    );
  });
}

function querySnapshotItems(db, stockHoldingReportId, limit, offset) {
  return new Promise((resolve, reject) => {
    const params = [stockHoldingReportId];
    let sql = ITEMS_SNAPSHOT_SELECT_SQL;

    if (limit != null) {
      sql += " LIMIT ? OFFSET ?";
      params.push(limit, offset);
    }

    db.query(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function getSnapshotItems(db, stockHoldingReportId, limit, offset) {
  return querySnapshotItems(db, stockHoldingReportId, limit, offset).then(
    (rows) => {
      if (!rows.length) return rows;
      return fetchLiveDistributorMeta(
        db,
        collectUniqueDistributorIds(rows)
      ).then((metaMap) => {
        applyLiveDistributorMeta(rows, metaMap);
        return rows;
      });
    }
  );
}

function mapItemRowSlim(item) {
  return {
    stock_holding_item_id: item.stock_holding_item_id,
    stock_holding_report_id: item.stock_holding_report_id,
    product_id: item.product_id,
    outlet_id: item.outlet_id,
    branch_id: item.branch_id ?? item.outlet_id,
    purchase_type: item.purchase_type ?? null,
    current_stock: item.current_stock,
    current_stock_value: item.current_stock_value,
    stock_on_order: null,
    stock_duration: item.stock_duration,
    holding_days: item.holding_days ?? null,
    status: item.status,
    chain_bill_count_level: item.chain_bill_count_level ?? null,
    supplier_name: item.supplier_name ?? null,
    distributor_name: item.distributor_name ?? null,
    created_at: item.created_at,
    updated_at: item.updated_at,
    product_name: item.product_name ?? null,
    product_image: item.image_url ?? null,
    branch_name: item.branch_name ?? null,
    supplier_id: null,
    supplier_master_name: item.supplier_name ?? null,
    distributor_id: item.distributor_id ?? null,
    distributor_master_name: item.distributor_master_name ?? null,
    buyer_id: item.buyer_id ?? null,
    buyer_name: item.buyer_name ?? null,
    department_id: item.department_id ?? null,
    category_id: item.category_id ?? null,
    subcategory_id: item.subcategory_id ?? null,
    department_name: item.department_name ?? null,
    category_name: item.category_name ?? null,
    subcategory_name: item.subcategory_name ?? null,
  };
}

function mapItemRow(item) {
  const slim = mapItemRowSlim(item);
  return {
    ...slim,
    product: item.product_id
      ? {
          product_id: item.product_id,
          de_name: item.de_name ?? null,
          image_url: item.image_url ?? null,
          de_buyer_name: slim.buyer_name ?? null,
        }
      : null,
    branch: item.outlet_id
      ? {
          branch_id: item.outlet_id,
          branch_name: item.branch_name ?? null,
        }
      : null,
    distributor:
      slim.distributor_id != null
        ? {
            master_id: slim.distributor_id,
            name: slim.distributor_master_name ?? null,
          }
        : null,
    buyer: slim.buyer_id
      ? {
          employee_id: slim.buyer_id,
          employee_name: slim.buyer_name ?? null,
        }
      : null,
  };
}

function mapItemsRows(items, slim) {
  const rows = items || [];
  if (!rows.length) return [];
  const mapped = new Array(rows.length);
  const mapper = slim ? mapItemRowSlim : mapItemRow;
  for (let i = 0; i < rows.length; i++) {
    mapped[i] = mapper(rows[i]);
  }
  return mapped;
}

function buildItemInsertRows(stockHoldingReportId, items) {
  return (items || []).map((item) => [
    stockHoldingReportId,
    item.product_id,
    item.outlet_id,
    item.current_stock,
    item.current_stock_value,
    parseDaysValue(item.stock_duration),
    item.status ?? null,
  ]);
}

const INSERT_ITEMS_SQL = `INSERT INTO stock_holding_items
(stock_holding_report_id, product_id, outlet_id, current_stock, current_stock_value, stock_duration, status)
VALUES ?`;

class StockHoldingReportRepository {
  constructor(db) {
    this.db = db;
  }

  createReportHeader({ report_name, date, created_by }) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `INSERT INTO stock_holding_report (report_name, date, created_by)
         VALUES (?, ?, ?)`,
        [report_name, date, created_by],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_HOLDING_REPORT",
              code: "REPOSITORY.STOCK_HOLDING_REPORT.CREATE_REPORT",
              description: err.toString(),
              category: "",
              ref: { report_name, date, created_by },
            });
            reject(err);
            return;
          }
          resolve(result.insertId);
        }
      );
    });
  }

  reportExists(stockHoldingReportId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT stock_holding_report_id
         FROM stock_holding_report
         WHERE stock_holding_report_id = ?
         LIMIT 1`,
        [stockHoldingReportId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(Array.isArray(rows) && rows.length > 0);
        }
      );
    });
  }

  getItemCountByReportId(stockHoldingReportId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT COUNT(*) AS item_count
         FROM stock_holding_items
         WHERE stock_holding_report_id = ?`,
        [stockHoldingReportId],
        (err, rows) => {
          if (err) reject(err);
          else resolve(Number(rows?.[0]?.item_count ?? 0));
        }
      );
    });
  }

  create(payload) {
    const { report_name, date, created_by, items = [] } = payload;

    return getConnectionAsync(this.db).then(async (connection) => {
      try {
        await beginTransactionAsync(connection);
        const reportResult = await queryAsync(
          connection,
          `INSERT INTO stock_holding_report (report_name, date, created_by)
           VALUES (?, ?, ?)`,
          [report_name, date, created_by]
        );
        const reportId = reportResult.insertId;

        if (items.length > 0) {
          const rows = buildItemInsertRows(reportId, items);
          await insertRowsInBatches(connection, INSERT_ITEMS_SQL, rows);
          await enrichItemsSnapshot(connection, reportId);
        }

        await commitAsync(connection);
        connection.release();
        return {
          stock_holding_report_id: reportId,
          report_name,
          date,
          created_by,
          item_count: items.length,
        };
      } catch (err) {
        await rollbackAsync(connection);
        connection.release();
        throw err;
      }
    });
  }

  appendItems(stockHoldingReportId, items = []) {
    if (!items.length) {
      return this.getItemCountByReportId(stockHoldingReportId).then(
        (item_count) => ({ inserted: 0, item_count })
      );
    }

    return getConnectionAsync(this.db).then(async (connection) => {
      try {
        await beginTransactionAsync(connection);
        const rows = buildItemInsertRows(stockHoldingReportId, items);
        await insertRowsInBatches(connection, INSERT_ITEMS_SQL, rows);
        await enrichItemsSnapshot(connection, stockHoldingReportId);
        await commitAsync(connection);
        connection.release();
        const item_count = await this.getItemCountByReportId(
          stockHoldingReportId
        );
        return { inserted: items.length, item_count };
      } catch (err) {
        await rollbackAsync(connection);
        connection.release();
        throw err;
      }
    });
  }

  getItemsByReportId(stockHoldingReportId, options = {}) {
    const { limit, offset = 0, slim = false } = options;
    const hasPagination =
      limit != null && Number.isFinite(Number(limit)) && Number(limit) > 0;
    const safeLimit = hasPagination ? Math.min(Number(limit), 5000) : null;
    const safeOffset = hasPagination ? Math.max(Number(offset) || 0, 0) : 0;

    return getSnapshotItems(
      this.db,
      stockHoldingReportId,
      hasPagination ? safeLimit : null,
      hasPagination ? safeOffset : 0
    )
      .then((items) => mapItemsRows(items, slim))
      .catch((err) => {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "REPOSITORY.STOCK_HOLDING_REPORT",
          code: "REPOSITORY.STOCK_HOLDING_REPORT.GET_ITEMS_BY_REPORT_ID",
          description: err.toString(),
          category: "",
          ref: { stockHoldingReportId, limit: safeLimit, offset: safeOffset },
        });
        throw err;
      });
  }

  getItemsPageByReportId(stockHoldingReportId, limit, offset = 0) {
    const safeLimit = Math.min(Number(limit), 5000);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const includeTotal = safeOffset === 0;

    const itemsPromise = this.getItemsByReportId(stockHoldingReportId, {
      limit: safeLimit,
      offset: safeOffset,
      slim: true,
    });

    if (!includeTotal) {
      return itemsPromise.then((items) => ({
        items,
        total: null,
        limit: safeLimit,
        offset: safeOffset,
        has_more: items.length === safeLimit,
      }));
    }

    return Promise.all([
      this.getItemCountByReportId(stockHoldingReportId),
      itemsPromise,
    ]).then(([total, items]) => {
      const nextOffset = safeOffset + items.length;
      return {
        items,
        total,
        limit: safeLimit,
        offset: safeOffset,
        has_more: nextOffset < total,
      };
    });
  }

  getReportHeaderById(stockHoldingReportId, options = {}) {
    const { includeItemCount = true } = options;
    return new Promise((resolve, reject) => {
      this.db.query(
        LATEST_REPORT_HEADER_SQL,
        [stockHoldingReportId],
        async (err, reports) => {
          if (err) {
            reject(err);
            return;
          }
          if (!reports || reports.length === 0) {
            resolve(null);
            return;
          }

          if (!includeItemCount) {
            resolve(reports[0]);
            return;
          }

          try {
            const item_count = await this.getItemCountByReportId(
              stockHoldingReportId
            );
            resolve({
              ...reports[0],
              item_count,
            });
          } catch (countErr) {
            reject(countErr);
          }
        }
      );
    });
  }

  getAllReports() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT shr.*,
                e.employee_name AS created_by_name
         FROM stock_holding_report shr
         LEFT JOIN new_employee e ON shr.created_by = e.employee_id
         ORDER BY shr.date DESC, shr.stock_holding_report_id DESC`,
        [],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_HOLDING_REPORT",
              code: "REPOSITORY.STOCK_HOLDING_REPORT.GET_ALL_REPORTS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(rows || []);
        }
      );
    });
  }

  getById(stockHoldingReportId, options = {}) {
    const { includeItems = false, limit, offset } = options;
    return this.getReportHeaderById(stockHoldingReportId).then((report) => {
      if (!report) return null;
      if (!includeItems) return report;
      if (limit != null) {
        return this.getItemsPageByReportId(
          stockHoldingReportId,
          limit,
          offset
        ).then((page) => ({
          ...report,
          ...page,
        }));
      }
      return this.getItemsByReportId(stockHoldingReportId, { slim: false }).then(
        (items) => ({
          ...report,
          items,
        })
      );
    });
  }

  getLatestReportIdByDate(date) {
    return new Promise((resolve, reject) => {
      this.db.query(LATEST_REPORT_ID_BY_DATE_SQL, [date], (err, rows) => {
        if (err) reject(err);
        else resolve(rows?.[0]?.stock_holding_report_id ?? null);
      });
    });
  }

  getLatestReportByDate(date, options = {}) {
    const { includeItems = false, limit, offset } = options;
    return this.getLatestReportIdByDate(date).then((reportId) => {
      if (!reportId) return null;
      return this.getById(reportId, { includeItems, limit, offset });
    });
  }

  getLatestItemsPageByDate(date, limit, offset = 0, reportId = null) {
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const reportIdPromise = reportId
      ? Promise.resolve(Number(reportId))
      : this.getLatestReportIdByDate(date);

    return reportIdPromise.then((resolvedReportId) => {
      if (!resolvedReportId) return null;

      const pagePromise = this.getItemsPageByReportId(
        resolvedReportId,
        limit,
        safeOffset
      );

      if (safeOffset > 0) {
        return pagePromise.then((page) => ({
          stock_holding_report_id: resolvedReportId,
          ...page,
        }));
      }

      return Promise.all([
        this.getReportHeaderById(resolvedReportId),
        pagePromise,
      ]).then(([report, page]) => {
        if (!report) return null;
        return {
          ...report,
          ...page,
        };
      });
    });
  }

  delete(stockHoldingReportId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `DELETE FROM stock_holding_report WHERE stock_holding_report_id = ?`,
        [stockHoldingReportId],
        (err, result) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.STOCK_HOLDING_REPORT",
              code: "REPOSITORY.STOCK_HOLDING_REPORT.DELETE",
              description: err.toString(),
              category: "",
              ref: { stockHoldingReportId },
            });
            reject(err);
            return;
          }
          resolve({ affectedRows: result.affectedRows });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new StockHoldingReportRepository(db);
};
