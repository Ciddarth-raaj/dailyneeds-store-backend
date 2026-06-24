const logger = require("../utils/logger");

function toOptionalString(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function toOptionalNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toRequiredNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toRequiredInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

function toOptionalDate(v) {
  const s = toOptionalString(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function mapHdrImportRow(row) {
  const moh_offer_id = toRequiredNumber(row.MOH_OFFER_ID);
  const retail_outlet_id = toRequiredInt(row.RETAIL_OUTLET_ID);

  if (moh_offer_id === null || retail_outlet_id === null) {
    return null;
  }

  return {
    moh_offer_id,
    moh_offer_name: toOptionalString(row.MOH_OFFER_NAME),
    moh_offer_family_id: toOptionalNumber(row.MOH_OFFER_FAMILY_ID),
    moh_offer_typeid: toOptionalNumber(row.MOH_OFFER_TYPEID),
    moh_offer_status: toOptionalNumber(row.MOH_OFFER_STATUS),
    moh_offer_get_confirm: toOptionalNumber(row.MOH_OFFER_GET_CONFIRM),
    moh_offer_tier_id: toOptionalNumber(row.MOH_OFFER_TIER_ID),
    moh_offer_period: toOptionalNumber(row.MOH_OFFER_PERIOD),
    moh_offer_happy_days: toOptionalNumber(row.MOH_OFFER_HAPPY_DAYS),
    moh_offer_happy_hours: toOptionalNumber(row.MOH_OFFER_HAPPY_HOURS),
    moh_offer_first_n_customers: toOptionalNumber(row.MOH_OFFER_FIRST_N_CUSTOMERS),
    moh_offer_st_date: toOptionalDate(row.MOH_OFFER_ST_DATE),
    moh_offer_end_date: toOptionalDate(row.MOH_OFFER_END_DATE),
    moh_offer_hq_id: toOptionalNumber(row.MOH_OFFER_HQ_ID),
    moh_offer_nth_bill: toOptionalNumber(row.MOH_OFFER_NTH_BILL),
    ts: toOptionalDate(row.TS),
    tsid: toOptionalNumber(row.TSID),
    retail_outlet_id,
    moh_vertical_id: toOptionalNumber(row.MOH_VERTICAL_ID),
    moh_offer_cust_type: toOptionalNumber(row.MOH_OFFER_CUST_TYPE),
    timestamp: toOptionalString(row.TIMESTAMP),
    moh_allow_span: toOptionalNumber(row.MOH_ALLOW_SPAN),
    moh_offer_on_nextbill: toOptionalNumber(row.MOH_OFFER_ON_NEXTBILL),
    moh_loyalty_card_must: toOptionalNumber(row.MOH_LOYALTY_CARD_MUST),
    hq_timestamp_id: toOptionalNumber(row.HQ_TIMESTAMP_ID) ?? 0,
    moh_offer_on_eachitem: toOptionalNumber(row.MOH_OFFER_ON_EACHITEM),
    moh_first_time_offer: toOptionalNumber(row.MOH_FIRST_TIME_OFFER),
    moh_offer_basedon_mrp: toOptionalNumber(row.MOH_OFFER_BASEDON_MRP),
    moh_happy_hours_basedon: toOptionalNumber(row.MOH_HAPPY_HOURS_BASEDON),
    moh_offer_on_itemuom: toOptionalNumber(row.MOH_OFFER_ON_ITEMUOM),
    moh_batch_offer: toOptionalNumber(row.MOH_BATCH_OFFER),
    moh_override_duplicate: toOptionalNumber(row.MOH_OVERRIDE_DUPLICATE),
    moh_block_return: toOptionalNumber(row.MOH_BLOCK_RETURN),
    moh_cust_specific_offer: toOptionalNumber(row.MOH_CUST_SPECIFIC_OFFER),
    moh_loyalty_point: toOptionalNumber(row.MOH_LOYALTY_POINT),
    moh_offer_st_day: toOptionalNumber(row.MOH_OFFER_ST_DAY),
    moh_offer_end_day: toOptionalNumber(row.MOH_OFFER_END_DAY),
    moh_offer_sales_period: toOptionalNumber(row.MOH_OFFER_SALES_PERIOD),
    moh_offer_sales_st_dt: toOptionalDate(row.MOH_OFFER_SALES_ST_DT),
    moh_offer_sales_end_dt: toOptionalDate(row.MOH_OFFER_SALES_END_DT),
    moh_allow_max_qty: toOptionalNumber(row.MOH_ALLOW_MAX_QTY),
  };
}

function mapProductImportRow(row) {
  const mosp_offer_id = toRequiredNumber(row.MOSP_OFFER_ID);
  const mosp_item_code = toRequiredInt(row.MOSP_ITEM_CODE);
  const retail_outlet_id = toRequiredInt(row.RETAIL_OUTLET_ID);
  const mosp_sub_id = toOptionalNumber(row.MOSP_SUB_ID);

  if (mosp_offer_id === null || mosp_item_code === null || retail_outlet_id === null) {
    return null;
  }

  return {
    mosp_offer_id,
    mosp_sub_id: mosp_sub_id ?? 0,
    mosp_category_id: toOptionalNumber(row.MOSP_CATEGORY_ID),
    mosp_item_code,
    ts: toOptionalDate(row.TS),
    tsid: toOptionalNumber(row.TSID),
    retail_outlet_id,
    timestamp: toOptionalString(row.TIMESTAMP),
    hq_timestamp_id: toOptionalNumber(row.HQ_TIMESTAMP_ID) ?? 0,
  };
}

function offerHdrKey(offerId, outletId) {
  return `${offerId}:${outletId}`;
}

function offerProductLineKey(offerId, subId, outletId) {
  return `${offerId}:${subId}:${outletId}`;
}

const FK_SKIP_REASON = {
  OUTLET: "RETAIL_OUTLET_ID does not exist in outlets",
  PRODUCT: "MOSP_ITEM_CODE does not exist in product_table",
  OFFER_HDR_PRODUCTS:
    "offer_hdr not found for MOSP_OFFER_ID and RETAIL_OUTLET_ID",
  OFFER_HDR_ISSUE: "offer_hdr not found for MOI_OFFER_ID and RETAIL_OUTLET_ID",
  OFFER_PRODUCTS_LINE:
    "offer_products line not found for MOI_OFFER_ID, MOI_OFFER_SL_NO, and RETAIL_OUTLET_ID",
};

function uniqueFkSkipReasons(reasons) {
  return [...reasons].sort();
}

function withSkippedFkFields(payload, skippedFk, skippedFkReasons) {
  if (!skippedFk) return payload;
  return {
    ...payload,
    skipped_fk_rows: skippedFk,
    skipped_fk_reasons: uniqueFkSkipReasons(skippedFkReasons),
  };
}

function mapIssueImportRow(row) {
  const moi_offer_id = toRequiredNumber(row.MOI_OFFER_ID);
  const retail_outlet_id = toRequiredInt(row.RETAIL_OUTLET_ID);
  const moi_offer_sl_no = toOptionalNumber(row.MOI_OFFER_SL_NO);

  if (moi_offer_id === null || retail_outlet_id === null) {
    return null;
  }

  return {
    moi_offer_id,
    moi_offer_sl_no: moi_offer_sl_no ?? 0,
    moi_offer_on: toOptionalString(row.MOI_OFFER_ON),
    moi_offer_satisfied: toOptionalString(row.MOI_OFFER_SATISFIED),
    moi_offer_type: toOptionalNumber(row.MOI_OFFER_TYPE),
    moi_item_code: toOptionalNumber(row.MOI_ITEM_CODE),
    moi_offer_value: toOptionalNumber(row.MOI_OFFER_VALUE),
    moi_offer_extra_condition: toOptionalNumber(row.MOI_OFFER_EXTRA_CONDITION),
    moi_offer_extra_condition_qty: toOptionalNumber(row.MOI_OFFER_EXTRA_CONDITION_QTY),
    ts: toOptionalDate(row.TS),
    tsid: toOptionalNumber(row.TSID),
    retail_outlet_id,
    timestamp: toOptionalString(row.TIMESTAMP),
    hq_timestamp_id: toOptionalNumber(row.HQ_TIMESTAMP_ID) ?? 0,
    moi_conv_type: toOptionalString(row.MOI_CONV_TYPE),
    moi_conv_factor: toOptionalNumber(row.MOI_CONV_FACTOR),
    moi_batch_no: toOptionalString(row.MOI_BATCH_NO),
  };
}

function formatDbDate(value) {
  if (value == null || value === "") return null;
  const dateOnly = String(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return dateOnly;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return null;
}

function roundToTwoDecimals(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Number(n.toFixed(2));
}

const HDR_SORT_COLUMNS = {
  moh_offer_id: true,
  moh_offer_name: true,
  moh_offer_st_date: true,
  moh_offer_end_date: true,
  branch_name: true,
  product_count: true,
};

const HDR_FILTER_COLUMNS = {
  moh_offer_id: true,
  moh_offer_name: true,
  moh_offer_st_date: true,
  moh_offer_end_date: true,
  branch_name: true,
  product_count: true,
};

const PRODUCT_SORT_COLUMNS = {
  moh_offer_id: true,
  moh_offer_name: true,
  product_id: true,
  de_name: true,
  moi_offer_on: true,
  moi_offer_value: true,
};

const PRODUCT_FILTER_COLUMNS = {
  moh_offer_id: true,
  moh_offer_name: true,
  product_id: true,
  de_name: true,
  moi_offer_on: true,
  moi_offer_value: true,
};

function parseFilterModel(raw, allowedColumns) {
  if (!raw) return {};
  let model = raw;
  if (typeof raw === "string") {
    try {
      model = JSON.parse(raw);
    } catch (_e) {
      return {};
    }
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(model)) {
    if (allowedColumns[key] && value && typeof value === "object") {
      safe[key] = value;
    }
  }
  return safe;
}

class HqOffersUsecase {
  constructor(hqOffersRepo) {
    this.hqOffersRepo = hqOffersRepo;
  }

  async filterHdrRowsByFk(rows) {
    const validOutlets = await this.hqOffersRepo.resolveValidOutletIds(
      rows.map((r) => r.retail_outlet_id)
    );

    const accepted = [];
    let skippedFk = 0;
    const skippedFkReasons = new Set();

    for (const row of rows) {
      if (!validOutlets.has(row.retail_outlet_id)) {
        skippedFk += 1;
        skippedFkReasons.add(FK_SKIP_REASON.OUTLET);
        continue;
      }
      accepted.push(row);
    }

    return { accepted, skippedFk, skippedFkReasons };
  }

  async filterProductRowsByFk(rows) {
    const validOutlets = await this.hqOffersRepo.resolveValidOutletIds(
      rows.map((r) => r.retail_outlet_id)
    );
    const validProducts = await this.hqOffersRepo.resolveValidProductIds(
      rows.map((r) => r.mosp_item_code)
    );
    const validOffers = await this.hqOffersRepo.resolveValidOfferHdrKeys(
      rows.map((r) => ({
        moh_offer_id: r.mosp_offer_id,
        retail_outlet_id: r.retail_outlet_id,
      }))
    );

    const accepted = [];
    let skippedFk = 0;
    const skippedFkReasons = new Set();

    for (const row of rows) {
      const outletOk = validOutlets.has(row.retail_outlet_id);
      const productOk = validProducts.has(row.mosp_item_code);
      const offerOk = validOffers.has(
        offerHdrKey(row.mosp_offer_id, row.retail_outlet_id)
      );

      if (!outletOk || !productOk || !offerOk) {
        skippedFk += 1;
        if (!outletOk) skippedFkReasons.add(FK_SKIP_REASON.OUTLET);
        if (!productOk) skippedFkReasons.add(FK_SKIP_REASON.PRODUCT);
        if (!offerOk) skippedFkReasons.add(FK_SKIP_REASON.OFFER_HDR_PRODUCTS);
        continue;
      }
      accepted.push(row);
    }

    return { accepted, skippedFk, skippedFkReasons };
  }

  async filterIssueRowsByFk(rows) {
    const validOutlets = await this.hqOffersRepo.resolveValidOutletIds(
      rows.map((r) => r.retail_outlet_id)
    );
    const validOffers = await this.hqOffersRepo.resolveValidOfferHdrKeys(
      rows.map((r) => ({
        moh_offer_id: r.moi_offer_id,
        retail_outlet_id: r.retail_outlet_id,
      }))
    );
    const validProductLines = await this.hqOffersRepo.resolveValidOfferProductLineKeys(
      rows.map((r) => ({
        mosp_offer_id: r.moi_offer_id,
        mosp_sub_id: r.moi_offer_sl_no,
        retail_outlet_id: r.retail_outlet_id,
      }))
    );

    const accepted = [];
    let skippedFk = 0;
    const skippedFkReasons = new Set();

    for (const row of rows) {
      const outletOk = validOutlets.has(row.retail_outlet_id);
      const offerOk = validOffers.has(
        offerHdrKey(row.moi_offer_id, row.retail_outlet_id)
      );
      const productLineOk = validProductLines.has(
        offerProductLineKey(
          row.moi_offer_id,
          row.moi_offer_sl_no,
          row.retail_outlet_id
        )
      );

      if (!outletOk || !offerOk || !productLineOk) {
        skippedFk += 1;
        if (!outletOk) skippedFkReasons.add(FK_SKIP_REASON.OUTLET);
        if (!offerOk) skippedFkReasons.add(FK_SKIP_REASON.OFFER_HDR_ISSUE);
        if (!productLineOk) skippedFkReasons.add(FK_SKIP_REASON.OFFER_PRODUCTS_LINE);
        continue;
      }
      accepted.push(row);
    }

    return { accepted, skippedFk, skippedFkReasons };
  }

  async insert(row) {
    const mapped = mapHdrImportRow(row);
    if (!mapped) {
      return {
        code: 400,
        msg: "MOH_OFFER_ID and RETAIL_OUTLET_ID are required numeric values.",
      };
    }

    try {
      const { accepted, skippedFk, skippedFkReasons } =
        await this.filterHdrRowsByFk([mapped]);
      if (!accepted.length) {
        return withSkippedFkFields(
          {
            code: 400,
            msg: "RETAIL_OUTLET_ID does not exist in outlets.",
          },
          skippedFk,
          skippedFkReasons
        );
      }
      return await this.hqOffersRepo.insertHdr(accepted[0]);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.HQ_OFFERS",
        code: "USECASE.HQ_OFFERS.INSERT",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async bulkInsert(rows) {
    const byKey = new Map();
    let skippedInvalid = 0;

    for (const row of rows) {
      const mapped = mapHdrImportRow(row);
      if (!mapped) {
        skippedInvalid += 1;
        continue;
      }
      byKey.set(offerHdrKey(mapped.moh_offer_id, mapped.retail_outlet_id), mapped);
    }

    const mappedRows = [...byKey.values()];
    if (!mappedRows.length) {
      return {
        code: 400,
        msg: "No valid rows to import. MOH_OFFER_ID and RETAIL_OUTLET_ID are required.",
      };
    }

    try {
      const { accepted, skippedFk, skippedFkReasons } =
        await this.filterHdrRowsByFk(mappedRows);
      if (!accepted.length) {
        return withSkippedFkFields(
          {
            code: 400,
            msg: "No rows with valid RETAIL_OUTLET_ID references.",
            skipped_invalid_rows: skippedInvalid,
          },
          skippedFk,
          skippedFkReasons
        );
      }

      const result = await this.hqOffersRepo.bulkInsertHdr(accepted);
      if (skippedInvalid) result.skipped_invalid_rows = skippedInvalid;
      return withSkippedFkFields(result, skippedFk, skippedFkReasons);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.HQ_OFFERS",
        code: "USECASE.HQ_OFFERS.BULK_INSERT",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async insertProduct(row) {
    const mapped = mapProductImportRow(row);
    if (!mapped) {
      return {
        code: 400,
        msg: "MOSP_OFFER_ID, MOSP_ITEM_CODE, and RETAIL_OUTLET_ID are required numeric values.",
      };
    }

    try {
      const { accepted, skippedFk, skippedFkReasons } =
        await this.filterProductRowsByFk([mapped]);
      if (!accepted.length) {
        return withSkippedFkFields(
          {
            code: 400,
            msg: "Row skipped: invalid offer_hdr, outlet, or product reference.",
          },
          skippedFk,
          skippedFkReasons
        );
      }
      return await this.hqOffersRepo.insertProduct(accepted[0]);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.HQ_OFFERS",
        code: "USECASE.HQ_OFFERS.INSERT_PRODUCT",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async bulkInsertProducts(rows) {
    const byKey = new Map();
    let skippedInvalid = 0;

    for (const row of rows) {
      const mapped = mapProductImportRow(row);
      if (!mapped) {
        skippedInvalid += 1;
        continue;
      }
      byKey.set(
        `${mapped.mosp_offer_id}:${mapped.mosp_sub_id}:${mapped.mosp_item_code}:${mapped.retail_outlet_id}`,
        mapped
      );
    }

    const mappedRows = [...byKey.values()];
    if (!mappedRows.length) {
      return {
        code: 400,
        msg: "No valid rows to import. MOSP_OFFER_ID, MOSP_ITEM_CODE, and RETAIL_OUTLET_ID are required.",
      };
    }

    try {
      const { accepted, skippedFk, skippedFkReasons } =
        await this.filterProductRowsByFk(mappedRows);
      if (!accepted.length) {
        return withSkippedFkFields(
          {
            code: 400,
            msg: "No rows with valid offer_hdr, outlet, or product references.",
            skipped_invalid_rows: skippedInvalid,
          },
          skippedFk,
          skippedFkReasons
        );
      }

      const result = await this.hqOffersRepo.bulkInsertProducts(accepted);
      if (skippedInvalid) result.skipped_invalid_rows = skippedInvalid;
      return withSkippedFkFields(result, skippedFk, skippedFkReasons);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.HQ_OFFERS",
        code: "USECASE.HQ_OFFERS.BULK_INSERT_PRODUCTS",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async insertIssue(row) {
    const mapped = mapIssueImportRow(row);
    if (!mapped) {
      return {
        code: 400,
        msg: "MOI_OFFER_ID and RETAIL_OUTLET_ID are required numeric values.",
      };
    }

    try {
      const { accepted, skippedFk, skippedFkReasons } =
        await this.filterIssueRowsByFk([mapped]);
      if (!accepted.length) {
        return withSkippedFkFields(
          {
            code: 400,
            msg: "Row skipped: invalid offer_hdr, offer_products, or outlet reference.",
          },
          skippedFk,
          skippedFkReasons
        );
      }
      return await this.hqOffersRepo.insertIssue(accepted[0]);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.HQ_OFFERS",
        code: "USECASE.HQ_OFFERS.INSERT_ISSUE",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  async bulkInsertIssues(rows) {
    const byKey = new Map();
    let skippedInvalid = 0;

    for (const row of rows) {
      const mapped = mapIssueImportRow(row);
      if (!mapped) {
        skippedInvalid += 1;
        continue;
      }
      byKey.set(
        `${mapped.moi_offer_id}:${mapped.moi_offer_sl_no}:${mapped.retail_outlet_id}`,
        mapped
      );
    }

    const mappedRows = [...byKey.values()];
    if (!mappedRows.length) {
      return {
        code: 400,
        msg: "No valid rows to import. MOI_OFFER_ID and RETAIL_OUTLET_ID are required.",
      };
    }

    try {
      const { accepted, skippedFk, skippedFkReasons } =
        await this.filterIssueRowsByFk(mappedRows);
      if (!accepted.length) {
        return withSkippedFkFields(
          {
            code: 400,
            msg: "No rows with valid offer_hdr, offer_products, or outlet references.",
            skipped_invalid_rows: skippedInvalid,
          },
          skippedFk,
          skippedFkReasons
        );
      }

      const result = await this.hqOffersRepo.bulkInsertIssues(accepted);
      if (skippedInvalid) result.skipped_invalid_rows = skippedInvalid;
      return withSkippedFkFields(result, skippedFk, skippedFkReasons);
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.HQ_OFFERS",
        code: "USECASE.HQ_OFFERS.BULK_INSERT_ISSUES",
        description: err.toString(),
        category: "",
        ref: {},
      });
      throw err;
    }
  }

  mapHdrListRow(row) {
    if (!row) return null;
    const moh_offer_status = row.moh_offer_status;
    return {
      moh_offer_id: row.moh_offer_id,
      retail_outlet_id: row.retail_outlet_id,
      display_offer_id: row.moh_offer_hq_id ?? row.moh_offer_id,
      moh_offer_hq_id: row.moh_offer_hq_id,
      moh_offer_name: row.moh_offer_name,
      product_count: Number(row.product_count) || 0,
      moh_offer_st_date: formatDbDate(row.moh_offer_st_date),
      moh_offer_end_date: formatDbDate(row.moh_offer_end_date),
      branch_name: row.branch_name,
      moh_offer_status,
      status: Number(moh_offer_status) === 1 ? "active" : "inactive",
    };
  }

  mapProductLineRow(row) {
    if (!row) return null;
    return {
      moh_offer_id: row.moh_offer_id,
      retail_outlet_id: row.retail_outlet_id,
      display_offer_id: row.moh_offer_hq_id ?? row.moh_offer_id,
      moh_offer_name: row.moh_offer_name,
      product_id: row.product_id,
      moi_offer_sl_no: row.moi_offer_sl_no,
      de_name: row.de_name,
      image_url: row.image_url,
      moi_offer_on: row.moi_offer_on,
      moi_offer_value: roundToTwoDecimals(row.moi_offer_value),
    };
  }

  async listHdr({
    limit = 20,
    offset = 0,
    sortBy = "moh_offer_id",
    sortDir = "desc",
    status = "active",
    filterModel = {},
  } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const safeStatus = status === "inactive" ? "inactive" : "active";
    const safeSortBy = HDR_SORT_COLUMNS[sortBy] ? sortBy : "moh_offer_id";
    const safeSortDir =
      String(sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const safeFilterModel = parseFilterModel(filterModel, HDR_FILTER_COLUMNS);

    const [rows, total] = await Promise.all([
      this.hqOffersRepo.listHdr({
        limit: safeLimit,
        offset: safeOffset,
        sortBy: safeSortBy,
        sortDir: safeSortDir,
        status: safeStatus,
        filterModel: safeFilterModel,
      }),
      this.hqOffersRepo.countHdr({ status: safeStatus, filterModel: safeFilterModel }),
    ]);

    return {
      code: 200,
      data: (rows || []).map((row) => this.mapHdrListRow(row)),
      total: Number(total) || 0,
      limit: safeLimit,
      offset: safeOffset,
      sort_by: safeSortBy,
      sort_dir: safeSortDir,
      status: safeStatus,
    };
  }

  async listProductLines({
    limit = 20,
    offset = 0,
    sortBy = "moh_offer_id",
    sortDir = "desc",
    status = "active",
    filterModel = {},
  } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 500);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const safeStatus = status === "inactive" ? "inactive" : "active";
    const safeSortBy = PRODUCT_SORT_COLUMNS[sortBy] ? sortBy : "moh_offer_id";
    const safeSortDir =
      String(sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const safeFilterModel = parseFilterModel(filterModel, PRODUCT_FILTER_COLUMNS);

    const [rows, total] = await Promise.all([
      this.hqOffersRepo.listProductLines({
        limit: safeLimit,
        offset: safeOffset,
        sortBy: safeSortBy,
        sortDir: safeSortDir,
        status: safeStatus,
        filterModel: safeFilterModel,
      }),
      this.hqOffersRepo.countProductLines({
        status: safeStatus,
        filterModel: safeFilterModel,
      }),
    ]);

    return {
      code: 200,
      data: (rows || []).map((row) => this.mapProductLineRow(row)),
      total: Number(total) || 0,
      limit: safeLimit,
      offset: safeOffset,
      sort_by: safeSortBy,
      sort_dir: safeSortDir,
      status: safeStatus,
    };
  }

  async listProductLinesAll({
    sortBy = "moh_offer_id",
    sortDir = "desc",
    status = "active",
    filterModel = {},
  } = {}) {
    const safeStatus = status === "inactive" ? "inactive" : "active";
    const safeSortBy = PRODUCT_SORT_COLUMNS[sortBy] ? sortBy : "moh_offer_id";
    const safeSortDir =
      String(sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const safeFilterModel = parseFilterModel(filterModel, PRODUCT_FILTER_COLUMNS);

    const rows = await this.hqOffersRepo.listProductLinesAll({
      sortBy: safeSortBy,
      sortDir: safeSortDir,
      status: safeStatus,
      filterModel: safeFilterModel,
    });

    return {
      code: 200,
      data: (rows || []).map((row) => this.mapProductLineRow(row)),
      sort_by: safeSortBy,
      sort_dir: safeSortDir,
      status: safeStatus,
    };
  }

  async listHdrAll({
    sortBy = "moh_offer_id",
    sortDir = "desc",
    status = "active",
    filterModel = {},
  } = {}) {
    const safeStatus = status === "inactive" ? "inactive" : "active";
    const safeSortBy = HDR_SORT_COLUMNS[sortBy] ? sortBy : "moh_offer_id";
    const safeSortDir =
      String(sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    const safeFilterModel = parseFilterModel(filterModel, HDR_FILTER_COLUMNS);

    const rows = await this.hqOffersRepo.listHdrAll({
      sortBy: safeSortBy,
      sortDir: safeSortDir,
      status: safeStatus,
      filterModel: safeFilterModel,
    });

    return {
      code: 200,
      data: (rows || []).map((row) => this.mapHdrListRow(row)),
      sort_by: safeSortBy,
      sort_dir: safeSortDir,
      status: safeStatus,
    };
  }

  async getOfferDetail(moh_offer_id, retail_outlet_id) {
    const offerRow = await this.hqOffersRepo.getHdrByKey(
      moh_offer_id,
      retail_outlet_id
    );
    if (!offerRow) {
      return { code: 404, msg: "Offer not found" };
    }

    const products = await this.hqOffersRepo.listOfferLinesByKey(
      moh_offer_id,
      retail_outlet_id
    );

    return {
      code: 200,
      data: {
        offer: this.mapHdrListRow(offerRow),
        products: (products || []).map((line) => ({
          ...line,
          moi_offer_value: roundToTwoDecimals(line.moi_offer_value),
        })),
      },
    };
  }
}

module.exports = (hqOffersRepo) => {
  return new HqOffersUsecase(hqOffersRepo);
};
