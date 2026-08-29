const logger = require("../utils/logger");

const OFFER_TYPES = ["percentage", "flat", "fixed_price"];

function logError(code, description, ref = {}) {
  logger.Log({
    level: logger.LEVEL.ERROR,
    component: "USECASE.OFFERS_V3",
    code,
    description,
    category: "",
    ref,
  });
}

function distinctCount(rows, key) {
  return new Set(rows.map((r) => r[key])).size;
}

function computeExpectedSelling(offer_type, value, mrp) {
  const v = Number(value);
  const m = Number(mrp);
  if (offer_type === "percentage") return m - (m * v) / 100;
  if (offer_type === "flat") return m - v;
  if (offer_type === "fixed_price") return v;
  return null;
}

/**
 * Validate an offer value against the offer type's rule.
 * Percentage: 0 < value < 100.
 * Flat / fixed price: 0 < value < the item's current MRP (throws if MRP is
 * unknown rather than silently allowing an unvalidated value).
 */
function validateOfferValue(offer_type, value, mrp) {
  const v = Number(value);
  if (offer_type === "percentage") {
    if (!(v > 0 && v < 100)) {
      const err = new Error("Percentage value must be greater than 0 and less than 100");
      err.code = 400;
      throw err;
    }
    return;
  }
  if (mrp == null) {
    const err = new Error(
      "No current MRP found for this item (upload it via Price Checker first); cannot validate the offer value"
    );
    err.code = 400;
    throw err;
  }
  const m = Number(mrp);
  if (!(v > 0 && v < m)) {
    const err = new Error(`Value must be greater than 0 and less than the item's current MRP (₹${m})`);
    err.code = 400;
    throw err;
  }
}

/**
 * Threshold Qty (item-level offers only) must be a non-negative whole
 * number. Required at creation — margin protection: a new, costlier batch
 * bought after the offer started could otherwise sell at the old discount
 * unnoticed, since item-level offers cover all current and future stock.
 */
function validateThresholdQty(value) {
  if (value === undefined || value === null || value === "") {
    const err = new Error("Threshold Qty is required for item-level offers");
    err.code = 400;
    throw err;
  }
  const v = Number(value);
  if (!Number.isInteger(v) || v < 0) {
    const err = new Error("Threshold Qty must be a whole number 0 or greater");
    err.code = 400;
    throw err;
  }
}

class OffersV3Usecase {
  constructor(offersV3Repo, outletRepo) {
    this.offersV3Repo = offersV3Repo;
    this.outletRepo = outletRepo;
  }

  // ---------------------------------------------------------------------
  // Item-level offers
  // ---------------------------------------------------------------------

  async listItemOffers(filters) {
    try {
      return await this.offersV3Repo.listItemOffers(filters);
    } catch (err) {
      logError("USECASE.OFFERS_V3.LIST_ITEM_OFFERS", err.toString());
      throw err;
    }
  }

  async getItemOfferById(id) {
    try {
      return await this.offersV3Repo.getItemOfferById(id);
    } catch (err) {
      logError("USECASE.OFFERS_V3.GET_ITEM_OFFER", err.toString(), { id });
      throw err;
    }
  }

  async createItemOffer(data, created_by) {
    try {
      const activeBatches = await this.offersV3Repo.getActiveBatchOffersByItemCode(data.item_code);
      if (activeBatches.length > 0) {
        return {
          code: 400,
          msg: `Item already has ${activeBatches.length} active batch-specific offer(s). End them before creating an item-level offer.`,
        };
      }

      const existingItemOffer = await this.offersV3Repo.getActiveItemOfferByItemCode(data.item_code);
      if (existingItemOffer) {
        return {
          code: 400,
          msg: `Item already has an active item-level offer (#${existingItemOffer.id}).`,
        };
      }

      if (data.offer_type !== "percentage") {
        const mrps = await this.offersV3Repo.getMrpsForItem(data.item_code);
        const mrp = mrps.length ? Math.min(...mrps) : null;
        validateOfferValue(data.offer_type, data.value, mrp);
      } else {
        validateOfferValue(data.offer_type, data.value, null);
      }
      validateThresholdQty(data.threshold_qty);

      const result = await this.offersV3Repo.createItemOffer({ ...data, created_by });
      return result;
    } catch (err) {
      if (err.code === 400) return { code: 400, msg: err.message };
      logError("USECASE.OFFERS_V3.CREATE_ITEM_OFFER", err.toString());
      throw err;
    }
  }

