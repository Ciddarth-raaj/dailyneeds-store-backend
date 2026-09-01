class GstPurchaseNo2aUsecase {
  constructor(gstPurchaseNo2aRepo) {
    this.gstPurchaseNo2aRepo = gstPurchaseNo2aRepo;
  }

  async getAll(filters) {
    return this.gstPurchaseNo2aRepo.getAll(filters);
  }

  /**
   * Accept purchases as never going to appear in GSTR-2A.
   * Only a purchase carrying no tax qualifies, and that is decided here from
   * the stored figures: a taxed invoice missing from 2A is input credit to
   * chase, not a row to write off.
   */
  async accept({ gst_tally_purchase_ids, accepted_by }) {
    const requested = [
      ...new Set(
        (gst_tally_purchase_ids || [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id))
      ),
    ];

    if (!requested.length) {
      return { code: 422, msg: "No purchases given" };
    }

    const eligible = await this.gstPurchaseNo2aRepo.filterZeroTaxPurchaseIds(
      requested
    );
    const eligibleSet = new Set(eligible);
    const rejected = requested.filter((id) => !eligibleSet.has(id));

    if (!eligible.length) {
      return {
        code: 422,
        msg: "Only purchases with zero total tax can be accepted",
        rejected,
      };
    }

    await this.gstPurchaseNo2aRepo.acceptMany(eligible, accepted_by);

    return {
      code: 200,
      accepted: eligible,
      accepted_count: eligible.length,
      // Named so the caller can report what it could not accept rather than
      // reporting a clean success over a partial one.
      rejected,
    };
  }

  async remove(gst_tally_purchase_id) {
    return this.gstPurchaseNo2aRepo.deleteByPurchaseId(gst_tally_purchase_id);
  }
}

module.exports = (gstPurchaseNo2aRepo) => {
  return new GstPurchaseNo2aUsecase(gstPurchaseNo2aRepo);
};
