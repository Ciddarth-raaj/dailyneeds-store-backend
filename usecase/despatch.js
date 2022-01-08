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
    getIndentsByDespatch(despatch_id) {
      return new Promise(async (resolve, reject) => {
        try {
          // console.log({despatch_id: despatch_id})
          const id = await this.despatchRepo.getIndentsByDespatch(despatch_id);
          const indent_id = id.split(',');
          // console.log({indent_id: indent_id});
          const data = await this.indentUsecase.getIndentById(indent_id);
          resolve(data);
        } catch (err) {
          console.log(err);
          reject(err);
        }
      });
    }
    getDespatchByStoreId(store_id) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.despatchRepo.getDespatchByStoreId(store_id);
          // console.log({data: data});
          resolve(data);
        } catch (err) {
          console.log(err);
          reject(err);
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
  