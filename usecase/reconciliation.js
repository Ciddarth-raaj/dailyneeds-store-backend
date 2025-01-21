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

  async createOrUpdateEpayment(reconciliation) {
    try {
      const result = await this.reconciliationRepo.createOrUpdateEpayment(
        reconciliation
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getSales(filters) {
    try {
      const result = await this.reconciliationRepo.getSales(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (reconciliationRepo) => {
  return new ReconciliationUsecase(reconciliationRepo);
};
