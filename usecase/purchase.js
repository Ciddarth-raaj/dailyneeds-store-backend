class PurchaseUsecase {
  constructor(purchaseRepo) {
    this.purchaseRepo = purchaseRepo;
  }

  async createPurchase(purchase) {
    try {
      const result = await this.purchaseRepo.create(purchase);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async updatePurchaseWithInternal(purchase, purchaseInternal) {
    try {
      const result = await this.purchaseRepo.updatePurchaseWithInternal(
        purchase,
        purchaseInternal
      );
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

  async bulkCreatePurchase(purchaseList) {
    try {
      const result = await this.purchaseRepo.bulkCreate(purchaseList);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (purchaseRepo) => {
  return new PurchaseUsecase(purchaseRepo);
};
