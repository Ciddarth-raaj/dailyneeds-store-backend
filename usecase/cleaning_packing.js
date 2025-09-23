class CleaningPackingUsecase {
  constructor(cleaningPackingRepo) {
    this.cleaningPackingRepo = cleaningPackingRepo;
    this.synker = null;
  }

  setSynker(synker) {
    this.synker = synker;
  }

  create(purchaseItem) {
    return new Promise(async (resolve, reject) => {
      try {
        // Validate required fields
        if (!purchaseItem.purchase_item) {
          reject(new Error("purchase_item (primary key) is required"));
          return;
        }
        if (!purchaseItem.purchase_item_name) {
          reject(new Error("purchase_item_name is required"));
          return;
        }

        const result = await this.cleaningPackingRepo.create(purchaseItem);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  getAll(filters = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const purchaseItems = await this.cleaningPackingRepo.getAll(filters);
        resolve(purchaseItems);
      } catch (err) {
        reject(err);
      }
    });
  }

  deleteAll() {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.cleaningPackingRepo.deleteAll();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  sync() {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this.synker || !this.synker.syncCleaningPacking) {
          throw new Error("Synker service not initialised");
        }
        await this.synker.syncCleaningPacking();
        resolve({ code: 200 });
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (cleaningPackingRepo) => {
  return new CleaningPackingUsecase(cleaningPackingRepo);
};
