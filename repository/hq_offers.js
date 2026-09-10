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

const EXCLUDED_RETAIL_OUTLET_IDS = [2];

function excludedRetailOutletWhereClause(alias = "h") {
  return EXCLUDED_RETAIL_OUTLET_IDS.map(
    (outletId) => `${alias}.retail_outlet_id != ${Number(outletId)}`
  ).join(" AND ");
}

const HDR_SORT_COLUMNS = {
  moh_offer_hq_id: "moh_offer_hq_id",
  moh_offer_name: "moh_offer_name",
  moh_offer_st_date: "moh_offer_st_date",
  moh_offer_end_date: "moh_offer_end_date",
  branch_count: "branch_count",
  product_count: "product_count",
};

const SENTINEL_NULL_DATE = "1900-01-01";

function realEndDateExpr(alias = "h") {
  return `CASE
    WHEN ${alias}.moh_offer_end_date IS NOT NULL
     AND DATE(${alias}.moh_offer_end_date) != '${SENTINEL_NULL_DATE}'
    THEN ${alias}.moh_offer_end_date
  END`;
}

function groupedHasNullEndDateSql() {
  return `SUM(CASE
    WHEN h.moh_offer_end_date IS NULL OR DATE(h.moh_offer_end_date) = '${SENTINEL_NULL_DATE}'
    THEN 1 ELSE 0 END) > 0`;
}

function groupedEffectiveEndDateSql() {
  const realEnd = realEndDateExpr("h");
  return `CASE
    WHEN ${groupedHasNullEndDateSql()}
    THEN MIN(${realEnd})
    ELSE MAX(${realEnd})
  END`;
}

function groupedOfferIsActiveSql() {
  const effectiveEnd = groupedEffectiveEndDateSql();
  return `(
    MAX(h.moh_offer_status) = 1
    AND (
      MIN(h.moh_offer_st_date) IS NULL
      OR DATE(MIN(h.moh_offer_st_date)) = '${SENTINEL_NULL_DATE}'
      OR DATE(MIN(h.moh_offer_st_date)) <= CURDATE()
    )
    AND (
      ${effectiveEnd} IS NULL
      OR DATE(${effectiveEnd}) >= CURDATE()
    )
  )`;
}

function branchIsActiveSql(alias = "h") {
  return `(
    ${alias}.moh_offer_status = 1
    AND (
      ${alias}.moh_offer_st_date IS NULL
      OR DATE(${alias}.moh_offer_st_date) = '${SENTINEL_NULL_DATE}'
      OR DATE(${alias}.moh_offer_st_date) <= CURDATE()
    )
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
  const offerActive = groupedOfferIsActiveSql();
  if (status === "inactive") {
    return `NOT (${offerActive})`;
  }
  if (status === "active") {
    return offerActive;
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
    SELECT COUNT(DISTINCT op.mosp_item_code)
    FROM offer_products op
    WHERE op.mosp_offer_id = h.moh_offer_id
      AND op.retail_outlet_id = h.retail_outlet_id
  )`;
}

function offerIssueToProductJoinSql(opAlias = "op", oiAlias = "oi") {
  return `(
    (${oiAlias}.moi_item_code IS NOT NULL AND ${oiAlias}.moi_item_code = ${opAlias}.mosp_item_code)
    OR ${oiAlias}.moi_offer_sl_no = ${opAlias}.mosp_sub_id
  )`;
}

function productDistributorNameExpr() {
  return "COALESCE(pdm.mdm_dist_name, pt.de_distributor)";
}

function productBuyerNameExpr() {
  return "COALESCE(ne.employee_name, pt.buyer_name)";
}

const OFFER_TYPE_LABEL_TO_ID = {
  Percentage: 1,
  Value: 4,
  "2": 2,
  "3": 3,
};

function resolveOfferTypeIdsFromFilter(filterDef) {
  if (
    !filterDef ||
    filterDef.filterType !== "badge" ||
    !Array.isArray(filterDef.values) ||
    filterDef.values.length === 0
  ) {
    return null;
  }
  const ids = filterDef.values
    .map((label) => OFFER_TYPE_LABEL_TO_ID[label])
    .filter((id) => id != null);
  return ids.length ? ids : null;
}

