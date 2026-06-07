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

const ITEMS_SELECT_SQL = `SELECT shi.stock_holding_item_id,
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
                p.de_name AS product_name,
                p.de_name,
                p.repln_mode AS purchase_type,
                p.department_id,
                p.category_id,
                p.subcategory_id,
                p.de_manufacturer_name AS supplier_name,
                p.de_distributor,
                p.distributor_id,
                pd_dept.department_name,
                cat.category_name,
                sub.subcategory_name,
                o.outlet_name AS branch_name,
                (
                  SELECT pi.image_url
                  FROM product_images pi
                  WHERE pi.product_id = p.product_id
                  ORDER BY pi.priority ASC, pi.image_id ASC
                  LIMIT 1
                ) AS image_url,
                pdm.mdm_dist_name AS distributor_master_name,
                COALESCE(pdm.mdm_dist_name, p.de_distributor) AS distributor_name,
                COALESCE(pd_map_cid.buyer_id, pd_map_code.buyer_id) AS buyer_id,
                ne.employee_name AS buyer_name,
                p.de_bill_count_level AS chain_bill_count_level,
                pdm.holding_days AS holding_days
         FROM stock_holding_items shi
         LEFT JOIN product_table p ON shi.product_id = p.product_id
         LEFT JOIN product_department pd_dept ON p.department_id = pd_dept.department_id
         LEFT JOIN categories cat ON p.category_id = cat.category_id
         LEFT JOIN subcategories sub ON p.subcategory_id = sub.category_id
         LEFT JOIN outlets o ON shi.outlet_id = o.outlet_id
         LEFT JOIN product_distributor_master pdm ON p.distributor_id = pdm.cid
         LEFT JOIN product_distributor pd_map_cid ON pd_map_cid.cid = p.distributor_id
         LEFT JOIN product_distributor pd_map_code
           ON pd_map_cid.cid IS NULL
          AND pdm.mdm_dist_code IS NOT NULL
          AND TRIM(pd_map_code.mdm_dist_code) = TRIM(pdm.mdm_dist_code)
         LEFT JOIN new_employee ne
           ON ne.employee_id = COALESCE(pd_map_cid.buyer_id, pd_map_code.buyer_id)`;

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
    const safeLimit = hasPagination ? Math.min(Number(limit), 15000) : null;
    const safeOffset = hasPagination ? Math.max(Number(offset) || 0, 0) : 0;

    return new Promise((resolve, reject) => {
      const params = [stockHoldingReportId];
      let sql = `${ITEMS_SELECT_SQL}
         WHERE shi.stock_holding_report_id = ?
         ORDER BY shi.stock_holding_item_id ASC`;

      if (hasPagination) {
        sql += " LIMIT ? OFFSET ?";
        params.push(safeLimit, safeOffset);
      }

      this.db.query(sql, params, (err, items) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.STOCK_HOLDING_REPORT",
            code: "REPOSITORY.STOCK_HOLDING_REPORT.GET_ITEMS_BY_REPORT_ID",
            description: err.toString(),
            category: "",
            ref: { stockHoldingReportId, limit: safeLimit, offset: safeOffset },
          });
          reject(err);
          return;
        }

        const mapped = (items || []).map((item) =>
          slim ? mapItemRowSlim(item) : mapItemRow(item)
        );
        resolve(mapped);
      });
    });
  }

  getItemsPageByReportId(stockHoldingReportId, limit, offset = 0) {
    return Promise.all([
      this.getItemCountByReportId(stockHoldingReportId),
      this.getItemsByReportId(stockHoldingReportId, {
        limit,
        offset,
        slim: true,
      }),
    ]).then(([total, items]) => {
      const nextOffset = offset + items.length;
      return {
        items,
        total,
        limit: Number(limit),
        offset: Number(offset),
        has_more: nextOffset < total,
      };
    });
  }

  getReportHeaderById(stockHoldingReportId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT shr.*,
                e.employee_name AS created_by_name
         FROM stock_holding_report shr
         LEFT JOIN new_employee e ON shr.created_by = e.employee_id
         WHERE shr.stock_holding_report_id = ?`,
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
      this.db.query(
        `SELECT stock_holding_report_id
         FROM stock_holding_report
         WHERE date <= DATE(?)
         ORDER BY date DESC, stock_holding_report_id DESC
         LIMIT 1`,
        [date],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows?.[0]?.stock_holding_report_id ?? null);
        }
      );
    });
  }

  getLatestReportByDate(date, options = {}) {
    const { includeItems = false, limit, offset } = options;
    return this.getLatestReportIdByDate(date).then((reportId) => {
      if (!reportId) return null;
      return this.getById(reportId, { includeItems, limit, offset });
    });
  }

  getLatestItemsPageByDate(date, limit, offset = 0) {
    return this.getLatestReportIdByDate(date).then((reportId) => {
      if (!reportId) return null;
      return this.getReportHeaderById(reportId).then((report) => {
        if (!report) return null;
        return this.getItemsPageByReportId(reportId, limit, offset).then(
          (page) => ({
            ...report,
            ...page,
          })
        );
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
