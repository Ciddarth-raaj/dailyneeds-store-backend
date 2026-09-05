const logger = require("../utils/logger");
const telegram = require("../services/telegram")();
const { OFFERS_V3_TELEGRAM_CHAT_ID } = require("../constants/telegram");

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

// Legacy Telegram Markdown treats _ * ` [ as formatting and rejects the
// whole message if one is unmatched -- backslash-escaping them is
// documented to work but proved unreliable in practice (a real product
// name still triggered "can't parse entities"), so strip them outright
// instead. Safer than a parse error silently killing the alert.
function stripMarkdown(value) {
  return String(value ?? "").replace(/[_*`[\]]/g, "");
}

const OFFER_TYPE_TELEGRAM_LABELS = {
  percentage: "Percentage Discount",
  flat: "Flat Discount",
  fixed_price: "Fixed Price",
};

function formatOfferValueForTelegram(offer_type, value) {
  const v = Number(value);
  if (offer_type === "percentage") return `${v}%`;
  return `₹${v.toFixed(2)}`;
}

function formatOfferTypeForTelegram(offer_type) {
  return OFFER_TYPE_TELEGRAM_LABELS[offer_type] ?? stripMarkdown(offer_type);
}

function buildItemOfferTelegramMessage(headline, { item_code, item_name, offer_type, value, threshold_qty }) {
  const lines = [
    headline,
    "",
    `🔢 Item Code: ${item_code}`,
    `📦 Item: ${stripMarkdown(item_name)}`,
    `🏷️ Offer Type: ${formatOfferTypeForTelegram(offer_type)}`,
    `💰 Offer Value: ${formatOfferValueForTelegram(offer_type, value)}`,
  ];
  if (threshold_qty !== undefined) {
    lines.push(`🎯 Threshold Qty: ${threshold_qty}`);
  }
  return lines.join("\n");
}

function buildBatchOfferTelegramMessage(headline, { item_code, item_name, outlet_name, batch_no, offer_type, value }) {
  return [
    headline,
    "",
    `🔢 Item Code: ${item_code}`,
    `📦 Item: ${stripMarkdown(item_name)}`,
    `🏬 Outlet: ${stripMarkdown(outlet_name)}`,
    `🔖 Batch No: ${stripMarkdown(batch_no)}`,
    `🏷️ Offer Type: ${formatOfferTypeForTelegram(offer_type)}`,
    `💰 Offer Value: ${formatOfferValueForTelegram(offer_type, value)}`,
  ].join("\n");
}

/**
 * The terms of an offer that were actually changed by an edit, as old -> new.
 *
 * An update carries only the fields the form submitted, and a field can be
 * submitted holding the value it already had, so "present in the payload" is
 * not the same as changed. Compared as numbers where both sides are numeric,
 * since a value arrives as "10" from a form and comes back as 10.00 from a
 * DECIMAL column - the same offer, spelled differently.
 */
function changedOfferTerms(existing, data, fields) {
  const beforeType = existing.offer_type;
  const afterType = data.offer_type ?? existing.offer_type;
  const changes = [];
  for (const { key, label, format } of fields) {
    if (data[key] === undefined) continue;
    const before = existing[key];
    const after = data[key];
    const bothNumeric =
      before != null &&
      after != null &&
      !Number.isNaN(Number(before)) &&
      !Number.isNaN(Number(after));
    const same = bothNumeric
      ? Number(before) === Number(after)
      : String(before ?? "") === String(after ?? "");
    if (same) continue;
    changes.push({
      label,
      // Each side is formatted with its own offer type: switching a flat
      // discount to a percentage makes "20 -> 5" read as a cut when it is
      // "Rs20 off -> 5% off", which may be either.
      from: format ? format(before, beforeType) : String(before ?? "—"),
      to: format ? format(after, afterType) : String(after ?? "—"),
    });
  }
  return changes;
}

const ITEM_OFFER_TERMS = [
  { key: "offer_type", label: "Offer Type", format: (v) => formatOfferTypeForTelegram(v) },
  {
    key: "value",
    label: "Offer Value",
    format: (v, offer_type) => formatOfferValueForTelegram(offer_type, v),
  },
  { key: "threshold_qty", label: "Threshold Qty" },
];

const BATCH_OFFER_TERMS = ITEM_OFFER_TERMS.filter(
  (f) => f.key !== "threshold_qty"
);

/** The change list appended to an edit alert, one line per changed term. */
function buildChangeLines(changes) {
  return ["", "✏️ Changed:", ...changes.map((c) => `• ${c.label}: ${c.from} → ${c.to}`)];
}

// Telegram alerts are best-effort: a failure here must never break the
// offer create/update/upload flow that triggered it. Returns the outcome
// (rather than throwing) so callers can optionally surface it for
// debugging without the alert itself ever failing the request.
async function notifyOffersV3(message) {
  try {
    await telegram.sendMessage(OFFERS_V3_TELEGRAM_CHAT_ID, message, { disableNotification: false });
    return { sent: true };
  } catch (err) {
    logError("USECASE.OFFERS_V3.TELEGRAM_NOTIFY_FAILED", err.toString(), { message });
    return { sent: false, error: err.message || err.toString() };
  }
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
 * Flat / fixed price: 0 < value, and below the item's current MRP when one is
 * known. An item with no price on file is allowed - see below.
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
  if (!(v > 0)) {
    const err = new Error("Value must be greater than 0");
    err.code = 400;
    throw err;
  }
  // An item with no price on file yet is not an error. Stock moves out of the
  // warehouse before it is ever priced at an outlet, and the offer is decided
  // before then - refusing it would mean the day's offers wait on a spreadsheet
  // rather than on anyone's decision. The MRP is a ceiling when one is known
  // and nothing when it is not; the Price Mismatches tab is what catches a
  // value that turns out to be wrong once the item is priced.
  if (mrp == null) return;
  const m = Number(mrp);
  if (!(v < m)) {
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
  constructor(offersV3Repo, outletRepo, priceCheckerRepo) {
    this.offersV3Repo = offersV3Repo;
    this.outletRepo = outletRepo;
    this.priceCheckerRepo = priceCheckerRepo;
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
      if (result.code === 200) {
        const created = await this.offersV3Repo.getItemOfferById(result.id);
        await notifyOffersV3(
          buildItemOfferTelegramMessage("🟢 ITEM-LEVEL OFFER CREATED", {
            item_code: data.item_code,
            item_name: created?.item_name,
            offer_type: data.offer_type,
            value: data.value,
            threshold_qty: data.threshold_qty,
          })
        );
      }
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
        await notifyOffersV3(
          buildItemOfferTelegramMessage("🔴 ITEM-LEVEL OFFER MADE INACTIVE", {
            item_code: existing.item_code,
            item_name: existing.item_name,
            offer_type: existing.offer_type,
            value: existing.value,
          })
        );
      } else if (nextStatus === "active" && existing.status !== "active") {
        await notifyOffersV3(
          buildItemOfferTelegramMessage("🟢 ITEM-LEVEL OFFER REACTIVATED", {
            item_code: existing.item_code,
            item_name: existing.item_name,
            offer_type: nextOfferType,
            value: nextValue,
          })
        );
      } else {
        // The status did not move, so an alert here is about the terms
        // themselves changing - a shopper sees a different price and nobody
        // was told. The two status branches above already carry the terms
        // they end on, so this stays in the else and never doubles up.
        const changes = changedOfferTerms(existing, data, ITEM_OFFER_TERMS);
        if (changes.length) {
          await notifyOffersV3(
            [
              buildItemOfferTelegramMessage("✏️ ITEM-LEVEL OFFER EDITED", {
                item_code: existing.item_code,
                item_name: existing.item_name,
                offer_type: nextOfferType,
                value: nextValue,
                threshold_qty:
                  data.threshold_qty !== undefined
                    ? data.threshold_qty
                    : existing.threshold_qty,
              }),
              ...buildChangeLines(changes),
            ].join("\n")
          );
        }
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

  /**
   * The batches known for an item at an outlet, so a batch offer is picked
   * from what exists rather than typed from memory. Which batch offer already
   * occupies one rides along, since that batch cannot take another.
   */
  async listBatchesForItemOutlets(item_code, outlet_ids) {
    try {
      const ids = (outlet_ids || []).map((o) => Number(o)).filter(Boolean);
      if (!ids.length) return [];
      const [rows, offers] = await Promise.all([
        this.offersV3Repo.listBatchesForItemOutlets(item_code, ids),
        this.offersV3Repo.listBatchOffers({ item_code, status: "active" }),
      ]);
      const takenBy = new Map(
        offers
          .filter((o) => ids.includes(Number(o.outlet_id)))
          .map((o) => [`${o.outlet_id}|${o.batch_no}`, o.id])
      );

      // One row per batch number, not per outlet: the same batch carries the
      // same number wherever it landed, and the offer is being made on the
      // batch. Which outlets hold it, and which of those already have an
      // offer on it, ride along so the choice is made with both in view.
      const byBatch = new Map();
      for (const row of rows) {
        const key = String(row.batch_no);
        if (!byBatch.has(key)) {
          byBatch.set(key, {
            batch_no: row.batch_no,
            mrp: row.mrp,
            selling_price: row.selling_price,
            total_stock_qty: 0,
            outlets: [],
          });
        }
        const entry = byBatch.get(key);
        entry.total_stock_qty += Number(row.stock_qty ?? 0);
        entry.outlets.push({
          outlet_id: row.outlet_id,
          outlet_name: row.outlet_name,
          stock_qty: row.stock_qty,
          mrp: row.mrp,
          selling_price: row.selling_price,
          occupied_by_offer_id: takenBy.get(`${row.outlet_id}|${row.batch_no}`) ?? null,
        });
      }

      return [...byBatch.values()].sort((a, b) => {
        const aHas = a.total_stock_qty > 0 ? 1 : 0;
        const bHas = b.total_stock_qty > 0 ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
        return String(a.batch_no).localeCompare(String(b.batch_no));
      });
    } catch (err) {
      logError("USECASE.OFFERS_V3.LIST_BATCHES_FOR_ITEM_OUTLETS", err.toString(), {
        item_code,
        outlet_ids,
      });
      throw err;
    }
  }

  /**
   * The same batch offer across several outlets.
   *
   * A batch number is the supplier's, so one batch reaches many stores and the
   * offer is decided once for all of them - creating it store by store is the
   * same decision typed N times. Each outlet is still created through
   * createBatchOffer, so every rule it enforces holds per outlet, and the
   * outcomes are reported per outlet rather than collapsed into one failure:
   * an outlet whose batch already carries an offer should not stop the rest.
   */
  async createBatchOffersForOutlets({ item_code, outlet_ids, batch_no, offer_type, value }, created_by) {
    const ids = [...new Set((outlet_ids || []).map((o) => Number(o)).filter(Boolean))];
    if (!ids.length) return { code: 400, msg: "Select at least one outlet" };

    const results = [];
    for (const outlet_id of ids) {
      // Sequential rather than parallel: these contend for the same rows, and
      // a per-outlet outcome is more useful than a faster failure.
      // eslint-disable-next-line no-await-in-loop
      const result = await this.createBatchOffer(
        { item_code, outlet_id, batch_no, offer_type, value },
        created_by
      );
      results.push({
        outlet_id,
        ok: result.code === 200,
        id: result.id ?? null,
        msg: result.code === 200 ? null : result.msg,
      });
    }

    const created = results.filter((r) => r.ok).length;
    return {
      code: created > 0 ? 200 : 400,
      created,
      failed: results.length - created,
      results,
      ...(created === 0 ? { msg: results[0]?.msg ?? "No offers could be created" } : {}),
    };
  }

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
        const created = await this.offersV3Repo.getBatchOfferById(result.id);
        await notifyOffersV3(
          buildBatchOfferTelegramMessage("🟢 BATCH-SPECIFIC OFFER CREATED", {
            item_code: data.item_code,
            item_name: created?.item_name,
            outlet_name: created?.outlet_name ?? data.outlet_id,
            batch_no: data.batch_no,
            offer_type: data.offer_type,
            value: data.value,
          })
        );
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

      const result = await this.offersV3Repo.updateBatchOffer(id, data);
      if (nextStatus === "inactive" && existing.status !== "inactive") {
        await notifyOffersV3(
          buildBatchOfferTelegramMessage("🔴 BATCH-SPECIFIC OFFER MADE INACTIVE", {
            item_code: existing.item_code,
            item_name: existing.item_name,
            outlet_name: existing.outlet_name ?? existing.outlet_id,
            batch_no: existing.batch_no,
            offer_type: existing.offer_type,
            value: existing.value,
          })
        );
      } else if (nextStatus === "active" && existing.status !== "active") {
        await notifyOffersV3(
          buildBatchOfferTelegramMessage("🟢 BATCH-SPECIFIC OFFER REACTIVATED", {
            item_code: existing.item_code,
            item_name: existing.item_name,
            outlet_name: existing.outlet_name ?? existing.outlet_id,
            batch_no: existing.batch_no,
            offer_type: nextOfferType,
            value: nextValue,
          })
        );
      } else {
        const changes = changedOfferTerms(existing, data, BATCH_OFFER_TERMS);
        if (changes.length) {
          await notifyOffersV3(
            [
              buildBatchOfferTelegramMessage("✏️ BATCH-SPECIFIC OFFER EDITED", {
                item_code: existing.item_code,
                item_name: existing.item_name,
                outlet_name: existing.outlet_name ?? existing.outlet_id,
                batch_no: existing.batch_no,
                offer_type: nextOfferType,
                value: nextValue,
              }),
              ...buildChangeLines(changes),
            ].join("\n")
          );
        }
      }
      return result;
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
    const lowStock = await this.detectLowStockWarningsBulk();

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
   * Item-level offers only: for every item touched by this upload that
   * currently has an active item-level offer, sum its stock across every
   * outlet and batch and check that total against the offer's Threshold Qty —
   * the offer applies everywhere, so the signal is whether the item overall is
   * running low, not any one store/batch. A total at or below the threshold is
   * upserted into the low-stock warning queue; a total back above it clears
   * any existing warning for that item.
   *
   * Zero counts, and counts hardest: an offer advertising an item nobody can
   * buy is the worst version of what this queue is for. It used to be exempt,
   * on the reading that only a threshold triggers a warning - which meant an
   * item selling out cleared its own warning on the way past.
   *
   * Every active item offer is checked, not only the ones this upload carried.
   * An item missing from the sheet has no stock anywhere, which is exactly the
   * case worth reporting and exactly the one a by-upload check cannot see.
   */
  async detectLowStockWarningsBulk() {
    const thresholds = await this.offersV3Repo.getAllActiveItemOfferThresholds();
    if (thresholds.size === 0) return [];

    const relevantItemCodes = [...thresholds.keys()];
    const totals = await this.offersV3Repo.getTotalStockByItemCodes(relevantItemCodes);

    const toWarn = [];
    const toClear = [];
    for (const item_code of relevantItemCodes) {
      const threshold = thresholds.get(item_code);
      const total = totals.get(item_code) ?? 0;
      if (total <= threshold) {
        toWarn.push({ item_code, total_stock_qty: total, threshold_qty: threshold });
      } else {
        toClear.push(item_code);
      }
    }

    // Only alert on items newly crossing into low-stock this run, not ones
    // that were already pending (which would spam the group on every
    // subsequent upload while an item stays low).
    const existingPending = await this.offersV3Repo.listLowStockWarnings("pending");
    const alreadyPending = new Set(existingPending.map((w) => w.item_code));
    const newlyWarned = toWarn.filter((w) => !alreadyPending.has(w.item_code));

    await Promise.all([
      this.offersV3Repo.upsertLowStockWarnings(toWarn),
      this.offersV3Repo.clearLowStockWarningsByItemCodes(toClear),
    ]);

    if (newlyWarned.length > 0) {
      // Out of stock is not the same news as running low - an offer with
      // nothing behind it is live on the shelf edge right now - so the two are
      // listed apart rather than as one number to read carefully.
      const out = newlyWarned.filter((w) => Number(w.total_stock_qty) <= 0);
      const low = newlyWarned.filter((w) => Number(w.total_stock_qty) > 0);
      const lines = [];
      if (out.length) {
        lines.push("🔴 OUT OF STOCK - offer still live:");
        lines.push(...out.map((w) => `🔢 Item Code: ${w.item_code} | 📊 No stock in any store`));
      }
      if (low.length) {
        if (lines.length) lines.push("");
        lines.push("🟡 Running low:");
        lines.push(
          ...low.map(
            (w) => `🔢 Item Code: ${w.item_code} | 📊 Total Stock: ${w.total_stock_qty} / Threshold: ${w.threshold_qty}`
          )
        );
      }
      await notifyOffersV3(
        ["🟡 LOW STOCK WARNING (total across all stores)", "", ...lines].join("\n")
      );
    }

    return toWarn;
  }

  /**
   * Process an uploaded price file (Price Checker-style export: Item Code,
   * Outlet, Batch No, MRP, Selling Price, optional Landing Cost —
   * MRP/Selling Price are always the Old_MRP/Old_Selling_Price columns per
   * the fixed mapping rule, resolved on the frontend before this is
   * called). Updates mrp/selling_price (and landing_cost, when present) for
   * matching rows; also detects untagged new batches.
   */
  async processPriceUpload(rows, created_by) {
    const { resolved: withKeys, skippedRows: keySkippedRows, unresolvedOutlets } = await this.resolveUploadRows(
      rows
    );
    const withNumericPrice = withKeys.map((row) => {
      const landing_cost = Number(row.landing_cost);
      return {
        ...row,
        mrp: Number(row.mrp),
        selling_price: Number(row.selling_price),
        landing_cost: Number.isNaN(landing_cost) ? null : landing_cost,
      };
    });
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

    // One id for the whole sheet, sortable by when it was made, so the rows it
    // writes can later be told apart from the ones earlier sheets left behind.
    const priceUploadId = `${new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 17)}${Math.random().toString(36).slice(2, 8)}`;
    await this.offersV3Repo.upsertBatchPrice(resolved, priceUploadId);

    // The sheet replaces the table rather than adding to it. A batch it leaves
    // out is not sold any more, so its price - and the stock recorded against
    // it - describe nothing; keeping them means a price you corrected and
    // re-uploaded goes on being reported from the row you corrected it from.
    const removedBatches = await this.offersV3Repo.deleteBatchDataNotInUpload(
      priceUploadId
    );

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
      removedBatches,
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

  async dismissAllUntaggedBatches() {
    return this.offersV3Repo.dismissAllUntaggedBatches();
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

    // The price sheet lists every live batch, but this table is never pruned:
    // a batch that stops appearing keeps its last-known price. Checking it
    // reports a price nobody uploaded, against stock nobody can sell, so only
    // the batches in the current sheet are checked. Before the first stamped
    // upload there is no current sheet to name, and everything is checked as
    // before rather than nothing at all.
    const uploadId = await this.offersV3Repo.getLatestPriceUploadId();

    const itemOffers = await this.offersV3Repo.listItemOffers({ status: "active" });
    const batchOffers = await this.offersV3Repo.listBatchOffers({ status: "active" });

    const landingCostMap = await this.getLandingCostMap([
      ...itemOffers.map((o) => o.item_code),
      ...batchOffers.map((o) => o.item_code),
    ]);

    for (const offer of itemOffers) {
      const prices = await this.offersV3Repo.getPricesForItem(offer.item_code, uploadId);
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
            stock_qty: price.stock_qty,
            // Which price upload this row's price came from. The table is
            // never pruned, so a batch that stopped appearing in the sheet
            // keeps its last-known price and goes on being checked.
            price_uploaded_at: price.price_uploaded_at ?? null,
            landing_cost:
              price.landing_cost ??
              landingCostMap.get(`${offer.item_code}|${price.outlet_id}|${price.batch_no}`) ??
              null,
          });
        }
      }
    }

    for (const offer of batchOffers) {
      const price = await this.offersV3Repo.getPriceForBatch(
        offer.item_code,
        offer.outlet_id,
        offer.batch_no,
        uploadId
      );
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
          stock_qty: price.stock_qty,
          price_uploaded_at: price.price_uploaded_at ?? null,
          landing_cost:
            price.landing_cost ??
            landingCostMap.get(`${offer.item_code}|${offer.outlet_id}|${offer.batch_no}`) ??
            null,
        });
      }
    }

    return mismatches;
  }

  // Landing cost per item/outlet/batch, sourced from the latest Price
  // Checker upload (its own separate data feed) rather than Offers V3's own
  // price/stock tables, which don't carry cost.
  async getLandingCostMap(itemCodes) {
    const map = new Map();
    if (!this.priceCheckerRepo) return map;
    const uniqueCodes = [...new Set(itemCodes)];
    if (uniqueCodes.length === 0) return map;
    const rows = await this.priceCheckerRepo.listLandingCostsByProductIds(uniqueCodes);
    (rows || []).forEach((r) => {
      if (r.landing_cost == null) return;
      map.set(`${r.product_id}|${r.outlet_id}|${r.batch_no}`, Number(r.landing_cost));
    });
    return map;
  }

  async listGroupedItemsByProductId(itemCode) {
    return this.offersV3Repo.listGroupedItemsByProductId(itemCode);
  }

  async listGroupedItemsByProductIds(itemCodes) {
    return this.offersV3Repo.listGroupedItemsByProductIds(itemCodes);
  }

  // Outlet/batch-level breakdown of one merged (mrp, selling_price) row from
  // the grouped price-checker view -- drill-down for the GRN Price Checker
  // modal.
  async getOutletStockBreakdown(itemCode, mrp, sellingPrice) {
    return this.offersV3Repo.getPricesForItem(itemCode, null, mrp, sellingPrice);
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

module.exports = (offersV3Repo, outletRepo, priceCheckerRepo) => {
  return new OffersV3Usecase(offersV3Repo, outletRepo, priceCheckerRepo);
};

module.exports.computeExpectedSelling = computeExpectedSelling;
module.exports.validateOfferValue = validateOfferValue;
module.exports.changedOfferTerms = changedOfferTerms;
module.exports.ITEM_OFFER_TERMS = ITEM_OFFER_TERMS;
module.exports.BATCH_OFFER_TERMS = BATCH_OFFER_TERMS;
