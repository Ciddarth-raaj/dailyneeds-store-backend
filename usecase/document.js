class DocumentUsecase {
    constructor(documentRepo) {
      this.documentRepo = documentRepo;
    }
  
    get() {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.documentRepo.get();
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
    }
    create(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.documentRepo.create(file);
          resolve(200);
        } catch(err) {
          reject(err);
        }
      });
    }
  }
  
  module.exports = (documentRepo) => {
    return new DocumentUsecase(documentRepo);
  };
  