function productEnrichmentJoinsSql() {
  return `
    LEFT JOIN product_distributor_master pdm ON pt.distributor_id = pdm.cid
    LEFT JOIN product_distributor pd_map ON pd_map.cid = pt.distributor_id
    LEFT JOIN new_employee ne ON ne.employee_id = pd_map.buyer_id
  `;
}

function resolveProductLineGroupBy(groupBy) {
  if (groupBy === "distributor") {
    return `${productDistributorNameExpr()}, ${OFFER_HQ_ID_EXPR}, op.mosp_item_code`;
  }
  if (groupBy === "buyer") {
    return `${productBuyerNameExpr()}, ${OFFER_HQ_ID_EXPR}, op.mosp_item_code`;
  }
  return `${OFFER_HQ_ID_EXPR}, op.mosp_item_code`;
}

function offerProductLinesSelectSql({ hqIdFilter = null, groupByBranch = false } = {}) {
  const hqFilterSql = hqIdFilter ? `AND ${hqIdFilter}` : "";
  const outletFilterSql = excludedRetailOutletWhereClause("h");
  const imageSql = `(
    SELECT image_url
    FROM product_images pi
    WHERE pi.product_id = op.mosp_item_code
    ORDER BY pi.priority ASC, pi.image_id ASC
    LIMIT 1
  )`;

  if (groupByBranch) {
    return `
      SELECT
        op.retail_outlet_id,
        op.mosp_item_code AS product_id,
        MAX(pt.de_name) AS de_name,
        MAX(${imageSql}) AS image_url,
        MAX(oi.moi_offer_on) AS moi_offer_on,
        MAX(oi.moi_offer_value) AS moi_offer_value,
        MAX(oi.moi_offer_type) AS moi_offer_type,
        MAX(${productDistributorNameExpr()}) AS distributor_name,
        MAX(${productBuyerNameExpr()}) AS buyer_name
      FROM offer_products op
      INNER JOIN offer_hdr h
        ON h.moh_offer_id = op.mosp_offer_id
       AND h.retail_outlet_id = op.retail_outlet_id
      LEFT JOIN offer_issue oi
        ON oi.moi_offer_id = op.mosp_offer_id
       AND oi.retail_outlet_id = op.retail_outlet_id
       AND ${offerIssueToProductJoinSql("op", "oi")}
      LEFT JOIN product_table pt ON pt.product_id = op.mosp_item_code
      ${productEnrichmentJoinsSql()}
      WHERE ${outletFilterSql} ${hqFilterSql}
      GROUP BY op.retail_outlet_id, op.mosp_item_code
    `;
  }

  return `
    SELECT
      op.retail_outlet_id,
      op.mosp_item_code AS product_id,
      pt.de_name,
      ${imageSql} AS image_url,
      oi.moi_offer_on,
      oi.moi_offer_value,
      oi.moi_offer_type,
      ${productDistributorNameExpr()} AS distributor_name,
      ${productBuyerNameExpr()} AS buyer_name
    FROM offer_products op
    INNER JOIN offer_hdr h
      ON h.moh_offer_id = op.mosp_offer_id
     AND h.retail_outlet_id = op.retail_outlet_id
    LEFT JOIN offer_issue oi
      ON oi.moi_offer_id = op.mosp_offer_id
     AND oi.retail_outlet_id = op.retail_outlet_id
     AND ${offerIssueToProductJoinSql("op", "oi")}
    LEFT JOIN product_table pt ON pt.product_id = op.mosp_item_code
    ${productEnrichmentJoinsSql()}
    WHERE ${outletFilterSql} ${hqFilterSql}
  `;
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
  return {
    sql: `
      SELECT * FROM (
        SELECT
          ${OFFER_HQ_ID_EXPR} AS moh_offer_hq_id,
          MAX(h.moh_offer_name) AS moh_offer_name,
          MAX(h.moh_offer_status) AS moh_offer_status,
          MIN(h.moh_offer_st_date) AS moh_offer_st_date,
          ${groupedEffectiveEndDateSql()} AS moh_offer_end_date,
          COUNT(DISTINCT h.retail_outlet_id) AS branch_count,
          COUNT(DISTINCT op.mosp_item_code) AS product_count
        FROM offer_hdr h
        INNER JOIN outlets o ON o.outlet_id = h.retail_outlet_id
        LEFT JOIN offer_products op
          ON op.mosp_offer_id = h.moh_offer_id
         AND op.retail_outlet_id = h.retail_outlet_id
        WHERE ${excludedRetailOutletWhereClause("h")} AND (${filterSql})
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
    WHERE ${excludedRetailOutletWhereClause("h")} AND ${statusWhereClause(status)} AND (${filterSql})
  `,
    params: filterParams,
  };
}

