const logger = require("../utils/logger");

const SQL_COLLATION = "utf8mb4_unicode_ci";
const SALES_DASHBOARD_LOOKBACK_DAYS = 62;

function sqlUtf8mb4(expr) {
  return `CONVERT(${expr} USING utf8mb4)`;
}

function sqlLowerTrim(expr) {
  return `LOWER(TRIM(${sqlUtf8mb4(expr)})) COLLATE ${SQL_COLLATION}`;
}

function sqlCompare(leftExpr, rightExpr) {
  return `${sqlLowerTrim(leftExpr)} = ${sqlLowerTrim(rightExpr)}`;
}

function sqlCollate(expr) {
  return `${sqlUtf8mb4(expr)} COLLATE ${SQL_COLLATION}`;
}

function sqlCoalesceText(...exprs) {
  return `COALESCE(${exprs.map(sqlCollate).join(", ")})`;
}

function sqlMaxText(expr) {
  return `MAX(${sqlCollate(expr)})`;
}

function sqlMaxCoalesceText(...exprs) {
  return `MAX(${sqlCoalesceText(...exprs)})`;
}

const PRODUCT_IMAGE_SUBQUERY = `(SELECT pi.image_url
  FROM product_images pi
  WHERE pi.product_id = p.product_id
  ORDER BY pi.priority ASC, pi.image_id ASC
  LIMIT 1)`;

const SALES_DAILY_TOTALS_JOINS = `
FROM product_sales ps
JOIN product_table p ON p.product_id = ps.product_id
LEFT JOIN product_distributor_master pdm ON p.distributor_id = pdm.cid`;

const SALES_LIGHT_JOINS = `
FROM product_sales ps
JOIN product_table p ON p.product_id = ps.product_id
JOIN outlets o ON o.outlet_id = ps.retail_outlet_id
LEFT JOIN categories cat ON p.category_id = cat.category_id
LEFT JOIN subcategories sub ON p.subcategory_id = sub.category_id
LEFT JOIN product_department pd ON p.department_id = pd.department_id
LEFT JOIN product_distributor pd_map ON pd_map.cid = p.distributor_id
LEFT JOIN new_employee ne ON ne.employee_id = pd_map.buyer_id
LEFT JOIN product_distributor_master pdm ON p.distributor_id = pdm.cid`;

const SALES_STOCK_JOIN = `
LEFT JOIN (
  SELECT shi.product_id,
         shi.outlet_id,
         shi.purchase_type,
         shi.chain_bill_count_level,
         shi.supplier_name,
         shi.distributor_name,
         shi.buyer_id,
         shi.buyer_name
  FROM stock_holding_items shi
  INNER JOIN stock_holding_report shr
    ON shr.stock_holding_report_id = shi.stock_holding_report_id
  INNER JOIN (
    SELECT shi2.product_id,
           shi2.outlet_id,
           MAX(shr2.date) AS max_date
    FROM stock_holding_items shi2
    INNER JOIN stock_holding_report shr2
      ON shr2.stock_holding_report_id = shi2.stock_holding_report_id
    WHERE shr2.date <= DATE(?)
    GROUP BY shi2.product_id, shi2.outlet_id
  ) latest
    ON latest.product_id = shi.product_id
   AND latest.outlet_id = shi.outlet_id
   AND shr.date = latest.max_date
) shi_latest
  ON shi_latest.product_id = ps.product_id
 AND shi_latest.outlet_id = ps.retail_outlet_id`;

const SALES_ITEMS_JOINS = `
FROM product_sales ps
JOIN product_table p ON p.product_id = ps.product_id
JOIN outlets o ON o.outlet_id = ps.retail_outlet_id
LEFT JOIN categories cat ON p.category_id = cat.category_id
LEFT JOIN subcategories sub ON p.subcategory_id = sub.category_id
LEFT JOIN product_department pd ON p.department_id = pd.department_id
LEFT JOIN product_distributor pd_map ON pd_map.cid = p.distributor_id
LEFT JOIN new_employee ne ON ne.employee_id = pd_map.buyer_id
LEFT JOIN product_distributor_master pdm ON p.distributor_id = pdm.cid
${SALES_STOCK_JOIN}`;

