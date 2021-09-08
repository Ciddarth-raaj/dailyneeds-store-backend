class StoreUsecase {
    constructor(storeRepo) {
      this.storeRepo = storeRepo;
    }
  
    get() {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.storeRepo.get();
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
    }
  }
  
  module.exports = (storeRepo) => {
    return new StoreUsecase(storeRepo);
  };
  