class DespatchUsecase {
    constructor(despatchRepo, indentUsecase) {
      this.despatchRepo = despatchRepo;
      this.indentUsecase = indentUsecase
    }

    createDespatch(despatch) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.indentUsecase.updateDeliveryStatus(despatch.indent_id)
          await this.despatchRepo.createDespatch(despatch);
          resolve(200);
        } catch (err) {
          reject(err);
          console.log(err);
        }
      });
    }
    get() {
      return new Promise(async (resolve, reject) => {
          try {
              const data = await this.despatchRepo.get();
              resolve(data);
          } catch (err) {
              reject(err);
          }
      });
  }
  }
  module.exports = (despatchRepo, indentUsecase) => {
    return new DespatchUsecase(despatchRepo, indentUsecase);
  };
  