const PRODUCT_LINE_SORT_COLUMNS = {
  moh_offer_hq_id: "moh_offer_hq_id",
  moh_offer_name: "moh_offer_name",
  product_id: "product_id",
  de_name: "de_name",
  moi_offer_on: "moi_offer_on",
  moi_offer_value: "moi_offer_value",
  moi_offer_type: "moi_offer_type",
  distributor_name: "distributor_name",
  buyer_name: "buyer_name",
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

  const distributorFilter = filterModel.distributor_name;
  if (
    distributorFilter?.filter != null &&
    String(distributorFilter.filter).trim() !== ""
  ) {
    const distValue = String(distributorFilter.filter).trim();
    const distType = distributorFilter.type || "contains";
    if (distType === "equals") {
      clauses.push(`${productDistributorNameExpr()} = ?`);
      params.push(distValue);
    } else {
      clauses.push(`${productDistributorNameExpr()} LIKE ?`);
      params.push(`%${distValue}%`);
    }
  }

  const buyerFilter = filterModel.buyer_name;
  if (buyerFilter?.filter != null && String(buyerFilter.filter).trim() !== "") {
    const buyerValue = String(buyerFilter.filter).trim();
    const buyerType = buyerFilter.type || "contains";
    if (buyerType === "equals") {
      clauses.push(`${productBuyerNameExpr()} = ?`);
      params.push(buyerValue);
    } else {
      clauses.push(`${productBuyerNameExpr()} LIKE ?`);
      params.push(`%${buyerValue}%`);
    }
  }

  const offerTypeFilter = filterModel.moi_offer_type;
  const offerTypeIds = resolveOfferTypeIdsFromFilter(offerTypeFilter);
  if (offerTypeIds) {
    clauses.push(`oi.moi_offer_type IN (${offerTypeIds.map(() => "?").join(", ")})`);
    params.push(...offerTypeIds);
  }

  return {
    sql: clauses.length ? clauses.join(" AND ") : "1=1",
    params,
  };
}

function resolveProductGroupExpr(groupBy) {
  return groupBy === "buyer" ? productBuyerNameExpr() : productDistributorNameExpr();
}

function resolveProductGroupNameField(groupBy) {
  return groupBy === "buyer" ? "buyer_name" : "distributor_name";
}

function buildProductGroupAggregateWhere(groupBy, filterModel = {}) {
  const clauses = [];
  const params = [];
  const nameField = resolveProductGroupNameField(groupBy);

  const nameFilter = filterModel[nameField];
  if (nameFilter?.filter != null && String(nameFilter.filter).trim() !== "") {
    clauses.push(`${nameField} LIKE ?`);
    params.push(`%${String(nameFilter.filter).trim()}%`);
  }

  const countFilter = filterModel.product_count;
  if (countFilter?.filter != null && countFilter.filter !== "") {
    const n = Number(countFilter.filter);
    if (!Number.isNaN(n)) {
      const type = countFilter.type || "equals";
      if (type === "equals") {
        clauses.push("product_count = ?");
        params.push(n);
      } else if (type === "greaterThan") {
        clauses.push("product_count > ?");
        params.push(n);
      } else if (type === "lessThan") {
        clauses.push("product_count < ?");
        params.push(n);
      } else if (type === "greaterThanOrEqual") {
        clauses.push("product_count >= ?");
        params.push(n);
      } else if (type === "lessThanOrEqual") {
        clauses.push("product_count <= ?");
        params.push(n);
      }
    }
  }

  return {
    sql: clauses.length ? clauses.join(" AND ") : "1=1",
    params,
  };
}

const PRODUCT_GROUP_SORT_COLUMNS = {
  distributor_name: "distributor_name",
  buyer_name: "buyer_name",
  product_count: "product_count",
};

