const { PURCHASE_TELEGRAM_CHAT_ID } = require("../constants/telegram");
const { normalizePurchaseTaxArrays } = require("../utils/purchase_tax");
const { financialYearBounds } = require("../utils/financial_year");
const {
  dayOf,
  purchaseDiscrepancies,
  hasBlockingDiscrepancy,
} = require("../utils/purchase_discrepancy");

class PurchaseUsecase {
  constructor(purchaseRepo, outletUsecase) {
    this.purchaseRepo = purchaseRepo;
    this.outletUsecase = outletUsecase;
    this.telegram = require("../services/telegram")();
  }

  async createPurchase(purchase) {
    try {
      const result = await this.purchaseRepo.create(
        normalizePurchaseTaxArrays(purchase)
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  /**
   * The MRC ref no is the Tally voucher number and restarts every financial
   * year, so it must stay unique per outlet within a year. Re-checked when
   * Accounts move a bill's MRC date into another year (or the ref no
   * changes); a save that keeps both is not re-checked, so an old duplicate
   * already in the table does not block unrelated edits.
   * @returns the clashing purchase, or null
   */
  async _refnoClash(purchase) {
    const day = dayOf(purchase.mmh_mrc_dt);
    if (!day || purchase.mmh_mrc_refno == null || purchase.mmh_mrc_refno === "") return null;
    const fy = financialYearBounds(day);
    const stored = await this.purchaseRepo.getById(purchase.purchase_id);
    if (stored && stored.code === 200) {
      const storedDay = dayOf(stored.data.mmh_mrc_dt);
      const sameYear = storedDay && financialYearBounds(storedDay).start === fy.start;
      const sameRef = String(stored.data.mmh_mrc_refno).trim() === String(purchase.mmh_mrc_refno).trim();
      if (sameYear && sameRef) return null;
    }
    const rows = await this.purchaseRepo.findByOutletRefnos([
      [purchase.retail_outlet_id, String(purchase.mmh_mrc_refno).trim(), fy.start, fy.end],
    ]);
    return rows.find((r) => Number(r.purchase_id) !== Number(purchase.purchase_id)) || null;
  }

  async updatePurchaseWithInternal(
    purchase,
    purchaseInternal,
    send_not_matched_notification
  ) {
    try {
      const clash = await this._refnoClash(purchase);
      if (clash) {
        return {
          code: 409,
          msg: `MRC ref no ${purchase.mmh_mrc_refno} is already used by purchase ${clash.purchase_id} at this branch in the same financial year. Check the MRC date.`,
        };
      }
      const result = await this.purchaseRepo.updatePurchaseWithInternal(
        normalizePurchaseTaxArrays(purchase),
        purchaseInternal
      );

      if (send_not_matched_notification) {
        try {
          const outlet = await this.outletUsecase.getOutletById(
            purchase.retail_outlet_id
          );
          const outletName = outlet.length > 0 ? outlet[0].outlet_name : "N/A";

          await this.telegram.sendMessage(
            PURCHASE_TELEGRAM_CHAT_ID,
            `✅ Purchase #${purchase.mmh_mrc_refno} (${outletName}) has been updated with ${purchaseInternal.total_amount} (MRC Amount: ${purchase.mmh_mrc_amt})`
          );
        } catch (error) {
          // do nothing
        }
      }
      return result;
    } catch (error) {
      throw error;
    }
  }

  async deletePurchase(purchaseId) {
    try {
      const result = await this.purchaseRepo.delete(purchaseId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAllPurchases(filters) {
    try {
      const result = await this.purchaseRepo.getAll(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getPurchaseById(purchaseId) {
    try {
      const result = await this.purchaseRepo.getById(purchaseId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getPurchaseByMmhMrcRefno(mmh_mrc_refno, retail_outlet_id = null) {
    try {
      return await this.purchaseRepo.getByMmhMrcRefno(
        mmh_mrc_refno,
        retail_outlet_id
      );
    } catch (error) {
      throw error;
    }
  }

  findByOutletRefnos(keys) {
    return this.purchaseRepo.findByOutletRefnos(keys);
  }

  upsertRetailPilotPurchase(payload) {
    return this.purchaseRepo.upsertRetailPilotPurchase(payload);
  }

  async bulkCreatePurchase(purchaseList) {
    try {
      const result = await this.purchaseRepo.bulkCreate(purchaseList);
      return result;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Approval is refused while the bill has a blocking discrepancy
   * (utils/purchase_discrepancy.js) - Tally would get a wrong voucher.
   */
  async updatePurchaseFlags(purchaseId, flags) {
    try {
      if (flags && (flags.is_approved === true || flags.is_approved === 1)) {
        const current = await this.purchaseRepo.getById(purchaseId);
        if (current.code !== 200) return { code: 404, msg: "Purchase not found" };
        const discrepancies = current.data.discrepancies || purchaseDiscrepancies(current.data);
        if (hasBlockingDiscrepancy(discrepancies)) {
          return {
            code: 409,
            msg: `Correct this bill before approving: ${discrepancies
              .filter((d) => d.severity === "block")
              .map((d) => d.message)
              .join(" ")}`,
            discrepancies,
          };
        }
      }
      const result = await this.purchaseRepo.updateFlags(purchaseId, flags);
      return result;
    } catch (error) {
      throw error;
    }
  }

  deleteTallyResponseForPurchase(purchaseId) {
    return this.purchaseRepo.deleteTallyResponseForPurchase(purchaseId);
  }

  async deleteTallyResponse(VoucherNo) {
    try {
      const result = await this.purchaseRepo.deleteTallyResponse(VoucherNo);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (purchaseRepo, outletUsecase) => {
  return new PurchaseUsecase(purchaseRepo, outletUsecase);
};