  async updateItemOffer(id, data) {
    try {
      const existing = await this.offersV3Repo.getItemOfferById(id);
      if (!existing) return { code: 404, msg: "Offer not found" };

      const nextOfferType = data.offer_type ?? existing.offer_type;
      const nextValue = data.value ?? existing.value;
      const nextStatus = data.status ?? existing.status;

      if (nextStatus === "active") {
        if (existing.status !== "active") {
          const activeBatches = await this.offersV3Repo.getActiveBatchOffersByItemCode(existing.item_code);
          if (activeBatches.length > 0) {
            return {
              code: 400,
              msg: `Item already has ${activeBatches.length} active batch-specific offer(s). End them before reactivating this item-level offer.`,
            };
          }
        }
        if (nextOfferType !== "percentage") {
          const mrps = await this.offersV3Repo.getMrpsForItem(existing.item_code);
          const mrp = mrps.length ? Math.min(...mrps) : null;
          validateOfferValue(nextOfferType, nextValue, mrp);
        } else {
          validateOfferValue(nextOfferType, nextValue, null);
        }
      }
      if (data.threshold_qty !== undefined) {
        validateThresholdQty(data.threshold_qty);
      }

      const result = await this.offersV3Repo.updateItemOffer(id, data);
      if (nextStatus === "inactive" && existing.status !== "inactive") {
        await this.offersV3Repo.clearLowStockWarningsByItemCode(existing.item_code);
      }
      return result;
    } catch (err) {
      if (err.code === 400) return { code: 400, msg: err.message };
      logError("USECASE.OFFERS_V3.UPDATE_ITEM_OFFER", err.toString(), { id });
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Batch-specific offers
  // ---------------------------------------------------------------------

  async listBatchOffers(filters) {
    try {
      return await this.offersV3Repo.listBatchOffers(filters);
    } catch (err) {
      logError("USECASE.OFFERS_V3.LIST_BATCH_OFFERS", err.toString());
      throw err;
    }
  }

  async getBatchOfferById(id) {
    try {
      return await this.offersV3Repo.getBatchOfferById(id);
    } catch (err) {
      logError("USECASE.OFFERS_V3.GET_BATCH_OFFER", err.toString(), { id });
      throw err;
    }
  }

  async createBatchOffer(data, created_by) {
    try {
      const activeItemOffer = await this.offersV3Repo.getActiveItemOfferByItemCode(data.item_code);
      if (activeItemOffer) {
        return {
          code: 400,
          msg: `Item already has an active item-level offer (#${activeItemOffer.id}). Make it inactive before creating batch-specific offers.`,
        };
      }

      const occupying = await this.offersV3Repo.findOccupyingBatchOffer(
        data.item_code,
        data.outlet_id,
        data.batch_no
      );
      if (occupying) {
        return {
          code: 400,
          msg: `This batch already has an active offer (#${occupying.id}).`,
        };
      }

      if (data.offer_type !== "percentage") {
        const price = await this.offersV3Repo.getPriceForBatch(data.item_code, data.outlet_id, data.batch_no);
        validateOfferValue(data.offer_type, data.value, price?.mrp ?? null);
      } else {
        validateOfferValue(data.offer_type, data.value, null);
      }

      const result = await this.offersV3Repo.createBatchOffer({ ...data, created_by });
      if (result.code === 200) {
        await this.offersV3Repo.resolveUntaggedBatchAlertByKey(data.item_code, data.outlet_id, data.batch_no);
      }
      return result;
    } catch (err) {
      if (err.code === 400) return { code: 400, msg: err.message };
      logError("USECASE.OFFERS_V3.CREATE_BATCH_OFFER", err.toString());
      throw err;
    }
  }

  async updateBatchOffer(id, data) {
    try {
      const existing = await this.offersV3Repo.getBatchOfferById(id);
      if (!existing) return { code: 404, msg: "Offer not found" };

      if (data.status === "batch_zero_ended" && existing.status !== "zero_stock_flagged") {
        return {
          code: 400,
          msg: "Only a batch flagged as Zero Stock can be moved to Batch Zero — Ended.",
        };
      }

      const nextOfferType = data.offer_type ?? existing.offer_type;
      const nextValue = data.value ?? existing.value;
      const nextStatus = data.status ?? existing.status;

      if (nextStatus === "active" && existing.status !== "active") {
        const activeItemOffer = await this.offersV3Repo.getActiveItemOfferByItemCode(existing.item_code);
        if (activeItemOffer) {
          return {
            code: 400,
            msg: `Item already has an active item-level offer (#${activeItemOffer.id}).`,
          };
        }
        const occupying = await this.offersV3Repo.findOccupyingBatchOffer(
          existing.item_code,
          existing.outlet_id,
          existing.batch_no
        );
        if (occupying && occupying.id !== existing.id) {
          return {
            code: 400,
            msg: `This batch already has an active offer (#${occupying.id}).`,
          };
        }
      }

      if (["active", "zero_stock_flagged"].includes(nextStatus)) {
        if (nextOfferType !== "percentage") {
          const price = await this.offersV3Repo.getPriceForBatch(
            existing.item_code,
            existing.outlet_id,
            existing.batch_no
          );
          validateOfferValue(nextOfferType, nextValue, price?.mrp ?? null);
        } else {
          validateOfferValue(nextOfferType, nextValue, null);
        }
      }

      return await this.offersV3Repo.updateBatchOffer(id, data);
    } catch (err) {
      if (err.code === 400) return { code: 400, msg: err.message };
      logError("USECASE.OFFERS_V3.UPDATE_BATCH_OFFER", err.toString(), { id });
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Batch stock upload
  // ---------------------------------------------------------------------

  async resolveOutletId(rawValue) {
    if (rawValue == null || rawValue === "") return null;
    if (!this._outletsCache) {
      this._outletsCache = await this.outletRepo.get();
    }
    const s = String(rawValue).trim().toLowerCase();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const byId = this._outletsCache.find((o) => String(o.outlet_id) === s);
      if (byId) return byId.outlet_id;
    }
    const byName = this._outletsCache.find(
      (o) => String(o.outlet_name ?? "").trim().toLowerCase() === s
    );
    if (byName) return byName.outlet_id;
    const byCode = this._outletsCache.find(
      (o) => String(o.outlet_code ?? "").trim().toLowerCase() === s
    );
    if (byCode) return byCode.outlet_id;
    return null;
  }

  /**
   * If this item/outlet/batch has no offer of its own yet, but the item
   * already carries an active BATCH-SPECIFIC offer elsewhere, surface it as
   * an untagged batch instead of assuming inheritance. An active item-level
   * offer does NOT trigger this: item-level offers already apply to all
   * current and future stock automatically, so a new batch under one is
   * already covered (its selling price already reflects the item-level
   * offer) and needs no separate tagging — that's the whole point of
   * item scope. A batch-specific offer, by contrast, only ever covers the
   * exact batch it was created for, so a sibling batch genuinely needs its
   * own explicit offer or an admin decision to leave it untouched.
   */
  async detectUntaggedBatch(item_code, outlet_id, batch_no) {
    const existingOffer = await this.offersV3Repo.findOccupyingBatchOffer(item_code, outlet_id, batch_no);
    if (existingOffer) return null;

    const activeBatchOffers = await this.offersV3Repo.getActiveBatchOffersByItemCode(item_code);
    if (activeBatchOffers.length === 0) return null;

    await this.offersV3Repo.upsertUntaggedBatchAlert(item_code, outlet_id, batch_no);
    return { item_code, outlet_id, batch_no };
  }

  /**
   * Bulk variant of detectUntaggedBatch for large uploads: a fixed number of
   * queries regardless of row count, instead of several per row.
   * `candidateRows` are rows already known to have no occupying offer of
   * their own. Only items with an active BATCH-SPECIFIC offer elsewhere
   * are flagged — see detectUntaggedBatch for why item-level offers are
   * excluded.
   */
  async detectUntaggedBatchesBulk(candidateRows) {
    if (candidateRows.length === 0) return [];
    const itemCodes = candidateRows.map((r) => r.item_code);
    const itemCodesWithBatchOffer = await this.offersV3Repo.getItemCodesWithActiveBatchOffers(itemCodes);
    const untagged = candidateRows.filter((r) => itemCodesWithBatchOffer.has(r.item_code));
    if (untagged.length === 0) return [];
    await this.offersV3Repo.upsertUntaggedBatchAlerts(untagged);
    return untagged;
  }

  /**
   * Resolve item_code/outlet/batch_no on each row of an upload. Rows missing
   * a numeric item_code or a batch_no are simply skipped (counted, not
   * fatal) rather than failing the whole upload; rows with an unresolvable
   * outlet are skipped and that outlet value reported back.
   */
  async resolveUploadRows(rows) {
    this._outletsCache = null;
    const resolved = [];
    const skippedRows = [];
    const unresolvedOutlets = [];

    for (const row of rows) {
      const item_code = parseInt(row.item_code, 10);
      const batch_no = String(row.batch_no ?? "").trim();
      if (!item_code || !batch_no) {
        skippedRows.push({ ...row, _reason: "Missing or invalid Item Code / Batch No" });
        continue;
      }
      const outlet_id = await this.resolveOutletId(row.outlet);
      if (!outlet_id) {
        unresolvedOutlets.push(row.outlet);
        skippedRows.push({ ...row, _reason: `Outlet not found: "${row.outlet ?? ""}"` });
        continue;
      }
      resolved.push({ ...row, item_code, outlet_id, batch_no });
    }

    return { resolved, skippedRows, unresolvedOutlets: [...new Set(unresolvedOutlets)] };
  }

  /**
   * Process an uploaded batch-stock file: upsert stock, revert/flag
   * zero-stock on matched batch offers, and detect untagged new batches of
   * items that already carry an active offer elsewhere.
   */
  async processStockUpload(rows, created_by) {
    const { resolved: withKeys, skippedRows: keySkippedRows, unresolvedOutlets } = await this.resolveUploadRows(
      rows
    );
    const withNumericStock = withKeys.map((row) => ({ ...row, stock_qty: Number(row.stock_qty) }));
    const resolved = withNumericStock.filter((row) => !Number.isNaN(row.stock_qty));
    const numericSkippedRows = withNumericStock
      .filter((row) => Number.isNaN(row.stock_qty))
      .map((row) => ({ ...row, _reason: "Stock Qty is not numeric" }));
    const skippedRows = [...keySkippedRows, ...numericSkippedRows];

    if (resolved.length === 0) {
      return {
        code: 400,
        msg: "No valid rows to import (need a numeric Item Code, a matching Outlet, a Batch No, and a numeric Stock Qty).",
        unresolvedOutlets,
        skippedInvalidRows: skippedRows.length,
        skippedRows,
      };
    }

    await this.offersV3Repo.upsertBatchStock(resolved);

    // One bulk lookup for all rows' offers instead of one query per row.
    const keys = resolved.map((r) => ({ item_code: r.item_code, outlet_id: r.outlet_id, batch_no: r.batch_no }));
    const occupyingByKey = await this.offersV3Repo.findOccupyingBatchOffersByKeys(keys);

    const toFlag = [];
    const toRevert = [];
    const flagged = [];
    const reverted = [];
    const untaggedCandidates = [];

    for (const row of resolved) {
      const offer = occupyingByKey.get(`${row.item_code}|${row.outlet_id}|${row.batch_no}`);
      if (offer) {
        if (row.stock_qty <= 0 && offer.status === "active") {
          toFlag.push(offer.id);
          flagged.push({ id: offer.id, item_code: row.item_code, outlet_id: row.outlet_id, batch_no: row.batch_no });
        } else if (row.stock_qty > 0 && offer.status === "zero_stock_flagged") {
          toRevert.push(offer.id);
          reverted.push({ id: offer.id, item_code: row.item_code, outlet_id: row.outlet_id, batch_no: row.batch_no });
        }
        continue;
      }
      untaggedCandidates.push({ item_code: row.item_code, outlet_id: row.outlet_id, batch_no: row.batch_no });
    }

    await Promise.all([
      this.offersV3Repo.updateBatchOffersStatusByIds(toFlag, "zero_stock_flagged"),
      this.offersV3Repo.updateBatchOffersStatusByIds(toRevert, "active"),
    ]);
    const untagged = await this.detectUntaggedBatchesBulk(untaggedCandidates);
    const lowStock = await this.detectLowStockWarningsBulk(resolved);

    await this.offersV3Repo.upsertUploadMeta("stock", {
      total_rows: resolved.length,
      total_products: distinctCount(resolved, "item_code"),
      uploaded_by: created_by,
    });

    return {
      code: 200,
      upserted: resolved.length,
      unresolvedOutlets,
      skippedInvalidRows: skippedRows.length,
      skippedRows,
      flagged,
      reverted,
      untagged,
      lowStock,
    };
  }

  /**
   * Item-level offers only: for every row of an item that currently has an
   * active item-level offer, check its stock against that offer's
   * Threshold Qty. A row with stock > 0 and <= threshold is upserted into
   * the low-stock warning queue; a row back above threshold clears any
   * existing warning for that exact outlet/batch. Zero stock is left alone
   * here — item-level offers have no zero-stock trigger, only Threshold Qty.
   */
  async detectLowStockWarningsBulk(resolvedRows) {
    if (resolvedRows.length === 0) return [];
    const itemCodes = resolvedRows.map((r) => r.item_code);
    const thresholds = await this.offersV3Repo.getActiveItemOfferThresholds(itemCodes);
    if (thresholds.size === 0) return [];

    const toWarn = [];
    const toClear = [];
    for (const row of resolvedRows) {
      const threshold = thresholds.get(row.item_code);
      if (threshold === undefined) continue;
      const key = { item_code: row.item_code, outlet_id: row.outlet_id, batch_no: row.batch_no };
      if (row.stock_qty > 0 && row.stock_qty <= threshold) {
        toWarn.push({ ...key, stock_qty: row.stock_qty, threshold_qty: threshold });
      } else {
        toClear.push(key);
      }
    }

    await Promise.all([
      this.offersV3Repo.upsertLowStockWarnings(toWarn),
      this.offersV3Repo.clearLowStockWarningsByKeys(toClear),
    ]);
    return toWarn;
  }

  /**
   * Process an uploaded price file (Price Checker-style export: Item Code,
   * Outlet, Batch No, MRP, Selling Price — MRP/Selling Price are always the
   * Old_MRP/Old_Selling_Price columns per the fixed mapping rule, resolved on
   * the frontend before this is called). Updates only mrp/selling_price for
   * matching rows; also detects untagged new batches.
   */
  async processPriceUpload(rows, created_by) {
    const { resolved: withKeys, skippedRows: keySkippedRows, unresolvedOutlets } = await this.resolveUploadRows(
      rows
    );
    const withNumericPrice = withKeys.map((row) => ({
      ...row,
      mrp: Number(row.mrp),
      selling_price: Number(row.selling_price),
    }));
    const resolved = withNumericPrice.filter((row) => !Number.isNaN(row.mrp) && !Number.isNaN(row.selling_price));
    const numericSkippedRows = withNumericPrice
      .filter((row) => Number.isNaN(row.mrp) || Number.isNaN(row.selling_price))
      .map((row) => ({ ...row, _reason: "MRP / Selling Price is not numeric" }));
    const skippedRows = [...keySkippedRows, ...numericSkippedRows];

    if (resolved.length === 0) {
      return {
        code: 400,
        msg: "No valid rows to import (need a numeric Item Code, a matching Outlet, a Batch No, and numeric MRP/Selling Price).",
        unresolvedOutlets,
        skippedInvalidRows: skippedRows.length,
        skippedRows,
      };
    }

    await this.offersV3Repo.upsertBatchPrice(resolved);

    // One bulk lookup instead of one query per row to find which rows
    // already have their own occupying batch offer.
    const keys = resolved.map((r) => ({ item_code: r.item_code, outlet_id: r.outlet_id, batch_no: r.batch_no }));
    const occupyingByKey = await this.offersV3Repo.findOccupyingBatchOffersByKeys(keys);
    const untaggedCandidates = resolved
      .filter((row) => !occupyingByKey.has(`${row.item_code}|${row.outlet_id}|${row.batch_no}`))
      .map((row) => ({ item_code: row.item_code, outlet_id: row.outlet_id, batch_no: row.batch_no }));
    const untagged = await this.detectUntaggedBatchesBulk(untaggedCandidates);

    await this.offersV3Repo.upsertUploadMeta("price", {
      total_rows: resolved.length,
      total_products: distinctCount(resolved, "item_code"),
      uploaded_by: created_by,
    });

    return {
      code: 200,
      upserted: resolved.length,
      unresolvedOutlets,
      skippedInvalidRows: skippedRows.length,
      skippedRows,
      untagged,
    };
  }

  // ---------------------------------------------------------------------
  // Untagged-batch alerts
  // ---------------------------------------------------------------------

  async listUntaggedBatches(status = "pending") {
    return this.offersV3Repo.listUntaggedBatches(status);
  }

  async dismissUntaggedBatch(id) {
    return this.offersV3Repo.dismissUntaggedBatchAlert(id);
  }

  // ---------------------------------------------------------------------
  // Low-stock warnings (item-level offers only)
  // ---------------------------------------------------------------------

  async listLowStockWarnings(status = "pending") {
    return this.offersV3Repo.listLowStockWarnings(status);
  }

  async dismissLowStockWarning(id) {
    return this.offersV3Repo.dismissLowStockWarning(id);
  }

  // ---------------------------------------------------------------------
  // Upload meta (rows/products/last-uploaded-at summary per upload type)
  // ---------------------------------------------------------------------

  async getUploadMeta() {
    return this.offersV3Repo.getUploadMeta();
  }

  // ---------------------------------------------------------------------
  // Selling-price mismatch check
  // ---------------------------------------------------------------------

  async computeMismatches() {
    const mismatches = [];

    const itemOffers = await this.offersV3Repo.listItemOffers({ status: "active" });
    for (const offer of itemOffers) {
      const prices = await this.offersV3Repo.getPricesForItem(offer.item_code);
      for (const price of prices) {
        if (price.mrp == null || price.selling_price == null) continue;
        const expected = computeExpectedSelling(offer.offer_type, offer.value, price.mrp);
        if (expected == null) continue;
        const roundedExpected = Math.round(expected * 100) / 100;
        const actual = Number(price.selling_price);
        if (Math.round(actual * 100) !== Math.round(roundedExpected * 100)) {
          mismatches.push({
            scope: "item",
            offer_id: offer.id,
            item_code: offer.item_code,
            item_name: offer.item_name,
            outlet_id: price.outlet_id,
            outlet_name: price.outlet_name,
            batch_no: price.batch_no,
            offer_type: offer.offer_type,
            value: offer.value,
            mrp: price.mrp,
            expected_selling_price: roundedExpected,
            actual_selling_price: actual,
          });
        }
      }
    }

    const batchOffers = await this.offersV3Repo.listBatchOffers({ status: "active" });
    for (const offer of batchOffers) {
      const price = await this.offersV3Repo.getPriceForBatch(offer.item_code, offer.outlet_id, offer.batch_no);
      if (!price || price.mrp == null || price.selling_price == null) continue;
      const expected = computeExpectedSelling(offer.offer_type, offer.value, price.mrp);
      if (expected == null) continue;
      const roundedExpected = Math.round(expected * 100) / 100;
      const actual = Number(price.selling_price);
      if (Math.round(actual * 100) !== Math.round(roundedExpected * 100)) {
        mismatches.push({
          scope: "batch",
          offer_id: offer.id,
          item_code: offer.item_code,
          item_name: offer.item_name,
          outlet_id: offer.outlet_id,
          outlet_name: offer.outlet_name,
          batch_no: offer.batch_no,
          offer_type: offer.offer_type,
          value: offer.value,
          mrp: price.mrp,
          expected_selling_price: roundedExpected,
          actual_selling_price: actual,
        });
      }
    }

    return mismatches;
  }

  // ---------------------------------------------------------------------
  // One-time go-live import (already-confirmed offers, no validation)
  // ---------------------------------------------------------------------

  async importOffers(rows, created_by) {
    this._outletsCache = null;
    let itemInserted = 0;
    let batchInserted = 0;
    const skipped = [];
    const failed = [];
    const insertedItemCodes = [];

    for (const row of rows) {
      const item_code = parseInt(row.item_code, 10);
      const offer_type = String(row.offer_type ?? "").trim().toLowerCase();
      const value = Number(row.value);
      if (!item_code) {
        skipped.push({ ...row, _reason: "Missing or invalid Item Code" });
        continue;
      }
      if (!OFFER_TYPES.includes(offer_type)) {
        skipped.push({ ...row, _reason: `Unrecognized Offer Type: "${row.offer_type ?? ""}"` });
        continue;
      }
      if (Number.isNaN(value)) {
        skipped.push({ ...row, _reason: "Value is not numeric" });
        continue;
      }

      const scope = String(row.scope ?? "").trim().toLowerCase();
      try {
        if (scope === "batch") {
          const batch_no = String(row.batch_no ?? "").trim();
          const outlet_id = await this.resolveOutletId(row.outlet);
          if (!batch_no) {
            skipped.push({ ...row, _reason: "Missing Batch No" });
            continue;
          }
          if (!outlet_id) {
            skipped.push({ ...row, _reason: `Outlet not found: "${row.outlet ?? ""}"` });
            continue;
          }
          const status = ["active", "zero_stock_flagged", "batch_zero_ended", "inactive"].includes(
            String(row.status ?? "").trim().toLowerCase()
          )
            ? String(row.status).trim().toLowerCase()
            : "active";
          await this.offersV3Repo.createBatchOffer({
            item_code,
            outlet_id,
            batch_no,
            offer_type,
            value,
            status,
            created_by,
          });
          batchInserted += 1;
          insertedItemCodes.push(item_code);
        } else {
          const status = ["active", "inactive"].includes(String(row.status ?? "").trim().toLowerCase())
            ? String(row.status).trim().toLowerCase()
            : "active";
          const parsedThreshold = parseInt(row.threshold_qty, 10);
          const threshold_qty = Number.isInteger(parsedThreshold) && parsedThreshold >= 0 ? parsedThreshold : 0;
          await this.offersV3Repo.createItemOffer({
            item_code,
            offer_type,
            value,
            threshold_qty,
            status,
            created_by,
          });
          itemInserted += 1;
          insertedItemCodes.push(item_code);
        }
      } catch (err) {
        const reason =
          err.code === "ER_NO_REFERENCED_ROW_2" || err.code === "ER_NO_REFERENCED_ROW"
            ? "item_code not found in product master"
            : err.code === "ER_DUP_ENTRY"
              ? "duplicate row"
              : err.message || String(err);
        logError("USECASE.OFFERS_V3.IMPORT_OFFERS.ROW_FAILED", reason, { item_code, scope });
        failed.push({ ...row, item_code, scope: scope === "batch" ? "batch" : "item", _reason: reason });
      }
    }

    if (itemInserted + batchInserted > 0) {
      await this.offersV3Repo.upsertUploadMeta("import", {
        total_rows: itemInserted + batchInserted,
        total_products: new Set(insertedItemCodes).size,
        uploaded_by: created_by,
      });
    }

    return {
      code: 200,
      itemInserted,
      batchInserted,
      skipped: skipped.length,
      failed,
      skippedRows: [...skipped, ...failed],
    };
  }
}

module.exports = (offersV3Repo, outletRepo) => {
  return new OffersV3Usecase(offersV3Repo, outletRepo);
};

module.exports.computeExpectedSelling = computeExpectedSelling;
module.exports.validateOfferValue = validateOfferValue;
