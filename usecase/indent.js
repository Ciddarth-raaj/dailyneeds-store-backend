class IndentUsecase {
    constructor(indentRepo) {
      this.indentRepo = indentRepo;
    }
  
    get(limit, offset) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.indentRepo.get(limit, offset);
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
    }
    getDespatch(limit, offset, delivery_status) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.indentRepo.getDespatch(limit, offset, delivery_status);
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
    }
    getIndentByStoreId(store_id) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.indentRepo.getIndentByStoreId(store_id);
          resolve(data);
        } catch (err) {
          console.log(err);
          reject(err);
        }
      });
    }
    getIndentFromStoreId(store_id) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.indentRepo.getIndentFromStoreId(store_id);
          resolve(data);
        } catch (err) {
          console.log(err);
          reject(err);
        }
      });
    }
    updateDeliveryStatus(delivery_status, indent_id) {
      return new Promise(async(resolve, reject) => {
        try {
          const data = await this.indentRepo.updateDeliveryStatus(delivery_status, indent_id);
          resolve(data);
        } catch(err) {
          reject(err);
        }
      });
    }
    getIndentById(indent_id) {
      return new Promise(async(resolve, reject) => {
        try {
          const data = await this.indentRepo.getIndentById(indent_id);
          resolve(data);
        } catch(err) {
          reject(err);
        }
      });
    }
    getIndentCount() {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.indentRepo.getIndentCount();
          resolve(data);
        } catch (err) {
          reject(err);
        }
      }); 
    }
    createIndent(indent) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.indentRepo.createIndent(indent);
          resolve(200);
        } catch (err) {
          reject(err);
          console.log(err);
        }
      });
    }
  }
  module.exports = (indentRepo) => {
    return new IndentUsecase(indentRepo);
  };
  