function resolveProductGroupSort(groupBy, sortBy, sortDir) {
  const nameField = resolveProductGroupNameField(groupBy);
  const column =
    PRODUCT_GROUP_SORT_COLUMNS[sortBy] ||
    (groupBy === "buyer"
      ? PRODUCT_GROUP_SORT_COLUMNS.buyer_name
      : PRODUCT_GROUP_SORT_COLUMNS.distributor_name);
  const safeColumn = column === nameField || column === "product_count" ? column : nameField;
  const dir = String(sortDir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  return { column: safeColumn, dir };
}

function productGroupsListBaseSql(status, groupBy, filterModel = {}) {
  const groupExpr = resolveProductGroupExpr(groupBy);
  const nameAlias = resolveProductGroupNameField(groupBy);
  const { sql: aggregateSql, params: aggregateParams } = buildProductGroupAggregateWhere(
    groupBy,
    filterModel
  );

  return {
    sql: `
      SELECT * FROM (
        SELECT
          ${groupExpr} AS ${nameAlias},
          COUNT(DISTINCT CONCAT(${OFFER_HQ_ID_EXPR}, ':', op.mosp_item_code)) AS product_count
        FROM offer_products op
        INNER JOIN offer_hdr h
          ON h.moh_offer_id = op.mosp_offer_id
         AND h.retail_outlet_id = op.retail_outlet_id
        LEFT JOIN offer_issue oi
          ON oi.moi_offer_id = op.mosp_offer_id
         AND oi.retail_outlet_id = op.retail_outlet_id
         AND ${offerIssueToProductJoinSql("op", "oi")}
        LEFT JOIN product_table pt ON pt.product_id = op.mosp_item_code
        ${productEnrichmentJoinsSql()}
        WHERE ${excludedRetailOutletWhereClause("h")} AND ${statusWhereClause(status, "h")}
        GROUP BY ${groupExpr}
      ) grouped
      WHERE (${aggregateSql})
    `,
    params: aggregateParams,
  };
}

function productLinesListBaseSql(status, filterModel = {}, groupBy = null) {
  const { sql: filterSql, params: filterParams } = buildProductLineFilterWhere(
    filterModel
  );
  const imageSql = productImageSubquery();
  const groupBySql = resolveProductLineGroupBy(groupBy);
  return {
    sql: `
    SELECT
      ${OFFER_HQ_ID_EXPR} AS moh_offer_hq_id,
      MAX(h.moh_offer_name) AS moh_offer_name,
      op.mosp_item_code AS product_id,
      MAX(pt.de_name) AS de_name,
      MAX(${imageSql}) AS image_url,
      MAX(oi.moi_offer_on) AS moi_offer_on,
      MAX(oi.moi_offer_value) AS moi_offer_value,
      MAX(oi.moi_offer_type) AS moi_offer_type,
      MAX(${productDistributorNameExpr()}) AS distributor_name,
      MAX(${productBuyerNameExpr()}) AS buyer_name
    FROM offer_products op
    INNER JOIN offer_hdr h
      ON h.moh_offer_id = op.mosp_offer_id
     AND h.retail_outlet_id = op.retail_outlet_id
    LEFT JOIN offer_issue oi
      ON oi.moi_offer_id = op.mosp_offer_id
     AND oi.retail_outlet_id = op.retail_outlet_id
     AND ${offerIssueToProductJoinSql("op", "oi")}
    LEFT JOIN product_table pt ON pt.product_id = op.mosp_item_code
    ${productEnrichmentJoinsSql()}
    WHERE ${excludedRetailOutletWhereClause("h")} AND ${statusWhereClause(status, "h")} AND (${filterSql})
    GROUP BY ${groupBySql}
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
      `${offerProductLinesSelectSql({
        hqIdFilter: `${OFFER_HQ_ID_EXPR} = ?`,
        groupByBranch: true,
      })}
      ORDER BY op.retail_outlet_id ASC, op.mosp_item_code ASC`,
      [moh_offer_hq_id]
    );
  }

  async listActiveOfferProductIds(productIds) {
    if (!Array.isArray(productIds) || !productIds.length) return [];

    const numericIds = [
      ...new Set(
        productIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      ),
    ];
    if (!numericIds.length) return [];

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "?").join(", ");
        return `
          SELECT DISTINCT op.mosp_item_code AS product_id
          FROM offer_products op
          INNER JOIN offer_hdr h
            ON h.moh_offer_id = op.mosp_offer_id
           AND h.retail_outlet_id = op.retail_outlet_id
          WHERE ${excludedRetailOutletWhereClause("h")}
            AND ${statusWhereClause("active", "h")}
            AND op.mosp_item_code IN (${ph})
        `;
      },
      numericIds
    );

    return (rows || []).map((row) => String(row.product_id));
  }

  // Bulk variant of listActiveOfferProductIds that also returns each active
  // offer's name, for a hover-tooltip summary alongside the Offer badge.
  async listActiveOfferDetailsForProductIds(productIds) {
    if (!Array.isArray(productIds) || !productIds.length) return [];

    const numericIds = [
      ...new Set(
        productIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
      ),
    ];
    if (!numericIds.length) return [];

    const rows = await queryInBatches(
      this.db,
      (chunk) => {
        const ph = chunk.map(() => "?").join(", ");
        return `
          SELECT DISTINCT op.mosp_item_code AS product_id, h.moh_offer_name AS offer_name
          FROM offer_products op
          INNER JOIN offer_hdr h
            ON h.moh_offer_id = op.mosp_offer_id
           AND h.retail_outlet_id = op.retail_outlet_id
          WHERE ${excludedRetailOutletWhereClause("h")}
            AND ${statusWhereClause("active", "h")}
            AND op.mosp_item_code IN (${ph})
        `;
      },
      numericIds
    );

    return (rows || []).map((row) => ({
      product_id: String(row.product_id),
      offer_name: row.offer_name,
    }));
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
      `${offerProductLinesSelectSql({ groupByBranch: true })}
        AND op.mosp_offer_id = ?
        AND op.retail_outlet_id = ?
      ORDER BY op.mosp_item_code ASC`,
      [moh_offer_id, retail_outlet_id]
    );
  }

  async countProductLines({
    status = "active",
    filterModel = {},
    groupBy = null,
  } = {}) {
    const { sql: baseSql, params: filterParams } = productLinesListBaseSql(
      status,
      filterModel,
      groupBy
    );
    const rows = await queryAsync(
      this.db,
      `SELECT COUNT(*) AS total FROM (${baseSql}) AS filtered_lines`,
      filterParams
    );
    return rows?.[0]?.total ?? 0;
  }

  async countProductGroups({
    status = "active",
    filterModel = {},
    groupBy = "distributor",
  } = {}) {
    const { sql: baseSql, params: filterParams } = productGroupsListBaseSql(
      status,
      groupBy,
      filterModel
    );
    const rows = await queryAsync(
      this.db,
      `SELECT COUNT(*) AS total FROM (${baseSql}) AS filtered_groups`,
      filterParams
    );
    return rows?.[0]?.total ?? 0;
  }

  async listProductGroups({
    limit = 20,
    offset = 0,
    sortBy,
    sortDir = "asc",
    status = "active",
    filterModel = {},
    groupBy = "distributor",
  } = {}) {
    const nameField = resolveProductGroupNameField(groupBy);
    const { column, dir } = resolveProductGroupSort(
      groupBy,
      sortBy || nameField,
      sortDir
    );
    const { sql: baseSql, params: filterParams } = productGroupsListBaseSql(
      status,
      groupBy,
      filterModel
    );
    const sql = `${baseSql}
      ORDER BY ${column} ${dir}
      LIMIT ? OFFSET ?`;
    return queryAsync(this.db, sql, [...filterParams, limit, offset]);
  }

  async listProductGroupsAll({
    sortBy,
    sortDir = "asc",
    status = "active",
    filterModel = {},
    groupBy = "distributor",
  } = {}) {
    const nameField = resolveProductGroupNameField(groupBy);
    const { column, dir } = resolveProductGroupSort(
      groupBy,
      sortBy || nameField,
      sortDir
    );
    const { sql: baseSql, params: filterParams } = productGroupsListBaseSql(
      status,
      groupBy,
      filterModel
    );
    const sql = `${baseSql}
      ORDER BY ${column} ${dir}
      LIMIT ?`;
    return queryAsync(this.db, sql, [...filterParams, LIST_ALL_CAP]);
  }

  async listProductLines({
    limit = 20,
    offset = 0,
    sortBy = "moh_offer_hq_id",
    sortDir = "desc",
    status = "active",
    filterModel = {},
    groupBy = null,
  } = {}) {
    const { column, dir } = resolveProductLineSort(sortBy, sortDir);
    const { sql: baseSql, params: filterParams } = productLinesListBaseSql(
      status,
      filterModel,
      groupBy
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
    groupBy = null,
  } = {}) {
    const { column, dir } = resolveProductLineSort(sortBy, sortDir);
    const { sql: baseSql, params: filterParams } = productLinesListBaseSql(
      status,
      filterModel,
      groupBy
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