const SALES_ITEMS_LIGHT_SELECT = `
SELECT DATE(ps.tran_date) AS report_date,
       ps.product_id,
       ps.retail_outlet_id AS branch_id,
       ${sqlMaxText("o.outlet_name")} AS branch_name,
       ${sqlMaxText("p.de_name")} AS product_name,
       ${sqlMaxText(PRODUCT_IMAGE_SUBQUERY)} AS product_image,
       ${sqlMaxCoalesceText(
         "shi_latest.buyer_name",
         "ne.employee_name",
         "p.buyer_name"
       )} AS buyer_name,
       MAX(COALESCE(shi_latest.buyer_id, pd_map.buyer_id)) AS buyer_id,
       NULL AS supplier_id,
       ${sqlMaxCoalesceText(
         "shi_latest.supplier_name",
         "p.de_manufacturer_name"
       )} AS supplier_name,
       MAX(p.distributor_id) AS distributor_id,
       ${sqlMaxCoalesceText(
         "pdm.mdm_dist_name",
         "p.de_distributor",
         "shi_latest.distributor_name"
       )} AS distributor_name,
       MAX(p.department_id) AS department_id,
       ${sqlMaxText("pd.department_name")} AS department_name,
       MAX(p.category_id) AS category_id,
       ${sqlMaxText("cat.category_name")} AS category_name,
       MAX(p.subcategory_id) AS subcategory_id,
       ${sqlMaxText("sub.subcategory_name")} AS subcategory_name,
       ${sqlMaxText("shi_latest.purchase_type")} AS purchase_type,
       ${sqlMaxText("shi_latest.chain_bill_count_level")} AS chain_bill_count_level,
       COALESCE(SUM(ps.tran_qty), 0) AS sold_qty,
       COALESCE(SUM(ps.net_amt), 0) AS sold_value,
       COALESCE(SUM(ps.profit), 0) AS sold_profit
${SALES_ITEMS_JOINS}`;

const SALES_ITEMS_LIGHT_NO_STOCK_SELECT = `
SELECT DATE(ps.tran_date) AS report_date,
       ps.product_id,
       ps.retail_outlet_id AS branch_id,
       ${sqlMaxText("o.outlet_name")} AS branch_name,
       ${sqlMaxText("p.de_name")} AS product_name,
       ${sqlMaxText(PRODUCT_IMAGE_SUBQUERY)} AS product_image,
       ${sqlMaxCoalesceText("ne.employee_name", "p.buyer_name")} AS buyer_name,
       MAX(pd_map.buyer_id) AS buyer_id,
       NULL AS supplier_id,
       ${sqlMaxText("p.de_manufacturer_name")} AS supplier_name,
       MAX(p.distributor_id) AS distributor_id,
       ${sqlMaxCoalesceText("pdm.mdm_dist_name", "p.de_distributor")} AS distributor_name,
       MAX(p.department_id) AS department_id,
       ${sqlMaxText("pd.department_name")} AS department_name,
       MAX(p.category_id) AS category_id,
       ${sqlMaxText("cat.category_name")} AS category_name,
       MAX(p.subcategory_id) AS subcategory_id,
       ${sqlMaxText("sub.subcategory_name")} AS subcategory_name,
       NULL AS purchase_type,
       NULL AS chain_bill_count_level,
       COALESCE(SUM(ps.tran_qty), 0) AS sold_qty,
       COALESCE(SUM(ps.net_amt), 0) AS sold_value,
       COALESCE(SUM(ps.profit), 0) AS sold_profit
${SALES_LIGHT_JOINS}`;

