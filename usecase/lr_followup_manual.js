const { istDateOf } = require("../utils/istDate");
const { toDateOnly } = require("../utils/lr_followup");
const { WAREHOUSE_OUTLET_ID } = require("../constants/outlets");

/**
 * Create LR Follow-up - the manual entry for goods a supplier dispatches on
 * credit, the second way a follow-up starts (the first is an Advance
 * Request reaching `paid`).
 *
 * The entry is kept in `credit_purchases` and its follow-up has source type
 * 'CREDIT_PURCHASE': the internal names this entry shipped with, kept
 * rather than migrated. The API calls it MANUAL.
 *
 * Saving one creates its LR Follow-up in the SAME transaction, so an entry
 * never exists without its follow-up. Every such delivery goes to the
 * Warehouse, so the outlet is the Warehouse and is never asked for.
 *
 * One press of Save is one follow-up, however often it is retried: the
 * client's request_key finds the first one.
 */

const named = (name, message) => {
  const err = new Error(message);
  err.name = name;
  return err;
};

const isDuplicateKey = (err) => err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062);

const blank = (v) => v === undefined || v === null || v === "";

class LrFollowupManualUsecase {
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
    return storeIds.includes(Number(outletId));
  }

  validate(data) {
    if (blank(data.distributor_code)) throw named("BusinessRuleError", "Supplier is required.");
    if (blank(data.transporter_id)) {
      throw named("BusinessRuleError", "Transporter is required - select one from the Transporter Master.");
    }
    const dispatch = toDateOnly(data.dispatch_date);
    if (dispatch && dispatch > this.today()) {
      throw named("BusinessRuleError", "Dispatch Date cannot be in the future.");
    }
    const expected = toDateOnly(data.expected_delivery_date);
    if (expected && dispatch && expected < dispatch) {
      throw named("BusinessRuleError", "Expected Delivery Date cannot be before the Dispatch Date.");
    }
    return {
      distributor_code: data.distributor_code,
      outlet_id: WAREHOUSE_OUTLET_ID,
      transporter_id: data.transporter_id,
      lr_no: data.lr_no ? String(data.lr_no).trim() || null : null,
      dispatch_date: dispatch,
      expected_delivery_date: expected,
      remarks: data.remarks ? String(data.remarks).trim() || null : null,
      request_key: data.request_key || null,
    };
  }

  /** Creates the entry and its follow-up; answers with the follow-up's detail. */
  async create(data, actorId, storeIds) {
    const entry = this.validate(data);
    if (!this.inScope(entry.outlet_id, storeIds)) {
      throw named(
        "ForbiddenError",
        "LR Follow-ups are delivered to the Warehouse. You need the Warehouse as your branch, or 'LR Follow-up: All Stores', to create one."
      );
    }

    let followupId;
    try {
      followupId = await this.repo.transaction(async (conn) => {
        if (entry.request_key) {
          const replay = await this.repo.findByRequestKey(entry.request_key, conn);
          if (replay) return this.followupIdOf(replay, conn);
        }

        await this.transporters.assertSelectable(entry.transporter_id, null, conn);

        const newId = await this.repo.insert({ ...entry, created_by: actorId }, conn);
        const result = await this.lrFollowup.createForManual(newId, actorId, conn);
        return result.lr_followup_id;
      });
    } catch (err) {
      if (!isDuplicateKey(err) || !entry.request_key) throw err;
      // Lost a race with a retry of the same submission: answer with its row.
      const replay = await this.repo.findByRequestKey(entry.request_key);
      if (!replay) throw err;
      followupId = await this.followupIdOf(replay);
    }

    return this.lrFollowup.getDetail(followupId, storeIds);
  }

  async followupIdOf(entryId, conn = null) {
    const id = await this.repo.followupIdOf(entryId, conn);
    if (!id) throw named("NotFoundError", "Follow-up not found");
    return id;
  }
}

module.exports = (repo, lrFollowup, transporters, options) =>
  new LrFollowupManualUsecase(repo, lrFollowup, transporters, options);
