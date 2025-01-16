class ReconciliationUsecase {
  constructor(reconciliationRepo) {
    this.reconciliationRepo = reconciliationRepo;
  }

  async createOrUpdateSales(reconciliation) {
    try {
      const result = await this.reconciliationRepo.createOrUpdateSales(
        reconciliation
      );
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (reconciliationRepo) => {
  return new ReconciliationUsecase(reconciliationRepo);
};
