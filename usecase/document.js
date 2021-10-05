class DocumentUsecase {
  constructor(documentRepo) {
    this.documentRepo = documentRepo;
  }

  get(employee_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.documentRepo.get(employee_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getDocumentById(document_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.documentRepo.getDocumentById(document_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getAllDocuments() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.documentRepo.getAllDocuments();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getAdhaar() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.documentRepo.getAdhaar();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getDocumentsWithoutAdhaar() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.documentRepo.getDocumentsWithoutAdhaar();
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
      } catch (err) {
        reject(err);
      }
    });
  }
  updateVerification(file) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.documentRepo.updateVerification(file);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateStatus(file) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.documentRepo.updateStatus(file);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }
  update(file) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.documentRepo.update(file);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (documentRepo) => {
  return new DocumentUsecase(documentRepo);
};
