class PurchaseTallyUsecase {
  constructor(purchaseTallyRepo) {
    this.purchaseTallyRepo = purchaseTallyRepo;
  }

  /**
   * Stores Tally's response linked to its debit note (debit_note_id), so
   * the Debit Note screen shows it as pushed - as purchase responses are
   * linked to their purchase. A response that cannot be linked is still
   * stored, unlinked, as before (the screen then matches it to a GoFrugal
   * debit note by voucher number + outlet).
   */
  async create(data) {
    const { debitNoteId, ambiguous } = await this.purchaseTallyRepo.resolveDebitNoteForTallyResponse(data);
    const result = await this.purchaseTallyRepo.create({ ...data, debit_note_id: debitNoteId });
    return {
      ...result,
      debit_note_id: debitNoteId,
      ...(ambiguous ? { ambiguous_debit_note_ids: ambiguous } : {}),
    };
  }

  async getAll(filters) {
    try {
      const result = await this.purchaseTallyRepo.getAll(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getById(id) {
    try {
      const result = await this.purchaseTallyRepo.getById(id);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async delete(id) {
    try {
      const result = await this.purchaseTallyRepo.delete(id);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (purchaseTallyRepo) => {
  return new PurchaseTallyUsecase(purchaseTallyRepo);
};
