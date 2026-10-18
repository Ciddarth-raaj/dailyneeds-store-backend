const { PURCHASE_TELEGRAM_CHAT_ID } = require("../constants/telegram");
const { normalizePurchaseTaxArrays } = require("../utils/purchase_tax");
const { financialYearBounds } = require("../utils/financial_year");
const { dayOf, hasBlockingDiscrepancy } = require("../utils/purchase_discrepancy");
const { sourceOf } = require("../utils/retailpilot_merge");

/** purchase_internal values whose change Accounts' audit trail records. */
const INTERNAL_AUDIT_FIELDS = [
  "round_off", "total_amount", "cash_discount", "scheme_difference",
  "cost_difference", "due", "freight_charges", "supplier_credit_note",
];

/**
 * What a Purchase-screen save changed: purchase fields compared as the
 * RetailPilot merge compares them (dates by day, tax as one unit), and the
 * internal adjustments. { field: { from, to } }.
 */
function correctionDiff(before, purchase, internal) {
  const was = sourceOf(before);
  const now = sourceOf({ ...before, ...purchase });
  const diff = {};
  for (const k of Object.keys(now)) {
    if (was[k] !== now[k]) diff[k] = { from: was[k], to: now[k] };
  }
  if (String(before.mmh_mrc_refno ?? "").trim() !== String(purchase.mmh_mrc_refno ?? "").trim()) {
    diff.mmh_mrc_refno = { from: before.mmh_mrc_refno, to: purchase.mmh_mrc_refno };
  }
  for (const k of INTERNAL_AUDIT_FIELDS) {
    if (!internal || internal[k] === undefined) continue;
    const from = before[k] == null ? null : Number(before[k]);
    const to = internal[k] == null || internal[k] === "" ? 0 : Number(internal[k]);
    if (from !== to) diff[k] = { from, to };
  }
  return diff;
}

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
  async _refnoClash(purchase, { always = false } = {}) {
    const day = dayOf(purchase.mmh_mrc_dt);
    if (!day || purchase.mmh_mrc_refno == null || purchase.mmh_mrc_refno === "") return null;
    const fy = financialYearBounds(day);
    const stored = always ? null : await this.purchaseRepo.getById(purchase.purchase_id);
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

  /**
   * A save from the Purchase screen. actor: { user_id, employee_id } of the
   * session, for the audit trail. On a RetailPilot bill it also confirms the
   * round-off as Accounts' own, so the sync never refreshes it again.
   */
  async updatePurchaseWithInternal(
    purchase,
    purchaseInternal,
    send_not_matched_notification,
    actor = null
  ) {
    try {
      const clash = await this._refnoClash(purchase);
      if (clash) {
        return {
          code: 409,
          msg: `MRC ref no ${purchase.mmh_mrc_refno} is already used by purchase ${clash.purchase_id} at this branch in the same financial year. Check the MRC date.`,
        };
      }
      const before = await this.purchaseRepo.getForAudit(purchase.purchase_id);
      const result = await this.purchaseRepo.updatePurchaseWithInternal(
        normalizePurchaseTaxArrays(purchase),
        purchaseInternal
      );
      if (before) {
        const changes = correctionDiff(before, normalizePurchaseTaxArrays(purchase), purchaseInternal);
        if (Object.keys(changes).length) {
          await this.purchaseRepo.addAuditLog(purchase.purchase_id, "accounts_correction", actor, {
            retailpilot: !!before.retailpilot_source,
            changes,
          });
        }
        if (before.retailpilot_source) {
          await this.purchaseRepo.confirmRetailPilotRoundOff(purchase.purchase_id);
        }
      }

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
   * Approval of a RetailPilot bill is refused while it has a blocking
   * discrepancy (utils/purchase_discrepancy.js) or while another bill at the
   * branch holds its MRC ref no in the same financial year - Tally would get
   * a wrong or duplicate voucher. A GoFrugal bill's findings are review
   * only, so its approval is unchanged. actor is recorded in the audit trail.
   */
  async updatePurchaseFlags(purchaseId, flags, actor = null) {
    try {
      const approving = flags && (flags.is_approved === true || flags.is_approved === 1);
      if (approving) {
        const current = await this.purchaseRepo.getById(purchaseId);
        if (current.code !== 200) return { code: 404, msg: "Purchase not found" };
        const discrepancies = current.data.discrepancies || [];
        if (current.data.retailpilot && hasBlockingDiscrepancy(discrepancies)) {
          return {
            code: 409,
            msg: `Correct this bill before approving: ${discrepancies
              .filter((d) => d.severity === "block")
              .map((d) => d.message)
              .join(" ")}`,
            discrepancies,
          };
        }
        if (current.data.retailpilot) {
          const clash = await this._refnoClash({ ...current.data, purchase_id: purchaseId }, { always: true });
          if (clash) {
            return {
              code: 409,
              msg: `MRC ref no ${current.data.mmh_mrc_refno} is also used by purchase ${clash.purchase_id} at this branch in the same financial year. Resolve the duplicate before approving.`,
            };
          }
        }
      }
      const result = await this.purchaseRepo.updateFlags(purchaseId, flags);
      if (result && result.code === 200 && flags && flags.is_approved !== undefined) {
        await this.purchaseRepo.addAuditLog(purchaseId, flags.is_approved ? "approved" : "unapproved", actor, null);
      }
      return result;
    } catch (error) {
      throw error;
    }
  }

  deleteTallyResponseForPurchase(purchaseId, actor = null) {
    return this.purchaseRepo.deleteTallyResponseForPurchase(purchaseId, actor);
  }

  async deleteTallyResponse(VoucherNo, actor = null) {
    try {
      const result = await this.purchaseRepo.deleteTallyResponse(VoucherNo, actor);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (purchaseRepo, outletUsecase) => {
  return new PurchaseUsecase(purchaseRepo, outletUsecase);
};