function normalizeRawList(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseIdList(values) {
  return normalizeRawList(values)
    .map((v) => parseInt(String(v), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parseBuyerIdList(values) {
  return normalizeRawList(values).filter(
    (v) => String(v ?? "").trim() !== "" && String(v) !== "unknown"
  );
}

function parseStringList(values) {
  return normalizeRawList(values)
    .map((v) =>
      String(v ?? "")
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
}

function buildInPlaceholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function filtersNeedStockJoin(filters = {}) {
  return (
    parseBuyerIdList(filters.buyer_ids).length > 0 ||
    parseStringList(filters.supplier_ids).length > 0 ||
    parseStringList(filters.purchase_types).length > 0 ||
    parseStringList(filters.chain_levels).length > 0
  );
}

function buildLightFilterClauses(filters = {}) {
  const params = [];
  const clauses = [];

  const branchIds = parseIdList(filters.branch_ids);
  if (branchIds.length) {
    clauses.push(
      `ps.retail_outlet_id IN (${buildInPlaceholders(branchIds.length)})`
    );
    params.push(...branchIds);
  }

  const distributorIds = parseIdList(filters.distributor_ids);
  if (distributorIds.length) {
    const distributorPh = buildInPlaceholders(distributorIds.length);
    clauses.push(`(
      p.distributor_id IN (${distributorPh})
      OR pdm.cid IN (${distributorPh})
    )`);
    params.push(...distributorIds, ...distributorIds);
  }

  const departmentIds = parseIdList(filters.department_ids);
  if (departmentIds.length) {
    clauses.push(
      `p.department_id IN (${buildInPlaceholders(departmentIds.length)})`
    );
    params.push(...departmentIds);
  }

  const categoryIds = parseIdList(filters.category_ids);
  if (categoryIds.length) {
    clauses.push(
      `p.category_id IN (${buildInPlaceholders(categoryIds.length)})`
    );
    params.push(...categoryIds);
  }

  const subcategoryIds = parseIdList(filters.subcategory_ids);
  if (subcategoryIds.length) {
    clauses.push(
      `p.subcategory_id IN (${buildInPlaceholders(subcategoryIds.length)})`
    );
    params.push(...subcategoryIds);
  }

  const whereExtra = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
  return { params, whereExtra };
}

function buildSalesFilterClauses(filters = {}, asOfDate) {
  const params = [asOfDate];
  const clauses = [];

  const branchIds = parseIdList(filters.branch_ids);
  if (branchIds.length) {
    clauses.push(
      `ps.retail_outlet_id IN (${buildInPlaceholders(branchIds.length)})`
    );
    params.push(...branchIds);
  }

  const buyerIds = parseBuyerIdList(filters.buyer_ids);
  if (buyerIds.length) {
    const numericBuyerIds = buyerIds
      .map((v) => parseInt(String(v), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (numericBuyerIds.length === buyerIds.length) {
      const buyerPh = buildInPlaceholders(numericBuyerIds.length);
      clauses.push(`(
        EXISTS (
          SELECT 1
          FROM new_employee e
          WHERE e.employee_id IN (${buyerPh})
            AND (
              (
                shi_latest.buyer_id IS NOT NULL
                AND shi_latest.buyer_id = e.employee_id
              )
              OR pd_map.buyer_id = e.employee_id
              OR ${sqlCompare("e.employee_name", "COALESCE(shi_latest.buyer_name, p.buyer_name)")}
            )
        )
      )`);
      params.push(...numericBuyerIds);
    } else {
      const buyerPh = buildInPlaceholders(buyerIds.length);
      clauses.push(`(
        EXISTS (
          SELECT 1
          FROM new_employee e
          WHERE ${sqlCollate("CAST(e.employee_id AS CHAR)")} IN (${buyerPh})
            AND (
              (
                shi_latest.buyer_id IS NOT NULL
                AND TRIM(CAST(shi_latest.buyer_id AS CHAR)) <> ''
                AND ${sqlCollate("CAST(shi_latest.buyer_id AS CHAR)")} = ${sqlCollate(
        "CAST(e.employee_id AS CHAR)"
      )}
              )
              OR ${sqlCollate("CAST(e.employee_id AS CHAR)")} = ${sqlCollate(
        "CAST(pd_map.buyer_id AS CHAR)"
      )}
              OR ${sqlCompare("e.employee_name", "COALESCE(shi_latest.buyer_name, p.buyer_name)")}
            )
        )
      )`);
      params.push(...buyerIds);
    }
  }

  const supplierKeys = parseStringList(filters.supplier_ids);
  if (supplierKeys.length) {
    const supplierPh = buildInPlaceholders(supplierKeys.length);
    clauses.push(`(
      ${sqlLowerTrim(
        "COALESCE(shi_latest.supplier_name, p.de_manufacturer_name, '')"
      )} IN (${supplierPh})
    )`);
    params.push(...supplierKeys);
  }

  const distributorIds = parseIdList(filters.distributor_ids);
  if (distributorIds.length) {
    const distributorPh = buildInPlaceholders(distributorIds.length);
    clauses.push(`(
      p.distributor_id IN (${distributorPh})
      OR pdm.cid IN (${distributorPh})
    )`);
    params.push(...distributorIds, ...distributorIds);
  }

  const departmentIds = parseIdList(filters.department_ids);
  if (departmentIds.length) {
    clauses.push(
      `p.department_id IN (${buildInPlaceholders(departmentIds.length)})`
    );
    params.push(...departmentIds);
  }

  const categoryIds = parseIdList(filters.category_ids);
  if (categoryIds.length) {
    clauses.push(
      `p.category_id IN (${buildInPlaceholders(categoryIds.length)})`
    );
    params.push(...categoryIds);
  }

  const subcategoryIds = parseIdList(filters.subcategory_ids);
  if (subcategoryIds.length) {
    clauses.push(
      `p.subcategory_id IN (${buildInPlaceholders(subcategoryIds.length)})`
    );
    params.push(...subcategoryIds);
  }

  const purchaseTypes = parseStringList(filters.purchase_types);
  if (purchaseTypes.length) {
    clauses.push(
      `${sqlLowerTrim(
        "COALESCE(shi_latest.purchase_type, '')"
      )} IN (${buildInPlaceholders(purchaseTypes.length)})`
    );
    params.push(...purchaseTypes);
  }

  const chainLevels = parseStringList(filters.chain_levels);
  if (chainLevels.length) {
    clauses.push(
      `${sqlLowerTrim(
        "COALESCE(shi_latest.chain_bill_count_level, '')"
      )} IN (${buildInPlaceholders(chainLevels.length)})`
    );
    params.push(...chainLevels);
  }

  const whereExtra = clauses.length ? ` AND ${clauses.join(" AND ")}` : "";
  return { params, whereExtra };
}

function formatDateKey(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const trimmed = String(value).trim();
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : trimmed.slice(0, 10);
}

function addDaysLocal(dateStr, days) {
  const dt = new Date(`${formatDateKey(dateStr)}T12:00:00`);
  dt.setDate(dt.getDate() + days);
  return formatDateKey(dt);
}

function mapDailyTotalRows(rows) {
  return (rows || []).map((row) => ({
    date: formatDateKey(row.date),
    sold_qty: Number(row.sold_qty ?? 0),
    sold_value: Number(row.sold_value ?? 0),
    sold_profit: Number(row.sold_profit ?? 0),
    row_count: Number(row.row_count ?? 0),
  }));
}

function mapItemRows(rows) {
  return (rows || []).map((row) => ({
    ...row,
    report_date: formatDateKey(row.report_date),
    sold_qty: Number(row.sold_qty ?? 0),
    sold_value: Number(row.sold_value ?? 0),
    sold_profit: Number(row.sold_profit ?? 0),
  }));
}

function buildFilterOptionsFromRows(rows) {
  const branchOptions = new Map();
  const buyerOptions = new Map();
  const supplierOptions = new Map();
  const distributorOptions = new Map();
  const departmentOptions = new Map();
  const categoryOptions = new Map();
  const subcategoryOptions = new Map();
  const purchaseTypeOptions = new Map();
  const chainLevelOptions = new Map();

  (rows || []).forEach((row) => {
    if (row.branch_id != null) {
      branchOptions.set(String(row.branch_id), {
        value: String(row.branch_id),
        label: row.branch_name || String(row.branch_id),
      });
    }
    const buyerKey = row.buyer_id;
    if (buyerKey != null && String(buyerKey).trim() !== "") {
      buyerOptions.set(String(buyerKey), {
        value: String(buyerKey),
        label: row.buyer_name || String(buyerKey),
      });
    }
    const supplierName = String(row.supplier_name ?? "").trim();
    if (supplierName) {
      const key = supplierName.toLowerCase();
      supplierOptions.set(key, { value: key, label: supplierName });
    }
    const distributorKey = row.distributor_id;
    if (distributorKey != null) {
      distributorOptions.set(String(distributorKey), {
        value: String(distributorKey),
        label: row.distributor_name || String(distributorKey),
      });
    }
    if (row.department_id != null) {
      departmentOptions.set(String(row.department_id), {
        value: String(row.department_id),
        label: row.department_name || String(row.department_id),
      });
    }
    if (row.category_id != null) {
      categoryOptions.set(String(row.category_id), {
        value: String(row.category_id),
        label: row.category_name || String(row.category_id),
      });
    }
    if (row.subcategory_id != null) {
      subcategoryOptions.set(String(row.subcategory_id), {
        value: String(row.subcategory_id),
        label: row.subcategory_name || String(row.subcategory_id),
      });
    }
    const purchaseType = String(row.purchase_type ?? "").trim();
    if (purchaseType) {
      const key = purchaseType.toLowerCase();
      purchaseTypeOptions.set(key, { value: key, label: purchaseType });
    }
    const chainLevel = String(row.chain_bill_count_level ?? "").trim();
    if (chainLevel) {
      const key = chainLevel.toLowerCase();
      chainLevelOptions.set(key, { value: key, label: chainLevel });
    }
  });

  const sortOptions = (map) =>
    Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));

  return {
    branchOptions: sortOptions(branchOptions),
    buyerOptions: sortOptions(buyerOptions),
    supplierOptions: sortOptions(supplierOptions),
    distributorOptions: sortOptions(distributorOptions),
    departmentOptions: sortOptions(departmentOptions),
    categoryOptions: sortOptions(categoryOptions),
    subcategoryOptions: sortOptions(subcategoryOptions),
    purchaseTypeOptions: sortOptions(purchaseTypeOptions),
    chainLevelOptions: sortOptions(chainLevelOptions),
  };
}

function emptyFilterOptions() {
  return buildFilterOptionsFromRows([]);
}

function resolveFilterOptionsDateRange(asOfDate, { fromDate, toDate } = {}) {
  const rangeTo = formatDateKey(toDate) || formatDateKey(asOfDate);
  const rangeFrom =
    formatDateKey(fromDate) ||
    formatDateKey(addDaysLocal(asOfDate, -SALES_DASHBOARD_LOOKBACK_DAYS));
  return { fromDate: rangeFrom, toDate: rangeTo };
}

class SalesDashboardRepository {
  constructor(db) {
    this.db = db;
  }

  queryRows(sql, params, logCode, ref = {}) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.SALES_DASHBOARD",
            code: logCode,
            description: err.toString(),
            category: "",
            ref,
          });
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  hasSalesForDate(date) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT 1 AS found
         FROM product_sales
         WHERE tran_date = DATE(?)
         LIMIT 1`,
        [date],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SALES_DASHBOARD",
              code: "REPOSITORY.SALES_DASHBOARD.HAS_SALES_FOR_DATE",
              description: err.toString(),
              category: "",
              ref: { date },
            });
            reject(err);
            return;
          }
          resolve(Boolean(rows?.[0]));
        }
      );
    });
  }

  getDailyTotals(asOfDate, filters = {}, { fromDate, toDate } = {}) {
    const rangeTo = formatDateKey(toDate || asOfDate);
    const rangeFrom =
      formatDateKey(fromDate) ||
      formatDateKey(addDaysLocal(asOfDate, -SALES_DASHBOARD_LOOKBACK_DAYS));
    const range = { fromDate: rangeFrom, toDate: rangeTo };

    if (filtersNeedStockJoin(filters)) {
      return this.getDailyTotalsWithStockJoin(asOfDate, filters, range);
    }
    return this.getDailyTotalsLight(asOfDate, filters, range);
  }

  getDailyTotalsLight(asOfDate, filters = {}, { fromDate, toDate } = {}) {
    const { params, whereExtra } = buildLightFilterClauses(filters);
    const sql = `
      SELECT ps.tran_date AS date,
             COALESCE(SUM(ps.tran_qty), 0) AS sold_qty,
             COALESCE(SUM(ps.net_amt), 0) AS sold_value,
             COALESCE(SUM(ps.profit), 0) AS sold_profit,
             COUNT(*) AS row_count
      ${SALES_DAILY_TOTALS_JOINS}
      WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
      ${whereExtra}
      GROUP BY ps.tran_date
      ORDER BY ps.tran_date ASC`;

    return new Promise((resolve, reject) => {
      this.db.query(sql, [fromDate, toDate, ...params], (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.SALES_DASHBOARD",
            code: "REPOSITORY.SALES_DASHBOARD.GET_DAILY_TOTALS_LIGHT",
            description: err.toString(),
            category: "",
            ref: { asOfDate, filters },
          });
          reject(err);
          return;
        }
        resolve(mapDailyTotalRows(rows));
      });
    });
  }

  getDailyTotalsWithStockJoin(
    asOfDate,
    filters = {},
    { fromDate, toDate } = {}
  ) {
    const { params, whereExtra } = buildSalesFilterClauses(filters, asOfDate);
    const [joinDateParam, ...filterParams] = params;
    const sql = `
      SELECT item_rows.date AS date,
             COALESCE(SUM(item_rows.sold_qty), 0) AS sold_qty,
             COALESCE(SUM(item_rows.sold_value), 0) AS sold_value,
             COALESCE(SUM(item_rows.sold_profit), 0) AS sold_profit,
             COUNT(*) AS row_count
      FROM (
        SELECT ps.product_sale_id,
               ps.tran_date AS date,
               ps.tran_qty AS sold_qty,
               ps.net_amt AS sold_value,
               ps.profit AS sold_profit
        ${SALES_ITEMS_JOINS}
        WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
        ${whereExtra}
      ) item_rows
      GROUP BY item_rows.date
      ORDER BY item_rows.date ASC`;

    return new Promise((resolve, reject) => {
      this.db.query(
        sql,
        [joinDateParam, fromDate, toDate, ...filterParams],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SALES_DASHBOARD",
              code: "REPOSITORY.SALES_DASHBOARD.GET_DAILY_TOTALS",
              description: err.toString(),
              category: "",
              ref: { asOfDate, filters },
            });
            reject(err);
            return;
          }
          resolve(mapDailyTotalRows(rows));
        }
      );
    });
  }

  getItemsByDate(date, filters = {}, { limit = 5000, offset = 0 } = {}) {
    if (filtersNeedStockJoin(filters)) {
      return this.getItemsByDateWithStockJoin(date, filters, { limit, offset });
    }
    return this.getItemsByDateLight(date, filters, { limit, offset });
  }

  getItemsByDateLight(date, filters = {}, { limit = 5000, offset = 0 } = {}) {
    const { params, whereExtra } = buildLightFilterClauses(filters);
    const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 15000);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const sql = `
      ${SALES_ITEMS_LIGHT_NO_STOCK_SELECT}
      WHERE ps.tran_date = DATE(?)
      ${whereExtra}
      GROUP BY ps.product_id, ps.retail_outlet_id
      ORDER BY ps.product_id ASC, ps.retail_outlet_id ASC
      LIMIT ? OFFSET ?`;

    return new Promise((resolve, reject) => {
      this.db.query(
        sql,
        [date, ...params, safeLimit, safeOffset],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SALES_DASHBOARD",
              code: "REPOSITORY.SALES_DASHBOARD.GET_ITEMS_BY_DATE_LIGHT",
              description: err.toString(),
              category: "",
              ref: { date, filters, limit: safeLimit, offset: safeOffset },
            });
            reject(err);
            return;
          }
          resolve(mapItemRows(rows));
        }
      );
    });
  }

  getItemsByDateWithStockJoin(
    date,
    filters = {},
    { limit = 5000, offset = 0 } = {}
  ) {
    const { params, whereExtra } = buildSalesFilterClauses(filters, date);
    const [joinDateParam, ...filterParams] = params;
    const safeLimit = Math.min(Math.max(Number(limit) || 5000, 1), 15000);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const sql = `
      ${SALES_ITEMS_LIGHT_SELECT}
      WHERE ps.tran_date = DATE(?)
      ${whereExtra}
      GROUP BY ps.product_id, ps.retail_outlet_id
      ORDER BY ps.product_id ASC, ps.retail_outlet_id ASC
      LIMIT ? OFFSET ?`;

    return new Promise((resolve, reject) => {
      this.db.query(
        sql,
        [joinDateParam, date, ...filterParams, safeLimit, safeOffset],
        (err, rows) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.SALES_DASHBOARD",
              code: "REPOSITORY.SALES_DASHBOARD.GET_ITEMS_BY_DATE",
              description: err.toString(),
              category: "",
              ref: { date, filters, limit: safeLimit, offset: safeOffset },
            });
            reject(err);
            return;
          }
          resolve(mapItemRows(rows));
        }
      );
    });
  }

  getItemCountByDate(date, filters = {}) {
    if (filtersNeedStockJoin(filters)) {
      return this.getItemCountByDateWithStockJoin(date, filters);
    }
    return this.getItemCountByDateLight(date, filters);
  }

  getItemCountByDateLight(date, filters = {}) {
    const { params, whereExtra } = buildLightFilterClauses(filters);
    const sql = `
      SELECT COUNT(*) AS total
      FROM (
        SELECT ps.product_id, ps.retail_outlet_id
        ${SALES_LIGHT_JOINS}
        WHERE ps.tran_date = DATE(?)
        ${whereExtra}
        GROUP BY ps.product_id, ps.retail_outlet_id
      ) grouped`;

    return new Promise((resolve, reject) => {
      this.db.query(sql, [date, ...params], (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.SALES_DASHBOARD",
            code: "REPOSITORY.SALES_DASHBOARD.GET_ITEM_COUNT_BY_DATE_LIGHT",
            description: err.toString(),
            category: "",
            ref: { date, filters },
          });
          reject(err);
          return;
        }
        resolve(Number(rows?.[0]?.total ?? 0));
      });
    });
  }

  getItemCountByDateWithStockJoin(date, filters = {}) {
    const { params, whereExtra } = buildSalesFilterClauses(filters, date);
    const [joinDateParam, ...filterParams] = params;
    const sql = `
      SELECT COUNT(*) AS total
      FROM (
        SELECT ps.product_id, ps.retail_outlet_id
        ${SALES_ITEMS_JOINS}
        WHERE ps.tran_date = DATE(?)
        ${whereExtra}
        GROUP BY ps.product_id, ps.retail_outlet_id
      ) grouped`;

    return new Promise((resolve, reject) => {
      this.db.query(sql, [joinDateParam, date, ...filterParams], (err, rows) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.SALES_DASHBOARD",
            code: "REPOSITORY.SALES_DASHBOARD.GET_ITEM_COUNT_BY_DATE",
            description: err.toString(),
            category: "",
            ref: { date, filters },
          });
          reject(err);
          return;
        }
        resolve(Number(rows?.[0]?.total ?? 0));
      });
    });
  }

  getStockDerivedFilterOptions(asOfDate, { fromDate, toDate } = {}) {
    const range = resolveFilterOptionsDateRange(asOfDate, { fromDate, toDate });
    const sql = `
      SELECT DISTINCT
        shi.supplier_name,
        shi.purchase_type,
        shi.chain_bill_count_level
      FROM product_sales ps
      INNER JOIN stock_holding_items shi
        ON shi.product_id = ps.product_id
       AND shi.outlet_id = ps.retail_outlet_id
      INNER JOIN stock_holding_report shr
        ON shr.stock_holding_report_id = shi.stock_holding_report_id
      WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
        AND shr.date BETWEEN DATE(?) AND DATE(?)`;

    return this.queryRows(
      sql,
      [range.fromDate, range.toDate, range.fromDate, range.toDate],
      "REPOSITORY.SALES_DASHBOARD.GET_STOCK_DERIVED_FILTER_OPTIONS",
      { asOfDate, ...range }
    );
  }

  getFilterOptionsLight(asOfDate, { fromDate, toDate } = {}) {
    const range = resolveFilterOptionsDateRange(asOfDate, { fromDate, toDate });
    const rangeParams = [range.fromDate, range.toDate];
    const salesFrom = `
      FROM product_sales ps
      INNER JOIN product_table p ON p.product_id = ps.product_id`;

    return Promise.all([
      this.queryRows(
        `SELECT DISTINCT ps.retail_outlet_id AS branch_id, o.outlet_name AS branch_name
         ${salesFrom}
         INNER JOIN outlets o ON o.outlet_id = ps.retail_outlet_id
         WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
           AND ps.retail_outlet_id IS NOT NULL`,
        rangeParams,
        "REPOSITORY.SALES_DASHBOARD.GET_FILTER_OPTIONS_BRANCHES",
        { asOfDate }
      ),
      this.queryRows(
        `SELECT DISTINCT pd_map.buyer_id,
                ne.employee_name AS buyer_name
         ${salesFrom}
         LEFT JOIN product_distributor pd_map ON pd_map.cid = p.distributor_id
         LEFT JOIN new_employee ne ON ne.employee_id = pd_map.buyer_id
         WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
           AND pd_map.buyer_id IS NOT NULL`,
        rangeParams,
        "REPOSITORY.SALES_DASHBOARD.GET_FILTER_OPTIONS_BUYERS",
        { asOfDate }
      ),
      this.queryRows(
        `SELECT DISTINCT p.distributor_id,
                COALESCE(pdm.mdm_dist_name, p.de_distributor) AS distributor_name
         ${salesFrom}
         LEFT JOIN product_distributor_master pdm ON p.distributor_id = pdm.cid
         WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
           AND p.distributor_id IS NOT NULL`,
        rangeParams,
        "REPOSITORY.SALES_DASHBOARD.GET_FILTER_OPTIONS_DISTRIBUTORS",
        { asOfDate }
      ),
      this.queryRows(
        `SELECT DISTINCT p.department_id, pd.department_name
         ${salesFrom}
         LEFT JOIN product_department pd ON pd.department_id = p.department_id
         WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
           AND p.department_id IS NOT NULL`,
        rangeParams,
        "REPOSITORY.SALES_DASHBOARD.GET_FILTER_OPTIONS_DEPARTMENTS",
        { asOfDate }
      ),
      this.queryRows(
        `SELECT DISTINCT p.category_id, cat.category_name
         ${salesFrom}
         LEFT JOIN categories cat ON cat.category_id = p.category_id
         WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
           AND p.category_id IS NOT NULL`,
        rangeParams,
        "REPOSITORY.SALES_DASHBOARD.GET_FILTER_OPTIONS_CATEGORIES",
        { asOfDate }
      ),
      this.queryRows(
        `SELECT DISTINCT p.subcategory_id, sub.subcategory_name
         ${salesFrom}
         LEFT JOIN subcategories sub ON sub.subcategory_id = p.subcategory_id
         WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
           AND p.subcategory_id IS NOT NULL`,
        rangeParams,
        "REPOSITORY.SALES_DASHBOARD.GET_FILTER_OPTIONS_SUBCATEGORIES",
        { asOfDate }
      ),
      this.queryRows(
        `SELECT DISTINCT p.de_manufacturer_name AS supplier_name
         ${salesFrom}
         WHERE ps.tran_date BETWEEN DATE(?) AND DATE(?)
           AND TRIM(COALESCE(p.de_manufacturer_name, '')) <> ''`,
        rangeParams,
        "REPOSITORY.SALES_DASHBOARD.GET_FILTER_OPTIONS_SUPPLIERS",
        { asOfDate }
      ),
    ]).then((resultSets) => resultSets.flat());
  }

  getFilterOptions(asOfDate, { fromDate, toDate } = {}) {
    return Promise.all([
      this.getFilterOptionsLight(asOfDate, { fromDate, toDate }).catch(() => []),
      this.getStockDerivedFilterOptions(asOfDate, { fromDate, toDate }).catch(
        () => []
      ),
    ])
      .then(([rows, stockRows]) =>
        buildFilterOptionsFromRows([...(rows || []), ...(stockRows || [])])
      )
      .catch(() => emptyFilterOptions());
  }
}

module.exports = (db) => {
  return new SalesDashboardRepository(db);
};
