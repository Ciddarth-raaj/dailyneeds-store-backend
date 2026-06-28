const logger = require("../utils/logger");
const {
  getConnectionAsync,
  insertRowsInBatches,
} = require("../utils/batchInsert");

const HDR_TABLE = "offer_hdr";
const PRODUCTS_TABLE = "offer_products";
const ISSUE_TABLE = "offer_issue";

const HDR_COLUMNS = [
  "moh_offer_id",
  "moh_offer_name",
  "moh_offer_family_id",
  "moh_offer_typeid",
  "moh_offer_status",
  "moh_offer_get_confirm",
  "moh_offer_tier_id",
  "moh_offer_period",
  "moh_offer_happy_days",
  "moh_offer_happy_hours",
  "moh_offer_first_n_customers",
  "moh_offer_st_date",
  "moh_offer_end_date",
  "moh_offer_hq_id",
  "moh_offer_nth_bill",
  "ts",
  "tsid",
  "retail_outlet_id",
  "moh_vertical_id",
  "moh_offer_cust_type",
  "timestamp",
  "moh_allow_span",
  "moh_offer_on_nextbill",
  "moh_loyalty_card_must",
  "hq_timestamp_id",
  "moh_offer_on_eachitem",
  "moh_first_time_offer",
  "moh_offer_basedon_mrp",
  "moh_happy_hours_basedon",
  "moh_offer_on_itemuom",
  "moh_batch_offer",
  "moh_override_duplicate",
  "moh_block_return",
  "moh_cust_specific_offer",
  "moh_loyalty_point",
  "moh_offer_st_day",
  "moh_offer_end_day",
  "moh_offer_sales_period",
  "moh_offer_sales_st_dt",
  "moh_offer_sales_end_dt",
  "moh_allow_max_qty",
];

const PRODUCT_COLUMNS = [
  "mosp_offer_id",
  "mosp_sub_id",
  "mosp_category_id",
  "mosp_item_code",
  "ts",
  "tsid",
  "retail_outlet_id",
  "timestamp",
  "hq_timestamp_id",
];

const ISSUE_COLUMNS = [
  "moi_offer_id",
  "moi_offer_sl_no",
  "moi_offer_on",
  "moi_offer_satisfied",
  "moi_offer_type",
  "moi_item_code",
  "moi_offer_value",
  "moi_offer_extra_condition",
  "moi_offer_extra_condition_qty",
  "ts",
  "tsid",
  "retail_outlet_id",
  "timestamp",
  "hq_timestamp_id",
  "moi_conv_type",
  "moi_conv_factor",
  "moi_batch_no",
];

const HDR_UPDATE_ASSIGNMENTS = HDR_COLUMNS.filter(
  (c) => c !== "moh_offer_id" && c !== "retail_outlet_id"
)
  .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
  .join(", ");

const PRODUCT_UPDATE_ASSIGNMENTS = PRODUCT_COLUMNS.filter(
  (c) =>
    c !== "mosp_offer_id" &&
    c !== "mosp_item_code" &&
    c !== "retail_outlet_id"
)
  .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
  .join(", ");

const ISSUE_UPDATE_ASSIGNMENTS = ISSUE_COLUMNS.filter(
  (c) =>
    c !== "moi_offer_id" &&
    c !== "moi_offer_sl_no" &&
    c !== "retail_outlet_id"
)
  .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
  .join(", ");

