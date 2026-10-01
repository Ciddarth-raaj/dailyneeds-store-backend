const { istDateOf } = require("../utils/istDate");
const { toDateOnly } = require("../utils/lr_followup");

/**
 * The minimal Credit Purchase entry.
 *
 * Saving one creates its LR Follow-up in the SAME transaction: there is no
 * moment at which a credit purchase exists without its follow-up, and no
 * screen that creates a follow-up for a purchase separately.
 *
 * Duplicate protection, three layers deep:
 *   * the client's request_key - one press of Save is one purchase, however
 *     often the request is retried;
 *   * supplier + bill reference is unique - the same supplier bill cannot be
 *     entered twice;
 *   * one follow-up per credit_purchase_id, by unique key.
 */

const named = (name, message) => {
  const err = new Error(message);
  err.name = name;
  return err;
};

const isDuplicateKey = (err) => err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062);

class CreditPurchaseUsecase {
  constructor(repo, lrFollowup, transporters, { clock = () => new Date() } = {}) {
    this.repo = repo;
    this.lrFollowup = lrFollowup;
    this.transporters = transporters;
    this.clock = clock;
  }

  today() {
    return istDateOf(this.clock());
  }

  inScope(outletId, storeIds) {
    if (storeIds === null || storeIds === undefined) return true;
    return outletId !== null && outletId !== undefined && storeIds.includes(Number(outletId));
  }

  validate(data) {
    const today = this.today();
    const bill = toDateOnly(data.bill_date);
    if (!bill) throw named("BusinessRuleError", "Invoice / Bill Date is required.");
    if (bill > today) throw named("BusinessRuleError", "Invoice / Bill Date cannot be in the future.");
    const dispatch = toDateOnly(data.dispatch_date);
    if (dispatch && dispatch > today) throw named("BusinessRuleError", "Dispatch Date cannot be in the future.");
    if (dispatch && dispatch < bill) {
      throw named("BusinessRuleError", "Dispatch Date cannot be before the Invoice / Bill Date.");
    }
    const expected = toDateOnly(data.expected_delivery_date);
    if (expected && expected < bill) {
      throw named("BusinessRuleError", "Expected Delivery Date cannot be before the Invoice / Bill Date.");
    }
    const billReference = String(data.bill_reference || "").trim();
    if (!billReference) throw named("BusinessRuleError", "Credit Purchase / Bill Reference is required.");
    return {
      distributor_code: data.distributor_code,
      bill_reference: billReference,
      amount: data.amount,
      bill_date: bill,
      outlet_id: data.outlet_id,
      transporter_id: data.transporter_id,
      lr_no: data.lr_no ? String(data.lr_no).trim() || null : null,
      dispatch_date: dispatch,
      expected_delivery_date: expected,
      remarks: data.remarks ? String(data.remarks).trim() || null : null,
      request_key: data.request_key || null,
    };
  }

  async create(data, actorId, storeIds) {
    const purchase = this.validate(data);
    if (!this.inScope(purchase.outlet_id, storeIds)) {
      throw named("ForbiddenError", "You can only raise a credit purchase for your own branch.");
    }

    let id;
    try {
      id = await this.repo.transaction(async (conn) => {
        if (purchase.request_key) {
          const replay = await this.repo.findByRequestKey(purchase.request_key, conn);
          if (replay) return replay;
        }

        const existing = await this.repo.findBySupplierBill(purchase.distributor_code, purchase.bill_reference, conn);
        if (existing) {
          throw named(
            "ConflictError",
            `Bill ${purchase.bill_reference} is already entered for this supplier as CP-${existing}.`
          );
        }

        await this.transporters.assertSelectable(purchase.transporter_id, null, conn);

        const newId = await this.repo.insert({ ...purchase, created_by: actorId }, conn);
        await this.lrFollowup.createForCreditPurchase(newId, actorId, conn);
        return newId;
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // Lost a race: either the same submission (request key) or the same
      // bill entered by someone else at the same moment.
      const replay = purchase.request_key ? await this.repo.findByRequestKey(purchase.request_key) : null;
      if (!replay) {
        throw named("ConflictError", `Bill ${purchase.bill_reference} is already entered for this supplier.`);
      }
      id = replay;
    }

    return this.getById(id, storeIds);
  }

  async getById(id, storeIds) {
    const row = await this.repo.getById(id);
    if (!row || !this.inScope(row.outlet_id, storeIds)) throw named("NotFoundError", "Credit purchase not found");
    return row;
  }

  async list(filters, storeIds, limit, offset) {
    const [items, count] = await Promise.all([
      this.repo.list(filters, storeIds, limit, offset),
      this.repo.count(filters, storeIds),
    ]);
    return { items, count, limit, offset };
  }
}

module.exports = (repo, lrFollowup, transporters, options) =>
  new CreditPurchaseUsecase(repo, lrFollowup, transporters, options);