const HDR_INSERT_SQL = `INSERT INTO \`${HDR_TABLE}\` (${HDR_COLUMNS.map((c) => `\`${c}\``).join(", ")})
VALUES ?
ON DUPLICATE KEY UPDATE ${HDR_UPDATE_ASSIGNMENTS}`;

const PRODUCT_INSERT_SQL = `INSERT INTO \`${PRODUCTS_TABLE}\` (${PRODUCT_COLUMNS.map((c) => `\`${c}\``).join(", ")})
VALUES ?
ON DUPLICATE KEY UPDATE ${PRODUCT_UPDATE_ASSIGNMENTS}`;

const ISSUE_INSERT_SQL = `INSERT INTO \`${ISSUE_TABLE}\` (${ISSUE_COLUMNS.map((c) => `\`${c}\``).join(", ")})
VALUES ?
ON DUPLICATE KEY UPDATE ${ISSUE_UPDATE_ASSIGNMENTS}`;

const LOOKUP_BATCH_SIZE = 1000;
const LIST_ALL_CAP = 50000;

const OFFER_HQ_ID_EXPR = "COALESCE(h.moh_offer_hq_id, h.moh_offer_id)";

const HDR_SORT_COLUMNS = {
  moh_offer_hq_id: "moh_offer_hq_id",
  moh_offer_name: "moh_offer_name",
  moh_offer_st_date: "moh_offer_st_date",
  moh_offer_end_date: "moh_offer_end_date",
  branch_count: "branch_count",
  product_count: "product_count",
};

const SENTINEL_NULL_DATE = "1900-01-01";

function branchIsActiveSql(alias = "h") {
  return `(
    ${alias}.moh_offer_status = 1
    AND (
      ${alias}.moh_offer_end_date IS NULL
      OR DATE(${alias}.moh_offer_end_date) = '${SENTINEL_NULL_DATE}'
      OR DATE(${alias}.moh_offer_end_date) >= CURDATE()
    )
  )`;
}

function statusWhereClause(status, alias = "h") {
  const active = branchIsActiveSql(alias);
  if (status === "inactive") {
    return `NOT ${active}`;
  }
  if (status === "active") {
    return active;
  }
  return "1=1";
}

function groupedStatusHavingClause(status) {
  const activeBranchCount = `SUM(CASE WHEN ${branchIsActiveSql("h")} THEN 1 ELSE 0 END)`;
  if (status === "inactive") {
    return `${activeBranchCount} = 0`;
  }
  if (status === "active") {
    return `${activeBranchCount} > 0`;
  }
  return "1=1";
}

function resolveSort(sortBy, sortDir) {
  const column = HDR_SORT_COLUMNS[sortBy] || HDR_SORT_COLUMNS.moh_offer_hq_id;
  const dir = String(sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return { column, dir };
}

function productCountSubquery() {
  return `(
    SELECT COUNT(*)
    FROM offer_products op
    WHERE op.mosp_offer_id = h.moh_offer_id
      AND op.retail_outlet_id = h.retail_outlet_id
  )`;
}

function buildHdrFilterWhere(filterModel = {}) {
  const clauses = [];
  const params = [];

  const idFilter = filterModel.moh_offer_hq_id;
  if (idFilter?.filter != null && String(idFilter.filter).trim() !== "") {
    const like = `%${String(idFilter.filter).trim()}%`;
    clauses.push(`CAST(${OFFER_HQ_ID_EXPR} AS CHAR) LIKE ?`);
    params.push(like);
  }

  const nameFilter = filterModel.moh_offer_name;
  if (nameFilter?.filter != null && String(nameFilter.filter).trim() !== "") {
    clauses.push("h.moh_offer_name LIKE ?");
    params.push(`%${String(nameFilter.filter).trim()}%`);
  }

  const branchFilter = filterModel.branch_name;
  if (branchFilter?.filter != null && String(branchFilter.filter).trim() !== "") {
    clauses.push("o.outlet_name LIKE ?");
    params.push(`%${String(branchFilter.filter).trim()}%`);
  }

  const countFilter = filterModel.product_count;
  if (countFilter?.filter != null && countFilter.filter !== "") {
    const n = Number(countFilter.filter);
    if (!Number.isNaN(n)) {
      const sub = productCountSubquery();
      const type = countFilter.type || "equals";
      if (type === "equals") {
        clauses.push(`${sub} = ?`);
        params.push(n);
      } else if (type === "greaterThan") {
        clauses.push(`${sub} > ?`);
        params.push(n);
      } else if (type === "lessThan") {
        clauses.push(`${sub} < ?`);
        params.push(n);
      } else if (type === "greaterThanOrEqual") {
        clauses.push(`${sub} >= ?`);
        params.push(n);
      } else if (type === "lessThanOrEqual") {
        clauses.push(`${sub} <= ?`);
        params.push(n);
      }
    }
  }

  const applyDateFilter = (column, filterDef) => {
    if (!filterDef) return;
    if (filterDef.type === "equals" && filterDef.filter) {
      clauses.push(`DATE(${column}) = DATE(?)`);
      params.push(filterDef.filter);
      return;
    }
    if (filterDef.type === "inRange") {
      if (filterDef.dateFrom) {
        clauses.push(`DATE(${column}) >= DATE(?)`);
        params.push(filterDef.dateFrom);
      }
      if (filterDef.dateTo) {
        clauses.push(`DATE(${column}) <= DATE(?)`);
        params.push(filterDef.dateTo);
      }
      return;
    }
    if (filterDef.type === "greaterThan" && filterDef.filter) {
      clauses.push(`DATE(${column}) > DATE(?)`);
      params.push(filterDef.filter);
      return;
    }
    if (filterDef.type === "lessThan" && filterDef.filter) {
      clauses.push(`DATE(${column}) < DATE(?)`);
      params.push(filterDef.filter);
    }
  };

  applyDateFilter("h.moh_offer_st_date", filterModel.moh_offer_st_date);
  applyDateFilter("h.moh_offer_end_date", filterModel.moh_offer_end_date);

  return {
    sql: clauses.length ? clauses.join(" AND ") : "1=1",
    params,
  };
}

function buildHdrRowFilterWhere(filterModel = {}) {
  const { product_count: _pc, branch_count: _bc, ...rowFilters } = filterModel;
  return buildHdrFilterWhere(rowFilters);
}

function buildGroupedAggregateWhere(filterModel = {}) {
  const clauses = [];
  const params = [];

  const applyNumberFilter = (column, filterDef) => {
    if (filterDef?.filter == null || filterDef.filter === "") return;
    const n = Number(filterDef.filter);
    if (Number.isNaN(n)) return;
    const type = filterDef.type || "equals";
    if (type === "equals") {
      clauses.push(`${column} = ?`);
      params.push(n);
    } else if (type === "greaterThan") {
      clauses.push(`${column} > ?`);
      params.push(n);
    } else if (type === "lessThan") {
      clauses.push(`${column} < ?`);
      params.push(n);
    } else if (type === "greaterThanOrEqual") {
      clauses.push(`${column} >= ?`);
      params.push(n);
    } else if (type === "lessThanOrEqual") {
      clauses.push(`${column} <= ?`);
      params.push(n);
    }
  };

  applyNumberFilter("product_count", filterModel.product_count);
  applyNumberFilter("branch_count", filterModel.branch_count);

  return {
    sql: clauses.length ? clauses.join(" AND ") : "1=1",
    params,
  };
}

function hdrGroupedListBaseSql(status, filterModel = {}) {
  const { sql: filterSql, params: filterParams } = buildHdrRowFilterWhere(filterModel);
  const { sql: aggregateSql, params: aggregateParams } = buildGroupedAggregateWhere(
    filterModel
  );
  const branchProductCount = productCountSubquery();
  return {
    sql: `
      SELECT * FROM (
        SELECT
          ${OFFER_HQ_ID_EXPR} AS moh_offer_hq_id,
          MAX(h.moh_offer_name) AS moh_offer_name,
          MAX(h.moh_offer_status) AS moh_offer_status,
          MIN(h.moh_offer_st_date) AS moh_offer_st_date,
          MAX(h.moh_offer_end_date) AS moh_offer_end_date,
          COUNT(DISTINCT h.retail_outlet_id) AS branch_count,
          SUM(${branchProductCount}) AS product_count,
          SUM(CASE WHEN ${branchIsActiveSql("h")} THEN 1 ELSE 0 END) AS active_branch_count
        FROM offer_hdr h
        INNER JOIN outlets o ON o.outlet_id = h.retail_outlet_id
        WHERE (${filterSql})
        GROUP BY ${OFFER_HQ_ID_EXPR}
        HAVING ${groupedStatusHavingClause(status)}
      ) grouped
      WHERE (${aggregateSql})
    `,
    params: [...filterParams, ...aggregateParams],
  };
}

function hdrListBaseSql(status, filterModel = {}) {
  const { sql: filterSql, params: filterParams } = buildHdrFilterWhere(filterModel);
  return {
    sql: `
    SELECT
      h.moh_offer_id,
      h.moh_offer_name,
      h.moh_offer_status,
      h.moh_offer_st_date,
      h.moh_offer_end_date,
      ${OFFER_HQ_ID_EXPR} AS moh_offer_hq_id,
      h.retail_outlet_id,
      o.outlet_name AS branch_name,
      ${productCountSubquery()} AS product_count
    FROM offer_hdr h
    INNER JOIN outlets o ON o.outlet_id = h.retail_outlet_id
    WHERE ${statusWhereClause(status)} AND (${filterSql})
  `,
    params: filterParams,
  };
}

const PRODUCT_LINE_SORT_COLUMNS = {
  moh_offer_hq_id: OFFER_HQ_ID_EXPR,
  moh_offer_name: "h.moh_offer_name",
  product_id: "op.mosp_item_code",
  de_name: "pt.de_name",
  moi_offer_on: "oi.moi_offer_on",
  moi_offer_value: "oi.moi_offer_value",
};

function resolveProductLineSort(sortBy, sortDir) {
  const column =
    PRODUCT_LINE_SORT_COLUMNS[sortBy] || PRODUCT_LINE_SORT_COLUMNS.moh_offer_hq_id;
  const dir = String(sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return { column, dir };
}

function productImageSubquery() {
  return `(
    SELECT image_url
    FROM product_images pi
    WHERE pi.product_id = op.mosp_item_code
    ORDER BY pi.priority ASC, pi.image_id ASC
    LIMIT 1
  )`;
}

function buildProductLineFilterWhere(filterModel = {}) {
  const clauses = [];
  const params = [];

  const offerIdFilter = filterModel.moh_offer_hq_id;
  if (offerIdFilter?.filter != null && String(offerIdFilter.filter).trim() !== "") {
    const like = `%${String(offerIdFilter.filter).trim()}%`;
    clauses.push(`CAST(${OFFER_HQ_ID_EXPR} AS CHAR) LIKE ?`);
    params.push(like);
  }

  const offerNameFilter = filterModel.moh_offer_name;
  if (offerNameFilter?.filter != null && String(offerNameFilter.filter).trim() !== "") {
    clauses.push("h.moh_offer_name LIKE ?");
    params.push(`%${String(offerNameFilter.filter).trim()}%`);
  }

  const productIdFilter = filterModel.product_id;
  if (productIdFilter?.filter != null && String(productIdFilter.filter).trim() !== "") {
    clauses.push("CAST(op.mosp_item_code AS CHAR) LIKE ?");
    params.push(`%${String(productIdFilter.filter).trim()}%`);
  }

  const productNameFilter = filterModel.de_name;
  if (productNameFilter?.filter != null && String(productNameFilter.filter).trim() !== "") {
    clauses.push("pt.de_name LIKE ?");
    params.push(`%${String(productNameFilter.filter).trim()}%`);
  }

  const offerOnFilter = filterModel.moi_offer_on;
  if (offerOnFilter?.filter != null && String(offerOnFilter.filter).trim() !== "") {
    clauses.push("oi.moi_offer_on LIKE ?");
    params.push(`%${String(offerOnFilter.filter).trim()}%`);
  }

  const offerValueFilter = filterModel.moi_offer_value;
  if (offerValueFilter?.filter != null && offerValueFilter.filter !== "") {
    const n = Number(offerValueFilter.filter);
    if (!Number.isNaN(n)) {
      const type = offerValueFilter.type || "equals";
      if (type === "equals") {
        clauses.push("oi.moi_offer_value = ?");
        params.push(n);
      } else if (type === "greaterThan") {
        clauses.push("oi.moi_offer_value > ?");
        params.push(n);
      } else if (type === "lessThan") {
        clauses.push("oi.moi_offer_value < ?");
        params.push(n);
      } else if (type === "greaterThanOrEqual") {
        clauses.push("oi.moi_offer_value >= ?");
        params.push(n);
      } else if (type === "lessThanOrEqual") {
        clauses.push("oi.moi_offer_value <= ?");
        params.push(n);
      }
    }
  }

  return {
    sql: clauses.length ? clauses.join(" AND ") : "1=1",
    params,
  };
}

function productLinesListBaseSql(status, filterModel = {}) {
  const { sql: filterSql, params: filterParams } = buildProductLineFilterWhere(
    filterModel
  );
  return {
    sql: `
    SELECT
      h.moh_offer_id,
      h.retail_outlet_id,
      ${OFFER_HQ_ID_EXPR} AS moh_offer_hq_id,
      h.moh_offer_name,
      op.mosp_item_code AS product_id,
      pt.de_name,
      ${productImageSubquery()} AS image_url,
      oi.moi_offer_on,
      oi.moi_offer_value
    FROM offer_issue oi
    INNER JOIN offer_products op
      ON oi.moi_offer_id = op.mosp_offer_id
     AND oi.moi_item_code = op.mosp_item_code
     AND oi.retail_outlet_id = op.retail_outlet_id
    INNER JOIN offer_hdr h
      ON h.moh_offer_id = oi.moi_offer_id
     AND h.retail_outlet_id = oi.retail_outlet_id
    LEFT JOIN product_table pt ON pt.product_id = op.mosp_item_code
    WHERE ${statusWhereClause(status)} AND (${filterSql})
  `,
    params: filterParams,
  };
}

function offerHdrKey(offerId, outletId) {
  return `${offerId}:${outletId}`;
}

function offerProductLineKey(offerId, itemCode, outletId) {
  return `${offerId}:${itemCode}:${outletId}`;
}

function rowToHdrTuple(row) {
  return HDR_COLUMNS.map((col) => row[col]);
}

function rowToProductTuple(row) {
  return PRODUCT_COLUMNS.map((col) => row[col]);
}

function rowToIssueTuple(row) {
  return ISSUE_COLUMNS.map((col) => row[col]);
}

function logError(code, description, ref = {}) {
  logger.Log({
    level: logger.LEVEL.ERROR,
    component: "REPOSITORY.HQ_OFFERS",
    code,
    description,
    category: "",
    ref,
  });
}

function queryAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.query(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function queryInBatches(db, buildSql, values, batchSize = LOOKUP_BATCH_SIZE) {
  const result = [];
  for (let i = 0; i < values.length; i += batchSize) {
    const chunk = values.slice(i, i + batchSize);
    if (!chunk.length) continue;
    const rows = await queryAsync(db, buildSql(chunk), chunk.flat());
    result.push(...(rows || []));
  }
  return result;
}

class HqOffersRepository {
  constructor(db) {
    this.db = db;
  }

  async resolveValidOutletIds(outletIds) {
    const valid = new Set();
    const unique = [...new Set(outletIds.filter((id) => id != null))];
    if (!unique.length) return valid;

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "?").join(", ");
        return `SELECT outlet_id FROM outlets WHERE outlet_id IN (${ph})`;
      },
      unique
    );

    for (const row of rows) {
      valid.add(row.outlet_id);
    }
    return valid;
  }

  async resolveValidProductIds(productIds) {
    const valid = new Set();
    const unique = [...new Set(productIds.filter((id) => id != null))];
    if (!unique.length) return valid;

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "?").join(", ");
        return `SELECT product_id FROM product_table WHERE product_id IN (${ph})`;
      },
      unique
    );

    for (const row of rows) {
      valid.add(row.product_id);
    }
    return valid;
  }

  async resolveValidOfferHdrKeys(keys) {
    const valid = new Set();
    const unique = [];
    const seen = new Set();

    for (const key of keys) {
      const token = offerHdrKey(key.moh_offer_id, key.retail_outlet_id);
      if (seen.has(token)) continue;
      seen.add(token);
      unique.push(key);
    }

    if (!unique.length) return valid;

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "(?, ?)").join(", ");
        return `SELECT moh_offer_id, retail_outlet_id FROM offer_hdr WHERE (moh_offer_id, retail_outlet_id) IN (${ph})`;
      },
      unique.map((k) => [k.moh_offer_id, k.retail_outlet_id])
    );

    for (const row of rows) {
      valid.add(offerHdrKey(row.moh_offer_id, row.retail_outlet_id));
    }
    return valid;
  }

  async resolveValidOfferProductLineKeys(keys) {
    const valid = new Set();
    const unique = [];
    const seen = new Set();

    for (const key of keys) {
      const token = offerProductLineKey(
        key.mosp_offer_id,
        key.mosp_item_code,
        key.retail_outlet_id
      );
      if (seen.has(token)) continue;
      seen.add(token);
      unique.push(key);
    }

    if (!unique.length) return valid;

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "(?, ?, ?)").join(", ");
        return `SELECT mosp_offer_id, mosp_item_code, retail_outlet_id
          FROM offer_products
          WHERE (mosp_offer_id, mosp_item_code, retail_outlet_id) IN (${ph})`;
      },
      unique.map((k) => [k.mosp_offer_id, k.mosp_item_code, k.retail_outlet_id])
    );

    for (const row of rows) {
      valid.add(
        offerProductLineKey(
          row.mosp_offer_id,
          row.mosp_item_code,
          row.retail_outlet_id
        )
      );
    }
    return valid;
  }

  async countHdr({ status = "active", filterModel = {} } = {}) {
    const { sql: baseSql, params: filterParams } = hdrGroupedListBaseSql(
      status,
      filterModel
    );
    const rows = await queryAsync(
      this.db,
      `SELECT COUNT(*) AS total FROM (${baseSql}) AS filtered_hdr`,
      filterParams
    );
    return rows?.[0]?.total ?? 0;
  }

  async listHdr({
    limit = 20,
    offset = 0,
    sortBy = "moh_offer_hq_id",
    sortDir = "desc",
    status = "active",
    filterModel = {},
  } = {}) {
    const { column, dir } = resolveSort(sortBy, sortDir);
    const { sql: baseSql, params: filterParams } = hdrGroupedListBaseSql(
      status,
      filterModel
    );
    const sql = `${baseSql}
      ORDER BY ${column} ${dir}
      LIMIT ? OFFSET ?`;
    return queryAsync(this.db, sql, [...filterParams, limit, offset]);
  }

  async listHdrAll({
    sortBy = "moh_offer_hq_id",
    sortDir = "desc",
    status = "active",
    filterModel = {},
  } = {}) {
    const { column, dir } = resolveSort(sortBy, sortDir);
    const { sql: baseSql, params: filterParams } = hdrGroupedListBaseSql(
      status,
      filterModel
    );
    const sql = `${baseSql}
      ORDER BY ${column} ${dir}
      LIMIT ?`;
    return queryAsync(this.db, sql, [...filterParams, LIST_ALL_CAP]);
  }

  async listHdrByOfferHqId(moh_offer_hq_id) {
    const { sql: baseSql, params: filterParams } = hdrListBaseSql("all");
    return queryAsync(
      this.db,
      `${baseSql}
        AND ${OFFER_HQ_ID_EXPR} = ?
      ORDER BY o.outlet_name ASC`,
      [...filterParams, moh_offer_hq_id]
    );
  }

  async listOfferLinesByOfferHqId(moh_offer_hq_id) {
    return queryAsync(
      this.db,
      `SELECT
        oi.retail_outlet_id,
        op.mosp_item_code AS product_id,
        pt.de_name,
        (
          SELECT image_url
          FROM product_images pi
          WHERE pi.product_id = op.mosp_item_code
          ORDER BY pi.priority ASC, pi.image_id ASC
          LIMIT 1
        ) AS image_url,
        oi.moi_offer_on,
        oi.moi_offer_value
      FROM offer_issue oi
      INNER JOIN offer_products op
        ON oi.moi_offer_id = op.mosp_offer_id
       AND oi.moi_item_code = op.mosp_item_code
       AND oi.retail_outlet_id = op.retail_outlet_id
      INNER JOIN offer_hdr h
        ON h.moh_offer_id = oi.moi_offer_id
       AND h.retail_outlet_id = oi.retail_outlet_id
      LEFT JOIN product_table pt ON pt.product_id = op.mosp_item_code
      WHERE ${OFFER_HQ_ID_EXPR} = ?
      ORDER BY oi.retail_outlet_id ASC, op.mosp_item_code ASC`,
      [moh_offer_hq_id]
    );
  }

  async getHdrByKey(moh_offer_id, retail_outlet_id) {
    const { sql: baseSql, params: filterParams } = hdrListBaseSql("all");
    const rows = await queryAsync(
      this.db,
      `${baseSql}
        AND h.moh_offer_id = ?
        AND h.retail_outlet_id = ?
      LIMIT 1`,
      [...filterParams, moh_offer_id, retail_outlet_id]
    );
    return rows?.[0] ?? null;
  }

  async listOfferLinesByKey(moh_offer_id, retail_outlet_id) {
    return queryAsync(
      this.db,
      `SELECT
        op.mosp_item_code AS product_id,
        pt.de_name,
        (
          SELECT image_url
          FROM product_images pi
          WHERE pi.product_id = op.mosp_item_code
          ORDER BY pi.priority ASC, pi.image_id ASC
          LIMIT 1
        ) AS image_url,
        oi.moi_offer_on,
        oi.moi_offer_value
      FROM offer_issue oi
      INNER JOIN offer_products op
        ON oi.moi_offer_id = op.mosp_offer_id
       AND oi.moi_item_code = op.mosp_item_code
       AND oi.retail_outlet_id = op.retail_outlet_id
      LEFT JOIN product_table pt ON pt.product_id = op.mosp_item_code
      WHERE oi.moi_offer_id = ?
        AND oi.retail_outlet_id = ?
      ORDER BY op.mosp_item_code ASC`,
      [moh_offer_id, retail_outlet_id]
    );
  }

  async countProductLines({ status = "active", filterModel = {} } = {}) {
    const { sql: baseSql, params: filterParams } = productLinesListBaseSql(
      status,
      filterModel
    );
    const rows = await queryAsync(
      this.db,
      `SELECT COUNT(*) AS total FROM (${baseSql}) AS filtered_lines`,
      filterParams
    );
    return rows?.[0]?.total ?? 0;
  }

  async listProductLines({
    limit = 20,
    offset = 0,
    sortBy = "moh_offer_hq_id",
    sortDir = "desc",
    status = "active",
    filterModel = {},
  } = {}) {
    const { column, dir } = resolveProductLineSort(sortBy, sortDir);
    const { sql: baseSql, params: filterParams } = productLinesListBaseSql(
      status,
      filterModel
    );
    const sql = `${baseSql}
      ORDER BY ${column} ${dir}
      LIMIT ? OFFSET ?`;
    return queryAsync(this.db, sql, [...filterParams, limit, offset]);
  }

  async listProductLinesAll({
    sortBy = "moh_offer_hq_id",
    sortDir = "desc",
    status = "active",
    filterModel = {},
  } = {}) {
    const { column, dir } = resolveProductLineSort(sortBy, sortDir);
    const { sql: baseSql, params: filterParams } = productLinesListBaseSql(
      status,
      filterModel
    );
    const sql = `${baseSql}
      ORDER BY ${column} ${dir}
      LIMIT ?`;
    return queryAsync(this.db, sql, [...filterParams, LIST_ALL_CAP]);
  }

  insertHdr(row) {
    return new Promise((resolve, reject) => {
      const placeholders = HDR_COLUMNS.map(() => "?").join(", ");
      const sql = `INSERT INTO \`${HDR_TABLE}\` (${HDR_COLUMNS.map((c) => `\`${c}\``).join(", ")})
        VALUES (${placeholders})
        ON DUPLICATE KEY UPDATE ${HDR_UPDATE_ASSIGNMENTS}`;

      this.db.query(sql, rowToHdrTuple(row), (err, result) => {
        if (err) {
          logError("REPOSITORY.HQ_OFFERS.INSERT_HDR", err.toString());
          return reject(err);
        }
        resolve({ code: 200, affectedRows: result.affectedRows });
      });
    });
  }

  bulkInsertHdr(rows) {
    return new Promise(async (resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, inserted: 0 });
        return;
      }

      let connection;
      try {
        connection = await getConnectionAsync(this.db);
        const tuples = rows.map(rowToHdrTuple);
        await insertRowsInBatches(connection, HDR_INSERT_SQL, tuples);
        connection.release();
        resolve({ code: 200, inserted: rows.length });
      } catch (err) {
        if (connection) connection.release();
        logError("REPOSITORY.HQ_OFFERS.BULK_INSERT_HDR", err.toString());
        reject(err);
      }
    });
  }

  insertProduct(row) {
    return new Promise((resolve, reject) => {
      const placeholders = PRODUCT_COLUMNS.map(() => "?").join(", ");
      const sql = `INSERT INTO \`${PRODUCTS_TABLE}\` (${PRODUCT_COLUMNS.map((c) => `\`${c}\``).join(", ")})
        VALUES (${placeholders})
        ON DUPLICATE KEY UPDATE ${PRODUCT_UPDATE_ASSIGNMENTS}`;

      this.db.query(sql, rowToProductTuple(row), (err, result) => {
        if (err) {
          logError("REPOSITORY.HQ_OFFERS.INSERT_PRODUCT", err.toString());
          return reject(err);
        }
        resolve({ code: 200, affectedRows: result.affectedRows });
      });
    });
  }

  bulkInsertProducts(rows) {
    return new Promise(async (resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, inserted: 0 });
        return;
      }

      let connection;
      try {
        connection = await getConnectionAsync(this.db);
        const tuples = rows.map(rowToProductTuple);
        await insertRowsInBatches(connection, PRODUCT_INSERT_SQL, tuples);
        connection.release();
        resolve({ code: 200, inserted: rows.length });
      } catch (err) {
        if (connection) connection.release();
        logError("REPOSITORY.HQ_OFFERS.BULK_INSERT_PRODUCTS", err.toString());
        reject(err);
      }
    });
  }

  insertIssue(row) {
    return new Promise((resolve, reject) => {
      const placeholders = ISSUE_COLUMNS.map(() => "?").join(", ");
      const sql = `INSERT INTO \`${ISSUE_TABLE}\` (${ISSUE_COLUMNS.map((c) => `\`${c}\``).join(", ")})
        VALUES (${placeholders})
        ON DUPLICATE KEY UPDATE ${ISSUE_UPDATE_ASSIGNMENTS}`;

      this.db.query(sql, rowToIssueTuple(row), (err, result) => {
        if (err) {
          logError("REPOSITORY.HQ_OFFERS.INSERT_ISSUE", err.toString());
          return reject(err);
        }
        resolve({ code: 200, affectedRows: result.affectedRows });
      });
    });
  }

  bulkInsertIssues(rows) {
    return new Promise(async (resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ code: 200, inserted: 0 });
        return;
      }

      let connection;
      try {
        connection = await getConnectionAsync(this.db);
        const tuples = rows.map(rowToIssueTuple);
        await insertRowsInBatches(connection, ISSUE_INSERT_SQL, tuples);
        connection.release();
        resolve({ code: 200, inserted: rows.length });
      } catch (err) {
        if (connection) connection.release();
        logError("REPOSITORY.HQ_OFFERS.BULK_INSERT_ISSUES", err.toString());
        reject(err);
      }
    });
  }
}

module.exports = (db) => {
  return new HqOffersRepository(db);
};
